#!/bin/bash

# create-job.sh - Creates Kubernetes jobs for evaluation system
# Usage: ./create-job.sh <job-type> [repo-url] [additional-params]

set -e

# Get parameters
JOB_TYPE="$1"
REPO_URL="$2"

# Default values
GKE_NAMESPACE="${GKE_NAMESPACE:-default}"
JOB_NAME_PREFIX="${JOB_NAME_PREFIX:-eval}"

# Generate unique job name with timestamp
TIMESTAMP=$(date +%s)
JOB_NAME="${JOB_NAME_PREFIX}-${JOB_TYPE}-${TIMESTAMP}"

# Function to create baseline job
create_baseline_job() {
    cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB_NAME}
  namespace: ${GKE_NAMESPACE}
  labels:
    app: eval-system
    job-type: baseline
spec:
  template:
    metadata:
      labels:
        app: eval-system
        job-type: baseline
    spec:
      restartPolicy: Never
      containers:
      - name: baseline-evaluator
        image: gcr.io/hackathon-demo-473203/baseline-evaluator:latest
        env:
        - name: JOB_ID
          value: "${JOB_NAME}"
        - name: JOB_TYPE
          value: "baseline"
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1024Mi"
            cpu: "1000m"
  backoffLimit: 2
EOF
}

# Function to create submission job
create_submission_job() {
    if [ -z "$REPO_URL" ]; then
        echo "Error: Repository URL is required for submission jobs" >&2
        exit 1
    fi

    cat <<EOF | kubectl apply -f -
apiVersion: batch/v1
kind: Job
metadata:
  name: ${JOB_NAME}
  namespace: ${GKE_NAMESPACE}
  labels:
    app: eval-system
    job-type: submission
spec:
  template:
    metadata:
      labels:
        app: eval-system
        job-type: submission
    spec:
      restartPolicy: Never
      containers:
      - name: submission-evaluator
        image: gcr.io/hackathon-demo-473203/submission-evaluator:latest
        env:
        - name: JOB_ID
          value: "${JOB_NAME}"
        - name: JOB_TYPE
          value: "submission"
        - name: REPO_URL
          value: "${REPO_URL}"
        - name: EXEC_PER_QUERY
          value: "${EXEC_PER_QUERY:-3}"
        - name: TIMEOUT_SECONDS
          value: "${TIMEOUT_SECONDS:-600}"
        resources:
          requests:
            memory: "512Mi"
            cpu: "500m"
          limits:
            memory: "1024Mi"
            cpu: "1000m"
  backoffLimit: 2
EOF
}

# Function to wait for job to be created and get its status
wait_for_job_creation() {
    local max_attempts=30
    local attempt=1
    
    while [ $attempt -le $max_attempts ]; do
        if kubectl get job "$JOB_NAME" -n "$GKE_NAMESPACE" >/dev/null 2>&1; then
            return 0
        fi
        sleep 1
        attempt=$((attempt + 1))
    done
    
    echo "Error: Job $JOB_NAME was not created within 30 seconds" >&2
    return 1
}

# Main logic
case "$JOB_TYPE" in
    "baseline")
        echo "Creating baseline evaluation job..." >&2
        create_baseline_job
        ;;
    "submission")
        echo "Creating submission evaluation job for repo: $REPO_URL" >&2
        create_submission_job
        ;;
    *)
        echo "Error: Unknown job type '$JOB_TYPE'. Supported types: baseline, submission" >&2
        exit 1
        ;;
esac

# Wait for job to be created
if wait_for_job_creation; then
    echo "Job created successfully" >&2
    # Output the job name (this is what the server will capture as job ID)
    echo "$JOB_NAME"
else
    echo "Failed to create job" >&2
    exit 1
fi