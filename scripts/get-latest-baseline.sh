#!/usr/bin/env bash
set -euo pipefail

# Script to get the latest baseline job folder from the baseline bucket
# Usage: ./get-latest-baseline.sh [specific_job_id]

BUCKET_NAME="${BASELINE_BUCKET:-db-baseline}"

# Function to authenticate with GCP if credentials are provided
authenticate_gcp() {
  if [ -n "${GCP_CREDENTIALS_JSON:-}" ]; then
    if [ -f "$GCP_CREDENTIALS_JSON" ]; then
      gcloud auth activate-service-account --key-file="$GCP_CREDENTIALS_JSON" 2>/dev/null
      # Extract and set project ID
      local project_id=$(jq -r '.project_id' "$GCP_CREDENTIALS_JSON")
    else
      echo "$GCP_CREDENTIALS_JSON" > /tmp/gcp-creds.json
      gcloud auth activate-service-account --key-file=/tmp/gcp-creds.json 2>/dev/null
      # Extract and set project ID
      local project_id=$(echo "$GCP_CREDENTIALS_JSON" | jq -r '.project_id')
    fi
    
    if [ -n "$project_id" ] && [ "$project_id" != "null" ]; then
      gcloud config set project "$project_id" >/dev/null 2>&1
    fi
  fi
}

# Function to find and list all files in the latest baseline job folder
get_latest_baseline_files() {
  local specific_job_id="${1:-}"
  
  # Check if bucket exists
  if ! gsutil ls -b "gs://$BUCKET_NAME" &>/dev/null; then
    echo "ERROR: Bucket gs://$BUCKET_NAME does not exist" >&2
    return 1
  fi
  
  if [ -n "$specific_job_id" ]; then
    # Use specific job ID
    local job_folder="gs://$BUCKET_NAME/$specific_job_id/"
    if gsutil ls "$job_folder" &>/dev/null; then
      # List all files and subdirectories recursively
      gsutil ls -r "$job_folder"
      return 0
    else
      echo "ERROR: Specific baseline job folder not found: $job_folder" >&2
      return 1
    fi
  else
    # Find the latest job folder
    local latest_job
    latest_job=$(gsutil ls "gs://$BUCKET_NAME/" | grep "/$" | sort -r | head -1)
    
    if [ -z "$latest_job" ]; then
      echo "ERROR: No job folders found in bucket gs://$BUCKET_NAME" >&2
      return 1
    fi
    
    # List all files and subdirectories recursively in the latest job folder
    gsutil ls -r "$latest_job"
    return 0
  fi
}

# Main execution
if [ "${BASH_SOURCE[0]}" == "${0}" ]; then
  # Only authenticate if we're running as a script (not being sourced)
  authenticate_gcp
  
  if [ $# -gt 0 ]; then
    get_latest_baseline_files "$1"
  else
    get_latest_baseline_files
  fi
fi