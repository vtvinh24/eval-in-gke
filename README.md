# eval-in-gke: Database Evaluation System on GKE

This repository contains a containerized database evaluation system that can run baseline data generation and submission query testing on Google Kubernetes Engine (GKE).

## Architecture Overview

```
Judge Server → Cloud Run API Gateway → GKE Jobs → GCS Storage
                                     ↓
                              PostgreSQL + Query Execution
```

### Needed Configurations

- An .env file with local | GCP project details (baseline.gcp.env | submission.gcp.env | baseline.local.env | submission.local.env)
- k8s/config.yml with database and GCS settings
- GCP.env

### Components

1. **Container Image** (`eval-db`): PostgreSQL + evaluation scripts with GCP integration
2. **Cloud Run API Gateway**: REST API for job management
3. **GKE Cluster**: Kubernetes Jobs for running evaluations
4. **GCS Bucket**: Storage for database dumps and outputs
5. **Artifact Registry**: Container image storage

## Prerequisites

- Google Cloud SDK (`gcloud`) installed and authenticated
- Docker installed
- kubectl installed
- GCP project with billing enabled

## Quick Start

1. **Configure environment**:

   ```bash
   # Update GCP.env with your project details
   cp gcp.env GCP.env
   # Edit GCP.env with your PROJECT_ID, ZONE, etc.
   ```

2. **Deploy GKE infrastructure**:

   ```bash
   ./scripts/deploy-gke.sh
   ```

3. **Deploy Cloud Run API Gateway** (optional):

   ```bash
   ./scripts/deploy-cloudrun.sh
   ```

4. **Test the deployment**:
   ```bash
   ./scripts/test-deployment.sh
   ```

## Container Image Updates

The container image has been enhanced with:

- **Job tracking**: Unique job IDs and metadata
- **Progress reporting**: Status updates throughout the process
- **Error handling**: Improved error reporting and recovery
- **GCP integration**: Automatic upload to Cloud Storage

### New Environment Variables

- `JOB_ID`: Unique identifier for the job
- `API_CALLBACK_URL`: Optional webhook for status updates

## API Specifications

### Cloud Run API Endpoints

#### Create Job

```http
POST /api/v1/jobs
Content-Type: application/json

{
  "type": "baseline|submission",
  "repo_url": "https://github.com/user/repo",  # Required for submission
  "config": {
    "users_count": 50000,      # For baseline jobs
    "devices_count": 50000,
    "events_count": 1000000,
    "timeout": 10000,
    "exec_per_query": 5
  }
}
```

Response:

```json
{
  "job_id": "eval-baseline-20240928-143022-abc123",
  "status": "queued",
  "created_at": "2024-09-28T14:30:22Z"
}
```

#### Get Job Status

```http
GET /api/v1/jobs/{job_id}/status
```

Response:

```json
{
  "job_id": "eval-baseline-20240928-143022-abc123",
  "status": "running|completed|failed",
  "progress": "75%",
  "created_at": "2024-09-28T14:30:22Z",
  "completed_at": "2024-09-28T14:45:30Z"
}
```

#### Get Job Results

```http
GET /api/v1/jobs/{job_id}/results
```

Response:

```json
{
  "job_id": "eval-baseline-20240928-143022-abc123",
  "summary": {
    "queries": {
      "Q1": { "status": "success", "avg_time": 145.2 },
      "Q2": { "status": "failed", "error": "timeout" }
    }
  },
  "gcp_output_path": "gs://eval-artifacts-project/job-outputs/"
}
```

## Manual Job Creation

### Baseline Job

```bash
JOB_ID="baseline-$(date +%Y%m%d-%H%M%S)"
sed "s/{JOB_ID}/$JOB_ID/g; s/{USERS_COUNT}/50000/g; s/{DEVICES_COUNT}/50000/g; s/{EVENTS_COUNT}/1000000/g" \
    k8s/job-baseline.yml | kubectl apply -f -
```

### Submission Job

```bash
JOB_ID="submission-$(date +%Y%m%d-%H%M%S)"
REPO_URL="https://github.com/your-username/db-submission"
sed "s/{JOB_ID}/$JOB_ID/g; s|{REPO_URL}|$REPO_URL|g" \
    k8s/job-submission.yml | kubectl apply -f -
```

## Monitoring

### Check Job Status

```bash
# List all jobs
kubectl get jobs -n eval-system

# Get job details
kubectl describe job <job-name> -n eval-system

# View logs
kubectl logs -n eval-system -l job-name=<job-name> -f
```

### Check Outputs

```bash
# List GCS outputs
gsutil ls gs://<bucket-name>/

# Download results
gsutil cp gs://<bucket-name>/<job-id>/summary.json ./
```

## Configuration Files

### Environment Files

- `gcp.env`: Main configuration template
- `GCP.env`: Your customized configuration (gitignored)
- `baseline.gcp.env`: Baseline-specific settings
- `submission.gcp.env`: Submission-specific settings

### Kubernetes Manifests

- `k8s/namespace.yml`: Namespace and service account
- `k8s/config.yml`: ConfigMap and secrets
- `k8s/job-baseline.yml`: Baseline job template
- `k8s/job-submission.yml`: Submission job template

## Resource Configuration

The default configuration uses `e2-micro` instances for cost optimization:

```yaml
resources:
  requests:
    memory: "1Gi"
    cpu: "500m"
  limits:
    memory: "2Gi"
    cpu: "1000m"
```

For larger datasets, consider upgrading to `e2-small` or `e2-medium` instances.

## Troubleshooting

### Common Issues

1. **Permission errors**: Ensure service accounts have proper IAM roles
2. **Resource limits**: Check if you have sufficient GCP quotas
3. **Image pull errors**: Verify Artifact Registry permissions
4. **Job failures**: Check pod logs for detailed error messages

### Debug Commands

```bash
# Check cluster status
kubectl cluster-info

# List failed jobs
kubectl get jobs -n eval-system --field-selector status.failed=1

# Get pod events
kubectl get events -n eval-system --sort-by='.lastTimestamp'

# Check resource usage
kubectl top nodes
kubectl top pods -n eval-system
```

## Security Considerations

- Service accounts use Workload Identity for secure GCP access
- Secrets are stored in Kubernetes secrets (base64 encoded)
- GCS bucket has restricted access for security
- Container images are stored in private Artifact Registry

## Cost Optimization

- Jobs have `ttlSecondsAfterFinished: 3600` for automatic cleanup
- Uses `e2-micro` instances by default
- GKE cluster has autoscaling enabled (1-5 nodes)
- Consider using Spot instances for cost savings

## Development

### Local Testing

```bash
# Test with Docker Compose
docker compose --profile baseline --env-file baseline.local.env up --build

# Test with local Kubernetes (minikube/kind)
kubectl apply -f k8s/
```

### Building Custom Images

```bash
# Build and push custom image
docker build -t ${IMAGE_REGISTRY}/eval-db:custom .
docker push ${IMAGE_REGISTRY}/eval-db:custom

# Update job templates to use custom tag
sed -i 's/:latest/:custom/g' k8s/job-*.yml
```

## Support

For issues and questions:

1. Check the logs using kubectl
2. Verify GCP quotas and permissions
3. Review the troubleshooting section
4. Check GCS bucket for output files

## License

[Your License Here]
