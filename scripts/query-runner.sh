#!/usr/bin/env bash
set -euo pipefail

# Parameters come from environment variables (all validated by entrypoint)
# No defaults - all variables must be set by entrypoint validation
mkdir -p "$OUT_DIR"
chmod 0777 "$OUT_DIR" 2>/dev/null || true

# Disable pager and psqlrc to avoid interactive formatting or delays. Keep machine-friendly flags.
# Do NOT force TCP via -h localhost; prefer the Unix domain socket (default) so the
# script can connect even when Postgres is configured to listen on sockets only.
PSQL="psql -U $POSTGRES_USER -d $POSTGRES_DB -q -t -A -F '|' -P pager=off --no-psqlrc"

# raw output directory for per-run logs
RAW_DIR="$OUT_DIR/raw"
mkdir -p "$RAW_DIR"
chmod 0777 "$RAW_DIR" 2>/dev/null || true

# Prepare JSON summary (we no longer write per-run raw files or CSV)
JSON_SUM="$OUT_DIR/summary.json"
jq -n '{}' > "$JSON_SUM" || true
chmod 0666 "$JSON_SUM" || true

# Import job status update function if available
if declare -F update_job_status >/dev/null; then
  echo "Job status updates enabled"
else
  # Define dummy function if not available
  update_job_status() { echo "Status: $1, Progress: $2"; }
fi

start_all=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Helper: run a SQL file with timeout (ms). Uses coreutils timeout which accepts seconds; convert ms->s with fraction
run_with_timeout() {
  local ms=$1; shift
  local cmd=("$@")
  # convert ms to seconds with millisecond precision
  sec=$(awk "BEGIN{printf \"%.3f\", ${ms}/1000}")
  timeout --foreground "${sec}s" "${cmd[@]}"
}

# Run migration first if present
MIG_FILE=/source/migration.sql
migration_status="missing"
migration_time=0
if [ -f "$MIG_FILE" ] && [ -s "$MIG_FILE" ]; then
  echo "Found migration script $MIG_FILE. Running..."
  mig_start=$(date +%s%3N)
  # run migration with timeout; capture output to a log so failures are visible
  MIG_LOG="$OUT_DIR/migration.log"
  rm -f "$MIG_LOG" || true
  # run migration and redirect stdout/stderr to MIG_LOG
  # Use bash -lc to ensure the environment assignment is interpreted by a shell
  # (otherwise timeout will try to execute the literal string 'PGPASSWORD=...').
  if run_with_timeout "$EXEC_TIMEOUT" bash -lc "PGPASSWORD=\"${POSTGRES_PASSWORD:-postgres}\" $PSQL -f \"$MIG_FILE\"" >"$MIG_LOG" 2>&1; then
    mig_end=$(date +%s%3N)
    migration_time=$(awk "BEGIN{printf \"%.3f\", (${mig_end}-${mig_start})/1000}")
    migration_status="success"
  else
    mig_end=$(date +%s%3N)
    migration_time=$(awk "BEGIN{printf \"%.3f\", (${mig_end}-${mig_start})/1000}")
    migration_status="failed"
  fi
else
  echo "No migration script found or file empty; skipping migration."
fi
echo "Migration status: $migration_status, time: $migration_time"

# If a migration log was produced, print a short excerpt to the console for debugging
if [ -f "$MIG_LOG" ]; then
  echo "---- migration.log (first 200 lines) ----"
  sed -n '1,200p' "$MIG_LOG" || true
  echo "---- end migration.log ----"
fi

# Build initial JSON structure
jq -n --arg status "$migration_status" --arg time "$migration_time" '{migration: {status: $status, time: $time}, queries: {}}' > "$JSON_SUM"

# Determine queries list from QUERIES env, default to files in /source
if [ -n "${QUERIES-}" ]; then
  IFS=',' read -r -a QLIST <<< "$QUERIES"
else
  # fallback: find .sql files (excluding migration.sql)
  mapfile -t QFILES < <(shopt -s nullglob; for f in /source/*.sql; do [ "$(basename $f)" = migration.sql ] && continue; echo "${f##*/}"; done)
  QLIST=("${QFILES[@]}")
fi

# Track query progress
total_queries=${#QLIST[@]}
completed_queries=0

for q in "${QLIST[@]}"; do
  # allow q to be 'Q1' or 'Q1.sql'
  qname="$q"
  if [[ "$qname" != *.sql ]]; then
    sqlname="$qname.sql"
  else
    sqlname="$qname"
    qname="${qname%.sql}"
  fi
  
  # Calculate progress (50% base + 40% for queries + 10% for dump)
  current_progress=$((50 + (40 * completed_queries / total_queries)))
  update_job_status "running" "${current_progress}%" null

  sqlpath="/source/$sqlname"
  if [ ! -f "$sqlpath" ]; then
    echo "Query $sqlname missing in /source. Marking missing."
    # add to JSON as missing
    jq --arg q "$qname" '.queries[$q] = {status: "missing"}' "$JSON_SUM" > "$JSON_SUM.tmp" && mv "$JSON_SUM.tmp" "$JSON_SUM"
    continue
  fi
  
  # Check if the SQL file is empty or contains only whitespace/comments
  if [ ! -s "$sqlpath" ]; then
    echo "Query $sqlname is empty. Marking empty."
    jq --arg q "$qname" '.queries[$q] = {status: "empty"}' "$JSON_SUM" > "$JSON_SUM.tmp" && mv "$JSON_SUM.tmp" "$JSON_SUM"
    continue
  fi
  
  # Check if file contains only comments and whitespace (no actual SQL statements)
  sql_content=$(grep -v '^\s*--' "$sqlpath" | grep -v '^\s*/\*' | grep -v '^\s*\*' | grep -v '^\s*\*/' | sed '/^\s*$/d')
  if [ -z "$sql_content" ]; then
    echo "Query $sqlname contains only comments/whitespace. Marking empty."
    jq --arg q "$qname" '.queries[$q] = {status: "empty"}' "$JSON_SUM" > "$JSON_SUM.tmp" && mv "$JSON_SUM.tmp" "$JSON_SUM"
    continue
  fi

  # mark query as pending in JSON
  jq --arg q "$qname" '.queries[$q] = {status: "pending", runs: []}' "$JSON_SUM" > "$JSON_SUM.tmp" && mv "$JSON_SUM.tmp" "$JSON_SUM"

  echo "Running query $sqlname ($EXEC_PER_QUERY runs)"
  for ((i=1;i<=EXEC_PER_QUERY;i++)); do
    start_ms=$(date +%s%3N)
    echo "-> Executing $sqlname run $i/$EXEC_PER_QUERY (timeout ${EXEC_TIMEOUT}ms)"
    # Execute with timeout; capture stdout/stderr in-memory (no temp files)
    set +e
    # Use a newline between the psql backslash commands so '\timing on' is not passed the trailing semicolon
    # which makes psql interpret it as 'on;' (invalid). We use $'...' style so the literal \timing and \i
    # reach psql correctly inside the -c argument.
  tmpfile=$(mktemp)
  rawfile="$RAW_DIR/${qname}-run${i}.log"
  # create a temporary SQL file that enables timing then includes the target SQL
  tmp_sql=$(mktemp)
  printf '%s
' "\\timing on" > "$tmp_sql"
  cat "$sqlpath" >> "$tmp_sql"
  # run psql on the combined tmp_sql and capture output
  run_with_timeout "$EXEC_TIMEOUT" bash -lc "PGPASSWORD=\"${POSTGRES_PASSWORD:-postgres}\" $PSQL -f \"$tmp_sql\"" > "$tmpfile" 2>&1
  rc=$?
  set -e
  # store output and copy raw log
  output=$(cat "$tmpfile" || true)
  cp "$tmpfile" "$rawfile" 2>/dev/null || true
  chmod 0666 "$rawfile" 2>/dev/null || true
  rm -f "$tmpfile" "$tmp_sql" || true

    if [ $rc -eq 0 ]; then
      status_run="success"
    else
      if [ $rc -eq 124 ]; then
        status_run="timeout"
      else
        status_run="failed"
      fi
    fi

    end_ms=$(date +%s%3N)

    # Extract latency from any 'Time: N ms' lines in output; otherwise use measured ms
    latency_ms=$(echo "$output" | sed -n 's/^Time: \([0-9.]*\) ms$/\1/p' | tail -n1)
    if [ -z "$latency_ms" ]; then
      latency_ms=$((end_ms - start_ms))
    fi

    # Rows: count non-empty lines that are not 'Time:' lines
    rows=$(echo "$output" | sed '/^Time:/d' | sed '/^\s*$/d' | wc -l | tr -d ' ')
    # Bytes: count bytes of the output excluding timing lines
    bytes=$(echo "$output" | sed '/^Time:/d' | wc -c | tr -d ' ')

    now_iso=$(date -u +%Y-%m-%dT%H:%M:%SZ)
    if [ "${latency_ms}" -gt 0 ] 2>/dev/null; then
      rows_per_sec=$(awk "BEGIN{printf \"%.3f\", ($rows)/($latency_ms/1000)}")
      bytes_per_sec=$(awk "BEGIN{printf \"%.3f\", ($bytes)/($latency_ms/1000)}")
    else
      rows_per_sec=0
      bytes_per_sec=0
    fi

    # Log run result to console (does not affect JSON)
    echo "   <- Result: status=$status_run latency=${latency_ms}ms rows=${rows} bytes=${bytes} rows/s=${rows_per_sec} bytes/s=${bytes_per_sec}"

    # append run info to JSON (no raw file paths)
    jq --arg q "$qname" --argjson runidx $i \
       --arg status "$status_run" --arg time "$latency_ms" --arg rows "$rows" --arg bytes "$bytes" \
       '.queries[$q].runs += [ {run: $runidx, status: $status, time: $time|tonumber, rows: ($rows|tonumber), bytes: ($bytes|tonumber)} ]' \
       "$JSON_SUM" > "$JSON_SUM.tmp" && mv "$JSON_SUM.tmp" "$JSON_SUM"

    # If this run failed due to missing/timeout/failed, we still continue next runs (per requirement not to skip unless missing)

    # wait between repeated executions
    if [ $i -lt $EXEC_PER_QUERY ]; then
      echo "   ...waiting ${EXEC_INTERVAL}ms before next run of $sqlname"
      sleep $(awk "BEGIN{print ${EXEC_INTERVAL}/1000}")
    fi
  done

  # After all runs, determine overall query status: success if any run success, else failed
  # Compute status by checking runs
  qstatus=$(jq -r --arg q "$qname" '.queries[$q].runs[].status' "$JSON_SUM" | awk 'BEGIN{ok=0}{if($0=="success") ok=1}END{print ok?"success":"failed"}')
  jq --arg q "$qname" --arg status "$qstatus" '.queries[$q].status=$status' "$JSON_SUM" > "$JSON_SUM.tmp" && mv "$JSON_SUM.tmp" "$JSON_SUM"

  # Update progress
  completed_queries=$((completed_queries + 1))
  current_progress=$((50 + (40 * completed_queries / total_queries)))
  update_job_status "running" "${current_progress}%" null

  # wait between queries
  echo "...waiting ${EXEC_INTERVAL_Q}ms before next query"
  sleep $(awk "BEGIN{print ${EXEC_INTERVAL_Q}/1000}")
done

end_all=$(date -u +%Y-%m-%dT%H:%M:%SZ)

# Add summary metadata
jq --arg start "$start_all" --arg end "$end_all" '. + {started_at: $start, finished_at: $end}' "$JSON_SUM" > "$JSON_SUM.tmp" && mv "$JSON_SUM.tmp" "$JSON_SUM"

echo "Completed runs. Summary: $JSON_SUM"
