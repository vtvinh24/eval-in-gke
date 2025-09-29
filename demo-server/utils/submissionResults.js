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
   * Check Kubernetes job status
   * @param {string} jobId - The job ID to check
   * @returns {string} Job status
   */
  async getKubernetesJobStatus(jobId) {
    try {
      const env = this.getGCPEnvironment();
      const namespace = process.env.GKE_NAMESPACE || "default";

      // First check if job exists and get basic status
      const jobExistsCommand = `kubectl get job ${jobId} -n ${namespace} -o json 2>/dev/null`;
      let jobData;
      try {
        const { stdout } = await execAsync(jobExistsCommand, { env });
        jobData = JSON.parse(stdout);
      } catch (error) {
        // Job not found in this namespace, try other common namespaces
        const namespaces = ["default", "eval-system"];
        for (const ns of namespaces) {
          try {
            const command = `kubectl get job ${jobId} -n ${ns} -o json 2>/dev/null`;
            const { stdout } = await execAsync(command, { env });
            jobData = JSON.parse(stdout);
            if (this.config.debug) {
              console.log(`Found job ${jobId} in namespace ${ns}`);
            }
            break;
          } catch (e) {
            continue;
          }
        }
        if (!jobData) {
          return "not-found";
        }
      }

      // Check job conditions for completion status
      const conditions = jobData.status?.conditions || [];
      const completedCondition = conditions.find((c) => c.type === "Complete");
      const failedCondition = conditions.find((c) => c.type === "Failed");

      if (completedCondition && completedCondition.status === "True") {
        return "completed";
      }
      if (failedCondition && failedCondition.status === "True") {
        return "failed";
      }

      // Check pod status for more detailed info
      const active = jobData.status?.active || 0;
      const ready = jobData.status?.ready || 0;

      if (active > 0) {
        // Job has active pods, check if they're actually running
        try {
          const podCommand = `kubectl get pods -n ${jobData.metadata.namespace} -l job-name=${jobId} -o json 2>/dev/null`;
          const { stdout: podStdout } = await execAsync(podCommand, { env });
          const podData = JSON.parse(podStdout);

          if (podData.items && podData.items.length > 0) {
            const pod = podData.items[0];
            const phase = pod.status?.phase;

            if (phase === "Pending") {
              // Check if it's pending due to resource constraints
              const conditions = pod.status?.conditions || [];
              const scheduled = conditions.find((c) => c.type === "PodScheduled");
              if (scheduled && scheduled.status === "False") {
                return "pending-resources";
              }
              return "pending";
            } else if (phase === "Running") {
              return "running";
            }
          }
        } catch (podError) {
          if (this.config.debug) {
            console.warn(`Could not get pod status for job ${jobId}:`, podError.message);
          }
        }

        return "running";
      }

      // Job exists but no active pods
      return "queued";
    } catch (error) {
      if (this.config.debug) {
        console.warn(`Failed to get Kubernetes job status for ${jobId}:`, error.message);
      }
      return "unknown";
    }
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
      const activeJobs = Object.entries(problem.jobStatuses || {}).filter(([jobId, status]) => ["running", "queued", "processing", "pending", "pending-resources"].includes(status));

      if (activeJobs.length > 0 && this.config.debug) {
        console.log(`Monitoring ${activeJobs.length} jobs for problem ${problemId}`);
      }

      for (const [jobId, status] of activeJobs) {
        try {
          if (this.config.debug) {
            console.log(`Checking job ${jobId} (${status}) for problem ${problemId}`);
          }

          // First check Kubernetes job status for real-time updates
          const k8sStatus = await this.getKubernetesJobStatus(jobId);

          if (k8sStatus === "completed") {
            // Job completed in Kubernetes, check for results in GCS
            const resultsData = await this.fetchSubmissionResults(jobId, problemId);

            if (resultsData && resultsData.queries) {
              // Results found in GCS, job is fully completed
              console.log(`✓ Job ${jobId} completed with results in GCS for problem ${problemId}`);

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
            } else {
              // Job completed but results not ready yet
              if (this.config.debug) {
                console.log(`⏳ Job ${jobId} completed in K8s but results not yet in GCS`);
              }
              if (problem.jobStatuses[jobId] !== "processing") {
                problem.jobStatuses[jobId] = "processing";

                // Update submission status
                const submission = problem.submissions.find((s) => s.jobId === jobId);
                if (submission && submission.status !== "processing") {
                  submission.status = "processing";
                  hasUpdates = true;
                }

                hasUpdates = true;
              }
            }
          } else if (k8sStatus === "failed") {
            // Job failed in Kubernetes
            console.log(`❌ Job ${jobId} failed in Kubernetes`);

            const submission = problem.submissions.find((s) => s.jobId === jobId);
            if (submission) {
              submission.status = "failed";
              submission.completedAt = new Date().toISOString();
              submission.error = "Job failed in Kubernetes";
            }

            problem.jobStatuses[jobId] = "failed";
            hasUpdates = true;
          } else if (k8sStatus === "pending-resources") {
            // Job is pending due to insufficient resources
            if (this.config.debug) {
              console.log(`⏸ Job ${jobId} is pending due to insufficient cluster resources`);
            }
            if (problem.jobStatuses[jobId] !== "pending-resources") {
              problem.jobStatuses[jobId] = "pending-resources";

              // Update submission status
              const submission = problem.submissions.find((s) => s.jobId === jobId);
              if (submission && submission.status !== "pending-resources") {
                submission.status = "pending-resources";
                hasUpdates = true;
              }
              hasUpdates = true;
            }
          } else if (k8sStatus === "pending") {
            // Job is pending for other reasons
            if (this.config.debug) {
              console.log(`⏳ Job ${jobId} is pending in Kubernetes`);
            }
            if (problem.jobStatuses[jobId] !== "pending") {
              problem.jobStatuses[jobId] = "pending";

              // Update submission status
              const submission = problem.submissions.find((s) => s.jobId === jobId);
              if (submission && submission.status !== "pending") {
                submission.status = "pending";
                hasUpdates = true;
              }
              hasUpdates = true;
            }
          } else if (k8sStatus === "running" && problem.jobStatuses[jobId] !== "running") {
            // Job is actively running
            if (this.config.debug) {
              console.log(`▶ Job ${jobId} is running in Kubernetes`);
            }
            problem.jobStatuses[jobId] = "running";

            // Update submission status
            const submission = problem.submissions.find((s) => s.jobId === jobId);
            if (submission && submission.status !== "running") {
              submission.status = "running";
              hasUpdates = true;
            }

            hasUpdates = true;
          } else if (k8sStatus === "not-found") {
            // Job not found - might have been cleaned up, check one more time for results
            console.log(`❓ Job ${jobId} not found in Kubernetes, checking for final results`);

            const resultsData = await this.fetchSubmissionResults(jobId, problemId);
            if (resultsData && resultsData.queries) {
              // Found results even though job was cleaned up
              const submission = problem.submissions.find((s) => s.jobId === jobId);
              if (submission) {
                submission.metrics = resultsData;
                submission.status = "evaluated";
                submission.completedAt = new Date().toISOString();

                if (calculateScoreFn && problem.baselineMetrics) {
                  submission.autoScore = calculateScoreFn(submission.metrics, problem.baselineMetrics);
                }
              }
              problem.jobStatuses[jobId] = "completed";
              hasUpdates = true;
            } else {
              // Job not found and no results - mark as failed after some retries
              const submission = problem.submissions.find((s) => s.jobId === jobId);
              if (submission) {
                submission.errorCount = (submission.errorCount || 0) + 1;
                if (submission.errorCount >= this.config.maxRetries) {
                  submission.status = "failed";
                  submission.completedAt = new Date().toISOString();
                  submission.error = "Job not found in Kubernetes and no results available";
                  problem.jobStatuses[jobId] = "failed";
                  hasUpdates = true;
                }
              }
            }
          } else {
            // Unknown status or no change, try to fetch results anyway
            const resultsData = await this.fetchSubmissionResults(jobId, problemId);

            if (resultsData && resultsData.queries) {
              // Found results
              console.log(`✓ Job ${jobId} results found in GCS for problem ${problemId}`);

              const submission = problem.submissions.find((s) => s.jobId === jobId);
              if (submission) {
                submission.metrics = resultsData;
                submission.status = "evaluated";
                submission.completedAt = new Date().toISOString();

                if (calculateScoreFn && problem.baselineMetrics) {
                  submission.autoScore = calculateScoreFn(submission.metrics, problem.baselineMetrics);
                }

                console.log(`✓ Submission ${submission.id} updated: auto score = ${submission.autoScore || "N/A"}`);
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
                  submission.error = "Timeout waiting for results";
                  problem.jobStatuses[jobId] = "failed";
                  hasUpdates = true;
                } else if (this.config.debug) {
                  console.log(`⏳ Job ${jobId} still ${status}, check ${submission.errorCount}/${this.config.maxRetries}`);
                }
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
              submission.error = `Monitoring error: ${error.message}`;
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
