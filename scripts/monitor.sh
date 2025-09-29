#!/usr/bin/env bash
set -euo pipefail

TRACE_FILE="${1:-${OUT_DIR:-/output}/trace.json}"
INTERVAL="${MONITOR_INTERVAL:-5}"
OUT_DIR="${OUT_DIR:-/output}"
JOB_ID="${JOB_ID:-unknown}"
MODE="${INIT_MODE:-unknown}"
HOSTNAME_VALUE="${HOSTNAME:-unknown}"
PGDATA_DIR="${PGDATA:-/var/lib/postgresql/data}"

if ! [[ "$INTERVAL" =~ ^[0-9]+([.][0-9]+)?$ ]]; then
  INTERVAL=5
fi

START_TS=$(date -u +%Y-%m-%dT%H:%M:%SZ)
START_UNIX=$(date +%s)
TMP_SAMPLES=$(mktemp)

echo "monitor.sh starting with interval ${INTERVAL}s, output -> ${TRACE_FILE}" >&2

cleanup() {
  local exit_code=$?
  local raw_exit_code=$exit_code
  local signal_value="null"
  if (( raw_exit_code > 128 )); then
    signal_value=$(( raw_exit_code - 128 ))
    exit_code=0
  fi
  local finished_ts
  finished_ts=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  local end_unix
  end_unix=$(date +%s)
  local duration_seconds=$(( end_unix - START_UNIX ))
  local samples_json="[]"

  if [[ -s "$TMP_SAMPLES" ]]; then
    if ! samples_json=$(jq -s '.' "$TMP_SAMPLES" 2>/dev/null); then
      samples_json="[]"
    fi
  fi
  local interval_json exit_json raw_exit_json signal_json duration_json
  interval_json="$INTERVAL"
  exit_json="$exit_code"
  raw_exit_json="$raw_exit_code"
  duration_json="$duration_seconds"
  if [[ "$signal_value" == "null" ]]; then
    signal_json="null"
  else
    signal_json="$signal_value"
  fi

  jq -n \
    --arg job_id "$JOB_ID" \
    --arg mode "$MODE" \
    --arg host "$HOSTNAME_VALUE" \
    --arg started "$START_TS" \
    --arg finished "$finished_ts" \
    --argjson interval "$interval_json" \
    --argjson duration "$duration_json" \
    --argjson exit_code "$exit_json" \
    --argjson raw_exit "$raw_exit_json" \
    --argjson signal "$signal_json" \
    --argjson samples "$samples_json" \
    '{
      metadata: {
        job_id: $job_id,
        mode: $mode,
        host: $host,
        interval_seconds: $interval,
        started_at: $started,
        finished_at: $finished,
        duration_seconds: $duration,
        exit_code: $exit_code,
        raw_exit_code: $raw_exit,
        signal: $signal
      },
      samples: $samples
  }' > "$TRACE_FILE"

  rm -f "$TMP_SAMPLES"
  exit "$exit_code"
}
trap cleanup EXIT INT TERM

mkdir -p "$(dirname "$TRACE_FILE")"

while true; do
  timestamp=$(date -u +%Y-%m-%dT%H:%M:%SZ)

  # Aggregate process metrics (postgres & helper scripts)
  ps_metrics=$(ps -eo pid=,%cpu=,%mem=,rss=,comm= |
      awk 'BEGIN { cpu=0; mem=0; rss=0; count=0 }
      /postgres|query-runner|psql|entrypoint/ {
        cpu+=$2; mem+=$3; rss+=$4; count++
      }
      END {
        if (count == 0) {
          printf "0 0 0\n"
        } else {
          printf "%.2f %.2f %.0f\n", cpu, mem, rss
        }
      }')
  read -r cpu_total mem_total rss_total_kb <<<"$ps_metrics"
  rss_total_kb=${rss_total_kb:-0}
  rss_bytes=$(awk -v rss="$rss_total_kb" 'BEGIN{printf "%.0f", rss * 1024}')

  # Database metrics (safe defaults if unavailable)
  connections=$(psql -qtAX -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -c "SELECT count(*) FROM pg_stat_activity;" 2>/dev/null || echo "0")
  connections=${connections//[[:space:]]/}
  if [[ -z "$connections" ]]; then
    connections=0
  fi
  active_queries=$(psql -qtAX -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -c "SELECT count(*) FROM pg_stat_activity WHERE state <> 'idle';" 2>/dev/null || echo "0")
  active_queries=${active_queries//[[:space:]]/}
  if [[ -z "$active_queries" ]]; then
    active_queries=0
  fi
  db_size=$(psql -qtAX -U "${POSTGRES_USER:-postgres}" -d "${POSTGRES_DB:-postgres}" -c "SELECT COALESCE(pg_database_size(current_database()),0);" 2>/dev/null || echo "0")
  db_size=${db_size//[[:space:]]/}
  if [[ -z "$db_size" ]]; then
    db_size=0
  fi

  # Filesystem usage
  data_dir_bytes=0
  if output=$(df --block-size=1 "$PGDATA_DIR" 2>/dev/null | awk 'NR==2 {print $3}'); then
    data_dir_bytes=${output:-0}
  fi
  wal_dir_bytes=0
  if output=$(du -sb "$PGDATA_DIR/pg_wal" 2>/dev/null); then
    wal_dir_bytes=$(echo "$output" | awk '{print $1}')
  fi
  output_dir_bytes=0
  if output=$(du -sb "$OUT_DIR" 2>/dev/null); then
    output_dir_bytes=$(echo "$output" | awk '{print $1}')
  fi

  # Load averages
  read -r load1 load5 load15 _ < /proc/loadavg

  sample=$(jq -n \
    --arg ts "$timestamp" \
    --arg cpu "$cpu_total" \
    --arg mem "$mem_total" \
    --arg rss "$rss_bytes" \
    --arg connections "${connections:-0}" \
    --arg active "${active_queries:-0}" \
    --arg db_size "${db_size:-0}" \
    --arg data_bytes "${data_dir_bytes:-0}" \
    --arg output_bytes "${output_dir_bytes:-0}" \
    --arg wal_bytes "${wal_dir_bytes:-0}" \
    --arg load1 "${load1:-0}" \
    --arg load5 "${load5:-0}" \
    --arg load15 "${load15:-0}" \
    '{
      timestamp: $ts,
      cpu_total_percent: ($cpu|tonumber),
      memory_total_percent: ($mem|tonumber),
      rss_bytes: ($rss|tonumber),
      connections: ($connections|tonumber),
      active_queries: ($active|tonumber),
      database_size_bytes: ($db_size|tonumber),
      data_directory_bytes: ($data_bytes|tonumber),
      output_directory_bytes: ($output_bytes|tonumber),
      wal_directory_bytes: ($wal_bytes|tonumber),
      load_avg_1m: ($load1|tonumber),
      load_avg_5m: ($load5|tonumber),
      load_avg_15m: ($load15|tonumber)
    }')

  echo "$sample" >> "$TMP_SAMPLES"

  sleep "$INTERVAL"
done
