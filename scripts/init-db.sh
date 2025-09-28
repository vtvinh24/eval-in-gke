#!/usr/bin/env bash
set -euo pipefail


# --- Parameterized DB initialization ---
INIT_MODE=${INIT_MODE:-CREATE} # CREATE or LOAD
USERS_COUNT=${USERS_COUNT:-1000}
DEVICES_COUNT=${DEVICES_COUNT:-1000}
EVENTS_COUNT=${EVENTS_COUNT:-10000}
SCHEMA_SQL=${SCHEMA_SQL:-/sql-templates/init-db.sql}
GCP_BUCKET=${GCP_BUCKET:-}
GCP_CREDENTIALS_JSON=${GCP_CREDENTIALS_JSON:-}
DUMP_PATH=${DUMP_PATH:-/output/db_dump.sql}

echo "[init-db.sh] INIT_MODE=$INIT_MODE"
echo "Target database: ${POSTGRES_DB:-demo_db}, User: ${POSTGRES_USER:-postgres}"

if [ "$INIT_MODE" = "CREATE" ]; then
  echo "[init-db.sh] Creating DB from schema and counts..."
  if [ -f "$SCHEMA_SQL" ]; then
    echo "Using schema SQL: $SCHEMA_SQL"
  else
    echo "Schema SQL $SCHEMA_SQL not found, exiting with error" >&2
    exit 1
  fi

  TMP_SQL=/tmp/init-db-generated.sql
  cat > "$TMP_SQL" <<SQL
-- Generated initializer (from init-db.sh)
\set users_count ${USERS_COUNT}
\set devices_count ${DEVICES_COUNT}
\set events_count ${EVENTS_COUNT}
\i $SCHEMA_SQL
SQL

  if grep -q '__USERS_COUNT__' "$SCHEMA_SQL" || grep -q '__DEVICES_COUNT__' "$SCHEMA_SQL" || grep -q '__EVENTS_COUNT__' "$SCHEMA_SQL"; then
    echo "Detected substitution markers in $SCHEMA_SQL, performing replacements"
    sed \
      -e "s/__USERS_COUNT__/${USERS_COUNT}/g" \
      -e "s/__DEVICES_COUNT__/${DEVICES_COUNT}/g" \
      -e "s/__EVENTS_COUNT__/${EVENTS_COUNT}/g" \
      "$SCHEMA_SQL" > "$TMP_SQL"
    psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-demo_db}" -v ON_ERROR_STOP=1 -f "$TMP_SQL"
  else
    psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-demo_db}" -v ON_ERROR_STOP=1 -f "$TMP_SQL"
  fi

elif [ "$INIT_MODE" = "LOAD" ]; then
  echo "[init-db.sh] Loading DB from GCP Cloud Storage..."
  if [ -z "$GCP_BUCKET" ]; then
    echo "GCP_BUCKET not set, cannot load DB from cloud." >&2
    exit 2
  fi
  if [ -z "$GCP_CREDENTIALS_JSON" ]; then
    echo "GCP_CREDENTIALS_JSON not set, cannot authenticate to GCP." >&2
    exit 2
  fi
  if [ -z "$DUMP_PATH" ]; then
    echo "DUMP_PATH not set, cannot restore DB." >&2
    exit 2
  fi
  echo "Activating GCP service account..."
  echo "$GCP_CREDENTIALS_JSON" > /tmp/gcp-creds.json
  gcloud auth activate-service-account --key-file=/tmp/gcp-creds.json
  echo "Downloading DB dump from gs://$GCP_BUCKET/db_dump.sql to $DUMP_PATH..."
  gsutil cp "gs://$GCP_BUCKET/db_dump.sql" "$DUMP_PATH"
  echo "Restoring DB from dump..."
  psql -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-demo_db}" -v ON_ERROR_STOP=1 -f "$DUMP_PATH"
else
  echo "Unknown INIT_MODE: $INIT_MODE" >&2
  exit 3
fi

# Make sure the output directory exists (host mount) and is writeable
mkdir -p /output || true
chmod ugo+rw /output || true

# Create a completion marker to signal that all initialization is truly complete
touch /tmp/db_init_complete
echo "Database initialization completed successfully"

exit 0
