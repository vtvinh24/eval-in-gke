#!/usr/bin/env bash
set -euo pipefail

# Script to get the latest baseline dump URL from the db-baseline bucket
# Usage: ./get-latest-baseline.sh [specific_job_id]

BUCKET_NAME="db-baseline"

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

# Function to find the latest baseline dump
get_latest_baseline_url() {
  local specific_job_id="${1:-}"
  
  # Check if bucket exists
  if ! gsutil ls -b "gs://$BUCKET_NAME" &>/dev/null; then
    echo "ERROR: Bucket gs://$BUCKET_NAME does not exist" >&2
    return 1
  fi
  
  if [ -n "$specific_job_id" ]; then
    # Use specific job ID
    local dump_url="gs://$BUCKET_NAME/$specific_job_id/db_dump.sql"
    if gsutil ls "$dump_url" &>/dev/null; then
      echo "$dump_url"
      return 0
    else
      echo "ERROR: Specific baseline dump not found: $dump_url" >&2
      return 1
    fi
  else
    # Find the latest job folder with a db_dump.sql
    local latest_job
    latest_job=$(gsutil ls "gs://$BUCKET_NAME/" | grep "/$" | sort -r | head -1)
    
    if [ -z "$latest_job" ]; then
      echo "ERROR: No job folders found in bucket gs://$BUCKET_NAME" >&2
      return 1
    fi
    
    local dump_url="${latest_job}db_dump.sql"
    if gsutil ls "$dump_url" &>/dev/null; then
      echo "$dump_url"
      return 0
    else
      echo "ERROR: No db_dump.sql found in latest job folder: $latest_job" >&2
      return 1
    fi
  fi
}

# Main execution
if [ "${BASH_SOURCE[0]}" == "${0}" ]; then
  # Only authenticate if we're running as a script (not being sourced)
  authenticate_gcp
  
  if [ $# -gt 0 ]; then
    get_latest_baseline_url "$1"
  else
    get_latest_baseline_url
  fi
fi