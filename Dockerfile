FROM postgres:14

# Install dependencies for GCP access and query execution
RUN --mount=type=cache,id=apt-lists,target=/var/lib/apt/lists \
  --mount=type=cache,id=apt-cache,target=/var/cache/apt \
  rm -f /etc/apt/apt.conf.d/docker-clean \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends \
     jq \
     curl \
     ca-certificates \
     gnupg \
     wget \
     git \
     uuid-runtime \
  && mkdir -p /usr/share/keyrings \
  && curl -fsSL https://packages.cloud.google.com/apt/doc/apt-key.gpg | gpg --dearmor -o /usr/share/keyrings/cloud.google.gpg \
  && echo "deb [signed-by=/usr/share/keyrings/cloud.google.gpg] https://packages.cloud.google.com/apt cloud-sdk main" | tee -a /etc/apt/sources.list.d/google-cloud-sdk.list \
  && apt-get update \
  && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends google-cloud-sdk \
  && apt-get clean

# Copy baseline setup files
COPY scripts/init-db.sh /sql-templates/init-db.sh
COPY scripts/init-db.sql /sql-templates/init-db.sql
COPY scripts/source /source

# Copy submission files (will be used only in submission mode)
COPY scripts/submission /submission

# Copy all scripts and make them executable
COPY scripts/entrypoint.sh /usr/local/bin/entrypoint.sh
COPY scripts/query-runner.sh /usr/local/bin/query-runner.sh
COPY scripts/dump-db.sh /usr/local/bin/dump-db.sh
COPY scripts/get-latest-baseline.sh /scripts/get-latest-baseline.sh
RUN chmod +x /usr/local/bin/entrypoint.sh /usr/local/bin/query-runner.sh /usr/local/bin/dump-db.sh /scripts/get-latest-baseline.sh

EXPOSE 5432

# Default environment variables (can be overridden by docker-compose or k8s)
ENV INIT_MODE=CREATE
ENV SCHEMA_SQL=/sql-templates/init-db.sql
ENV UPLOAD_ENABLED=""
ENV UPLOAD_LOCATION=gcp
ENV DUMP_ENABLED=""
ENV REPO_URL=""
ENV JOB_ID=""
ENV API_CALLBACK_URL=""

ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]