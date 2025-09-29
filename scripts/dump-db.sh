#!/usr/bin/env bash
set -euo pipefail

# --- Enhanced output upload logic ---
# All variables validated by entrypoint - no defaults needed

# Function to authenticate with GCP
authenticate_gcp() {
  if [ -z "$GCP_BUCKET" ]; then
    echo "ERROR: GCP_BUCKET env var not set for GCP upload." >&2
    exit 1
  fi
  if [ -z "$GCP_CREDENTIALS_JSON" ]; then
    echo "ERROR: GCP_CREDENTIALS_JSON env var not set for GCP upload." >&2
    exit 1
  fi
  
  # Activate service account (write credentials to file if not already a file)
  if [ -f "$GCP_CREDENTIALS_JSON" ]; then
    gcloud auth activate-service-account --key-file="$GCP_CREDENTIALS_JSON"
  else
    echo "$GCP_CREDENTIALS_JSON" > /tmp/gcp-creds.json
    gcloud auth activate-service-account --key-file=/tmp/gcp-creds.json
  fi
}

# Function to create GCS bucket if it doesn't exist
create_bucket_if_not_exists() {
  local bucket_name="$1"
  
  echo "Checking if bucket gs://$bucket_name exists..."
  
  # Extract project ID from service account credentials
  local project_id
  if [ -f "$GCP_CREDENTIALS_JSON" ]; then
    project_id=$(jq -r '.project_id' "$GCP_CREDENTIALS_JSON")
  else
    project_id=$(echo "$GCP_CREDENTIALS_JSON" | jq -r '.project_id')
  fi
  
  if [ -z "$project_id" ] || [ "$project_id" = "null" ]; then
    echo "ERROR: Could not extract project_id from GCP credentials" >&2
    exit 1
  fi
  
  echo "Using project ID: $project_id"
  
  # Set the default project for gsutil
  gcloud config set project "$project_id" >/dev/null 2>&1
  
  # Check if bucket exists
  if gsutil ls -b "gs://$bucket_name" &>/dev/null; then
    echo "Bucket gs://$bucket_name already exists"
  else
    echo "Creating bucket gs://$bucket_name..."
    
    # Create bucket with appropriate region and project
    if gsutil mb -p "$project_id" -l us-central1 "gs://$bucket_name"; then
      echo "Successfully created bucket gs://$bucket_name"
      
      # Set bucket permissions for public read access to dumps
      echo "Setting bucket permissions for public read access..."
      gsutil iam ch allUsers:objectViewer "gs://$bucket_name" || {
        echo "WARNING: Failed to set public read permissions on bucket"
      }
    else
      echo "ERROR: Failed to create bucket gs://$bucket_name" >&2
      exit 1
    fi
  fi
}

# Function to upload entire output directory
upload_output_directory() {
  local bucket_name="$1"
  local bucket_path="$2"
  
  echo "Uploading entire output directory to gs://$bucket_name/$bucket_path/ ..."
  
  # Create a timestamp for this upload
  local upload_timestamp=$(date -u +%Y%m%d-%H%M%S)
  
  # Upload all files in output directory recursively
  if [ -d "$OUT_DIR" ]; then
    # Sync the entire output directory to GCS
    gsutil -m rsync -r -C "$OUT_DIR" "gs://$bucket_name/$bucket_path/"
    echo "Output directory upload complete."
    
    # Create a completion marker in GCS
    echo "$upload_timestamp" | gsutil cp - "gs://$bucket_name/$bucket_path/upload_complete.txt"
  else
    echo "WARNING: Output directory $OUT_DIR does not exist"
  fi
}

# Function to create database dump
create_db_dump() {
  echo "Creating database dump at $DUMP_PATH ..."
  mkdir -p "$(dirname "$DUMP_PATH")" || true
  
  if [ -e "$DUMP_PATH" ] && [ -d "$DUMP_PATH" ]; then
    BACKUP_DIR="${DUMP_PATH}.dir_backup.$(date +%s)"
    echo "Warning: $DUMP_PATH exists and is a directory. Backing it up to $BACKUP_DIR"
    mv "$DUMP_PATH" "$BACKUP_DIR" 2>/dev/null || rm -rf "$DUMP_PATH" 2>/dev/null || true
  fi
  
  TMP_DUMP="${DUMP_PATH}.tmp.$$"
  set +e
  pg_dumpall -U "$POSTGRES_USER" > "$TMP_DUMP" 2>/tmp/pg_dumpall.err
  rc=$?
  set -e
  
  if [ $rc -eq 0 ]; then
    mv -f "$TMP_DUMP" "$DUMP_PATH" || true
    chmod 0666 "$DUMP_PATH" || true
    echo "DB dump written to $DUMP_PATH"
    touch "$DUMP_READY_FILE" || true
    chmod 0666 "$DUMP_READY_FILE" || true
    return 0
  else
    echo "WARNING: pg_dumpall failed (exit $rc). Dump error (first 200 lines):" >&2
    sed -n '1,200p' /tmp/pg_dumpall.err || true
    return 1
  fi
}

# Main logic based on mode and settings
if [ "$UPLOAD_ENABLED" != "true" ]; then
  echo "[dump-db.sh] UPLOAD_ENABLED is not true, skipping upload."
  exit 0
fi

# Determine bucket and path based on mode and job ID
if [ "$INIT_MODE" = "CREATE" ]; then
  # Baseline mode: use db-baseline bucket
  BUCKET_NAME="db-baseline"
  BUCKET_PATH="${JOB_ID:-$(date +%Y%m%d-%H%M%S)}"
  
  echo "=== Baseline Mode: Creating dump and uploading all outputs ==="
  
  # Always create database dump for baseline
  if create_db_dump; then
    echo "Database dump created successfully"
  else
    echo "WARNING: Database dump creation failed, continuing with output upload"
  fi
  
  if [ "$UPLOAD_LOCATION" = "gcp" ]; then
    authenticate_gcp
    create_bucket_if_not_exists "$BUCKET_NAME"
    upload_output_directory "$BUCKET_NAME" "$BUCKET_PATH"
  elif [ "$UPLOAD_LOCATION" = "local" ]; then
    echo "Local storage mode - outputs remain in $OUT_DIR"
  else
    echo "WARNING: Unknown UPLOAD_LOCATION value: $UPLOAD_LOCATION" >&2
  fi
  
elif [ "$INIT_MODE" = "LOAD" ]; then
  # Submission mode: use db-submission-{job_id} bucket
  SUBMISSION_ID="${JOB_ID:-$(date +%Y%m%d-%H%M%S)}"
  BUCKET_NAME="db-submission-${SUBMISSION_ID}"
  BUCKET_PATH="results"
  
  echo "=== Submission Mode: Uploading results only ==="
  
  # Only create dump if explicitly requested
  if [ "${DUMP_ENABLED:-false}" = "true" ]; then
    echo "Database dump explicitly enabled for submission"
    if create_db_dump; then
      echo "Database dump created successfully"
    else
      echo "WARNING: Database dump creation failed"
    fi
  else
    echo "Database dump disabled for submission mode (default)"
  fi
  
  if [ "$UPLOAD_LOCATION" = "gcp" ]; then
    authenticate_gcp
    create_bucket_if_not_exists "$BUCKET_NAME"
    upload_output_directory "$BUCKET_NAME" "$BUCKET_PATH"
  elif [ "$UPLOAD_LOCATION" = "local" ]; then
    echo "Local storage mode - outputs remain in $OUT_DIR"
  else
    echo "WARNING: Unknown UPLOAD_LOCATION value: $UPLOAD_LOCATION" >&2
  fi
  
else
  echo "ERROR: Unknown INIT_MODE value: $INIT_MODE" >&2
  exit 1
fi

echo "Upload process completed."
