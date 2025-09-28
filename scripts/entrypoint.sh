#!/usr/bin/env bash
set -euo pipefail

# Trap errors and update job status
trap 'update_job_status "failed" "error" "\"Script failed at line $LINENO\""' ERR

# ============================================================================
# VALIDATION: Exit immediately if required variables are missing/invalid
# ============================================================================

echo "=== Initializing Job Metadata ==="

# Generate unique job ID if not provided
if [[ -z "${JOB_ID:-}" ]]; then
  export JOB_ID="job-$(date +%Y%m%d-%H%M%S)-$(uuidgen | cut -d- -f1)"
  echo "Generated JOB_ID: $JOB_ID"
else
  echo "Using provided JOB_ID: $JOB_ID"
fi

# Create output directory structure
mkdir -p "${OUT_DIR:-/output}/logs"
mkdir -p "${OUT_DIR:-/output}/results" 
mkdir -p "${OUT_DIR:-/output}/dumps"

# Create job metadata file
cat > "${OUT_DIR:-/output}/job_metadata.json" << EOF
{
  "job_id": "$JOB_ID",
  "job_type": "${INIT_MODE:-unknown}",
  "repo_url": "${REPO_URL:-null}",
  "started_at": "$(date -Iseconds)",
  "node_name": "${HOSTNAME:-unknown}",
  "status": "initializing",
  "progress": "0%"
}
EOF

# Function to update job status
update_job_status() {
  local status="$1"
  local progress="${2:-0%}"
  local error="${3:-null}"
  
  cat > "${OUT_DIR:-/output}/job_metadata.json" << EOF
{
  "job_id": "$JOB_ID",
  "job_type": "${INIT_MODE:-unknown}",
  "repo_url": "${REPO_URL:-null}",
  "started_at": "$(cat "${OUT_DIR:-/output}/job_metadata.json" 2>/dev/null | jq -r '.started_at // "unknown"')",
  "updated_at": "$(date -Iseconds)",
  "node_name": "${HOSTNAME:-unknown}",
  "status": "$status",
  "progress": "$progress",
  "error": $error
}
EOF

  # Optional: Send callback to API if URL provided
  if [[ -n "${API_CALLBACK_URL:-}" ]]; then
    curl -X POST "$API_CALLBACK_URL/jobs/$JOB_ID/status" \
      -H "Content-Type: application/json" \
      -d @"${OUT_DIR:-/output}/job_metadata.json" \
      --max-time 10 --silent || true
  fi
}

echo "=== Validating Environment Variables ==="

# Validate core database settings (REQUIRED)
if [[ -z "${POSTGRES_PASSWORD:-}" ]]; then
  echo "ERROR: POSTGRES_PASSWORD is required but not set" >&2
  exit 1
fi

if [[ -z "${POSTGRES_USER:-}" ]]; then
  echo "ERROR: POSTGRES_USER is required but not set" >&2
  exit 1
fi

if [[ -z "${POSTGRES_DB:-}" ]]; then
  echo "ERROR: POSTGRES_DB is required but not set" >&2
  exit 1
fi

# Validate INIT_MODE (REQUIRED)
if [[ -z "${INIT_MODE:-}" ]]; then
  echo "ERROR: INIT_MODE is required but not set (must be CREATE or LOAD)" >&2
  exit 1
fi

if [[ "$INIT_MODE" != "CREATE" && "$INIT_MODE" != "LOAD" ]]; then
  echo "ERROR: INIT_MODE must be 'CREATE' or 'LOAD', got '$INIT_MODE'" >&2
  exit 1
fi

# Validate DUMP_ENABLED (REQUIRED)
if [[ -z "${DUMP_ENABLED:-}" ]]; then
  echo "ERROR: DUMP_ENABLED is required but not set (must be true or false)" >&2
  exit 1
fi

if [[ "$DUMP_ENABLED" != "true" && "$DUMP_ENABLED" != "false" ]]; then
  echo "ERROR: DUMP_ENABLED must be 'true' or 'false', got '$DUMP_ENABLED'" >&2
  exit 1
fi

# Validate DUMP_LOCATION if dumping is enabled
if [[ "$DUMP_ENABLED" == "true" ]]; then
  if [[ -z "${DUMP_LOCATION:-}" ]]; then
    echo "ERROR: DUMP_LOCATION is required when DUMP_ENABLED=true (must be local or gcp)" >&2
    exit 1
  fi
  
  if [[ "$DUMP_LOCATION" != "local" && "$DUMP_LOCATION" != "gcp" ]]; then
    echo "ERROR: DUMP_LOCATION must be 'local' or 'gcp', got '$DUMP_LOCATION'" >&2
    exit 1
  fi
  
  # Validate GCP settings if using GCP dump location
  if [[ "$DUMP_LOCATION" == "gcp" ]]; then
    if [[ -z "${GCP_BUCKET:-}" ]]; then
      echo "ERROR: GCP_BUCKET is required when DUMP_LOCATION=gcp" >&2
      exit 1
    fi
    
    if [[ -z "${GCP_CREDENTIALS_JSON:-}" ]]; then
      echo "ERROR: GCP_CREDENTIALS_JSON is required when DUMP_LOCATION=gcp" >&2
      exit 1
    fi
  fi
fi

# Validate mode-specific settings
if [[ "$INIT_MODE" == "CREATE" ]]; then
  # Baseline mode validation
  echo "Validating baseline mode settings..."
  
  if [[ -z "${USERS_COUNT:-}" ]] || ! [[ "$USERS_COUNT" =~ ^[0-9]+$ ]]; then
    echo "ERROR: USERS_COUNT is required and must be a positive integer for baseline mode" >&2
    exit 1
  fi
  
  if [[ -z "${DEVICES_COUNT:-}" ]] || ! [[ "$DEVICES_COUNT" =~ ^[0-9]+$ ]]; then
    echo "ERROR: DEVICES_COUNT is required and must be a positive integer for baseline mode" >&2
    exit 1
  fi
  
  if [[ -z "${EVENTS_COUNT:-}" ]] || ! [[ "$EVENTS_COUNT" =~ ^[0-9]+$ ]]; then
    echo "ERROR: EVENTS_COUNT is required and must be a positive integer for baseline mode" >&2
    exit 1
  fi
  
  if [[ -z "${SCHEMA_SQL:-}" ]]; then
    echo "ERROR: SCHEMA_SQL is required for baseline mode" >&2
    exit 1
  fi
  
elif [[ "$INIT_MODE" == "LOAD" ]]; then
  # Submission mode validation
  echo "Validating submission mode settings..."
  
  if [[ -z "${BASELINE_DUMP_URL:-}" ]]; then
    echo "ERROR: BASELINE_DUMP_URL is required for submission mode" >&2
    exit 1
  fi
  
  # Validate URL format
  if ! [[ "$BASELINE_DUMP_URL" =~ ^https?:// ]]; then
    echo "ERROR: BASELINE_DUMP_URL must be a valid HTTP/HTTPS URL" >&2
    exit 1
  fi
  
  if [[ -z "${REPO_URL:-}" ]]; then
    echo "ERROR: REPO_URL is required for submission mode" >&2
    exit 1
  fi
  
  # Validate REPO_URL format if provided
  if [[ -n "$REPO_URL" ]] && ! [[ "$REPO_URL" =~ ^https?:// ]]; then
    echo "ERROR: REPO_URL must be a valid HTTP/HTTPS URL" >&2
    exit 1
  fi
fi

# Validate common required settings
required_vars=(
  "TIMEOUT"
  "MIG_LOG" 
  "EXEC_PER_QUERY"
  "EXEC_INTERVAL"
  "EXEC_INTERVAL_Q"
  "EXEC_TIMEOUT"
  "OUT_DIR"
  "DUMP_PATH"
  "DUMP_READY_FILE"
)

for var in "${required_vars[@]}"; do
  if [[ -z "${!var:-}" ]]; then
    echo "ERROR: $var is required but not set" >&2
    exit 1
  fi
done

# Validate numeric settings
numeric_vars=("TIMEOUT" "EXEC_PER_QUERY" "EXEC_INTERVAL" "EXEC_INTERVAL_Q" "EXEC_TIMEOUT")
for var in "${numeric_vars[@]}"; do
  if ! [[ "${!var}" =~ ^[0-9]+$ ]]; then
    echo "ERROR: $var must be a positive integer, got '${!var}'" >&2
    exit 1
  fi
done

echo "✅ All environment variables validated successfully"
echo "Mode: $INIT_MODE | Dump: $DUMP_ENABLED | Location: ${DUMP_LOCATION:-N/A}"

# Export key parameters for child scripts
export INIT_MODE
export DUMP_ENABLED
export REPO_URL

# Start the official postgres entrypoint in background to initialize DB and run server
docker_entrypoint=/usr/local/bin/docker-entrypoint.sh
if [ ! -x "$docker_entrypoint" ]; then
  echo "Cannot find official docker-entrypoint.sh"
  exec "$docker_entrypoint" "$@"
fi

export POSTGRES_PASSWORD
export POSTGRES_USER
export POSTGRES_DB

# Timeout is now validated and required - no defaults

# Ensure shared output directory exists and is writable
if [ ! -d /output ]; then
  mkdir -p /output 2>/dev/null || true
fi
if [ "$(id -u)" = "0" ]; then
  chown -R postgres:postgres /output 2>/dev/null || true
  chmod 0777 /output 2>/dev/null || true
fi

# Ensure a migration log path is defined and writable
export MIG_LOG=${MIG_LOG:-/output/migration.log}
if ! touch "$MIG_LOG" >/dev/null 2>&1; then
  echo "Warning: cannot create migration log at $MIG_LOG — falling back to /tmp/migration.log"
  export MIG_LOG=/tmp/migration.log
  touch "$MIG_LOG" >/dev/null 2>&1 || true
fi
if [ "$(id -u)" = "0" ]; then
  chown postgres:postgres "$MIG_LOG" 2>/dev/null || true
  chmod 0666 "$MIG_LOG" 2>/dev/null || true
fi

# Start postgres in background
echo "Starting postgres server..."
"$docker_entrypoint" postgres &
PG_PID=$!

# Check for completion markers based on mode
if [ "$INIT_MODE" = "CREATE" ]; then
  # Baseline mode
  COMPLETION_MARKER=${BASELINE_MARKER:-/output/baseline_done}
  if [ -f "$COMPLETION_MARKER" ]; then
    echo "Baseline marker $COMPLETION_MARKER found — baseline already ran. Exiting without re-running."
    chmod 0666 "$COMPLETION_MARKER" 2>/dev/null || true
    kill -TERM "$PG_PID" 2>/dev/null || true
    wait "$PG_PID" 2>/dev/null || true
    exit 0
  fi
else
  # Submission mode
  COMPLETION_MARKER=${SUBMISSION_MARKER:-/output/submission_done}
  if [ -f "$COMPLETION_MARKER" ]; then
    echo "Submission marker $COMPLETION_MARKER found — submission already ran. Exiting without re-running."
    chmod 0666 "$COMPLETION_MARKER" 2>/dev/null || true
    kill -TERM "$PG_PID" 2>/dev/null || true
    wait "$PG_PID" 2>/dev/null || true
    exit 0
  fi
fi

# Wait for postgres to accept connections
echo "Waiting for postgres to be ready..."
until pg_isready -U "$POSTGRES_USER" >/dev/null 2>&1; do
  sleep 0.5
done

# Create database if it doesn't exist
echo "Ensuring database exists..."
createdb -U "$POSTGRES_USER" "$POSTGRES_DB" 2>/dev/null || true

# Wait for database to be accessible
until pg_isready -U "$POSTGRES_USER" -d "$POSTGRES_DB" >/dev/null 2>&1; do
  sleep 0.5
done

# Handle different initialization modes
if [ "$INIT_MODE" = "LOAD" ]; then
  # Submission mode: download and load baseline database dump
  echo "Postgres ready. Downloading baseline database dump..."
  
  # Download the baseline database dump (URL already validated)
  BASELINE_DOWNLOAD_PATH="/tmp/baseline_dump.sql"
  echo "Downloading baseline dump from: $BASELINE_DUMP_URL"
  curl -L -o "$BASELINE_DOWNLOAD_PATH" "$BASELINE_DUMP_URL"
  
  if [ ! -f "$BASELINE_DOWNLOAD_PATH" ] || [ ! -s "$BASELINE_DOWNLOAD_PATH" ]; then
    echo "ERROR: Failed to download baseline dump or file is empty" >&2
    exit 1
  fi
  
  echo "Baseline dump downloaded successfully. Size: $(du -h "$BASELINE_DOWNLOAD_PATH" | cut -f1)"
  
  # Load the baseline database dump
  echo "Loading baseline database dump..."
  # Filter out role and database creation commands that might conflict with existing setup
  FILTERED_DUMP_PATH="/tmp/filtered_baseline_dump.sql"
  echo "Filtering dump to avoid role and database conflicts..."
  # Remove problematic lines that conflict with existing database/role setup
  grep -v -E '^CREATE ROLE postgres;$|^ALTER ROLE postgres |^\\connect template1$|^CREATE DATABASE demo_db |^ALTER DATABASE demo_db OWNER|^\\connect demo_db$' "$BASELINE_DOWNLOAD_PATH" > "$FILTERED_DUMP_PATH"
  
  # Load the filtered dump
  psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f "$FILTERED_DUMP_PATH"
  
  # Apply submission migration if present
  if [ -f "/submission/migration.sql" ] && [ -s "/submission/migration.sql" ]; then
    echo "Applying submission migration..."
    psql -U "$POSTGRES_USER" -d "$POSTGRES_DB" -v ON_ERROR_STOP=1 -f "/submission/migration.sql"
  fi
  
  echo "Database loaded successfully. Starting query evaluation..."
  update_job_status "running" "50%" null
  
  # Override the source directory to use submission queries
  export QUERIES_DIR=/submission
else
  # Baseline mode: run database initialization manually
  echo "Postgres ready. Initializing baseline database..."
  update_job_status "running" "20%" null
  
  # Set environment variables for the init script (all already validated)
  export INIT_MODE
  export USERS_COUNT
  export DEVICES_COUNT 
  export EVENTS_COUNT
  export SCHEMA_SQL
  
  # Run the initialization script
  bash /sql-templates/init-db.sh
  
  echo "Database initialization complete. Starting query evaluation..."
  update_job_status "running" "50%" null
  
  # Use baseline queries directory
  export QUERIES_DIR=/source
fi

# Download submission files from repository if REPO_URL is provided
if [ -n "$REPO_URL" ] && [ "$INIT_MODE" = "LOAD" ]; then
  echo "Downloading submission files from repository: $REPO_URL"
  
  # Create temporary directory for cloning
  TEMP_REPO_DIR="/tmp/submission_repo"
  rm -rf "$TEMP_REPO_DIR"
  
  # Clone the repository
  if command -v git >/dev/null 2>&1; then
    git clone "$REPO_URL" "$TEMP_REPO_DIR"
    
    # Copy SQL files to submission directory
    if [ -d "$TEMP_REPO_DIR" ]; then
      find "$TEMP_REPO_DIR" -name "*.sql" -exec cp {} /submission/ \;
      echo "Submission files downloaded and copied successfully"
    fi
    
    # Clean up
    rm -rf "$TEMP_REPO_DIR"
  else
    echo "WARNING: git not available, skipping repository download"
  fi
fi

# Forward SIGTERM/SIGINT to the postgres process so it can shutdown cleanly
term_handler() {
  echo "Signal received, forwarding to postgres (pid $PG_PID) and exiting..."
  kill -TERM "$PG_PID" 2>/dev/null || true
  wait "$PG_PID" 2>/dev/null || true
  exit 0
}
trap term_handler SIGTERM SIGINT

# Run the query runner (it uses psql to connect)
/usr/local/bin/query-runner.sh

echo "Query runs finished. Preparing results and DB dump..."

# Dump DB using dump-db.sh script
if [ "$DUMP_ENABLED" = "true" ]; then
  # Set dump path based on mode
  if [ "$INIT_MODE" = "CREATE" ]; then
    export DUMP_PATH=${DUMP_PATH:-/output/db_dump.sql}
  else
    export DUMP_PATH=${DUMP_PATH:-/output/submission_dump.sql}
  fi
  
  export DUMP_LOCATION=${DUMP_LOCATION:-local}
  /usr/local/bin/dump-db.sh
fi

# Create completion marker
touch "$COMPLETION_MARKER"
chmod 0666 "$COMPLETION_MARKER" 2>/dev/null || true

# Update job status to completed
update_job_status "completed" "100%" null

if [ "$INIT_MODE" = "CREATE" ]; then
  echo "Baseline evaluation completed. Will terminate postgres after ${TIMEOUT}ms."
else
  echo "Submission evaluation completed. Will terminate postgres after ${TIMEOUT}ms."
fi

# Sleep for TIMEOUT milliseconds
sleep_sec=$(awk "BEGIN{printf \"%.3f\", ${TIMEOUT}/1000}")
echo "Sleeping for ${sleep_sec}s before shutdown..."
sleep "$sleep_sec"

echo "Timeout reached (${TIMEOUT}ms). Stopping postgres (pid $PG_PID) and exiting."
kill -TERM "$PG_PID" 2>/dev/null || true
wait "$PG_PID" 2>/dev/null || true

exit 0