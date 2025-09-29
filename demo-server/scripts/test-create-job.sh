#!/bin/bash

# test-create-job.sh - Test version of create-job.sh for validation
# Usage: ./test-create-job.sh <job-type> [repo-url]

set -e

echo "=== CREATE JOB TEST SCRIPT ===" >&2

# Get parameters
JOB_TYPE="$1"
REPO_URL="$2"

echo "Parameters received:" >&2
echo "  JOB_TYPE: ${JOB_TYPE}" >&2
echo "  REPO_URL: ${REPO_URL}" >&2
echo "  GKE_NAMESPACE: ${GKE_NAMESPACE:-default}" >&2

# Default values
GKE_NAMESPACE="${GKE_NAMESPACE:-default}"
JOB_NAME_PREFIX="${JOB_NAME_PREFIX:-eval}"

# Generate unique job name with timestamp
TIMESTAMP=$(date +%s)
JOB_NAME="${JOB_NAME_PREFIX}-${JOB_TYPE}-${TIMESTAMP}"

echo "Generated job name: ${JOB_NAME}" >&2

# Validate job type
case "$JOB_TYPE" in
    "baseline")
        echo "✓ Valid job type: baseline" >&2
        echo "Would create baseline evaluation job..." >&2
        ;;
    "submission")
        echo "✓ Valid job type: submission" >&2
        if [ -z "$REPO_URL" ]; then
            echo "❌ Error: Repository URL is required for submission jobs" >&2
            exit 1
        fi
        echo "✓ Repository URL provided: $REPO_URL" >&2
        echo "Would create submission evaluation job..." >&2
        ;;
    *)
        echo "❌ Error: Unknown job type '$JOB_TYPE'. Supported types: baseline, submission" >&2
        exit 1
        ;;
esac

echo "✓ All validations passed" >&2
echo "Would execute: kubectl apply -f <job-manifest> -n ${GKE_NAMESPACE}" >&2
echo "Test completed successfully" >&2

# Output the job name (this is what the server will capture as job ID)
echo "$JOB_NAME"