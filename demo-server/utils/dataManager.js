const fs = require("fs").promises;
const path = require("path");

class DataManager {
  constructor(dataDir = "./data") {
    this.dataDir = dataDir;
    this.users = null;
    this.problems = null;
    this.baselines = null;
    this.submissions = null;
  }

  async loadUsers() {
    if (!this.users) {
      try {
        const data = await fs.readFile(path.join(this.dataDir, "users.json"), "utf8");
        this.users = JSON.parse(data).users;
      } catch (error) {
        console.log("No users file found, creating default users");
        this.users = [
          { id: "host", name: "Contest Host", role: "host", password: "host123", createdAt: new Date().toISOString() },
          { id: "judge1", name: "Judge Alice", role: "judge", password: "judge123", createdAt: new Date().toISOString() },
          { id: "judge2", name: "Judge Bob", role: "judge", password: "judge123", createdAt: new Date().toISOString() },
          { id: "team1", name: "Team Alpha", role: "team", password: "team123", createdAt: new Date().toISOString() },
          { id: "team2", name: "Team Beta", role: "team", password: "team123", createdAt: new Date().toISOString() },
          { id: "team3", name: "Team Gamma", role: "team", password: "team123", createdAt: new Date().toISOString() },
        ];
        await this.saveUsers();
      }
    }
    return this.users;
  }

  async saveUsers() {
    await fs.writeFile(path.join(this.dataDir, "users.json"), JSON.stringify({ users: this.users }, null, 2));
  }

  async loadProblems() {
    if (!this.problems) {
      try {
        const data = await fs.readFile(path.join(this.dataDir, "problems.json"), "utf8");
        this.problems = JSON.parse(data);
      } catch (error) {
        console.log("No problems file found, creating default problems");
        this.problems = {};
        await this.saveProblems();
      }
    }
    return this.problems;
  }

  async saveProblems() {
    await fs.writeFile(path.join(this.dataDir, "problems.json"), JSON.stringify(this.problems, null, 2));
  }

  async loadBaselines() {
    if (!this.baselines) {
      try {
        const data = await fs.readFile(path.join(this.dataDir, "baselines.json"), "utf8");
        this.baselines = JSON.parse(data);
      } catch (error) {
        console.log("No baselines file found, creating empty baselines");
        this.baselines = {};
        await this.saveBaselines();
      }
    }
    return this.baselines;
  }

  async saveBaselines() {
    await fs.writeFile(path.join(this.dataDir, "baselines.json"), JSON.stringify(this.baselines, null, 2));
  }

  async loadSubmissions() {
    if (!this.submissions) {
      try {
        const data = await fs.readFile(path.join(this.dataDir, "submissions.json"), "utf8");
        this.submissions = JSON.parse(data);
      } catch (error) {
        console.log("No submissions file found, creating empty submissions");
        this.submissions = {};
        await this.saveSubmissions();
      }
    }
    return this.submissions;
  }

  async saveSubmissions() {
    await fs.writeFile(path.join(this.dataDir, "submissions.json"), JSON.stringify(this.submissions, null, 2));
  }

  // Helper methods for submissions
  async getSubmissionsList() {
    const submissions = await this.loadSubmissions();
    return Object.values(submissions);
  }

  async getSubmission(submissionId) {
    const submissions = await this.loadSubmissions();
    return submissions[submissionId];
  }

  async addSubmission(submission) {
    const submissions = await this.loadSubmissions();
    submissions[submission.id] = submission;
    await this.saveSubmissions();
    return submission;
  }

  async updateSubmission(submissionId, updates) {
    const submissions = await this.loadSubmissions();
    if (submissions[submissionId]) {
      submissions[submissionId] = { ...submissions[submissionId], ...updates };
      await this.saveSubmissions();
      return submissions[submissionId];
    }
    return null;
  }

  // Helper methods for problems
  async getProblemsArray() {
    const problems = await this.loadProblems();
    return Object.values(problems).map((problem) => ({
      ...problem,
      submissionCount: this.getSubmissionCountForProblem(problem.id),
      evaluatedCount: this.getEvaluatedCountForProblem(problem.id),
    }));
  }

  async getSubmissionCountForProblem(problemId) {
    const submissions = await this.getSubmissionsList();
    return submissions.filter((s) => s.problemId === problemId).length;
  }

  async getEvaluatedCountForProblem(problemId) {
    const submissions = await this.getSubmissionsList();
    return submissions.filter((s) => s.problemId === problemId && s.status === "evaluated").length;
  }

  // File output operations
  async getSubmissionOutputFiles(submissionId, requestedPath = "") {
    const outputDir = path.join(this.dataDir, "outputs", submissionId);
    const targetDir = requestedPath ? path.join(outputDir, requestedPath) : outputDir;

    try {
      await fs.access(targetDir);
      return await this.getDirectoryContents(targetDir, requestedPath);
    } catch (error) {
      return [];
    }
  }

  async getDirectoryContents(dirPath, relativePath = "") {
    const items = [];
    const entries = await fs.readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      const itemPath = path.join(relativePath, entry.name);

      items.push({
        name: entry.name,
        path: itemPath,
        isDirectory: entry.isDirectory(),
        size: entry.isFile() ? (await fs.stat(fullPath)).size : 0,
      });
    }

    return items.sort((a, b) => {
      if (a.isDirectory !== b.isDirectory) {
        return a.isDirectory ? -1 : 1;
      }
      return a.name.localeCompare(b.name);
    });
  }

  async getFileContent(submissionId, filePath) {
    const fullPath = path.join(this.dataDir, "outputs", submissionId, filePath);

    try {
      const stats = await fs.stat(fullPath);
      if (stats.isDirectory()) {
        throw new Error("Path is a directory");
      }

      // Check if file is likely text
      const isText = this.isTextFile(filePath);

      if (isText && stats.size < 1024 * 1024) {
        // 1MB limit for text files
        const content = await fs.readFile(fullPath, "utf8");
        return { content, isText: true };
      } else {
        return {
          isText: false,
          downloadUrl: `/api/submissions/${submissionId}/files/download?filePath=${encodeURIComponent(filePath)}`,
        };
      }
    } catch (error) {
      throw new Error(`File not found: ${error.message}`);
    }
  }

  async createSubmission(submissionData) {
    try {
      const submissions = await this.loadSubmissions();

      // Generate unique ID
      const submissionId = `sub_${Date.now()}`;
      const submission = {
        id: submissionId,
        ...submissionData,
        submittedAt: new Date().toISOString(),
        autoScore: null,
        judgeScores: [],
        metrics: null,
        status: submissionData.status || "submitted",
      };

      submissions[submissionId] = submission;
      await this.saveSubmissions();

      // Create output directory for this submission
      const outputDir = path.join(this.dataDir, "outputs", submissionId);
      try {
        await fs.mkdir(outputDir, { recursive: true });
      } catch (error) {
        // Directory might already exist, ignore error
      }

      return submission;
    } catch (error) {
      console.error("Error creating submission:", error);
      throw error;
    }
  }

  async updateSubmission(submissionId, updates) {
    try {
      const submissions = await this.loadSubmissions();

      if (!submissions[submissionId]) {
        throw new Error("Submission not found");
      }

      submissions[submissionId] = { ...submissions[submissionId], ...updates };
      await this.saveSubmissions();

      return submissions[submissionId];
    } catch (error) {
      console.error("Error updating submission:", error);
      throw error;
    }
  }

  async getSubmissionsByTeam(teamId, problemId = null) {
    try {
      const submissions = await this.loadSubmissions();
      let filtered = Object.values(submissions).filter((sub) => sub.teamId === teamId);

      if (problemId) {
        filtered = filtered.filter((sub) => sub.problemId === problemId);
      }

      return filtered.sort((a, b) => new Date(b.submittedAt) - new Date(a.submittedAt));
    } catch (error) {
      console.error("Error getting submissions by team:", error);
      throw error;
    }
  }

  isTextFile(filePath) {
    const textExtensions = [
      ".txt",
      ".log",
      ".json",
      ".csv",
      ".tsv",
      ".sql",
      ".md",
      ".yml",
      ".yaml",
      ".js",
      ".py",
      ".java",
      ".cpp",
      ".c",
      ".h",
      ".go",
      ".rs",
      ".rb",
      ".php",
      ".html",
      ".htm",
      ".css",
      ".xml",
      ".properties",
      ".conf",
      ".config",
    ];

    const ext = path.extname(filePath).toLowerCase();
    return textExtensions.includes(ext);
  }

  // Initialize directories
  async ensureDirectories() {
    const directories = [this.dataDir, path.join(this.dataDir, "outputs"), path.join(this.dataDir, "submissions"), path.join(this.dataDir, "problems")];

    for (const dir of directories) {
      try {
        await fs.access(dir);
      } catch (error) {
        await fs.mkdir(dir, { recursive: true });
      }
    }
  }
}

module.exports = DataManager;
