# XXL DB Query Optimization Challenge

## Problem Overview

Large-scale analytics and OLTP systems often encounter SQL queries that become prohibitively slow as data volume grows (100M+ rows). This challenge simulates a real-world scenario where you must optimize a slow SQL workload to run efficiently on a single machine, using pragmatic schema/index/query changes and lightweight engineering. No distributed sharding or external DBs are allowed.

### Domain

- Databases, query optimization, systems engineering, data engineering

### Real-World Story

In production, slow queries cause delays in dashboards, ETL pipelines, and customer-facing features. Your task is to make a given slow SQL workload run acceptably fast on a single machine by applying schema/index/query changes and engineering best practices.

## Technical Details

### Submission Requirements

Submit a ZIP file (or Docker image) containing:

- `migration.sql`: DDL/DML for new tables/indexes/materialized views
- `optimize.sql`: Rewritten queries and helper SQL (functions, views)
- `README.md`: Exact steps to apply the migration and run tests (include commands)
- Optional: `run_tests.sh` (helper script for judge runner)
- Optional: `explanation.txt` (≤500 words, what you changed and why)

#### Constraints

- **DB**: PostgreSQL 14
- **Dataset**: events table ~100M rows; other tables up to ~120M rows
- **Hardware**: 8 vCPU, 32GB RAM, 1TB SSD
- **Migration step**: ≤30 minutes
- **Query timeout**: 4s target, 10s max
- **Auxiliary storage**: ≤30% extra over base DB (scored)
- **No precomputed answer tables for test queries**

### Input Schema

```
CREATE TABLE events (
  event_id   BIGSERIAL PRIMARY KEY,
  user_id    BIGINT NOT NULL,
  device_id  BIGINT,
  event_type VARCHAR(50),
  event_ts   TIMESTAMP WITHOUT TIME ZONE NOT NULL,
  payload    JSONB
);
CREATE TABLE users (
  user_id   BIGINT PRIMARY KEY,
  signup_ts TIMESTAMP,
  country   CHAR(2),
  plan      VARCHAR(20)
);
CREATE TABLE devices (
  device_id   BIGINT PRIMARY KEY,
  device_type VARCHAR(30),
  os_version  VARCHAR(20)
);
```

### Example Benchmark Queries

- **q1**: Count of events per event_type for active users in last 30 days
- **q2**: Recent distinct device types used by users from country 'VN' with a specific payload flag
- **q3**: Top 100 users by number of purchases in last 90 days, with signup date

(Full judge will use parameterized variations of these queries.)

### Evaluation

The judge uses a combination of correctness, latency, concurrency and storage-efficiency to score submissions. Below are the exact measurements, thresholds and formulas used by the judge.

Top-level evaluation components (weights):

- 50% — Correctness
- 30% — Latency
- 10% — Concurrency (throughput under load)
- 10% — Resource efficiency (storage overhead)

Scoring formulas and details

- Correctness (50%): each benchmark query must return results identical to the canonical baseline for the full dataset. For a given query, a full match (rows and ordering where ordering is required) yields 100% for that query's correctness component. Partial matches may receive partial credit for queries where ordering is not required. Any mismatch in values or ordering for queries that require order results in correctness = 0 for that query.

- Latency (30%): for each query the judge runs the query multiple times and computes median_time_ms (median of the measured runs used for scoring). The per-query latency score is:

  score_q = clamp(target_ms / median_time_ms, 0, 1)

  where target_ms = 4000 ms (4s). If the query exceeds the hard timeout (>10s) in any scored run, that run is considered a failure and the query's latency score is 0.

- Concurrency / Throughput (10%): the judge runs a concurrency test where the same query (usually q1 or a representative heavy query) is executed with 10 concurrent clients for 30 seconds and measures successful queries/sec. The throughput score is:

  Btarget = 10.0 # target baseline throughput (queries/sec)
  score_t = clamp(measured_throughput / Btarget, 0, 1)

  Measured_throughput is the number of successful query completions per second during the 30s window. Only successful responses (correct results within timeout) count toward throughput.

- Storage / Resource efficiency (10%): the judge measures additional storage used by auxiliary objects created during `migration.sql` (indexes, materialized views, summary tables, etc). Let base_data_size be the size of the dataset (tables + baseline indexes if any) and extra_storage be the additional space used by objects created by migration. The storage score is:

  score_s = clamp(1 - (extra_storage / (0.3 \* base_data_size)), 0, 1)

  This gives full points if extra_storage ≤ 0.3 \* base_data_size (≤30% extra). If extra_storage approaches the size of the dataset, score_s → 0. If extra_storage ≥ base_data_size, score_s = 0.

Final score

The final numeric score is the weighted sum of the four components (correctness, latency, concurrency, storage) using the weights above. All per-query latency scores are combined into the latency component according to the judge's aggregation (median across repeated runs per query, then averaged across queries as configured by the judge).

Failure conditions

- If a query returns incorrect results (including incorrect ordering when ordering is required), the query's correctness component is 0 and the submission will typically be considered failed for that query.
- If a query run times out (>10s), that run is counted as a failure and may cause score_q = 0 for latency; repeated timeouts lead to a failing submission for that query.
- If `migration.sql` fails (syntax error, crash, or exceeds the 30 minute migration timeout), the submission receives 0 points.

Concurrency test and determinism

- The concurrency test described above runs against a single-machine judge VM (8 vCPU, 32GB RAM). The judge will assert correctness for responses recorded during concurrency testing — only correct responses within timeout count.

Notes on allowed / disallowed techniques

Allowed: indexes (including partial and composite), partitioning (e.g., range partition by event_ts), clustering, materialized views, summary tables (created during migration), query rewriting, PL/pgSQL helper functions, and other single-machine optimizations. EXPLAIN/ANALYZE may be used during development.

Disallowed: precomputing answer tables that directly correspond to the benchmark queries' expected outputs (submissions must not include static result tables matching judge queries), external/remote DBs, sharding across multiple machines, or modifications to the judge harness. Any submission showing evidence of these disallowed techniques will be disqualified.

### Allowed Techniques

- Indexes (including partial/composite)
- Partitioning, clustering
- Materialized views, summary tables
- Query rewriting, PL/pgSQL functions
- Use of EXPLAIN during development

### Disallowed Techniques

- Precomputed answer tables for test queries
- External/remote DBs, distributed sharding
- Modifying judge harness

## Deliverables

- `migration.sql` (schema/index/materialized view changes)
- `optimize.sql` (rewritten queries, helper SQL)
- `README.md` (commands to run migration/tests)
- Optional: `run_tests.sh`, `explanation.txt`

## Scoring

- 50% Correctness
- 30% Latency
- 10% Concurrency
- 10% Storage overhead

## Example Judge Workflow

```
pg_restore -d hackathon_db full_dataset.dump
psql -d hackathon_db -f migration.sql
./run_tests.sh
```

## Hints

- Use indexes, partitioning, materialized views, summary tables
- Use EXPLAIN ANALYZE to optimize plans
- Make scripts idempotent and robust to empty/partial tables

---

**See README.md for exact run instructions.**
