require("dotenv").config();
const express = require("express");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;
const CLOUD_RUN_API_URL = process.env.CLOUD_RUN_API_URL || "https://eval-api-gateway-337494334022.us-central1.run.app";
const GCS_BUCKET_NAME = process.env.GCS_BUCKET_NAME || "eval-baseline-outputs-20250928";
const GCS_BUCKET_URI = process.env.GCS_BUCKET_URI || "gs://eval-baseline-outputs-20250928";

// Middleware
app.use(express.json());
app.use(express.static("public"));

// Data persistence
const DATA_FILE = path.join(__dirname, "data.json");

// Initialize data structure
const initData = {
  users: [
    { id: "judge1", name: "Judge Alice", role: "judge", password: "judge123" },
    { id: "judge2", name: "Judge Bob", role: "judge", password: "judge123" },
    { id: "team1", name: "Team Alpha", role: "team", password: "team123" },
    { id: "team2", name: "Team Beta", role: "team", password: "team123" },
    { id: "team3", name: "Team Gamma", role: "team", password: "team123" },
  ],
  submissions: [],
  evaluations: [],
  baselineMetrics: null,
  jobStatuses: {},
};

// Data persistence helpers
async function loadData() {
  try {
    const data = await fs.readFile(DATA_FILE, "utf8");
    return JSON.parse(data);
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
async function fetchBaselineMetrics() {
  const data = await loadData();

  if (data.baselineMetrics) {
    console.log("Using cached baseline metrics");
    return data.baselineMetrics;
  }

  try {
    console.log("Fetching baseline metrics from Cloud Run...");

    // Create baseline job
    const jobResponse = await axios.post(`${CLOUD_RUN_API_URL}/api/v1/jobs`, {
      type: "baseline",
      config: {
        users_count: 50000,
        devices_count: 50000,
        events_count: 1000000,
      },
    });

    const jobId = jobResponse.data.job_id;
    console.log(`Baseline job created: ${jobId}`);

    // Poll for completion
    let completed = false;
    let attempts = 0;
    const maxAttempts = 60; // Wait up to 30 minutes

    while (!completed && attempts < maxAttempts) {
      await new Promise((resolve) => setTimeout(resolve, 30000)); // Wait 30 seconds

      try {
        const statusResponse = await axios.get(`${CLOUD_RUN_API_URL}/api/v1/jobs/${jobId}/status`);
        console.log(`Baseline job status: ${statusResponse.data.status}`);

        if (statusResponse.data.status === "completed") {
          const resultsResponse = await axios.get(`${CLOUD_RUN_API_URL}/api/v1/jobs/${jobId}/results`);
          data.baselineMetrics = resultsResponse.data.summary;
          await saveData(data);
          console.log("Baseline metrics fetched and cached");
          return data.baselineMetrics;
        } else if (statusResponse.data.status === "failed") {
          console.error("Baseline job failed");
          break;
        }
      } catch (error) {
        console.error("Error checking baseline job status:", error.message);
      }

      attempts++;
    }

    console.error("Failed to fetch baseline metrics");
    return null;
  } catch (error) {
    console.error("Error fetching baseline metrics:", error.message);
    return null;
  }
}

// Job status monitoring
async function monitorJobStatuses() {
  const data = await loadData();

  for (const [jobId, status] of Object.entries(data.jobStatuses)) {
    if (status === "running" || status === "queued") {
      try {
        const statusResponse = await axios.get(`${CLOUD_RUN_API_URL}/api/v1/jobs/${jobId}/status`);

        if (statusResponse.data.status === "completed") {
          // Fetch results and update submission
          const resultsResponse = await axios.get(`${CLOUD_RUN_API_URL}/api/v1/jobs/${jobId}/results`);

          const submission = data.submissions.find((s) => s.jobId === jobId);
          if (submission) {
            submission.metrics = resultsResponse.data.summary;
            submission.status = "evaluated";
            submission.autoScore = calculateScore(submission.metrics, data.baselineMetrics);
            submission.completedAt = new Date().toISOString();
          }

          data.jobStatuses[jobId] = "completed";
          await saveData(data);
          console.log(`Job ${jobId} completed and results updated`);
        } else if (statusResponse.data.status === "failed") {
          const submission = data.submissions.find((s) => s.jobId === jobId);
          if (submission) {
            submission.status = "failed";
            submission.completedAt = new Date().toISOString();
          }

          data.jobStatuses[jobId] = "failed";
          await saveData(data);
          console.log(`Job ${jobId} failed`);
        }
      } catch (error) {
        console.error(`Error monitoring job ${jobId}:`, error.message);
      }
    }
  }
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

// Authentication
app.post("/api/auth", async (req, res) => {
  const { username, password } = req.body;
  const data = await loadData();

  const user = data.users.find((u) => u.id === username && u.password === password);
  if (!user) {
    return res.status(401).json({ error: "Invalid credentials" });
  }

  res.json({ user: { id: user.id, name: user.name, role: user.role } });
});

// Submit repo for evaluation
app.post("/api/submissions", authenticate, async (req, res) => {
  const { repo_url } = req.body;

  if (req.user.role !== "team") {
    return res.status(403).json({ error: "Only teams can submit repositories" });
  }

  if (!repo_url) {
    return res.status(400).json({ error: "repo_url is required" });
  }

  try {
    const data = await loadData();

    // Create submission job
    const jobResponse = await axios.post(`${CLOUD_RUN_API_URL}/api/v1/jobs`, {
      type: "submission",
      repo_url: repo_url,
      config: {
        timeout: 600000, // 10 minutes
        exec_per_query: 3,
      },
    });

    const submission = {
      id: `sub_${Date.now()}`,
      teamId: req.user.id,
      teamName: req.user.name,
      repoUrl: repo_url,
      jobId: jobResponse.data.job_id,
      status: "evaluating", // evaluating, evaluated, failed
      submittedAt: new Date().toISOString(),
      autoScore: null,
      judgeScores: [],
      metrics: null,
    };

    data.submissions.push(submission);
    data.jobStatuses[jobResponse.data.job_id] = "queued";
    await saveData(data);

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

// Get submissions
app.get("/api/submissions", async (req, res) => {
  const data = await loadData();
  const { team } = req.query;

  let submissions = data.submissions;

  if (team) {
    submissions = submissions.filter((s) => s.teamId === team);
  }

  res.json(submissions);
});

// Get submission by ID
app.get("/api/submissions/:id", async (req, res) => {
  const data = await loadData();
  const submission = data.submissions.find((s) => s.id === req.params.id);

  if (!submission) {
    return res.status(404).json({ error: "Submission not found" });
  }

  res.json(submission);
});

// Judge submission
app.post("/api/submissions/:id/judge", authenticate, async (req, res) => {
  const { criteria1, criteria2, criteria3 } = req.body;

  if (req.user.role !== "judge") {
    return res.status(403).json({ error: "Only judges can score submissions" });
  }

  const data = await loadData();
  const submission = data.submissions.find((s) => s.id === req.params.id);

  if (!submission) {
    return res.status(404).json({ error: "Submission not found" });
  }

  const judgeScore = {
    judgeId: req.user.id,
    judgeName: req.user.name,
    criteria1: Number(criteria1) || 0,
    criteria2: Number(criteria2) || 0,
    criteria3: Number(criteria3) || 0,
    totalScore: (Number(criteria1) || 0) + (Number(criteria2) || 0) + (Number(criteria3) || 0),
    submittedAt: new Date().toISOString(),
  };

  // Remove existing score from this judge
  submission.judgeScores = submission.judgeScores.filter((s) => s.judgeId !== req.user.id);
  submission.judgeScores.push(judgeScore);

  await saveData(data);

  res.json({ message: "Score submitted successfully", judgeScore });
});

// Get leaderboard
app.get("/api/leaderboard", async (req, res) => {
  const data = await loadData();

  const leaderboard = data.submissions
    .filter((s) => s.status === "evaluated")
    .map((submission) => {
      const avgJudgeScore = submission.judgeScores.length > 0 ? submission.judgeScores.reduce((sum, score) => sum + score.totalScore, 0) / submission.judgeScores.length : 0;

      return {
        id: submission.id,
        teamId: submission.teamId,
        teamName: submission.teamName,
        repoUrl: submission.repoUrl,
        autoScore: submission.autoScore || 0,
        judgeScore: Math.round(avgJudgeScore * 10) / 10,
        totalScore: Math.round(((submission.autoScore || 0) + avgJudgeScore) * 10) / 10,
        submittedAt: submission.submittedAt,
        judgeCount: submission.judgeScores.length,
      };
    })
    .sort((a, b) => b.totalScore - a.totalScore);

  res.json(leaderboard);
});

// Get GCS bucket contents
app.get("/api/gcs/list", authenticate, async (req, res) => {
  if (req.user.role !== "judge") {
    return res.status(403).json({ error: "Access denied" });
  }

  try {
    const { exec } = require("child_process");
    const { promisify } = require("util");
    const execAsync = promisify(exec);

    const { stdout } = await execAsync(`gsutil ls ${GCS_BUCKET_URI}/`);
    const files = stdout
      .trim()
      .split("\n")
      .filter((line) => line.trim());

    res.json({
      bucket: GCS_BUCKET_URI,
      files: files,
    });
  } catch (error) {
    console.error("Error listing GCS bucket:", error.message);
    res.status(500).json({ error: "Failed to list bucket contents" });
  }
});

// Get baseline metrics
app.get("/api/baseline", async (req, res) => {
  const data = await loadData();
  res.json(data.baselineMetrics);
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
    // Initialize data
    const data = await loadData();
    await saveData(data);

    // Fetch baseline metrics in background
    fetchBaselineMetrics().catch((error) => {
      console.error("Failed to fetch baseline metrics:", error.message);
    });

    // Start job monitoring
    setInterval(monitorJobStatuses, 60000); // Check every minute

    app.listen(PORT, () => {
      console.log(`Judge server running on http://localhost:${PORT}`);
      console.log("Default credentials:");
      console.log("Judges: judge1/judge123, judge2/judge123");
      console.log("Teams: team1/team123, team2/team123, team3/team123");
    });
  } catch (error) {
    console.error("Failed to start server:", error);
    process.exit(1);
  }
}

startServer();
