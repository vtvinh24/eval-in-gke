#!/usr/bin/env bash
set -euo pipefail

# --- Parameterized DB dump logic ---
# All variables validated by entrypoint - no defaults needed

if [ "$DUMP_ENABLED" != "true" ]; then
  echo "[dump-db.sh] DUMP_ENABLED is not true, skipping DB dump."
  exit 0
fi

mkdir -p "$(dirname "$DUMP_PATH")" || true

if [ "$DUMP_LOCATION" = "local" ]; then
  echo "Dumping cluster to $DUMP_PATH ..."
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
  else
    echo "WARNING: pg_dumpall failed (exit $rc). Dump error (first 200 lines):" >&2
    sed -n '1,200p' /tmp/pg_dumpall.err || true
  fi
elif [ "$DUMP_LOCATION" = "gcp" ]; then
  echo "Dumping cluster for GCP upload..."
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
    # Upload to GCP bucket
    if [ -z "$GCP_BUCKET" ]; then
      echo "ERROR: GCP_BUCKET env var not set for GCP upload." >&2
      exit 1
    fi
    if [ -z "$GCP_CREDENTIALS_JSON" ]; then
      echo "ERROR: GCP_CREDENTIALS_JSON env var not set for GCP upload." >&2
      exit 1
    fi
    echo "Uploading $DUMP_PATH to gs://$GCP_BUCKET/ ..."
    # Activate service account (write credentials to file if not already a file)
    if [ -f "$GCP_CREDENTIALS_JSON" ]; then
      gcloud auth activate-service-account --key-file="$GCP_CREDENTIALS_JSON"
    else
      echo "$GCP_CREDENTIALS_JSON" > /tmp/gcp-creds.json
      gcloud auth activate-service-account --key-file=/tmp/gcp-creds.json
    fi
    gsutil cp "$DUMP_PATH" "gs://$GCP_BUCKET/$(basename "$DUMP_PATH")"
    echo "Upload complete."
  else
    echo "WARNING: pg_dumpall failed (exit $rc). Dump error (first 200 lines):" >&2
    sed -n '1,200p' /tmp/pg_dumpall.err || true
  fi
else
  echo "ERROR: Unknown DUMP_LOCATION value: $DUMP_LOCATION" >&2
  exit 1
fi
