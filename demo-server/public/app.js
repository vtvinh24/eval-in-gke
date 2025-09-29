// Global state
let currentUser = null;
let authToken = null;

// Utility functions
function showAlert(message, type = "info") {
  const existingAlert = document.querySelector(".alert");
  if (existingAlert) {
    existingAlert.remove();
  }

  const alert = document.createElement("div");
  alert.className = `alert alert-${type}`;
  alert.innerHTML = message;

  const content = document.querySelector(".content");
  content.insertBefore(alert, content.firstChild);

  setTimeout(() => {
    if (alert.parentNode) {
      alert.remove();
    }
  }, 5000);
}

function formatDate(dateString) {
  return new Date(dateString).toLocaleString();
}

function formatRepoUrl(url) {
  return url.replace("https://github.com/", "").replace(".git", "");
}

function getScoreClass(score) {
  if (score >= 80) return "high";
  if (score >= 60) return "medium";
  return "low";
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
    showAlert("Please enter username and password", "danger");
    return;
  }

  try {
    authToken = btoa(`${username}:${password}`);
    const result = await apiCall("/auth", {
      method: "POST",
      body: { username, password },
    });

    currentUser = result.user;

    // Show main app
    document.getElementById("authSection").classList.add("hidden");
    document.getElementById("mainApp").classList.remove("hidden");

    // Update UI based on user role
    updateUIForRole();

    // Load initial data
    loadDashboard();

    showAlert(`Welcome, ${currentUser.name}!`, "success");
  } catch (error) {
    showAlert(error.message, "danger");
    authToken = null;
  }
}

function logout() {
  currentUser = null;
  authToken = null;

  document.getElementById("authSection").classList.remove("hidden");
  document.getElementById("mainApp").classList.add("hidden");

  document.getElementById("username").value = "";
  document.getElementById("password").value = "";

  showSection("dashboard");
}

function updateUIForRole() {
  const userInfo = document.getElementById("userInfo");
  userInfo.textContent = `${currentUser.name} (${currentUser.role})`;
  userInfo.style.display = "block";

  // Show/hide navigation based on role
  const teamOnlyElements = document.querySelectorAll(".team-only");
  const judgeOnlyElements = document.querySelectorAll(".judge-only");

  if (currentUser.role === "team") {
    teamOnlyElements.forEach((el) => el.classList.remove("hidden"));
    judgeOnlyElements.forEach((el) => el.classList.add("hidden"));
  } else if (currentUser.role === "judge") {
    teamOnlyElements.forEach((el) => el.classList.add("hidden"));
    judgeOnlyElements.forEach((el) => el.classList.remove("hidden"));
  }
}

// Navigation
function showSection(sectionName) {
  // Update active section
  document.querySelectorAll(".section").forEach((section) => {
    section.classList.remove("active");
  });
  document.getElementById(sectionName).classList.add("active");

  // Update active nav button
  document.querySelectorAll(".nav-btn").forEach((btn) => {
    btn.classList.remove("active");
  });
  event.target.classList.add("active");

  // Load section data
  switch (sectionName) {
    case "dashboard":
      loadDashboard();
      break;
    case "submissions":
      loadSubmissions();
      break;
    case "judge":
      loadJudgeSubmissions();
      break;
    case "leaderboard":
      loadLeaderboard();
      break;
  }
}

// Dashboard
async function loadDashboard() {
  try {
    const [submissions, leaderboard, baseline] = await Promise.all([apiCall("/submissions"), apiCall("/leaderboard"), apiCall("/baseline")]);

    // Update stats
    document.getElementById("totalSubmissions").textContent = submissions.length;
    document.getElementById("completedEvaluations").textContent = submissions.filter((s) => s.status === "evaluated").length;
    document.getElementById("activeTeams").textContent = new Set(submissions.map((s) => s.teamId)).size;
    document.getElementById("judgeScores").textContent = submissions.reduce((sum, s) => sum + (s.judgeScores?.length || 0), 0);

    // Update baseline status
    const baselineStatus = document.getElementById("baselineStatus");
    if (baseline) {
      baselineStatus.innerHTML = `
                <div style="color: #27ae60; font-weight: bold;">✓ Baseline metrics available</div>
                <div style="margin-top: 10px; font-size: 14px;">
                    Queries: ${Object.keys(baseline.queries || {}).length} | 
                    Generated: ${formatDate(baseline.created_at || new Date())}
                </div>
            `;
    } else {
      baselineStatus.innerHTML = `
                <div style="color: #f39c12; font-weight: bold;">⏳ Fetching baseline metrics...</div>
                <div style="margin-top: 10px; font-size: 14px;">
                    This may take several minutes on first startup
                </div>
            `;
    }
  } catch (error) {
    showAlert("Failed to load dashboard data", "danger");
  }
}

// Submissions
async function loadSubmissions() {
  try {
    const teamFilter = document.getElementById("teamFilter").value;
    const url = teamFilter ? `/submissions?team=${teamFilter}` : "/submissions";
    const submissions = await apiCall(url);

    // Populate team filter if empty
    const teamFilterEl = document.getElementById("teamFilter");
    if (teamFilterEl.children.length <= 1) {
      const teams = [...new Set(submissions.map((s) => ({ id: s.teamId, name: s.teamName })))];
      teams.forEach((team) => {
        const option = document.createElement("option");
        option.value = team.id;
        option.textContent = team.name;
        teamFilterEl.appendChild(option);
      });
    }

    const submissionsList = document.getElementById("submissionsList");

    if (submissions.length === 0) {
      submissionsList.innerHTML = '<div class="loading">No submissions found</div>';
      return;
    }

    submissionsList.innerHTML = submissions
      .map(
        (submission) => `
            <div class="submission-card">
                <div style="display: flex; justify-content: between; align-items: start; margin-bottom: 15px;">
                    <div>
                        <h4>${submission.teamName}</h4>
                        <div style="color: #666; font-size: 14px;">${formatRepoUrl(submission.repoUrl)}</div>
                    </div>
                    <span class="status ${submission.status}">${submission.status}</span>
                </div>
                
                <div style="margin-bottom: 15px;">
                    <strong>Job ID:</strong> ${submission.jobId}<br>
                    <strong>Submitted:</strong> ${formatDate(submission.submittedAt)}
                    ${submission.completedAt ? `<br><strong>Completed:</strong> ${formatDate(submission.completedAt)}` : ""}
                </div>
                
                ${
                  submission.autoScore !== null
                    ? `
                    <div style="margin-bottom: 15px;">
                        <strong>Auto Score:</strong> 
                        <span class="score ${getScoreClass(submission.autoScore)}">${submission.autoScore}/100</span>
                    </div>
                `
                    : ""
                }
                
                ${
                  submission.judgeScores && submission.judgeScores.length > 0
                    ? `
                    <div style="margin-bottom: 15px;">
                        <strong>Judge Scores:</strong><br>
                        ${submission.judgeScores
                          .map(
                            (score) => `
                            <div style="font-size: 14px; margin-left: 10px;">
                                ${score.judgeName}: ${score.totalScore}/300
                            </div>
                        `
                          )
                          .join("")}
                    </div>
                `
                    : ""
                }
                
                ${
                  submission.metrics
                    ? `
                    <details>
                        <summary style="cursor: pointer; font-weight: bold;">View Metrics</summary>
                        <div class="metrics-display">
                            <pre>${JSON.stringify(submission.metrics, null, 2)}</pre>
                        </div>
                    </details>
                `
                    : ""
                }
            </div>
        `
      )
      .join("");
  } catch (error) {
    showAlert("Failed to load submissions", "danger");
  }
}

// Submit Repository
async function submitRepository() {
  const repoUrl = document.getElementById("repoUrl").value.trim();

  if (!repoUrl) {
    showAlert("Please enter a repository URL", "danger");
    return;
  }

  if (!repoUrl.match(/^https:\/\/github\.com\/.+\/.+/)) {
    showAlert("Please enter a valid GitHub repository URL", "danger");
    return;
  }

  try {
    const result = await apiCall("/submissions", {
      method: "POST",
      body: { repo_url: repoUrl },
    });

    document.getElementById("repoUrl").value = "";
    showAlert("Repository submitted successfully! Evaluation is starting...", "success");

    // Switch to submissions view
    showSection("submissions");
  } catch (error) {
    showAlert(error.message, "danger");
  }
}

// Judge Submissions
async function loadJudgeSubmissions() {
  try {
    const submissions = await apiCall("/submissions");
    const evaluatedSubmissions = submissions.filter((s) => s.status === "evaluated");

    const judgeSubmissionsList = document.getElementById("judgeSubmissionsList");

    if (evaluatedSubmissions.length === 0) {
      judgeSubmissionsList.innerHTML = '<div class="loading">No submissions ready for judging</div>';
      return;
    }

    judgeSubmissionsList.innerHTML = evaluatedSubmissions
      .map((submission) => {
        const existingScore = submission.judgeScores?.find((s) => s.judgeId === currentUser.id);

        return `
                <div class="card">
                    <h3>${submission.teamName}</h3>
                    <div style="margin-bottom: 20px;">
                        <strong>Repository:</strong> ${formatRepoUrl(submission.repoUrl)}<br>
                        <strong>Auto Score:</strong> 
                        <span class="score ${getScoreClass(submission.autoScore || 0)}">${submission.autoScore || 0}/100</span><br>
                        <strong>Submitted:</strong> ${formatDate(submission.submittedAt)}
                    </div>
                    
                    ${
                      submission.metrics
                        ? `
                        <details style="margin-bottom: 20px;">
                            <summary style="cursor: pointer; font-weight: bold;">View Performance Metrics</summary>
                            <div class="metrics-display">
                                <pre>${JSON.stringify(submission.metrics, null, 2)}</pre>
                            </div>
                        </details>
                    `
                        : ""
                    }
                    
                    <div style="border-top: 1px solid #ddd; padding-top: 20px;">
                        <h4>Judge Scoring</h4>
                        <div class="criteria-inputs">
                            <div class="form-group">
                                <label>Code Quality (0-100):</label>
                                <input type="number" id="criteria1_${submission.id}" min="0" max="100" 
                                       value="${existingScore?.criteria1 || 0}">
                            </div>
                            <div class="form-group">
                                <label>Optimization (0-100):</label>
                                <input type="number" id="criteria2_${submission.id}" min="0" max="100"
                                       value="${existingScore?.criteria2 || 0}">
                            </div>
                            <div class="form-group">
                                <label>Innovation (0-100):</label>
                                <input type="number" id="criteria3_${submission.id}" min="0" max="100"
                                       value="${existingScore?.criteria3 || 0}">
                            </div>
                        </div>
                        <button class="btn btn-success" onclick="submitJudgeScore('${submission.id}')">
                            ${existingScore ? "Update Score" : "Submit Score"}
                        </button>
                        
                        ${
                          existingScore
                            ? `
                            <div style="margin-top: 15px; padding: 10px; background: #f8f9fa; border-radius: 4px;">
                                <strong>Your Current Score:</strong> ${existingScore.totalScore}/300<br>
                                <small>Submitted: ${formatDate(existingScore.submittedAt)}</small>
                            </div>
                        `
                            : ""
                        }
                    </div>
                </div>
            `;
      })
      .join("");
  } catch (error) {
    showAlert("Failed to load submissions for judging", "danger");
  }
}

async function submitJudgeScore(submissionId) {
  const criteria1 = parseInt(document.getElementById(`criteria1_${submissionId}`).value) || 0;
  const criteria2 = parseInt(document.getElementById(`criteria2_${submissionId}`).value) || 0;
  const criteria3 = parseInt(document.getElementById(`criteria3_${submissionId}`).value) || 0;

  if (criteria1 < 0 || criteria1 > 100 || criteria2 < 0 || criteria2 > 100 || criteria3 < 0 || criteria3 > 100) {
    showAlert("All criteria scores must be between 0 and 100", "danger");
    return;
  }

  try {
    await apiCall(`/submissions/${submissionId}/judge`, {
      method: "POST",
      body: { criteria1, criteria2, criteria3 },
    });

    showAlert("Score submitted successfully!", "success");
    loadJudgeSubmissions(); // Reload to show updated score
  } catch (error) {
    showAlert(error.message, "danger");
  }
}

// Leaderboard
async function loadLeaderboard() {
  try {
    const leaderboard = await apiCall("/leaderboard");

    const tbody = document.querySelector("#leaderboardTable tbody");

    if (leaderboard.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="loading">No completed submissions yet</td></tr>';
      return;
    }

    tbody.innerHTML = leaderboard
      .map(
        (entry, index) => `
            <tr>
                <td style="font-weight: bold;">#${index + 1}</td>
                <td>${entry.teamName}</td>
                <td>
                    <a href="${entry.repoUrl}" target="_blank" style="color: #3498db;">
                        ${formatRepoUrl(entry.repoUrl)}
                    </a>
                </td>
                <td>
                    <span class="score ${getScoreClass(entry.autoScore)}">${entry.autoScore}</span>
                </td>
                <td>
                    <span class="score ${getScoreClass(entry.judgeScore)}">${entry.judgeScore}</span>
                    <small style="display: block; color: #666;">(${entry.judgeCount} judges)</small>
                </td>
                <td>
                    <span class="score ${getScoreClass(entry.totalScore)}" style="font-size: 20px;">
                        ${entry.totalScore}
                    </span>
                </td>
                <td style="font-size: 14px; color: #666;">
                    ${formatDate(entry.submittedAt)}
                </td>
            </tr>
        `
      )
      .join("");
  } catch (error) {
    showAlert("Failed to load leaderboard", "danger");
  }
}

// Auto-refresh functionality
function startAutoRefresh() {
  setInterval(() => {
    const activeSection = document.querySelector(".section.active");
    if (activeSection && currentUser) {
      const sectionId = activeSection.id;
      switch (sectionId) {
        case "dashboard":
          loadDashboard();
          break;
        case "submissions":
          loadSubmissions();
          break;
        case "judge":
          loadJudgeSubmissions();
          break;
        case "leaderboard":
          loadLeaderboard();
          break;
      }
    }
  }, 30000); // Refresh every 30 seconds
}

// Event listeners
document.addEventListener("DOMContentLoaded", () => {
  // Handle Enter key in login form
  document.getElementById("password").addEventListener("keypress", (e) => {
    if (e.key === "Enter") {
      login();
    }
  });

  // Start auto-refresh
  startAutoRefresh();
});

// Export functions for global access
window.login = login;
window.logout = logout;
window.showSection = showSection;
window.submitRepository = submitRepository;
window.submitJudgeScore = submitJudgeScore;
window.loadSubmissions = loadSubmissions;
