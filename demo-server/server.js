require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const { SubmissionResultsMonitor } = require("./utils/submissionResults");
const DataManager = require("./utils/dataManager");

const app = express();
const PORT = process.env.PORT || 3000;
const BASELINE_BUCKET = process.env.BASELINE_BUCKET || "db-baseline";
const BASELINE_SUMMARY_FILE = process.env.BASELINE_SUMMARY_FILE || "summary.json";

// Initialize data manager
const dataManager = new DataManager();

// Initialize submission results monitor
const submissionMonitor = new SubmissionResultsMonitor({
  submissionResultsBucket: process.env.SUBMISSION_RESULTS_BUCKET,
  summaryFile: process.env.SUBMISSION_SUMMARY_FILE,
  credentialsPath: process.env.GCP_CREDENTIALS_JSON_PATH,
  monitorInterval: parseInt(process.env.JOB_MONITOR_INTERVAL_MS) || 30000,
  maxRetries: parseInt(process.env.SUBMISSION_MONITOR_MAX_RETRIES) || 5,
  debug: process.env.DEBUG === "true",
});

// Middleware
app.use(express.json());
app.use(express.static("public"));

// Data persistence
const DATA_FILE = path.join(__dirname, "data.json");

// Initialize data structure
const initData = {
  users: [
    { id: "host", name: "Contest Host", role: "host", password: "host123" },
    { id: "judge1", name: "Judge Alice", role: "judge", password: "judge123" },
    { id: "judge2", name: "Judge Bob", role: "judge", password: "judge123" },
    { id: "team1", name: "Team Alpha", role: "team", password: "team123" },
    { id: "team2", name: "Team Beta", role: "team", password: "team123" },
    { id: "team3", name: "Team Gamma", role: "team", password: "team123" },
  ],
  problems: {
    "db-query-optimization": {
      id: "db-query-optimization",
      title: "Database Query Optimization Challenge",
      description:
        "Large-scale analytics and OLTP systems often encounter SQL queries that become prohibitively slow as data volume grows (100M+ rows). This challenge simulates a real-world scenario where you must optimize a slow SQL workload to run efficiently on a single machine.",
      domain: "Databases, query optimization, systems engineering, data engineering",
      constraints: {
        database: "PostgreSQL 14",
        dataset: "events table ~100M rows; other tables up to ~120M rows",
        hardware: "8 vCPU, 32GB RAM, 1TB SSD",
        migrationTime: "≤30 minutes",
        queryTimeout: "4s target, 10s max",
        auxiliaryStorage: "≤30% extra over base DB",
      },
      scoringWeights: {
        correctness: 50,
        latency: 30,
        concurrency: 10,
        storageEfficiency: 10,
      },
      submissions: [],
      baselineMetrics: null,
      jobStatuses: {},
    },
  },
  // Legacy support - will be migrated to problems structure
  submissions: [],
  evaluations: [],
  baselineMetrics: null,
  jobStatuses: {},
};

// Data persistence helpers
async function loadData() {
  try {
    const data = await fs.readFile(DATA_FILE, "utf8");
    const loaded = JSON.parse(data);

    // Migrate legacy data structure to new multi-problem format
    if (!loaded.problems && (loaded.submissions || loaded.baselineMetrics)) {
      console.log("Migrating legacy data structure to multi-problem format...");

      if (!loaded.problems) {
        loaded.problems = {};
      }

      // Create the default DB optimization problem with existing data
      loaded.problems["db-query-optimization"] = {
        id: "db-query-optimization",
        title: "Database Query Optimization Challenge",
        description: "Large-scale analytics and OLTP systems often encounter SQL queries that become prohibitively slow as data volume grows (100M+ rows).",
        domain: "Databases, query optimization, systems engineering, data engineering",
        constraints: {
          database: "PostgreSQL 14",
          dataset: "events table ~100M rows; other tables up to ~120M rows",
          hardware: "8 vCPU, 32GB RAM, 1TB SSD",
          migrationTime: "≤30 minutes",
          queryTimeout: "4s target, 10s max",
          auxiliaryStorage: "≤30% extra over base DB",
        },
        scoringWeights: {
          correctness: 50,
          latency: 30,
          concurrency: 10,
          storageEfficiency: 10,
        },
        submissions: loaded.submissions || [],
        baselineMetrics: loaded.baselineMetrics || null,
        jobStatuses: loaded.jobStatuses || {},
      };

      // Update submission objects to include problemId if missing
      if (loaded.problems["db-query-optimization"].submissions) {
        loaded.problems["db-query-optimization"].submissions.forEach((submission) => {
          if (!submission.problemId) {
            submission.problemId = "db-query-optimization";
          }
        });
      }

      await saveData(loaded);
      console.log("Data migration completed");
    }

    return loaded;
  } catch (error) {
    console.log("No existing data file, using initial data");
    return initData;
  }
}

async function saveData(data) {
  await fs.writeFile(DATA_FILE, JSON.stringify(data, null, 2));
}

// Auto-scoring mechanism based on baseline metrics
function calculateScore(submissionMetrics, baselineMetrics) {
  if (!baselineMetrics || !submissionMetrics) return 0;

  let totalScore = 0;
  let queryCount = 0;

  // Compare each query performance
  for (const [queryId, submissionQuery] of Object.entries(submissionMetrics.queries || {})) {
    const baselineQuery = baselineMetrics.queries?.[queryId];

    if (baselineQuery && submissionQuery.status === "success" && baselineQuery.status === "success") {
      // Performance score (0-40 points per query)
      const performanceRatio = baselineQuery.avg_time / submissionQuery.avg_time;
      const performanceScore = Math.min(40, Math.max(0, performanceRatio * 20));

      // Correctness score (0-60 points per query)
      const correctnessScore = submissionQuery.correctness_check ? 60 : 0;

      totalScore += performanceScore + correctnessScore;
      queryCount++;
    } else if (submissionQuery.status === "failed") {
      // Penalty for failed queries
      totalScore += 0;
      queryCount++;
    }
  }

  return queryCount > 0 ? Math.round(totalScore / queryCount) : 0;
}

// Fetch baseline metrics on startup
async function fetchBaselineMetrics(problemId = "db-query-optimization") {
  const data = await loadData();

  if (data.problems?.[problemId]?.baselineMetrics) {
    console.log(`Using cached baseline metrics for problem: ${problemId}`);
    return data.problems[problemId].baselineMetrics;
  }

  try {
    console.log("Fetching baseline metrics using get-latest-baseline.sh...");

    const { exec } = require("child_process");
    const { promisify } = require("util");
    const execAsync = promisify(exec);

    // Set up environment variables for the script
    const env = {
      ...process.env,
      BASELINE_BUCKET: BASELINE_BUCKET,
    };

    // Only set GCP credentials if the file exists
    const credentialsPath = process.env.GCP_CREDENTIALS_JSON_PATH;
    if (credentialsPath) {
      const fullCredentialsPath = path.resolve(__dirname, credentialsPath);
      try {
        await fs.access(fullCredentialsPath);
        env.GCP_CREDENTIALS_JSON = fullCredentialsPath;
      } catch (error) {
        console.log(`GCP credentials file not found at ${fullCredentialsPath}, continuing without explicit authentication`);
      }
    }

    // Get the script path
    const scriptPath = path.resolve(__dirname, process.env.GET_LATEST_BASELINE_SCRIPT || "../scripts/get-latest-baseline.sh");

    // Execute the get-latest-baseline.sh script to get the latest baseline files
    const { stdout: scriptOutput } = await execAsync(`bash "${scriptPath}"`, { env });

    // Parse the script output to find the summary.json file
    const lines = scriptOutput.trim().split("\n");
    const summaryLine = lines.find((line) => line.includes("summary.json"));

    if (!summaryLine) {
      throw new Error("No summary.json found in baseline bucket");
    }

    const summaryUrl = summaryLine.trim();
    console.log(`Fetching baseline metrics from: ${summaryUrl}`);

    // Download and parse the summary.json file
    const { stdout: summaryJson } = await execAsync(`gsutil cat "${summaryUrl}"`, { env });
    const rawBaselineMetrics = JSON.parse(summaryJson);

    // Process the baseline metrics to add average times for compatibility with scoring
    const processedMetrics = processBaselineMetrics(rawBaselineMetrics);

    // Store the metrics
    if (!data.problems[problemId]) {
      data.problems[problemId] = initData.problems["db-query-optimization"];
    }
    data.problems[problemId].baselineMetrics = processedMetrics;
    await saveData(data);

    console.log(`Baseline metrics fetched and cached for problem: ${problemId}`);
    console.log(`Metrics include ${Object.keys(processedMetrics.queries || {}).length} queries`);

    return data.problems[problemId].baselineMetrics;
  } catch (error) {
    console.error("Error fetching baseline metrics:", error.message);
    return null;
  }
}

// Process baseline metrics to add average times for compatibility with scoring
function processBaselineMetrics(rawMetrics) {
  const processedMetrics = { ...rawMetrics };

  // Add average times to each query for compatibility with the scoring function
  if (processedMetrics.queries) {
    Object.keys(processedMetrics.queries).forEach((queryId) => {
      const query = processedMetrics.queries[queryId];
      if (query.status === "success" && query.runs && query.runs.length > 0) {
        const validTimes = query.runs.filter((run) => run.status === "success" && typeof run.time === "number").map((run) => run.time);

        if (validTimes.length > 0) {
          query.avg_time = validTimes.reduce((sum, time) => sum + time, 0) / validTimes.length;
        }
      }
    });
  }

  return processedMetrics;
}

// Helper function to create job using create-job.sh script
async function createJobUsingScript(type, repoUrl, config = {}) {
  try {
    const { exec } = require("child_process");
    const { promisify } = require("util");
    const execAsync = promisify(exec);

    // Set up environment variables
    const env = {
      ...process.env,
      GCP_CREDENTIALS_JSON: process.env.GCP_CREDENTIALS_JSON_PATH || "./config/service-account.json",
      GKE_NAMESPACE: process.env.GKE_NAMESPACE || "eval-system",
    };

    // Get the script path
    const scriptPath = path.resolve(__dirname, process.env.CREATE_JOB_SCRIPT || "../scripts/create-job.sh");

    let command = `bash "${scriptPath}" ${type}`;
    if (repoUrl) {
      command += ` "${repoUrl}"`;
    }

    console.log(`Creating ${type} job using script: ${command}`);

    // Execute the create-job.sh script
    const { stdout } = await execAsync(command, { env });

    // Parse the job ID from script output
    // The script should output the job ID or job name
    const jobId = stdout.trim().split("\n").pop(); // Get last line of output

    if (jobId && jobId.length > 0) {
      console.log(`Job created via script: ${jobId}`);
      return { job_id: jobId };
    } else {
      throw new Error("Script did not return a job ID");
    }
  } catch (error) {
    console.error("Error creating job using script:", error.message);
    throw error;
  }
}

// Helper function to fetch submission results from GCS (using new module)
async function fetchSubmissionResultsFromGCS(jobId, problemId = null) {
  return await submissionMonitor.fetchSubmissionResults(jobId, problemId);
}

// Job status monitoring (using new module)
async function monitorJobStatuses() {
  return await submissionMonitor.monitorJobStatuses(loadData, saveData, calculateScore);
}

// Authentication middleware
function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return res.status(401).json({ error: "Authorization header required" });
  }

  const [username, password] = Buffer.from(authHeader.split(" ")[1], "base64").toString().split(":");

  loadData()
    .then((data) => {
      const user = data.users.find((u) => u.id === username && u.password === password);
      if (!user) {
        return res.status(401).json({ error: "Invalid credentials" });
      }

      req.user = user;
      next();
    })
    .catch((error) => {
      res.status(500).json({ error: "Authentication error" });
    });
}

// Routes

// Get all problems
app.get("/api/problems", async (req, res) => {
  try {
    const problems = await dataManager.getProblemsArray();
    res.json(problems);
  } catch (error) {
    console.error("Error loading problems:", error);
    res.status(500).json({ error: "Failed to load problems" });
  }
});

// Get specific problem details
app.get("/api/problems/:problemId", async (req, res) => {
  const data = await loadData();
  const problem = data.problems[req.params.problemId];

  if (!problem) {
    return res.status(404).json({ error: "Problem not found" });
  }

  res.json(problem);
});

// Create new problem (Host only)
app.post("/api/problems", authenticate, async (req, res) => {
  if (req.user.role !== "host") {
    return res.status(403).json({ error: "Only hosts can create problems" });
  }

  const { id, title, description, domain, constraints, scoringWeights, baselineDockerImage, baselineDockerParams, submissionDockerImage, submissionDockerParams } = req.body;

  if (!id || !title || !submissionDockerImage || !submissionDockerParams) {
    return res.status(400).json({
      error: "id, title, submissionDockerImage, and submissionDockerParams are required",
    });
  }

  try {
    const data = await loadData();

    if (data.problems[id]) {
      return res.status(409).json({ error: "Problem with this ID already exists" });
    }

    const newProblem = {
      id,
      title,
      description: description || "",
      domain: domain || "",
      constraints: constraints || {},
      scoringWeights: scoringWeights || {
        correctness: 50,
        performance: 30,
        efficiency: 20,
      },
      baselineDockerImage: baselineDockerImage || null,
      baselineDockerParams: baselineDockerParams || null,
      submissionDockerImage,
      submissionDockerParams,
      submissions: [],
      baselineMetrics: null,
      jobStatuses: {},
      createdAt: new Date().toISOString(),
      createdBy: req.user.id,
    };

    data.problems[id] = newProblem;
    await saveData(data);

    console.log(`✓ Problem "${title}" created by ${req.user.name}`);

    // Create baseline job if baseline docker image is provided
    if (baselineDockerImage) {
      try {
        console.log(`Creating baseline job for problem ${id}...`);
        const baselineJobResponse = await createJobUsingScript("baseline", null, {
          timeout: 600000,
          exec_per_query: 3,
          problemId: id,
          dockerImage: baselineDockerImage,
          dockerParams: baselineDockerParams,
        });

        const baselineJobId = baselineJobResponse.job_id || baselineJobResponse.data?.job_id;
        newProblem.baselineJobId = baselineJobId;
        newProblem.jobStatuses[baselineJobId] = "queued";

        await saveData(data);
        console.log(`✓ Baseline job created: ${baselineJobId}`);
      } catch (error) {
        console.error(`Failed to create baseline job for problem ${id}:`, error.message);
        // Don't fail problem creation if baseline job fails
      }
    }

    res.status(201).json({
      message: "Problem created successfully",
      problem: newProblem,
    });
  } catch (error) {
    console.error("Error creating problem:", error.message);
    res.status(500).json({
      error: "Failed to create problem",
      details: error.message,
    });
  }
});

// Update problem (Host only)
app.put("/api/problems/:problemId", authenticate, async (req, res) => {
  if (req.user.role !== "host") {
    return res.status(403).json({ error: "Only hosts can update problems" });
  }

  const { problemId } = req.params;
  const updates = req.body;

  try {
    const data = await loadData();

    if (!data.problems[problemId]) {
      return res.status(404).json({ error: "Problem not found" });
    }

    // Prevent updating certain fields
    delete updates.id;
    delete updates.submissions;
    delete updates.baselineMetrics;
    delete updates.jobStatuses;
    delete updates.createdAt;
    delete updates.createdBy;

    // Update the problem
    data.problems[problemId] = {
      ...data.problems[problemId],
      ...updates,
      updatedAt: new Date().toISOString(),
      updatedBy: req.user.id,
    };

    await saveData(data);

    console.log(`✓ Problem "${problemId}" updated by ${req.user.name}`);

    res.json({
      message: "Problem updated successfully",
      problem: data.problems[problemId],
    });
  } catch (error) {
    console.error("Error updating problem:", error.message);
    res.status(500).json({
      error: "Failed to update problem",
      details: error.message,
    });
  }
});

// Delete problem (Host only)
app.delete("/api/problems/:problemId", authenticate, async (req, res) => {
  if (req.user.role !== "host") {
    return res.status(403).json({ error: "Only hosts can delete problems" });
  }

  const { problemId } = req.params;

  try {
    const data = await loadData();

    if (!data.problems[problemId]) {
      return res.status(404).json({ error: "Problem not found" });
    }

    const problem = data.problems[problemId];
    const submissionCount = problem.submissions?.length || 0;

    if (submissionCount > 0) {
      return res.status(400).json({
        error: `Cannot delete problem with ${submissionCount} submissions. Archive it instead.`,
      });
    }

    delete data.problems[problemId];
    await saveData(data);

    console.log(`✓ Problem "${problemId}" deleted by ${req.user.name}`);

    res.json({
      message: "Problem deleted successfully",
    });
  } catch (error) {
    console.error("Error deleting problem:", error.message);
    res.status(500).json({
      error: "Failed to delete problem",
      details: error.message,
    });
  }
});

// Authentication
app.post("/api/auth", async (req, res) => {
  try {
    const { username, password } = req.body;
    const users = await dataManager.loadUsers();

    const user = users.find((u) => u.id === username && u.password === password);
    if (!user) {
      return res.status(401).json({ error: "Invalid credentials" });
    }

    res.json({ user: { id: user.id, name: user.name, role: user.role } });
  } catch (error) {
    console.error("Authentication error:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// Submit repo for evaluation (enhanced with confirmation)
app.post("/api/problems/:problemId/submissions", authenticate, async (req, res) => {
  const { repo_url, confirmReplace } = req.body;
  const { problemId } = req.params;

  if (req.user.role !== "team") {
    return res.status(403).json({ error: "Only teams can submit repositories" });
  }

  if (!repo_url) {
    return res.status(400).json({ error: "repo_url is required" });
  }

  try {
    const problems = await dataManager.getProblemsArray();
    const problem = problems.find((p) => p.id === problemId);

    if (!problem) {
      return res.status(404).json({ error: "Problem not found" });
    }

    // Check for existing submissions from this team
    const existingSubmissions = await dataManager.getSubmissionsByTeam(req.user.id, problemId);
    const latestSubmission = existingSubmissions[0];

    // Check if there's a pending submission
    if (latestSubmission && (latestSubmission.status === "evaluating" || latestSubmission.status === "queued")) {
      return res.status(409).json({
        error: "You have a pending submission that is still being evaluated",
        conflictType: "pending_submission",
        latestSubmission: {
          id: latestSubmission.id,
          repoUrl: latestSubmission.repoUrl,
          status: latestSubmission.status,
          submittedAt: latestSubmission.submittedAt,
        },
      });
    }

    // Check if user wants to replace existing evaluated submission
    if (latestSubmission && (latestSubmission.status === "evaluated" || latestSubmission.status === "failed") && !confirmReplace) {
      return res.status(409).json({
        error: "You already have a submission for this problem. Set confirmReplace=true to submit a new one.",
        conflictType: "existing_submission",
        latestSubmission: {
          id: latestSubmission.id,
          repoUrl: latestSubmission.repoUrl,
          status: latestSubmission.status,
          submittedAt: latestSubmission.submittedAt,
          autoScore: latestSubmission.autoScore,
        },
      });
    }

    console.log(`Creating submission job for team ${req.user.id}, problem ${problemId}, repo: ${repo_url}`);

    // Create submission job using script
    const jobResponse = await createJobUsingScript("submission", repo_url, {
      timeout: 600000, // 10 minutes
      exec_per_query: 3,
      problemId: problemId,
      dockerImage: problem.submissionDockerImage,
      dockerParams: problem.submissionDockerParams,
    });

    const jobId = jobResponse.job_id || jobResponse.data?.job_id;
    console.log(`✓ Job created: ${jobId}`);

    const submission = await dataManager.createSubmission({
      problemId: problemId,
      teamId: req.user.id,
      teamName: req.user.name,
      repoUrl: repo_url,
      jobId: jobId,
      status: "submitted",
      replacedSubmission: latestSubmission ? latestSubmission.id : null,
    });

    console.log(`✓ Submission ${submission.id} created and saved`);

    res.json({
      message: "Submission created successfully",
      submission: {
        id: submission.id,
        problemId: submission.problemId,
        jobId: submission.jobId,
        status: submission.status,
        repoUrl: submission.repoUrl,
        submittedAt: submission.submittedAt,
        estimatedCompletionTime: "5-15 minutes",
        replacedSubmission: submission.replacedSubmission,
      },
    });
  } catch (error) {
    console.error("Error creating submission:", error.message);
    res.status(500).json({ error: "Failed to create submission" });
  }
});

// Legacy submission endpoint for backward compatibility
app.post("/api/submissions", authenticate, async (req, res) => {
  const { repo_url } = req.body;

  if (req.user.role !== "team") {
    return res.status(403).json({ error: "Only teams can submit repositories" });
  }

  if (!repo_url) {
    return res.status(400).json({ error: "repo_url is required" });
  }

  try {
    // Create submission job using script
    const jobResponse = await createJobUsingScript("submission", repo_url, {
      timeout: 600000, // 10 minutes
      exec_per_query: 3,
    });
    console.log(`Legacy job created using script`);

    const submission = await dataManager.createSubmission({
      problemId: "db-query-optimization", // Default to DB optimization problem
      teamId: req.user.id,
      teamName: req.user.name,
      repoUrl: repo_url,
      jobId: jobResponse.job_id,
      status: "submitted",
    });

    res.json({
      message: "Submission created successfully",
      submission: {
        id: submission.id,
        jobId: submission.jobId,
        status: submission.status,
      },
    });
  } catch (error) {
    console.error("Error creating submission:", error.message);
    res.status(500).json({ error: "Failed to create submission" });
  }
});

// Get submissions for a specific problem
app.get("/api/problems/:problemId/submissions", async (req, res) => {
  try {
    const { problemId } = req.params;
    const { team } = req.query;

    const problems = await dataManager.getProblemsArray();
    const problem = problems.find((p) => p.id === problemId);

    if (!problem) {
      return res.status(404).json({ error: "Problem not found" });
    }

    let submissions = await dataManager.getSubmissionsList();

    // Filter by problem
    submissions = submissions.filter((s) => s.problemId === problemId);

    // Filter by team if specified
    if (team) {
      submissions = submissions.filter((s) => s.teamId === team);
    }

    res.json(submissions);
  } catch (error) {
    console.error("Error loading problem submissions:", error);
    res.status(500).json({ error: "Failed to load submissions" });
  }
});

// Get submissions (enhanced with role-based filtering)
app.get("/api/submissions", authenticate, async (req, res) => {
  try {
    const { team, problem } = req.query;
    let submissions = await dataManager.getSubmissionsList();

    // Apply problem filtering
    if (problem) {
      submissions = submissions.filter((s) => s.problemId === problem);
    }

    // Apply role-based filtering
    if (req.user.role === "team") {
      // Teams can only see their own submissions
      submissions = submissions.filter((s) => s.teamId === req.user.id);
    } else if (team && (req.user.role === "judge" || req.user.role === "host")) {
      // Judges and hosts can filter by team
      submissions = submissions.filter((s) => s.teamId === team);
    }

    // Sort by submission time (newest first)
    submissions.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));

    res.json(submissions);
  } catch (error) {
    console.error("Error loading submissions:", error);
    res.status(500).json({ error: "Failed to load submissions" });
  }
});

// Get team's latest submission status
app.get("/api/teams/latest-submission", authenticate, async (req, res) => {
  if (req.user.role !== "team") {
    return res.status(403).json({ error: "Only teams can view their latest submission" });
  }

  const { problemId } = req.query;

  try {
    let latestSubmission = null;

    if (problemId) {
      // Get latest submission for specific problem
      const submissions = await dataManager.getSubmissionsByTeam(req.user.id, problemId);
      latestSubmission = submissions[0] || null;
    } else {
      // Get latest submission across all problems
      const submissions = await dataManager.getSubmissionsByTeam(req.user.id);
      latestSubmission = submissions[0] || null;
    }

    if (!latestSubmission) {
      return res.json({
        hasSubmission: false,
        message: "No submissions found",
      });
    }

    // Calculate estimated completion time for pending submissions
    let estimatedCompletion = null;
    if (latestSubmission.status === "evaluating" && latestSubmission.submittedAt) {
      const submittedTime = new Date(latestSubmission.submittedAt);
      const elapsedMinutes = (Date.now() - submittedTime.getTime()) / (1000 * 60);
      const estimatedTotalMinutes = 15; // Estimated total time
      const remainingMinutes = Math.max(0, estimatedTotalMinutes - elapsedMinutes);

      if (remainingMinutes > 0) {
        estimatedCompletion = new Date(Date.now() + remainingMinutes * 60 * 1000).toISOString();
      }
    }

    res.json({
      hasSubmission: true,
      submission: latestSubmission,
      estimatedCompletion,
      canSubmitNew: latestSubmission.status === "evaluated" || latestSubmission.status === "failed",
    });
  } catch (error) {
    console.error("Error fetching latest submission:", error.message);
    res.status(500).json({
      error: "Failed to fetch latest submission",
      details: error.message,
    });
  }
});

// Get submission by ID
app.get("/api/submissions/:id", async (req, res) => {
  try {
    const submission = await dataManager.getSubmission(req.params.id);

    if (!submission) {
      return res.status(404).json({ error: "Submission not found" });
    }

    res.json(submission);
  } catch (error) {
    console.error("Error fetching submission:", error);
    res.status(500).json({ error: "Failed to fetch submission" });
  }
});

// Judge submission with 100-point rubric system
app.post("/api/submissions/:id/judge", authenticate, async (req, res) => {
  const { correctness, performance, codeQuality, documentation, comments } = req.body;

  if (req.user.role !== "judge") {
    return res.status(403).json({ error: "Only judges can score submissions" });
  }

  // Validate scores (0-100 for each criterion)
  const scores = { correctness, performance, codeQuality, documentation };
  for (const [criterion, score] of Object.entries(scores)) {
    if (score === undefined || score === null) {
      return res.status(400).json({
        error: `${criterion} score is required`,
      });
    }
    if (score < 0 || score > 100) {
      return res.status(400).json({
        error: `${criterion} score must be between 0 and 100`,
      });
    }
  }

  try {
    // Get submission using DataManager
    const submission = await dataManager.getSubmission(req.params.id);

    if (!submission) {
      return res.status(404).json({ error: "Submission not found" });
    }

    // Get problem scoring weights (or use defaults)
    const problemId = submission.problemId;
    const problems = await dataManager.loadProblems();
    const problem = problemId ? problems[problemId] : null;
    const weights = problem?.scoringWeights || {
      correctness: 40, // 40% weight
      performance: 30, // 30% weight
      codeQuality: 20, // 20% weight
      documentation: 10, // 10% weight
    };

    // Calculate weighted total score
    const weightedScore =
      (Number(correctness) * weights.correctness) / 100 +
      (Number(performance) * weights.performance) / 100 +
      (Number(codeQuality) * weights.codeQuality) / 100 +
      (Number(documentation) * weights.documentation) / 100;

    const judgeScore = {
      judgeId: req.user.id,
      judgeName: req.user.name,
      scores: {
        correctness: Number(correctness),
        performance: Number(performance),
        codeQuality: Number(codeQuality),
        documentation: Number(documentation),
      },
      weights: weights,
      totalScore: Math.round(weightedScore * 100) / 100, // Round to 2 decimal places
      comments: comments || "",
      submittedAt: new Date().toISOString(),
    };

    // Remove existing score from this judge
    if (!submission.judgeScores) submission.judgeScores = [];
    submission.judgeScores = submission.judgeScores.filter((s) => s.judgeId !== req.user.id);
    submission.judgeScores.push(judgeScore);

    // Calculate average judge score (handle both old and new score structures)
    if (submission.judgeScores.length > 0) {
      const validScores = submission.judgeScores.map((score) => {
        // If totalScore is null or missing, calculate it from nested scores and weights
        if (score.totalScore === null || score.totalScore === undefined) {
          if (score.scores && score.weights) {
            const weightedScore =
              (Number(score.scores.correctness || 0) * (score.weights.correctness || 0)) / 100 +
              (Number(score.scores.performance || 0) * (score.weights.performance || 0)) / 100 +
              (Number(score.scores.codeQuality || 0) * (score.weights.codeQuality || 0)) / 100 +
              (Number(score.scores.documentation || 0) * (score.weights.documentation || 0)) / 100;
            score.totalScore = Math.round(weightedScore * 100) / 100;
          } else {
            score.totalScore = 0; // Fallback if structure is invalid
          }
        }
        return score.totalScore;
      });

      const averageJudgeScore = validScores.reduce((sum, score) => sum + score, 0) / validScores.length;
      submission.averageJudgeScore = Math.round(averageJudgeScore * 100) / 100;
    }

    // Update submission using DataManager
    await dataManager.updateSubmission(submission.id, {
      judgeScores: submission.judgeScores,
      averageJudgeScore: submission.averageJudgeScore,
    });

    console.log(`✓ Judge score submitted by ${req.user.name} for submission ${submission.id}: ${judgeScore.totalScore}/100`);

    res.json({
      message: "Score submitted successfully",
      judgeScore,
      averageJudgeScore: submission.averageJudgeScore,
    });
  } catch (error) {
    console.error("Error submitting judge score:", error);
    res.status(500).json({ error: "Failed to submit score" });
  }
});

// Get default scoring rubric
app.get("/api/scoring/rubric", authenticate, async (req, res) => {
  if (req.user.role !== "judge") {
    return res.status(403).json({ error: "Only judges can view scoring rubric" });
  }

  const { problemId } = req.query;
  const data = await loadData();

  let weights = {
    correctness: 40,
    performance: 30,
    codeQuality: 20,
    documentation: 10,
  };

  if (problemId && data.problems[problemId]?.scoringWeights) {
    weights = data.problems[problemId].scoringWeights;
  }

  const rubric = {
    totalPoints: 100,
    criteria: {
      correctness: {
        name: "Correctness",
        weight: weights.correctness,
        description: "Does the solution produce correct results? Are all test cases passing?",
        levels: [
          { points: weights.correctness, name: "Excellent", description: "Perfect correctness, all test cases pass" },
          { points: Math.round(weights.correctness * 0.85), name: "Good", description: "Minor errors or edge cases missed" },
          { points: Math.round(weights.correctness * 0.7), name: "Fair", description: "Some incorrect results but core logic works" },
          { points: Math.round(weights.correctness * 0.5), name: "Poor", description: "Major correctness issues" },
          { points: 0, name: "Fail", description: "Solution doesn't work or produces wrong results" },
        ],
      },
      performance: {
        name: "Performance",
        weight: weights.performance,
        description: "How efficient is the solution? Does it meet performance requirements?",
        levels: [
          { points: weights.performance, name: "Excellent", description: "Excellent performance, beats baseline significantly" },
          { points: Math.round(weights.performance * 0.85), name: "Good", description: "Good performance, meets all requirements" },
          { points: Math.round(weights.performance * 0.7), name: "Fair", description: "Acceptable performance with minor issues" },
          { points: Math.round(weights.performance * 0.5), name: "Poor", description: "Performance issues but functional" },
          { points: 0, name: "Fail", description: "Poor performance, fails requirements" },
        ],
      },
      codeQuality: {
        name: "Code Quality",
        weight: weights.codeQuality,
        description: "Is the code well-written, readable, and maintainable?",
        levels: [
          { points: weights.codeQuality, name: "Excellent", description: "Exceptional code quality, best practices followed" },
          { points: Math.round(weights.codeQuality * 0.85), name: "Good", description: "Good code structure and readability" },
          { points: Math.round(weights.codeQuality * 0.7), name: "Fair", description: "Decent code with some improvements needed" },
          { points: Math.round(weights.codeQuality * 0.5), name: "Poor", description: "Poor code organization or style" },
          { points: 0, name: "Fail", description: "Very poor code quality" },
        ],
      },
      documentation: {
        name: "Documentation",
        weight: weights.documentation,
        description: "Is the solution well-documented with clear explanations?",
        levels: [
          { points: weights.documentation, name: "Excellent", description: "Excellent documentation and explanations" },
          { points: Math.round(weights.documentation * 0.85), name: "Good", description: "Good documentation covering key points" },
          { points: Math.round(weights.documentation * 0.7), name: "Fair", description: "Basic documentation present" },
          { points: Math.round(weights.documentation * 0.5), name: "Poor", description: "Minimal or unclear documentation" },
          { points: 0, name: "Fail", description: "No meaningful documentation" },
        ],
      },
    },
  };

  res.json(rubric);
});

// Get leaderboard for a specific problem
app.get("/api/problems/:problemId/leaderboard", async (req, res) => {
  const data = await loadData();
  const { problemId } = req.params;

  if (!data.problems[problemId]) {
    return res.status(404).json({ error: "Problem not found" });
  }

  const submissions = data.problems[problemId].submissions || [];

  const leaderboard = submissions
    .filter((s) => s.status === "evaluated")
    .map((submission) => {
      const avgJudgeScore =
        (submission.judgeScores || []).length > 0
          ? (() => {
              const validScores = submission.judgeScores.map((score) => {
                // Handle null totalScore by calculating from nested scores and weights
                if (score.totalScore === null || score.totalScore === undefined) {
                  if (score.scores && score.weights) {
                    const weightedScore =
                      (Number(score.scores.correctness || 0) * (score.weights.correctness || 0)) / 100 +
                      (Number(score.scores.performance || 0) * (score.weights.performance || 0)) / 100 +
                      (Number(score.scores.codeQuality || 0) * (score.weights.codeQuality || 0)) / 100 +
                      (Number(score.scores.documentation || 0) * (score.weights.documentation || 0)) / 100;
                    return Math.round(weightedScore * 100) / 100;
                  }
                  return 0;
                }
                return score.totalScore;
              });
              return validScores.reduce((sum, score) => sum + score, 0) / validScores.length;
            })()
          : 0;

      return {
        id: submission.id,
        problemId: submission.problemId,
        teamId: submission.teamId,
        teamName: submission.teamName,
        repoUrl: submission.repoUrl,
        autoScore: submission.autoScore || 0,
        judgeScore: Math.round(avgJudgeScore * 10) / 10,
        totalScore: Math.round(((submission.autoScore || 0) + avgJudgeScore) * 10) / 10,
        submittedAt: submission.submittedAt,
        judgeCount: (submission.judgeScores || []).length,
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore);

  res.json(leaderboard);
});

// Get leaderboard (legacy endpoint - combines all problems)
app.get("/api/leaderboard", async (req, res) => {
  try {
    const { problem } = req.query;

    let allSubmissions = [];

    if (problem) {
      // Get submissions for specific problem
      const submissions = await dataManager.getSubmissionsList();
      allSubmissions = submissions.filter((s) => s.problemId === problem);
    } else {
      // Get all submissions
      allSubmissions = await dataManager.getSubmissionsList();
    }

    const leaderboard = allSubmissions
      .filter((s) => s.status === "evaluated")
      .map((submission) => {
        const avgJudgeScore =
          (submission.judgeScores || []).length > 0
            ? (() => {
                const validScores = submission.judgeScores.map((score) => {
                  // Handle null totalScore by calculating from nested scores and weights
                  if (score.totalScore === null || score.totalScore === undefined) {
                    if (score.scores && score.weights) {
                      const weightedScore =
                        (Number(score.scores.correctness || 0) * (score.weights.correctness || 0)) / 100 +
                        (Number(score.scores.performance || 0) * (score.weights.performance || 0)) / 100 +
                        (Number(score.scores.codeQuality || 0) * (score.weights.codeQuality || 0)) / 100 +
                        (Number(score.scores.documentation || 0) * (score.weights.documentation || 0)) / 100;
                      return Math.round(weightedScore * 100) / 100;
                    }
                    return 0;
                  }
                  return score.totalScore;
                });
                return validScores.reduce((sum, score) => sum + score, 0) / validScores.length;
              })()
            : 0;

        return {
          id: submission.id,
          problemId: submission.problemId,
          teamId: submission.teamId,
          teamName: submission.teamName,
          repoUrl: submission.repoUrl,
          autoScore: submission.autoScore || 0,
          judgeScore: Math.round(avgJudgeScore * 10) / 10,
          totalScore: Math.round(((submission.autoScore || 0) + avgJudgeScore) * 10) / 10,
          submittedAt: submission.submittedAt,
          judgeCount: (submission.judgeScores || []).length,
        };
      })
      .sort((a, b) => b.totalScore - a.totalScore);

    res.json(leaderboard);
  } catch (error) {
    console.error("Error generating leaderboard:", error);
    res.status(500).json({ error: "Failed to generate leaderboard" });
  }
});

// Enhanced file browser for submission outputs
app.get("/api/submissions/:submissionId/files", authenticate, async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { path: requestedPath = "" } = req.query;

    // Check if submission exists
    const submission = await dataManager.getSubmission(submissionId);
    if (!submission) {
      return res.status(404).json({ error: "Submission not found" });
    }

    // Role-based access control
    if (req.user.role === "team" && submission.teamId !== req.user.id) {
      return res.status(403).json({ error: "Access denied" });
    }

    const files = await dataManager.getSubmissionOutputFiles(submissionId, requestedPath);

    res.json({
      submissionId,
      currentPath: requestedPath,
      jobId: submission.jobId,
      files,
    });
  } catch (error) {
    console.error("Error loading submission files:", error);
    res.status(500).json({ error: "Failed to load submission files" });
  }
});

// Get file content
app.get("/api/submissions/:submissionId/files/content", authenticate, async (req, res) => {
  try {
    const { submissionId } = req.params;
    const { filePath, download } = req.query;

    if (!filePath) {
      return res.status(400).json({ error: "filePath parameter is required" });
    }

    // Check if submission exists
    const submission = await dataManager.getSubmission(submissionId);
    if (!submission) {
      return res.status(404).json({ error: "Submission not found" });
    }

    // Role-based access control
    if (req.user.role === "team" && submission.teamId !== req.user.id) {
      return res.status(403).json({ error: "Access denied" });
    }

    if (download === "true") {
      // Handle file download
      const fullPath = path.join(__dirname, "data", "outputs", submissionId, filePath);
      res.download(fullPath, path.basename(filePath));
    } else {
      // Handle file content viewing
      const content = await dataManager.getFileContent(submissionId, filePath);
      res.json(content);
    }
  } catch (error) {
    console.error("Error loading file content:", error);
    res.status(404).json({ error: "File not found" });
  }
});

// File content endpoint
app.get("/api/files/content", authenticate, async (req, res) => {
  try {
    const { submissionId, filePath } = req.query;

    if (!submissionId || !filePath) {
      return res.status(400).json({ error: "submissionId and filePath are required" });
    }

    // Get submission to verify access
    const submission = await dataManager.getSubmission(submissionId);
    if (!submission) {
      return res.status(404).json({ error: "Submission not found" });
    }

    // Role-based access control
    if (req.user.role === "team" && submission.teamId !== req.user.id) {
      return res.status(403).json({ error: "Access denied" });
    }

    const content = await dataManager.getFileContent(submissionId, filePath);
    res.json(content);
  } catch (error) {
    console.error("Error loading file content:", error);
    res.status(404).json({ error: "File not found" });
  }
});

// Legacy GCS listing (kept for backward compatibility)
app.get("/api/gcs/list", authenticate, async (req, res) => {
  if (req.user.role !== "judge") {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    const { exec } = require("child_process");
    const { promisify } = require("util");
    const execAsync = promisify(exec);

    const bucketName = submissionMonitor.config.submissionResultsBucket;
    const { stdout } = await execAsync(`gsutil ls gs://${bucketName}/`);
    const files = stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim());

    res.json({
      bucket: `gs://${bucketName}/`,
      files: files,
    });
  } catch (error) {
    console.error("Error listing GCS bucket:", error.message);
    res.status(500).json({ error: "Failed to list bucket contents" });
  }
});

// Get baseline metrics for a specific problem
app.get("/api/problems/:problemId/baseline", async (req, res) => {
  const data = await loadData();
  const { problemId } = req.params;

  if (!data.problems[problemId]) {
    return res.status(404).json({ error: "Problem not found" });
  }

  res.json(data.problems[problemId].baselineMetrics);
});

// Get baseline metrics (legacy endpoint)
app.get("/api/baseline", async (req, res) => {
  const data = await loadData();
  const { problem } = req.query;

  if (problem && data.problems[problem]) {
    res.json(data.problems[problem].baselineMetrics);
  } else {
    // Default to DB optimization problem or legacy baseline
    res.json(data.problems["db-query-optimization"]?.baselineMetrics || data.baselineMetrics);
  }
});

// Get users (for admin)
app.get("/api/users", authenticate, async (req, res) => {
  if (req.user.role !== "judge") {
    return res.status(403).json({ error: "Access denied" });
  }

  const data = await loadData();
  const users = data.users.map((u) => ({ id: u.id, name: u.name, role: u.role }));
  res.json(users);
});

// Monitoring control endpoints
app.get("/api/monitoring/status", authenticate, async (req, res) => {
  if (req.user.role !== "judge") {
    return res.status(403).json({ error: "Only judges can view monitoring status" });
  }

  const status = submissionMonitor.getMonitoringStatus();
  res.json(status);
});

app.post("/api/monitoring/trigger", authenticate, async (req, res) => {
  if (req.user.role !== "judge") {
    return res.status(403).json({ error: "Only judges can trigger monitoring" });
  }

  try {
    const hasUpdates = await submissionMonitor.triggerMonitoring(loadData, saveData, calculateScore);
    res.json({
      success: true,
      message: "Monitoring cycle completed",
      hasUpdates: hasUpdates,
    });
  } catch (error) {
    console.error("Error triggering monitoring:", error);
    res.status(500).json({
      error: "Failed to trigger monitoring",
      details: error.message,
    });
  }
});

app.get("/api/monitoring/jobs/:jobId", authenticate, async (req, res) => {
  if (req.user.role !== "judge") {
    return res.status(403).json({ error: "Only judges can view job details" });
  }

  try {
    const { jobId } = req.params;
    const { problemId } = req.query;

    const results = await submissionMonitor.fetchSubmissionResults(jobId, problemId);

    if (results) {
      res.json({
        jobId: jobId,
        problemId: problemId,
        status: results.status || "completed",
        results: results,
      });
    } else {
      res.json({
        jobId: jobId,
        problemId: problemId,
        status: "not_found",
        results: null,
      });
    }
  } catch (error) {
    console.error("Error fetching job results:", error);
    res.status(500).json({
      error: "Failed to fetch job results",
      details: error.message,
    });
  }
});

// Serve main page
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "public", "index.html"));
});

// Error handling
app.use((error, req, res, next) => {
  console.error("Server error:", error);
  res.status(500).json({ error: "Internal server error" });
});

// Start server
async function startServer() {
  try {
    // Log configuration for debugging
    console.log("Server configuration:");
    console.log(`  BASELINE_BUCKET: ${process.env.BASELINE_BUCKET}`);
    console.log(`  GET_LATEST_BASELINE_SCRIPT: ${process.env.GET_LATEST_BASELINE_SCRIPT}`);
    console.log(`  CREATE_JOB_SCRIPT: ${process.env.CREATE_JOB_SCRIPT}`);
    console.log(`  GCP_CREDENTIALS_JSON_PATH: ${process.env.GCP_CREDENTIALS_JSON_PATH}`);

    // Initialize data
    const data = await loadData();
    await saveData(data);

    // Initialize submission results monitor
    await submissionMonitor.initialize();

    // Fetch baseline metrics in background for DB optimization problem
    fetchBaselineMetrics("db-query-optimization").catch((error) => {
      console.error("Failed to fetch baseline metrics for DB optimization:", error.message);
    });

    // Start job monitoring using the new module
    submissionMonitor.startMonitoring(loadData, saveData, calculateScore);

    app.listen(PORT, () => {
      console.log(`✓ Contest Management Server running on http://localhost:${PORT}`);
      console.log("=== Default Login Credentials ===");
      console.log("Host: host/host123");
      console.log("Judges: judge1/judge123, judge2/judge123");
      console.log("Teams: team1/team123, team2/team123, team3/team123");
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
