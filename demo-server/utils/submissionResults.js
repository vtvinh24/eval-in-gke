/**
 * Submission Results Module
 *
 * This module handles fetching submission evaluation results from GCS buckets,
 * monitoring job statuses, and processing submission metrics.
 *
 * Features:
 * - Async polling of GCS buckets for submission results
 * - Job status monitoring with automatic status updates
 * - Result processing and scoring integration
 * - Error handling and retry logic
 * - Configurable monitoring intervals
 */

const { exec } = require("child_process");
const { promisify } = require("util");
const fs = require("fs").promises;
const path = require("path");

const execAsync = promisify(exec);

class SubmissionResultsMonitor {
  constructor(config = {}) {
    this.config = {
      submissionResultsBucket: config.submissionResultsBucket || process.env.SUBMISSION_RESULTS_BUCKET || process.env.BASELINE_BUCKET || "eval-artifacts-hackathon-demo-473203",
      summaryFile: config.summaryFile || process.env.SUBMISSION_SUMMARY_FILE || "summary.json",
      credentialsPath: config.credentialsPath || process.env.GCP_CREDENTIALS_JSON_PATH,
      monitorInterval: config.monitorInterval || parseInt(process.env.JOB_MONITOR_INTERVAL_MS) || 30000,
      maxRetries: config.maxRetries || 5,
      debug: config.debug || false,
      ...config,
    };

    this.isMonitoring = false;
    this.monitoringInterval = null;
  }

  /**
   * Initialize the monitoring system
   */
  async initialize() {
    if (this.config.debug) {
      console.log("=== Submission Results Monitor Configuration ===");
      console.log(`  Bucket: ${this.config.submissionResultsBucket}`);
      console.log(`  Summary File: ${this.config.summaryFile}`);
      console.log(`  Monitor Interval: ${this.config.monitorInterval}ms`);
      console.log(`  Max Retries: ${this.config.maxRetries}`);
      console.log(`  Credentials Path: ${this.config.credentialsPath || "default"}`);
      console.log("==============================================");
    }

    // Validate GCS access
    try {
      await this.validateGCSAccess();
      console.log("✓ GCS access validated");
    } catch (error) {
      console.warn("⚠ GCS access validation failed:", error.message);
    }
  }

  /**
   * Validate GCS access by testing bucket connectivity
   */
  async validateGCSAccess() {
    const env = this.getGCPEnvironment();
    const { stdout } = await execAsync(`gsutil ls gs://${this.config.submissionResultsBucket}/ | head -1`, { env });
    return stdout.trim().length > 0;
  }

  /**
   * Get GCP environment variables for command execution
   */
  getGCPEnvironment() {
    const env = { ...process.env };

    if (this.config.credentialsPath) {
      const fullCredentialsPath = path.resolve(process.cwd(), this.config.credentialsPath);
      try {
        require("fs").accessSync(fullCredentialsPath);
        env.GOOGLE_APPLICATION_CREDENTIALS = fullCredentialsPath;
      } catch (error) {
        if (this.config.debug) {
          console.log(`GCP credentials file not found at ${fullCredentialsPath}, using default authentication`);
        }
      }
    }

    return env;
  }

  /**
   * Fetch submission results from GCS for a specific job
   * @param {string} jobId - The job ID to fetch results for
   * @param {string} problemId - The problem ID (for logging/organization)
   * @returns {Object|null} The submission results or null if not available
   */
  async fetchSubmissionResults(jobId, problemId = null) {
    try {
      const env = this.getGCPEnvironment();
      const bucketName = this.config.submissionResultsBucket;
      const summaryFile = this.config.summaryFile;

      if (this.config.debug) {
        console.log(`Checking for submission results: gs://${bucketName}/${jobId}/${summaryFile}`);
      }

      // First, check if the job directory exists and list its contents
      let jobDirectoryExists = false;
      try {
        const { stdout: listOutput } = await execAsync(`gsutil ls gs://${bucketName}/${jobId}/ 2>/dev/null`, { env });
        jobDirectoryExists = listOutput.trim().length > 0;

        if (this.config.debug && jobDirectoryExists) {
          console.log(`Job ${jobId} directory contents:\n${listOutput}`);
        }
      } catch (error) {
        if (this.config.debug) {
          console.log(`Job ${jobId} directory not found or empty`);
        }
        return null;
      }

      if (!jobDirectoryExists) {
        return null;
      }

      // Try to download the summary.json file
      const summaryUrl = `gs://${bucketName}/${jobId}/${summaryFile}`;
      try {
        const { stdout: summaryJson } = await execAsync(`gsutil cat "${summaryUrl}" 2>/dev/null`, { env });

        if (summaryJson.trim()) {
          const rawResults = JSON.parse(summaryJson);

          // Process the results to ensure compatibility with scoring
          const processedResults = this.processSubmissionMetrics(rawResults);

          if (this.config.debug) {
            console.log(`✓ Successfully fetched submission results for job ${jobId}`);
            console.log(`  Results include ${Object.keys(processedResults.queries || {}).length} queries`);
          }

          return processedResults;
        }
      } catch (error) {
        if (this.config.debug) {
          console.log(`Summary file not yet available for job ${jobId}: ${error.message}`);
        }
      }

      // If summary.json not available, check for other result files to determine job status
      try {
        const { stdout: rawFiles } = await execAsync(`gsutil ls gs://${bucketName}/${jobId}/**/*.log 2>/dev/null | head -5`, { env });
        if (rawFiles.trim()) {
          if (this.config.debug) {
            console.log(`Job ${jobId} has log files but summary.json not ready yet`);
          }
          return { status: "processing", message: "Job completed, results being processed" };
        }
      } catch (error) {
        // No log files yet, job might still be running
      }

      return null;
    } catch (error) {
      console.error(`Error fetching submission results for job ${jobId}:`, error.message);
      return null;
    }
  }

  /**
   * Process submission metrics to add computed fields and ensure compatibility
   * @param {Object} rawMetrics - Raw metrics from GCS
   * @returns {Object} Processed metrics with additional computed fields
   */
  processSubmissionMetrics(rawMetrics) {
    const processedMetrics = { ...rawMetrics };

    // Add average times to each query for compatibility with the scoring function
    if (processedMetrics.queries) {
      Object.keys(processedMetrics.queries).forEach((queryId) => {
        const query = processedMetrics.queries[queryId];

        if (query.status === "success" && query.runs && query.runs.length > 0) {
          const validTimes = query.runs.filter((run) => run.status === "success" && typeof run.time === "number").map((run) => run.time);

          if (validTimes.length > 0) {
            query.avg_time = validTimes.reduce((sum, time) => sum + time, 0) / validTimes.length;
            query.min_time = Math.min(...validTimes);
            query.max_time = Math.max(...validTimes);
            query.success_rate = validTimes.length / query.runs.length;
          }

          // Add correctness check (based on successful runs)
          query.correctness_check = query.runs.every((run) => run.status === "success");
        } else {
          // Handle failed queries
          query.avg_time = null;
          query.min_time = null;
          query.max_time = null;
          query.success_rate = 0;
          query.correctness_check = false;
        }
      });
    }

    // Add overall statistics
    if (processedMetrics.queries) {
      const queryStats = Object.values(processedMetrics.queries);
      processedMetrics.overall = {
        total_queries: queryStats.length,
        successful_queries: queryStats.filter((q) => q.correctness_check).length,
        overall_success_rate: queryStats.length > 0 ? queryStats.filter((q) => q.correctness_check).length / queryStats.length : 0,
        avg_execution_time: this.calculateOverallAverageTime(queryStats),
      };
    }

    return processedMetrics;
  }

  /**
   * Calculate overall average execution time across all successful queries
   */
  calculateOverallAverageTime(queryStats) {
    const validTimes = queryStats.filter((q) => q.avg_time !== null && typeof q.avg_time === "number").map((q) => q.avg_time);

    return validTimes.length > 0 ? validTimes.reduce((sum, time) => sum + time, 0) / validTimes.length : null;
  }

  /**
   * Monitor job statuses across all problems and update submission data
   * @param {Function} loadDataFn - Function to load current data
   * @param {Function} saveDataFn - Function to save updated data
   * @param {Function} calculateScoreFn - Function to calculate submission scores
   */
  async monitorJobStatuses(loadDataFn, saveDataFn, calculateScoreFn) {
    if (!loadDataFn || !saveDataFn) {
      throw new Error("loadDataFn and saveDataFn are required for monitoring");
    }

    const data = await loadDataFn();
    let hasUpdates = false;

    if (this.config.debug) {
      console.log("Starting job status monitoring cycle...");
    }

    // Monitor jobs across all problems
    for (const [problemId, problem] of Object.entries(data.problems || {})) {
      const runningJobs = Object.entries(problem.jobStatuses || {}).filter(([jobId, status]) => status === "running" || status === "queued" || status === "processing");

      if (runningJobs.length > 0 && this.config.debug) {
        console.log(`Monitoring ${runningJobs.length} jobs for problem ${problemId}`);
      }

      for (const [jobId, status] of runningJobs) {
        try {
          if (this.config.debug) {
            console.log(`Checking job ${jobId} (${status}) for problem ${problemId}`);
          }

          // Try to fetch results directly from GCS
          const resultsData = await this.fetchSubmissionResults(jobId, problemId);

          if (resultsData && resultsData.queries) {
            // Results found in GCS, job is completed
            console.log(`✓ Job ${jobId} results found in GCS for problem ${problemId}`);

            const submission = problem.submissions.find((s) => s.jobId === jobId);
            if (submission) {
              submission.metrics = resultsData;
              submission.status = "evaluated";
              submission.completedAt = new Date().toISOString();

              // Calculate score if function provided
              if (calculateScoreFn && problem.baselineMetrics) {
                submission.autoScore = calculateScoreFn(submission.metrics, problem.baselineMetrics);
              }

              console.log(`✓ Submission ${submission.id} updated: auto score = ${submission.autoScore || "N/A"}`);
            } else {
              console.log(`⚠ No submission found for job ${jobId}`);
            }

            problem.jobStatuses[jobId] = "completed";
            hasUpdates = true;
          } else if (resultsData && resultsData.status === "processing") {
            // Job completed but results still being processed
            if (this.config.debug) {
              console.log(`⏳ Job ${jobId} completed but results still processing`);
            }
            if (problem.jobStatuses[jobId] !== "processing") {
              problem.jobStatuses[jobId] = "processing";
              hasUpdates = true;
            }
          } else {
            // No results found yet, increment error count for eventual timeout
            const submission = problem.submissions.find((s) => s.jobId === jobId);
            if (submission) {
              submission.errorCount = (submission.errorCount || 0) + 1;

              if (submission.errorCount >= this.config.maxRetries) {
                console.log(`❌ Job ${jobId} marked as failed after ${submission.errorCount} failed checks`);
                submission.status = "failed";
                submission.completedAt = new Date().toISOString();
                problem.jobStatuses[jobId] = "failed";
                hasUpdates = true;
              } else if (this.config.debug) {
                console.log(`⏳ Job ${jobId} still ${status}, check ${submission.errorCount}/${this.config.maxRetries}`);
              }
            }
          }
        } catch (error) {
          console.error(`❌ Error monitoring job ${jobId} for problem ${problemId}:`, error.message);

          // Increment error count for submission
          const submission = problem.submissions.find((s) => s.jobId === jobId);
          if (submission) {
            submission.errorCount = (submission.errorCount || 0) + 1;
            if (submission.errorCount >= this.config.maxRetries) {
              console.log(`❌ Job ${jobId} marked as failed after ${submission.errorCount} errors`);
              submission.status = "failed";
              submission.completedAt = new Date().toISOString();
              problem.jobStatuses[jobId] = "failed";
              hasUpdates = true;
            }
          }
        }
      }
    }

    // Handle legacy job monitoring for backward compatibility
    if (data.jobStatuses) {
      const legacyRunningJobs = Object.entries(data.jobStatuses).filter(([jobId, status]) => status === "running" || status === "queued" || status === "processing");

      for (const [jobId, status] of legacyRunningJobs) {
        try {
          if (this.config.debug) {
            console.log(`Checking legacy job ${jobId} (${status})`);
          }

          const resultsData = await this.fetchSubmissionResults(jobId);

          if (resultsData && resultsData.queries) {
            console.log(`✓ Legacy job ${jobId} results found in GCS`);

            const submission = data.submissions?.find((s) => s.jobId === jobId);
            if (submission) {
              submission.metrics = resultsData;
              submission.status = "evaluated";
              submission.completedAt = new Date().toISOString();

              if (calculateScoreFn && data.baselineMetrics) {
                submission.autoScore = calculateScoreFn(submission.metrics, data.baselineMetrics);
              }
            }

            data.jobStatuses[jobId] = "completed";
            hasUpdates = true;
          }
        } catch (error) {
          console.error(`❌ Error monitoring legacy job ${jobId}:`, error.message);
        }
      }
    }

    // Save data if there were updates
    if (hasUpdates) {
      await saveDataFn(data);
      if (this.config.debug) {
        console.log("✓ Job monitoring updates saved");
      }
    }

    if (this.config.debug) {
      console.log("Job status monitoring cycle completed");
    }

    return hasUpdates;
  }

  /**
   * Start automatic monitoring with the configured interval
   * @param {Function} loadDataFn - Function to load current data
   * @param {Function} saveDataFn - Function to save updated data
   * @param {Function} calculateScoreFn - Function to calculate submission scores
   */
  startMonitoring(loadDataFn, saveDataFn, calculateScoreFn) {
    if (this.isMonitoring) {
      console.warn("Monitoring is already running");
      return;
    }

    console.log(`Starting submission results monitoring (interval: ${this.config.monitorInterval}ms)`);

    // Run once immediately
    this.monitorJobStatuses(loadDataFn, saveDataFn, calculateScoreFn).catch((error) => {
      console.error("Error in initial monitoring run:", error);
    });

    // Set up interval monitoring
    this.monitoringInterval = setInterval(() => {
      this.monitorJobStatuses(loadDataFn, saveDataFn, calculateScoreFn).catch((error) => {
        console.error("Error in monitoring cycle:", error);
      });
    }, this.config.monitorInterval);

    this.isMonitoring = true;
  }

  /**
   * Stop automatic monitoring
   */
  stopMonitoring() {
    if (this.monitoringInterval) {
      clearInterval(this.monitoringInterval);
      this.monitoringInterval = null;
    }
    this.isMonitoring = false;
    console.log("Submission results monitoring stopped");
  }

  /**
   * Get monitoring status
   */
  getMonitoringStatus() {
    return {
      isMonitoring: this.isMonitoring,
      config: this.config,
      interval: this.config.monitorInterval,
    };
  }

  /**
   * Manual trigger for a single monitoring cycle
   * @param {Function} loadDataFn - Function to load current data
   * @param {Function} saveDataFn - Function to save updated data
   * @param {Function} calculateScoreFn - Function to calculate submission scores
   */
  async triggerMonitoring(loadDataFn, saveDataFn, calculateScoreFn) {
    console.log("Manually triggering monitoring cycle...");
    return await this.monitorJobStatuses(loadDataFn, saveDataFn, calculateScoreFn);
  }
}

// Export both the class and a default instance
module.exports = {
  SubmissionResultsMonitor,
  createMonitor: (config) => new SubmissionResultsMonitor(config),
};
