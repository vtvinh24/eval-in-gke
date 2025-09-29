// Global state
let currentUser = null;
let authToken = null;
let currentProblem = null;
let availableProblems = [];
let currentSection = null;
let confirmCallback = null;

// Enhanced status display with better status names and descriptions
function getStatusDisplay(status) {
  const statusMap = {
    "creating": {
      name: "Creating",
      description: "Preparing submission for evaluation",
      color: "info",
      icon: "⏳",
    },
    "queued": {
      name: "Queued",
      description: "Waiting for evaluation to start",
      color: "info",
      icon: "⏳",
    },
    "pending": {
      name: "Pending",
      description: "Job is pending in Kubernetes",
      color: "warning",
      icon: "⏸️",
    },
    "pending-resources": {
      name: "Pending Resources",
      description: "Waiting for cluster resources to become available",
      color: "warning",
      icon: "🔄",
    },
    "running": {
      name: "Running",
      description: "Evaluation in progress",
      color: "info",
      icon: "⚙️",
    },
    "processing": {
      name: "Processing",
      description: "Job completed, processing results",
      color: "info",
      icon: "⚙️",
    },
    "evaluated": {
      name: "Evaluated",
      description: "Evaluation completed successfully",
      color: "success",
      icon: "✅",
    },
    "failed": {
      name: "Failed",
      description: "Evaluation failed",
      color: "danger",
      icon: "❌",
    },
    "submitted": {
      name: "Submitted",
      description: "Submission received",
      color: "info",
      icon: "📝",
    },
    "evaluating": {
      name: "Evaluating",
      description: "Evaluation in progress",
      color: "info",
      icon: "⚙️",
    },
  };

  return (
    statusMap[status] || {
      name: status,
      description: "Unknown status",
      color: "secondary",
      icon: "❓",
    }
  );
}

// Manual monitoring trigger for debugging
async function triggerMonitoring() {
  if (currentUser.role !== "host" && currentUser.role !== "judge") {
    showAlert("Only hosts and judges can trigger monitoring", "error");
    return;
  }

  try {
    const result = await apiCall("/monitor/trigger", { method: "POST" });
    showAlert(`Monitoring triggered successfully. Updates: ${result.hasUpdates ? "Yes" : "No"}`, "success");

    // Refresh current section if it shows submissions
    if (["judgeSubmissions", "teamStatus", "hostProblems"].includes(currentSection)) {
      loadCurrentSection();
    }
  } catch (error) {
    showAlert(`Failed to trigger monitoring: ${error.message}`, "error");
  }
}

// Job polling functionality
let activePollingJobs = new Set();
let pollingIntervals = new Map();

async function pollJobStatus(jobId, submissionId = null, onUpdate = null) {
  // Prevent duplicate polling for the same job
  if (activePollingJobs.has(jobId)) {
    return;
  }

  activePollingJobs.add(jobId);
  console.log(`🔄 Starting polling for job: ${jobId}`);

  const pollInterval = setInterval(async () => {
    try {
      const result = await apiCall(`/jobs/${jobId}/poll`);

      // Call update callback if provided
      if (onUpdate) {
        onUpdate(result);
      }

      // Update submission status display if submissionId is provided
      if (submissionId) {
        updateSubmissionDisplay(submissionId, result);
      }

      // Stop polling if job is completed or failed
      if (result.status === "completed" || result.status === "failed" || result.status === "not-found") {
        console.log(`✓ Job ${jobId} finished with status: ${result.status}`);
        stopPolling(jobId);

        // Refresh the current section to show updated results
        if (["judgeSubmissions", "teamStatus", "hostProblems"].includes(currentSection)) {
          setTimeout(() => loadCurrentSection(), 1000); // Small delay to ensure data is processed
        }
      }
    } catch (error) {
      console.warn(`Failed to poll job ${jobId}:`, error.message);

      // Stop polling on consecutive errors
      if (error.message.includes("not found") || error.message.includes("404")) {
        console.log(`Stopping polling for job ${jobId} - not found`);
        stopPolling(jobId);
      }
    }
  }, 10000); // Poll every 10 seconds

  pollingIntervals.set(jobId, pollInterval);

  // Auto-stop polling after 30 minutes to prevent runaway intervals
  setTimeout(() => {
    if (activePollingJobs.has(jobId)) {
      console.log(`⏰ Auto-stopping polling for job ${jobId} after 30 minutes`);
      stopPolling(jobId);
    }
  }, 30 * 60 * 1000);
}

function stopPolling(jobId) {
  if (pollingIntervals.has(jobId)) {
    clearInterval(pollingIntervals.get(jobId));
    pollingIntervals.delete(jobId);
  }
  activePollingJobs.delete(jobId);
}

function stopAllPolling() {
  for (const jobId of activePollingJobs) {
    stopPolling(jobId);
  }
}

function updateSubmissionDisplay(submissionId, jobResult) {
  // Find submission display element and update it
  const submissionElement = document.querySelector(`[data-submission-id="${submissionId}"]`);
  if (submissionElement) {
    const statusElement = submissionElement.querySelector(".status-badge");
    const progressElement = submissionElement.querySelector(".job-progress");

    if (statusElement && jobResult.progress) {
      // Update status based on job progress
      const newStatus = getJobStatusFromProgress(jobResult.progress);
      statusElement.textContent = newStatus;
      statusElement.className = `status-badge status-${newStatus.toLowerCase()}`;
    }

    if (progressElement && jobResult.progress) {
      progressElement.innerHTML = `
        <div class="progress-info">
          <span>${jobResult.progress.phase} (${jobResult.progress.percentage}%)</span>
          ${jobResult.progress.estimatedTimeRemaining ? `<small>ETA: ${jobResult.progress.estimatedTimeRemaining}</small>` : ""}
        </div>
        <div class="progress-bar">
          <div class="progress-fill" style="width: ${jobResult.progress.percentage}%"></div>
        </div>
      `;
    }
  }
}

function getJobStatusFromProgress(progress) {
  switch (progress.phase) {
    case "queued":
      return "Queued";
    case "executing":
      return "Running";
    case "completed":
      return "Evaluated";
    case "failed":
      return "Failed";
    default:
      return "Processing";
  }
}

// Enhanced submission status polling for teams
async function pollSubmissionStatus(submissionId) {
  try {
    const result = await apiCall(`/submissions/${submissionId}/status`);

    if (result.job && result.job.id && result.submission.status !== "evaluated" && result.submission.status !== "failed") {
      // Start polling the job if it's not finished
      pollJobStatus(result.job.id, submissionId);
    }

    return result;
  } catch (error) {
    console.warn(`Failed to get submission status for ${submissionId}:`, error.message);
    return null;
  }
}

// Cleanup polling when page unloads
window.addEventListener("beforeunload", () => {
  stopAllPolling();
});

// Stop polling when user navigates to different sections (except team status)
function handleSectionChange(newSection) {
  if (newSection !== "teamStatus") {
    // Stop polling when navigating away from team status
    // but keep it running for a few minutes in case they come back
    setTimeout(() => {
      if (currentSection !== "teamStatus") {
        console.log("Stopping job polling due to section change");
        stopAllPolling();
      }
    }, 2 * 60 * 1000); // 2 minutes delay
  }
}

// Utility functions
function showAlert(message, type = "info") {
  // Use toast notification instead of inline alerts
  const iconMap = {
    success: "✓",
    error: "⚠",
    warning: "⚠",
    info: "ℹ",
  };

  const icon = iconMap[type] || "ℹ";
  const title = `${icon} ${type.charAt(0).toUpperCase() + type.slice(1)}`;

  return showToast(title, `<p>${message}</p>`, type, 5000);
}

function formatDate(dateString) {
  return new Date(dateString).toLocaleString();
}

function formatRepoUrl(url) {
  return url.replace("https://github.com/", "").replace(".git", "");
}

// Helper function to get parent directory path
function getParentPath(path) {
  if (!path || path === "") return "";
  const parts = path.split("/").filter((p) => p !== "");
  parts.pop(); // Remove last part
  return parts.join("/");
}

// Toast notification utility
function showToast(title, content, type = "success", duration = 5000) {
  const toast = document.createElement("div");
  toast.className = "submission-status-update";
  toast.innerHTML = `
    <div class="alert alert-${type}">
      <button class="toast-close" onclick="this.closest('.submission-status-update').remove()">&times;</button>
      <h4>${title}</h4>
      ${content}
    </div>
  `;

  document.body.appendChild(toast);

  // Auto-remove after duration
  if (duration > 0) {
    setTimeout(() => {
      if (toast.parentNode) {
        toast.style.animation = "slideOutToRight 0.3s ease-in";
        setTimeout(() => {
          if (toast.parentNode) {
            toast.remove();
          }
        }, 300);
      }
    }, duration);
  }

  return toast;
}

// API functions
async function apiCall(endpoint, options = {}) {
  const config = {
    headers: {
      "Content-Type": "application/json",
      ...(authToken && { Authorization: `Basic ${authToken}` }),
    },
    ...options,
  };

  if (config.body && typeof config.body !== "string") {
    config.body = JSON.stringify(config.body);
  }

  try {
    const response = await fetch(`/api${endpoint}`, config);

    if (!response.ok) {
      const error = await response.json();
      throw new Error(error.error || "API request failed");
    }

    return await response.json();
  } catch (error) {
    console.error("API Error:", error);
    throw error;
  }
}

// Authentication
async function login() {
  const username = document.getElementById("username").value;
  const password = document.getElementById("password").value;

  if (!username || !password) {
    document.getElementById("loginError").textContent = "Please enter username and password";
    document.getElementById("loginError").classList.remove("hidden");
    return;
  }

  try {
    authToken = btoa(`${username}:${password}`);
    const result = await apiCall("/auth", {
      method: "POST",
      body: { username, password },
    });

    currentUser = result.user;

    // Hide login, show main app
    document.getElementById("loginScreen").classList.add("hidden");
    document.getElementById("mainApp").classList.remove("hidden");

    // Update UI for user role
    updateUIForRole();

    // Load initial data
    await loadProblems();
    showDefaultSection();
  } catch (error) {
    document.getElementById("loginError").textContent = error.message;
    document.getElementById("loginError").classList.remove("hidden");
    authToken = null;
  }
}

function logout() {
  currentUser = null;
  authToken = null;
  document.getElementById("loginScreen").classList.remove("hidden");
  document.getElementById("mainApp").classList.add("hidden");
  document.getElementById("username").value = "";
  document.getElementById("password").value = "";
  document.getElementById("loginError").classList.add("hidden");
}

function updateUIForRole() {
  const userNameEl = document.getElementById("userName");
  const userRoleEl = document.getElementById("userRole");
  const navigationEl = document.getElementById("navigation");

  userNameEl.textContent = currentUser.name;
  userRoleEl.textContent = currentUser.role;
  userRoleEl.className = `role-badge role-${currentUser.role}`;
  document.getElementById("userInfo").classList.remove("hidden");

  // Clear navigation
  navigationEl.innerHTML = "";

  // Add navigation based on role
  const navItems = [];

  if (currentUser.role === "host") {
    navItems.push({ id: "hostProblems", label: "Manage Problems" }, { id: "leaderboard", label: "Leaderboard" });
  } else if (currentUser.role === "judge") {
    navItems.push({ id: "judgeSubmissions", label: "All Submissions" }, { id: "leaderboard", label: "Leaderboard" }, { id: "problems", label: "Problems" });
  } else if (currentUser.role === "team") {
    navItems.push({ id: "teamSubmit", label: "Submit Solution" }, { id: "teamStatus", label: "My Submissions" }, { id: "leaderboard", label: "Leaderboard" }, { id: "problems", label: "Problems" });
  }

  navItems.forEach((item) => {
    const button = document.createElement("button");
    button.textContent = item.label;
    button.onclick = () => showSection(item.id);
    navigationEl.appendChild(button);
  });
}

function showDefaultSection() {
  if (currentUser.role === "host") {
    showSection("hostProblems");
  } else if (currentUser.role === "judge") {
    showSection("judgeSubmissions");
  } else if (currentUser.role === "team") {
    showSection("teamSubmit");
  }
}

function showSection(sectionId) {
  // Handle section change for polling management
  handleSectionChange(sectionId);

  // Hide all sections
  document.querySelectorAll(".section").forEach((section) => {
    section.classList.remove("active");
  });

  // Remove active class from nav buttons
  document.querySelectorAll(".nav button").forEach((button) => {
    button.classList.remove("active");
  });

  // Show selected section
  const section = document.getElementById(sectionId);
  if (section) {
    section.classList.add("active");
    currentSection = sectionId;

    // Add active class to corresponding nav button
    const navButton = Array.from(document.querySelectorAll(".nav button")).find((button) => button.onclick && button.onclick.toString().includes(sectionId));
    if (navButton) {
      navButton.classList.add("active");
    }

    // Load section-specific data
    loadSectionData(sectionId);
  }
}

async function loadSectionData(sectionId) {
  try {
    switch (sectionId) {
      case "hostProblems":
        await loadHostProblems();
        break;
      case "judgeSubmissions":
        await loadJudgeSubmissions();
        break;
      case "teamSubmit":
        await loadTeamSubmitForm();
        break;
      case "teamStatus":
        await loadTeamSubmissions();
        break;
      case "leaderboard":
        await loadLeaderboard();
        break;
      case "problems":
        await loadProblemsTable();
        break;
    }
  } catch (error) {
    showAlert(`Error loading ${sectionId}: ${error.message}`, "error");
  }
}

// Problem management
async function loadProblems() {
  try {
    availableProblems = await apiCall("/problems");
  } catch (error) {
    showAlert("Failed to load problems", "error");
  }
}

async function loadHostProblems() {
  const container = document.getElementById("problemsList");
  container.innerHTML = "<p>Loading problems...</p>";

  try {
    await loadProblems();

    if (availableProblems.length === 0) {
      container.innerHTML = "<p>No problems created yet.</p>";
      return;
    }

    container.innerHTML = availableProblems
      .map(
        (problem) => `
      <div class="card">
        <h3>${problem.title}</h3>
        <p><strong>ID:</strong> ${problem.id}</p>
        <p><strong>Domain:</strong> ${problem.domain || "Not specified"}</p>
        <p><strong>Description:</strong> ${problem.description || "No description"}</p>
        <p><strong>Submissions:</strong> ${problem.submissionCount} (${problem.evaluatedCount} evaluated)</p>
        <div style="margin-top: 15px;">
          <button class="btn btn-warning" onclick="editProblem('${problem.id}')">Edit</button>
          <button class="btn btn-danger" onclick="deleteProblem('${problem.id}')">Delete</button>
        </div>
      </div>
    `
      )
      .join("");
  } catch (error) {
    container.innerHTML = `<p class="alert alert-error">Error loading problems: ${error.message}</p>`;
  }
}

function showCreateProblem() {
  showSection("createProblem");
}

// Problem creation form handler
document.addEventListener("DOMContentLoaded", () => {
  const form = document.getElementById("createProblemForm");
  if (form) {
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const formData = {
        id: document.getElementById("problemId").value,
        title: document.getElementById("problemTitle").value,
        description: document.getElementById("problemDescription").value,
        domain: document.getElementById("problemDomain").value,
        submissionDockerImage: document.getElementById("submissionDockerImage").value,
        submissionDockerParams: document.getElementById("submissionDockerParams").value,
        baselineDockerImage: document.getElementById("baselineDockerImage").value,
        baselineDockerParams: document.getElementById("baselineDockerParams").value,
      };

      try {
        // Parse JSON parameters
        if (formData.submissionDockerParams) {
          formData.submissionDockerParams = JSON.parse(formData.submissionDockerParams);
        }
        if (formData.baselineDockerParams) {
          formData.baselineDockerParams = JSON.parse(formData.baselineDockerParams);
        }

        await apiCall("/problems", {
          method: "POST",
          body: formData,
        });

        showAlert("Problem created successfully!", "success");
        form.reset();
        await loadProblems();
        showSection("hostProblems");
      } catch (error) {
        showAlert(`Failed to create problem: ${error.message}`, "error");
      }
    });
  }
});

async function deleteProblem(problemId) {
  showConfirmation("Delete Problem", `Are you sure you want to delete the problem "${problemId}"? This action cannot be undone.`, async () => {
    try {
      await apiCall(`/problems/${problemId}`, { method: "DELETE" });
      showAlert("Problem deleted successfully!", "success");
      await loadProblems();
      await loadHostProblems();
    } catch (error) {
      showAlert(`Failed to delete problem: ${error.message}`, "error");
    }
  });
}

// Judge functionality
async function loadJudgeSubmissions() {
  const container = document.getElementById("submissionsTable");
  container.innerHTML = "<p>Loading submissions...</p>";

  try {
    const submissions = await apiCall("/submissions");

    if (submissions.length === 0) {
      container.innerHTML = `
        <div class="section-header">
          <h3>All Submissions</h3>
          <button class="btn btn-secondary" onclick="triggerMonitoring()">🔄 Refresh Status</button>
        </div>
        <p>No submissions found.</p>
      `;
      return;
    }

    container.innerHTML = `
      <div class="section-header">
        <h3>All Submissions</h3>
        <button class="btn btn-secondary" onclick="triggerMonitoring()">🔄 Refresh Status</button>
      </div>
      <table class="table">
        <thead>
          <tr>
            <th>Team</th>
            <th>Problem</th>
            <th>Repository</th>
            <th>Submitted</th>
            <th>Status</th>
            <th>Auto Score</th>
            <th>Judge Score</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          ${submissions
            .map(
              (submission) => `
            <tr>
              <td>${submission.teamName}</td>
              <td>${submission.problemId || "Legacy"}</td>
              <td><a href="${submission.repoUrl}" target="_blank">${formatRepoUrl(submission.repoUrl)}</a></td>
              <td>${formatDate(submission.submittedAt)}</td>
              <td><span class="status-badge status-${submission.status}" title="${getStatusDisplay(submission.status).description}">${getStatusDisplay(submission.status).icon} ${
                getStatusDisplay(submission.status).name
              }</span></td>
              <td>${submission.autoScore || "N/A"}</td>
              <td>${submission.averageJudgeScore || "Not scored"}</td>
              <td>
                <button class="btn" onclick="evaluateSubmission('${submission.id}')">Evaluate</button>
                <button class="btn" onclick="viewSubmissionFiles('${submission.id}')">Files</button>
              </td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    `;
  } catch (error) {
    container.innerHTML = `<p class="alert alert-error">Error loading submissions: ${error.message}</p>`;
  }
}

async function evaluateSubmission(submissionId) {
  try {
    const submission = await apiCall(`/submissions/${submissionId}`);
    const rubric = await apiCall("/scoring/rubric");

    const container = document.getElementById("evaluationForm");
    container.innerHTML = `
      <div class="card">
        <h3>Evaluate Submission: ${submission.teamName}</h3>
        <div class="submission-info">
          <p><strong>Repository:</strong> <a href="${submission.repoUrl}" target="_blank">${submission.repoUrl}</a></p>
          <p><strong>Problem:</strong> ${submission.problemId || "Legacy Problem"}</p>
          <p><strong>Submitted:</strong> ${formatDate(submission.submittedAt)}</p>
          <p><strong>Status:</strong> <span class="status-badge status-${submission.status}" title="${getStatusDisplay(submission.status).description}">${getStatusDisplay(submission.status).icon} ${
      getStatusDisplay(submission.status).name
    }</span></p>
          ${submission.autoScore ? `<p><strong>Auto Score:</strong> ${submission.autoScore}/100</p>` : ""}
        </div>

        ${
          submission.metrics
            ? `
        <details class="metrics-section">
          <summary>View Performance Metrics</summary>
          <div class="metrics-display">
            <pre>${JSON.stringify(submission.metrics, null, 2)}</pre>
          </div>
        </details>
        `
            : ""
        }
        
        <form id="evaluationScoreForm">
          <h4>Scoring Rubric (Total: 100 points)</h4>
          <div class="rubric-container">
            ${Object.entries(rubric.criteria)
              .map(
                ([criterion, details]) => `
              <div class="rubric-section">
                <div class="rubric-header">
                  <h4>${details.name}</h4>
                  <span class="weight-indicator">${details.weight} points</span>
                </div>
                <p class="rubric-description">${details.description}</p>
                
                <div class="scoring-levels">
                  ${details.levels
                    .map(
                      (level, index) => `
                    <div class="scoring-level">
                      <label>
                        <input type="radio" name="${criterion}" value="${level.points}" 
                               ${index === 0 ? "checked" : ""} />
                        <div class="level-content">
                          <strong>${level.points} pts - ${level.name}</strong>
                          <p>${level.description}</p>
                        </div>
                      </label>
                    </div>
                  `
                    )
                    .join("")}
                </div>
                
                <div class="custom-score">
                  <label>
                    <input type="radio" name="${criterion}" value="custom" />
                    Custom Score: 
                    <input type="number" class="custom-score-input" min="0" max="${details.weight}" 
                           onchange="this.previousElementSibling.value = this.value" />
                  </label>
                </div>
              </div>
            `
              )
              .join("")}
          </div>
          
          <div class="form-group">
            <label for="judgeComments">Comments & Feedback:</label>
            <textarea id="judgeComments" rows="6" placeholder="Provide detailed feedback on the submission. What did they do well? What could be improved?"></textarea>
          </div>

          <div class="score-summary">
            <h4>Total Score: <span id="totalScore">0</span>/100</h4>
          </div>
          
          <div class="form-actions">
            <button type="submit" class="btn btn-success">Submit Evaluation</button>
            <button type="button" class="btn btn-warning" onclick="saveDraft('${submissionId}')">Save Draft</button>
            <button type="button" class="btn" onclick="showSection('judgeSubmissions')">Cancel</button>
          </div>
        </form>
      </div>
    `;

    // Add real-time score calculation
    const form = document.getElementById("evaluationScoreForm");
    form.addEventListener("change", calculateTotalScore);

    // Load existing draft if available
    loadEvaluationDraft(submissionId);

    // Handle form submission
    form.addEventListener("submit", async (e) => {
      e.preventDefault();

      const scores = {};
      let totalScore = 0;

      // Collect scores from each criterion
      Object.keys(rubric.criteria).forEach((criterion) => {
        const selectedInput = form.querySelector(`input[name="${criterion}"]:checked`);
        if (selectedInput) {
          const score = selectedInput.value === "custom" ? parseInt(selectedInput.nextElementSibling.value) || 0 : parseInt(selectedInput.value);
          scores[criterion] = score;
          totalScore += score;
        }
      });

      const evaluation = {
        ...scores,
        totalScore,
        comments: document.getElementById("judgeComments").value,
        submittedAt: new Date().toISOString(),
      };

      try {
        await apiCall(`/submissions/${submissionId}/judge`, {
          method: "POST",
          body: evaluation,
        });

        showAlert("Evaluation submitted successfully!", "success");
        clearEvaluationDraft(submissionId);
        showSection("judgeSubmissions");
      } catch (error) {
        handleApiError(error, "Failed to submit evaluation");
      }
    });

    showSection("judgeEvaluate");
  } catch (error) {
    handleApiError(error, "Failed to load submission for evaluation");
  }
}

function calculateTotalScore() {
  const form = document.getElementById("evaluationScoreForm");
  let total = 0;

  // Get all criterion names from the form
  const criteriaInputs = form.querySelectorAll('input[type="radio"]:checked');

  criteriaInputs.forEach((input) => {
    const score = input.value === "custom" ? parseInt(input.nextElementSibling?.value) || 0 : parseInt(input.value) || 0;
    total += score;
  });

  const totalElement = document.getElementById("totalScore");
  if (totalElement) {
    totalElement.textContent = total;
    totalElement.className = total >= 80 ? "score-excellent" : total >= 60 ? "score-good" : total >= 40 ? "score-fair" : "score-poor";
  }
}

function saveDraft(submissionId) {
  const form = document.getElementById("evaluationScoreForm");
  const draft = {
    submissionId,
    timestamp: new Date().toISOString(),
    scores: {},
    comments: document.getElementById("judgeComments").value,
  };

  // Collect current form state
  const criteriaInputs = form.querySelectorAll('input[type="radio"]:checked');
  criteriaInputs.forEach((input) => {
    const criterion = input.name;
    const score = input.value === "custom" ? parseInt(input.nextElementSibling?.value) || 0 : parseInt(input.value) || 0;
    draft.scores[criterion] = score;
  });

  localStorage.setItem(`evaluation_draft_${submissionId}`, JSON.stringify(draft));
  showAlert("Draft saved locally", "success");
}

function loadEvaluationDraft(submissionId) {
  const draftKey = `evaluation_draft_${submissionId}`;
  const draftData = localStorage.getItem(draftKey);

  if (draftData) {
    try {
      const draft = JSON.parse(draftData);

      // Restore form state
      Object.entries(draft.scores).forEach(([criterion, score]) => {
        const radio = document.querySelector(`input[name="${criterion}"][value="${score}"]`);
        if (radio) {
          radio.checked = true;
        } else {
          // Must be a custom score
          const customRadio = document.querySelector(`input[name="${criterion}"][value="custom"]`);
          if (customRadio) {
            customRadio.checked = true;
            customRadio.nextElementSibling.value = score;
          }
        }
      });

      document.getElementById("judgeComments").value = draft.comments || "";
      calculateTotalScore();

      showAlert(`Draft loaded from ${formatDate(draft.timestamp)}`, "info");
    } catch (error) {
      console.error("Failed to load draft:", error);
    }
  }
}

function clearEvaluationDraft(submissionId) {
  localStorage.removeItem(`evaluation_draft_${submissionId}`);
}

async function viewSubmissionFiles(submissionId) {
  try {
    const files = await apiCall(`/submissions/${submissionId}/files`);

    // Validate response structure
    if (!files || !Array.isArray(files.files)) {
      throw new Error("Invalid response format or no files found");
    }

    const container = document.getElementById("fileBrowser");
    container.innerHTML = `
      <div class="card">
        <h3>Submission Files</h3>
        <p><strong>Job ID:</strong> ${files.jobId}</p>
        <p><strong>Current Path:</strong> /${files.currentPath}</p>
        
        <div class="file-browser">
          ${files.files
            .map(
              (file) => `
            <div class="file-item" onclick="selectFile('${submissionId}', '${file.path}', ${file.isDirectory})">
              <span class="file-icon">${file.isDirectory ? "📁" : "📄"}</span>
              <span>${file.name}</span>
            </div>
          `
            )
            .join("")}
        </div>
        
        <div id="fileContent"></div>
        
        <button class="btn" onclick="showSection('judgeSubmissions')">Back to Submissions</button>
      </div>
    `;

    showSection("judgeFiles");
  } catch (error) {
    showAlert(`Failed to load files: ${error.message}`, "error");
  }
}

async function selectFile(submissionId, filePath, isDirectory) {
  if (isDirectory) {
    // Navigate to directory
    try {
      const files = await apiCall(`/submissions/${submissionId}/files?path=${encodeURIComponent(filePath)}`);

      // Update the file browser with the new directory contents
      const container = document.getElementById("fileBrowser");
      container.innerHTML = `
        <div class="card">
          <h3>Submission Files</h3>
          <p><strong>Job ID:</strong> ${files.jobId}</p>
          <p><strong>Current Path:</strong> /${files.currentPath}</p>
          
          <div class="file-browser">
            ${
              filePath !== ""
                ? `
              <div class="file-item" onclick="selectFile('${submissionId}', '${getParentPath(filePath)}', true)">
                <span class="file-icon">📁</span>
                <span>.. (go back)</span>
              </div>
            `
                : ""
            }
            ${files.files
              .map(
                (file) => `
              <div class="file-item" onclick="selectFile('${submissionId}', '${file.path}', ${file.isDirectory})">
                <span class="file-icon">${file.isDirectory ? "📁" : "📄"}</span>
                <span>${file.name}</span>
              </div>
            `
              )
              .join("")}
          </div>
          
          <div id="fileContent"></div>
          
          <button class="btn" onclick="showSection('judgeSubmissions')">Back to Submissions</button>
        </div>
      `;
    } catch (error) {
      showAlert(`Failed to browse directory: ${error.message}`, "error");
    }
    return;
  }

  // Load file content
  try {
    const content = await apiCall(`/submissions/${submissionId}/files/content?filePath=${encodeURIComponent(filePath)}`);

    const container = document.getElementById("fileContent");
    if (content.isText) {
      // Detect file type for syntax highlighting
      const fileExtension = filePath.split(".").pop().toLowerCase();
      const language = getLanguageFromExtension(fileExtension);

      container.innerHTML = `
        <h4>File: ${filePath}</h4>
        <div class="file-actions">
          <button class="btn" onclick="downloadFile('${submissionId}', '${filePath}')">Download</button>
          <button class="btn" onclick="copyToClipboard('${submissionId}-${filePath}')">Copy</button>
        </div>
        <div class="file-content" id="fileContent-${submissionId}-${filePath}" data-language="${language}">${escapeHtml(content.content)}</div>
      `;
    } else {
      container.innerHTML = `
        <h4>File: ${filePath}</h4>
        <p>Binary file - <a href="${content.downloadUrl}" target="_blank" class="btn">Download</a></p>
      `;
    }
  } catch (error) {
    showAlert(`Failed to load file: ${error.message}`, "error");
  }
}

function getLanguageFromExtension(ext) {
  const languageMap = {
    js: "javascript",
    py: "python",
    sql: "sql",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
    html: "html",
    css: "css",
    java: "java",
    cpp: "cpp",
    c: "c",
    go: "go",
    sh: "bash",
  };
  return languageMap[ext] || "text";
}

function escapeHtml(text) {
  const div = document.createElement("div");
  div.textContent = text;
  return div.innerHTML;
}

async function downloadFile(submissionId, filePath) {
  try {
    const response = await fetch(`/api/submissions/${submissionId}/files/content?filePath=${encodeURIComponent(filePath)}&download=true`, {
      headers: authToken ? { Authorization: `Basic ${authToken}` } : {},
    });

    if (response.ok) {
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filePath.split("/").pop();
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } else {
      throw new Error("Failed to download file");
    }
  } catch (error) {
    showAlert(`Failed to download file: ${error.message}`, "error");
  }
}

function copyToClipboard(elementId) {
  const element = document.getElementById(`fileContent-${elementId}`);
  if (element) {
    navigator.clipboard
      .writeText(element.textContent)
      .then(() => {
        showAlert("Content copied to clipboard!", "success");
      })
      .catch(() => {
        showAlert("Failed to copy to clipboard", "error");
      });
  }
}

// Auto-refresh functionality
let autoRefreshInterval = null;
let autoRefreshEnabled = true;

function startAutoRefresh() {
  if (autoRefreshInterval) {
    clearInterval(autoRefreshInterval);
  }

  autoRefreshInterval = setInterval(() => {
    if (!autoRefreshEnabled || !currentSection) return;

    // Only auto-refresh certain sections to avoid disrupting user interaction
    const autoRefreshSections = ["judgeSubmissions", "teamStatus", "leaderboard", "hostProblems"];

    if (autoRefreshSections.includes(currentSection)) {
      loadSectionData(currentSection);
    }
  }, 30000); // Refresh every 30 seconds
}

function toggleAutoRefresh() {
  autoRefreshEnabled = !autoRefreshEnabled;
  const button = document.getElementById("autoRefreshToggle");
  if (button) {
    button.textContent = autoRefreshEnabled ? "Disable Auto-refresh" : "Enable Auto-refresh";
    button.className = autoRefreshEnabled ? "btn btn-warning" : "btn btn-success";
  }
  showAlert(`Auto-refresh ${autoRefreshEnabled ? "enabled" : "disabled"}`, "info");
}

// Enhanced error handling
function handleApiError(error, context = "") {
  console.error(`API Error ${context}:`, error);

  if (error.message.includes("401") || error.message.includes("Unauthorized")) {
    showAlert("Session expired. Please log in again.", "error");
    logout();
    return;
  }

  if (error.message.includes("403") || error.message.includes("Forbidden")) {
    showAlert("You don't have permission to perform this action.", "error");
    return;
  }

  if (error.message.includes("404") || error.message.includes("Not Found")) {
    showAlert("The requested resource was not found.", "error");
    return;
  }

  showAlert(`${context ? context + ": " : ""}${error.message}`, "error");
}

// Team functionality
async function loadTeamSubmitForm() {
  const container = document.getElementById("teamSubmissionForm");

  if (availableProblems.length === 0) {
    container.innerHTML = `
      <div class="alert alert-warning">
        <strong>No problems available</strong><br>
        No problems are currently available for submission. Please check back later or contact the contest host.
      </div>
    `;
    return;
  }

  // Get team's existing submissions to show status
  const teamSubmissions = await apiCall("/submissions").catch(() => []);
  const submissionsByProblem = {};
  teamSubmissions.forEach((sub) => {
    submissionsByProblem[sub.problemId] = sub;
  });

  container.innerHTML = `
    <div class="card">
      <h3>Submit Solution</h3>
      <p>Select a problem below and provide your GitHub repository URL containing the solution.</p>
      
      <div class="problem-selection">
        ${availableProblems
          .map((problem) => {
            const existingSubmission = submissionsByProblem[problem.id];
            const hasSubmission = !!existingSubmission;
            const canResubmit = hasSubmission && ["failed", "evaluated"].includes(existingSubmission.status);

            return `
            <div class="problem-card ${hasSubmission ? "has-submission" : ""}">
              <div class="problem-header">
                <h4>${problem.title}</h4>
                <div class="problem-status">
                  ${
                    hasSubmission
                      ? `
                    <span class="status-indicator ${existingSubmission.status}"></span>
                    <span class="status-badge status-${existingSubmission.status}">${existingSubmission.status}</span>
                  `
                      : `
                    <span class="status-indicator offline"></span>
                    <span class="status-text">Not submitted</span>
                  `
                  }
                </div>
              </div>
              
              <p><strong>Domain:</strong> ${problem.domain || "Not specified"}</p>
              <p class="problem-description">${problem.description || "No description available"}</p>
              
              ${
                hasSubmission
                  ? `
                <div class="existing-submission">
                  <h5>Current Submission:</h5>
                  <p><strong>Repository:</strong> <a href="${existingSubmission.repoUrl}" target="_blank">${formatRepoUrl(existingSubmission.repoUrl)}</a></p>
                  <p><strong>Submitted:</strong> ${formatDate(existingSubmission.submittedAt)}</p>
                  ${existingSubmission.autoScore ? `<p><strong>Score:</strong> ${existingSubmission.autoScore}/100</p>` : ""}
                  ${
                    existingSubmission.status === "evaluating"
                      ? `
                    <div class="evaluation-progress">
                      <div class="progress-bar">
                        <div class="progress-fill"></div>
                      </div>
                      <p><em>Evaluation in progress... This may take 5-15 minutes.</em></p>
                    </div>
                  `
                      : ""
                  }
                </div>
              `
                  : ""
              }
              
              <div class="submission-actions">
                ${
                  !hasSubmission || canResubmit
                    ? `
                  <button class="btn ${hasSubmission ? "btn-warning" : "btn-success"}" 
                          onclick="showSubmissionForm('${problem.id}', ${hasSubmission})">
                    ${hasSubmission ? "Resubmit Solution" : "Submit Solution"}
                  </button>
                `
                    : `
                  <button class="btn" disabled>
                    ${existingSubmission.status === "evaluating" ? "Evaluation in progress" : "Already submitted"}
                  </button>
                `
                }
                
                ${
                  hasSubmission
                    ? `
                  <button class="btn" onclick="viewSubmissionDetails('${existingSubmission.id}')">
                    View Details
                  </button>
                `
                    : ""
                }
              </div>
            </div>
          `;
          })
          .join("")}
      </div>
    </div>
    
    <div id="submissionFormContainer"></div>
    <div id="submissionDetails"></div>
  `;
}

function showSubmissionForm(problemId, isResubmission = false) {
  const problem = availableProblems.find((p) => p.id === problemId);
  if (!problem) return;

  const container = document.getElementById("submissionFormContainer");
  container.innerHTML = `
    <div class="card submission-form">
      <h3>${isResubmission ? "Resubmit" : "Submit"} Solution for "${problem.title}"</h3>
      
      ${
        isResubmission
          ? `
        <div class="alert alert-warning">
          <strong>Warning:</strong> This will replace your existing submission. Make sure your new solution is ready for evaluation.
        </div>
      `
          : ""
      }
      
      <form id="submitRepoForm">
        <div class="form-group">
          <label for="repoUrl">GitHub Repository URL:</label>
          <input type="url" id="repoUrl" required 
                 placeholder="https://github.com/username/repository-name" 
                 pattern="https://github\.com/.+/.+" />
          <small>Repository must be public and contain your solution files</small>
        </div>
        
        <div class="submission-requirements">
          <h4>Submission Requirements:</h4>
          <ul>
            <li>Repository must be <strong>public</strong> for evaluation access</li>
            <li>Include all required solution files in the repository root</li>
            <li>Follow the problem-specific requirements and file naming conventions</li>
            <li>Ensure your code can run in the specified environment</li>
          </ul>
        </div>
        
        <div class="form-actions">
          <button type="submit" class="btn btn-success">
            ${isResubmission ? "Resubmit" : "Submit"} Solution
          </button>
          <button type="button" class="btn" onclick="hideSubmissionForm()">Cancel</button>
        </div>
      </form>
    </div>
  `;

  // Handle form submission
  document.getElementById("submitRepoForm").addEventListener("submit", async (e) => {
    e.preventDefault();

    const repoUrl = document.getElementById("repoUrl").value.trim();
    const submitButton = e.target.querySelector('button[type="submit"]');
    const originalButtonText = submitButton.textContent;

    // Validate GitHub URL format
    if (!repoUrl.match(/^https:\/\/github\.com\/[^\/]+\/[^\/]+\/?$/)) {
      showAlert("Please enter a valid GitHub repository URL", "error");
      return;
    }

    // Show loading state
    submitButton.disabled = true;
    submitButton.innerHTML = `
      <span class="loading-spinner"></span>
      ${isResubmission ? "Resubmitting..." : "Submitting..."}
    `;

    // Add progress indicator
    const progressContainer = document.createElement("div");
    progressContainer.className = "submission-progress";
    progressContainer.innerHTML = `
      <div class="progress-steps">
        <div class="step active">
          <span class="step-number">1</span>
          <span class="step-label">Validating repository</span>
        </div>
        <div class="step">
          <span class="step-number">2</span>
          <span class="step-label">Creating evaluation job</span>
        </div>
        <div class="step">
          <span class="step-number">3</span>
          <span class="step-label">Starting evaluation</span>
        </div>
      </div>
      <div class="progress-message">Checking repository accessibility...</div>
    `;

    const form = document.getElementById("submitRepoForm");
    form.appendChild(progressContainer);

    try {
      // Step 1: Validate repository
      setTimeout(() => {
        if (progressContainer.parentNode) {
          progressContainer.querySelector(".progress-message").textContent = "Repository validated successfully";
          progressContainer.querySelectorAll(".step")[1].classList.add("active");
        }
      }, 1000);

      // Step 2: Submit to API
      setTimeout(() => {
        if (progressContainer.parentNode) {
          progressContainer.querySelector(".progress-message").textContent = "Creating evaluation job in GKE...";
          progressContainer.querySelectorAll(".step")[2].classList.add("active");
        }
      }, 2000);

      const result = await apiCall(`/problems/${problemId}/submissions`, {
        method: "POST",
        body: {
          repo_url: repoUrl,
          confirmReplace: isResubmission,
        },
      });

      // Success
      if (progressContainer.parentNode) {
        progressContainer.querySelector(".progress-message").innerHTML = `
          <span style="color: #27ae60;">✓ Evaluation started successfully!</span><br>
          <small>Job ID: ${result.submission?.jobId || "N/A"}</small><br>
          <small>Status: <span class="status-badge status-evaluating">evaluating</span></small>
        `;
      }

      // Start polling for job status if we have a job ID
      if (result.submission?.jobId) {
        console.log(`🔄 Starting polling for new submission job: ${result.submission.jobId}`);
        pollJobStatus(result.submission.jobId, result.submission.id);
      }

      // Show immediate status update as a toast notification
      const toastContent = `
        <p><strong>Problem:</strong> ${problem.title}</p>
        <p><strong>Repository:</strong> <a href="${repoUrl}" target="_blank">${formatRepoUrl(repoUrl)}</a></p>
        <p><strong>Status:</strong> <span class="status-badge status-submitted">submitted</span></p>
        <p><strong>Estimated completion:</strong> 5-15 minutes</p>
        <p><em>Redirecting to submissions in 3 seconds...</em></p>
      `;

      const statusNotification = showToast("✓ New Submission Created", toastContent, "success", 0);

      setTimeout(() => {
        hideSubmissionForm();
        loadTeamSubmitForm(); // Refresh the form
        loadTeamSubmissions(); // Refresh submissions list

        // Remove the status notification with animation
        if (statusNotification.parentNode) {
          statusNotification.style.animation = "slideOutToRight 0.3s ease-in";
          setTimeout(() => {
            if (statusNotification.parentNode) {
              statusNotification.remove();
            }
          }, 300);
        }

        // Auto-navigate to submissions status to show the user the update
        showSection("teamStatus");

        // Scroll to top to ensure user sees the new submission
        window.scrollTo({ top: 0, behavior: "smooth" });
      }, 3000);
    } catch (error) {
      // Reset button state
      submitButton.disabled = false;
      submitButton.textContent = originalButtonText;

      // Remove progress indicator
      if (progressContainer.parentNode) {
        progressContainer.remove();
      }

      if (error.message.includes("confirmReplace") && !isResubmission) {
        showConfirmation("Replace Existing Submission", "You already have a submission for this problem. Do you want to replace it with this new submission?", async () => {
          // Re-enable and retry with confirmReplace
          showSubmissionForm(problemId, true);
        });
      } else {
        handleApiError(error, "Failed to submit solution");
      }
    }
  });

  // Scroll to form
  container.scrollIntoView({ behavior: "smooth" });
}

function hideSubmissionForm() {
  document.getElementById("submissionFormContainer").innerHTML = "";
}

async function viewSubmissionDetails(submissionId) {
  try {
    const submission = await apiCall(`/submissions/${submissionId}`);

    const container = document.getElementById("submissionDetails");
    container.innerHTML = `
      <div class="card submission-details">
        <h3>Submission Details</h3>
        
        <div class="detail-grid">
          <div class="detail-item">
            <strong>Problem:</strong> ${submission.problemId || "Legacy Problem"}
          </div>
          <div class="detail-item">
            <strong>Repository:</strong> 
            <a href="${submission.repoUrl}" target="_blank">${formatRepoUrl(submission.repoUrl)}</a>
          </div>
          <div class="detail-item">
            <strong>Status:</strong> 
            <span class="status-badge status-${submission.status}">${submission.status}</span>
          </div>
          <div class="detail-item">
            <strong>Submitted:</strong> ${formatDate(submission.submittedAt)}
          </div>
          ${
            submission.completedAt
              ? `
            <div class="detail-item">
              <strong>Completed:</strong> ${formatDate(submission.completedAt)}
            </div>
          `
              : ""
          }
          ${
            submission.autoScore
              ? `
            <div class="detail-item">
              <strong>Auto Score:</strong> ${submission.autoScore}/100
            </div>
          `
              : ""
          }
          ${
            submission.judgeScores && submission.judgeScores.length > 0
              ? `
            <div class="detail-item">
              <strong>Judge Scores:</strong> 
              ${submission.judgeScores
                .map((score) => {
                  let displayScore = score.totalScore;
                  // Calculate totalScore if it's null
                  if (displayScore === null || displayScore === undefined) {
                    if (score.scores && score.weights) {
                      const weightedScore =
                        (Number(score.scores.correctness || 0) * (score.weights.correctness || 0)) / 100 +
                        (Number(score.scores.performance || 0) * (score.weights.performance || 0)) / 100 +
                        (Number(score.scores.codeQuality || 0) * (score.weights.codeQuality || 0)) / 100 +
                        (Number(score.scores.documentation || 0) * (score.weights.documentation || 0)) / 100;
                      displayScore = Math.round(weightedScore * 100) / 100;
                    } else {
                      displayScore = "Pending";
                    }
                  }
                  return `${score.judgeName}: ${displayScore}/100`;
                })
                .join(", ")}
            </div>
          `
              : ""
          }
        </div>
        
        ${
          submission.metrics
            ? `
          <details class="metrics-section">
            <summary>View Performance Metrics</summary>
            <div class="metrics-display">
              <pre>${JSON.stringify(submission.metrics, null, 2)}</pre>
            </div>
          </details>
        `
            : ""
        }
        
        <div class="form-actions">
          <button class="btn" onclick="hideSubmissionDetails()">Close</button>
        </div>
      </div>
    `;

    container.scrollIntoView({ behavior: "smooth" });
  } catch (error) {
    handleApiError(error, "Failed to load submission details");
  }
}

function hideSubmissionDetails() {
  document.getElementById("submissionDetails").innerHTML = "";
}

async function loadTeamSubmissions() {
  const container = document.getElementById("teamSubmissions");
  container.innerHTML = "<p>Loading your submissions...</p>";

  try {
    const submissions = await apiCall("/submissions");

    if (submissions.length === 0) {
      container.innerHTML = "<p>You haven't made any submissions yet.</p>";
      return;
    }

    container.innerHTML = submissions
      .map((submission) => {
        const statusDisplay = getStatusDisplay(submission.status);
        const isActive = ["creating", "queued", "running", "processing"].includes(submission.status);

        return `
            <div class="submission-card" data-submission-id="${submission.id}">
              <div class="submission-header">
                <h3>${submission.problemId || "Legacy Problem"}</h3>
                <span class="status-badge status-${statusDisplay.color}">${statusDisplay.icon} ${statusDisplay.name}</span>
              </div>
              <p><strong>Repository:</strong> <a href="${submission.repoUrl}" target="_blank">${formatRepoUrl(submission.repoUrl)}</a></p>
              <p><strong>Submitted:</strong> ${formatDate(submission.submittedAt)}</p>
              ${submission.completedAt ? `<p><strong>Completed:</strong> ${formatDate(submission.completedAt)}</p>` : ""}
              ${submission.autoScore ? `<p><strong>Auto Score:</strong> ${submission.autoScore}/100</p>` : ""}
              ${submission.averageJudgeScore ? `<p><strong>Judge Score:</strong> ${submission.averageJudgeScore}/100</p>` : ""}
              ${submission.jobId ? `<p><strong>Job ID:</strong> <code>${submission.jobId}</code></p>` : ""}
              ${
                isActive
                  ? `
                <div class="job-progress">
                  <div class="progress-info">
                    <span>Processing...</span>
                    <small>ETA: 5-15 minutes</small>
                  </div>
                  <div class="progress-bar">
                    <div class="progress-fill" style="width: 25%"></div>
                  </div>
                </div>
              `
                  : ""
              }
              ${submission.error ? `<p class="alert alert-error"><strong>Error:</strong> ${submission.error}</p>` : ""}
            </div>
          `;
      })
      .join("");

    // Start polling for active submissions
    submissions.forEach((submission) => {
      if (["creating", "queued", "running", "processing"].includes(submission.status)) {
        if (submission.jobId) {
          pollJobStatus(submission.jobId, submission.id);
        } else {
          // Poll submission status directly if no job ID yet
          pollSubmissionStatus(submission.id);
        }
      }
    });
  } catch (error) {
    container.innerHTML = `<p class="alert alert-error">Error loading submissions: ${error.message}</p>`;
  }
}

// Shared functionality
async function loadLeaderboard() {
  const container = document.getElementById("leaderboardTable");
  container.innerHTML = "<p>Loading leaderboard...</p>";

  try {
    const leaderboard = await apiCall("/leaderboard");

    if (leaderboard.length === 0) {
      container.innerHTML = "<p>No evaluated submissions yet.</p>";
      return;
    }

    container.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Rank</th>
            <th>Team</th>
            <th>Problem</th>
            <th>Auto Score</th>
            <th>Judge Score</th>
            <th>Total Score</th>
            <th>Submitted</th>
          </tr>
        </thead>
        <tbody>
          ${leaderboard
            .map(
              (entry, index) => `
            <tr>
              <td>${index + 1}</td>
              <td>${entry.teamName}</td>
              <td>${entry.problemId || "Legacy"}</td>
              <td>${entry.autoScore || "N/A"}</td>
              <td>${entry.judgeScore || "N/A"}</td>
              <td><strong>${entry.totalScore || "N/A"}</strong></td>
              <td>${formatDate(entry.submittedAt)}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    `;
  } catch (error) {
    container.innerHTML = `<p class="alert alert-error">Error loading leaderboard: ${error.message}</p>`;
  }
}

async function loadProblemsTable() {
  const container = document.getElementById("problemsTable");
  container.innerHTML = "<p>Loading problems...</p>";

  try {
    await loadProblems();

    if (availableProblems.length === 0) {
      container.innerHTML = "<p>No problems available.</p>";
      return;
    }

    container.innerHTML = `
      <table class="table">
        <thead>
          <tr>
            <th>Title</th>
            <th>Domain</th>
            <th>Description</th>
            <th>Submissions</th>
            <th>Evaluated</th>
          </tr>
        </thead>
        <tbody>
          ${availableProblems
            .map(
              (problem) => `
            <tr>
              <td><strong>${problem.title}</strong></td>
              <td>${problem.domain || "Not specified"}</td>
              <td>${problem.description || "No description"}</td>
              <td>${problem.submissionCount}</td>
              <td>${problem.evaluatedCount}</td>
            </tr>
          `
            )
            .join("")}
        </tbody>
      </table>
    `;
  } catch (error) {
    container.innerHTML = `<p class="alert alert-error">Error loading problems: ${error.message}</p>`;
  }
}

// Confirmation dialog
function showConfirmation(title, message, callback) {
  document.getElementById("confirmTitle").textContent = title;
  document.getElementById("confirmMessage").textContent = message;
  document.getElementById("confirmationDialog").classList.remove("hidden");
  confirmCallback = callback;
}

function hideConfirmation() {
  document.getElementById("confirmationDialog").classList.add("hidden");
  confirmCallback = null;
}

function confirmAction() {
  if (confirmCallback) {
    confirmCallback();
  }
  hideConfirmation();
}

// Keyboard shortcuts
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    hideConfirmation();
  }
});

// Initialize app
document.addEventListener("DOMContentLoaded", () => {
  // Add enter key support for login
  document.getElementById("password").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      login();
    }
  });

  // Start auto-refresh functionality
  startAutoRefresh();

  // Add keyboard shortcuts
  document.addEventListener("keydown", (e) => {
    // Ctrl/Cmd + R to refresh current section
    if ((e.ctrlKey || e.metaKey) && e.key === "r") {
      e.preventDefault();
      if (currentSection) {
        loadSectionData(currentSection);
        showAlert("Section refreshed", "info");
      }
    }
  });

  // Handle browser tab visibility changes for auto-refresh
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) {
      // Pause auto-refresh when tab is not visible
      autoRefreshEnabled = false;
    } else {
      // Resume auto-refresh when tab becomes visible
      autoRefreshEnabled = true;
      // Immediately refresh current section when tab becomes visible
      if (currentSection) {
        loadSectionData(currentSection);
      }
    }
  });

  // Handle online/offline status
  window.addEventListener("online", () => {
    showAlert("Connection restored", "success");
    if (currentSection) {
      loadSectionData(currentSection);
    }
  });

  window.addEventListener("offline", () => {
    showAlert("Connection lost - working offline", "warning");
  });
});

// Enhanced API call function with retry logic
async function apiCallWithRetry(endpoint, options = {}, maxRetries = 3) {
  let lastError;

  for (let i = 0; i < maxRetries; i++) {
    try {
      return await apiCall(endpoint, options);
    } catch (error) {
      lastError = error;

      // Don't retry on authentication or permission errors
      if (error.message.includes("401") || error.message.includes("403")) {
        throw error;
      }

      // Wait before retrying (exponential backoff)
      if (i < maxRetries - 1) {
        await new Promise((resolve) => setTimeout(resolve, Math.pow(2, i) * 1000));
      }
    }
  }

  throw lastError;
}

// Update apiCall references in critical sections to use retry logic
const originalApiCall = apiCall;
function enhancedApiCall(endpoint, options = {}) {
  // Use retry for critical read operations
  if (!options.method || options.method === "GET") {
    return apiCallWithRetry(endpoint, options);
  }

  // Use normal call for write operations to avoid duplicate actions
  return originalApiCall(endpoint, options);
}

// Global error boundary
window.addEventListener("error", (event) => {
  console.error("Global error:", event.error);
  showAlert("An unexpected error occurred. Please refresh the page if problems persist.", "error");
});

window.addEventListener("unhandledrejection", (event) => {
  console.error("Unhandled promise rejection:", event.reason);
  showAlert("A network error occurred. Please check your connection.", "error");
});

// Performance monitoring
const performanceMetrics = {
  pageLoadTime: 0,
  apiCallTimes: [],

  recordApiCall: function (endpoint, duration) {
    this.apiCallTimes.push({ endpoint, duration, timestamp: Date.now() });

    // Keep only last 100 calls
    if (this.apiCallTimes.length > 100) {
      this.apiCallTimes.shift();
    }

    // Log slow API calls
    if (duration > 5000) {
      console.warn(`Slow API call detected: ${endpoint} took ${duration}ms`);
    }
  },

  getAverageApiTime: function () {
    if (this.apiCallTimes.length === 0) return 0;
    const total = this.apiCallTimes.reduce((sum, call) => sum + call.duration, 0);
    return total / this.apiCallTimes.length;
  },
};

// Monitor page load time
window.addEventListener("load", () => {
  performanceMetrics.pageLoadTime = performance.now();
  console.log(`Page loaded in ${performanceMetrics.pageLoadTime.toFixed(2)}ms`);
});

// Export functions for debugging and testing
if (typeof window !== "undefined") {
  window.debugAPI = {
    performanceMetrics,
    currentUser,
    currentSection,
    availableProblems,
    autoRefreshEnabled,
  };
}
