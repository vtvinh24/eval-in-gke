#!/bin/bash
set -euo pipefail

# Configuration (load from GCP.env)
source "$(dirname "$0")/../GCP.env"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Deploying Cloud Run API Gateway for eval-in-gke ===$NC"

# Check prerequisites
check_prerequisites() {
    echo -e "${BLUE}Checking prerequisites...$NC"
    
    # Check if gcloud is installed
    if ! command -v gcloud &> /dev/null; then
        echo -e "${RED}ERROR: gcloud CLI is not installed. Please install it first.$NC"
        exit 1
    fi
    
    # Check if kubectl is installed
    if ! command -v kubectl &> /dev/null; then
        echo -e "${RED}ERROR: kubectl is not installed. Please install it first.$NC"
        exit 1
    fi
    
    # Check if docker is installed
    if ! command -v docker &> /dev/null; then
        echo -e "${RED}ERROR: docker is not installed. Please install it first.$NC"
        exit 1
    fi
    
    # Check if logged in to gcloud
    if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | grep -q .; then
        echo -e "${RED}ERROR: Not logged in to gcloud. Please run: gcloud auth login$NC"
        exit 1
    fi
    
    echo -e "${GREEN}✓ Prerequisites check passed$NC"
}

# Set up GCP project
setup_project() {
    echo -e "${BLUE}Setting up GCP project...$NC"
    
    # Set project
    gcloud config set project "$PROJECT_ID"
    
    # Enable required APIs
    echo "Enabling required APIs..."
    gcloud services enable \
        run.googleapis.com \
        container.googleapis.com \
        artifactregistry.googleapis.com \
        storage.googleapis.com \
        cloudbuild.googleapis.com \
        iam.googleapis.com \
        --quiet
    
    echo -e "${GREEN}✓ Project setup completed$NC"
}

# Create Artifact Registry if not exists
setup_artifact_registry() {
    echo -e "${BLUE}Setting up Artifact Registry...$NC"
    
    # Check if repository exists
    if gcloud artifacts repositories describe "$ARTIFACT_REPO" \
        --location=us \
        --format="value(name)" &>/dev/null; then
        echo -e "${YELLOW}Artifact Registry repository '$ARTIFACT_REPO' already exists$NC"
    else
        echo "Creating Artifact Registry repository..."
        gcloud artifacts repositories create "$ARTIFACT_REPO" \
            --repository-format=docker \
            --location=us \
            --description="Container images for eval system" || {
            echo -e "${YELLOW}Repository might already exist, continuing...$NC"
        }
    fi
    
    # Configure Docker auth
    gcloud auth configure-docker us-docker.pkg.dev --quiet
    
    echo -e "${GREEN}✓ Artifact Registry setup completed$NC"
}

# Create service account if not exists
setup_service_account() {
    echo -e "${BLUE}Setting up service accounts...$NC"
    
    # Cloud Run service account
    if gcloud iam service-accounts describe "${CLOUD_RUN_SA}@${PROJECT_ID}.iam.gserviceaccount.com" &>/dev/null; then
        echo -e "${YELLOW}Service account '$CLOUD_RUN_SA' already exists$NC"
    else
        echo "Creating Cloud Run service account..."
        gcloud iam service-accounts create "$CLOUD_RUN_SA" \
            --display-name="Cloud Run Eval API Service Account"
    fi
    
    # Grant necessary permissions to Cloud Run SA
    echo "Granting permissions to Cloud Run service account..."
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:${CLOUD_RUN_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
        --role="roles/container.admin" \
        --quiet
    
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:${CLOUD_RUN_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
        --role="roles/storage.admin" \
        --quiet
    
    echo -e "${GREEN}✓ Service account setup completed$NC"
}

# Create API Gateway Cloud Run service
create_api_gateway() {
    echo -e "${BLUE}Creating API Gateway service...$NC"
    
    # Create a simple API gateway service
    cat > api-gateway.py << 'EOF'
import os
import json
import uuid
from datetime import datetime, timezone
from flask import Flask, request, jsonify
from google.cloud import container_v1
from kubernetes import client, config
import base64
import yaml

app = Flask(__name__)

# Configure Kubernetes client
try:
    config.load_incluster_config()
except:
    config.load_kube_config()

k8s_batch_v1 = client.BatchV1Api()
k8s_core_v1 = client.CoreV1Api()

PROJECT_ID = os.environ.get('PROJECT_ID', 'hackathon-demo-473203')
ZONE = os.environ.get('ZONE', 'us-central1-a')
CLUSTER_NAME = os.environ.get('CLUSTER', 'cluster-1')
NAMESPACE = os.environ.get('NAMESPACE', 'eval-system')

@app.route('/health', methods=['GET'])
def health():
    return jsonify({"status": "healthy", "timestamp": datetime.now(timezone.utc).isoformat()})

@app.route('/api/v1/jobs', methods=['POST'])
def create_job():
    try:
        data = request.get_json()
        job_type = data.get('type', 'baseline')  # baseline or submission
        repo_url = data.get('repo_url', '')
        config_data = data.get('config', {})
        
        # Generate unique job ID
        job_id = f"eval-{job_type}-{datetime.now().strftime('%Y%m%d-%H%M%S')}-{str(uuid.uuid4())[:8]}"
        
        # Load job template
        if job_type == 'baseline':
            template_path = '/app/k8s/job-baseline.yml'
        else:
            template_path = '/app/k8s/job-submission.yml'
        
        with open(template_path, 'r') as f:
            job_manifest = yaml.safe_load(f)
        
        # Update job manifest
        job_manifest['metadata']['name'] = job_id
        
        # Update environment variables
        container = job_manifest['spec']['template']['spec']['containers'][0]
        env_vars = container.get('env', [])
        
        # Add job-specific environment variables
        env_vars.append({'name': 'JOB_ID', 'value': job_id})
        
        if job_type == 'baseline':
            env_vars.append({'name': 'USERS_COUNT', 'value': str(config_data.get('users_count', 50000))})
            env_vars.append({'name': 'DEVICES_COUNT', 'value': str(config_data.get('devices_count', 50000))})
            env_vars.append({'name': 'EVENTS_COUNT', 'value': str(config_data.get('events_count', 1000000))})
        else:
            env_vars.append({'name': 'REPO_URL', 'value': repo_url})
        
        container['env'] = env_vars
        
        # Create the job
        k8s_batch_v1.create_namespaced_job(namespace=NAMESPACE, body=job_manifest)
        
        return jsonify({
            "job_id": job_id,
            "status": "queued",
            "created_at": datetime.now(timezone.utc).isoformat()
        }), 201
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/v1/jobs/<job_id>/status', methods=['GET'])  
def get_job_status(job_id):
    try:
        # Get job from Kubernetes
        job = k8s_batch_v1.read_namespaced_job(name=job_id, namespace=NAMESPACE)
        
        status = "queued"
        if job.status.active:
            status = "running"
        elif job.status.succeeded:
            status = "completed"
        elif job.status.failed:
            status = "failed"
        
        response = {
            "job_id": job_id,
            "status": status,
            "created_at": job.metadata.creation_timestamp.isoformat(),
        }
        
        if job.status.completion_time:
            response["completed_at"] = job.status.completion_time.isoformat()
        
        return jsonify(response)
        
    except client.exceptions.ApiException as e:
        if e.status == 404:
            return jsonify({"error": "Job not found"}), 404
        return jsonify({"error": str(e)}), 500

@app.route('/api/v1/jobs/<job_id>/results', methods=['GET'])
def get_job_results(job_id):
    try:
        # Check if job is completed
        job = k8s_batch_v1.read_namespaced_job(name=job_id, namespace=NAMESPACE)
        
        if not job.status.succeeded:
            return jsonify({"error": "Job not completed yet"}), 400
        
        # Get pod logs to extract results
        pods = k8s_core_v1.list_namespaced_pod(
            namespace=NAMESPACE,
            label_selector=f"job-name={job_id}"
        )
        
        if not pods.items:
            return jsonify({"error": "No pods found for job"}), 404
        
        pod_name = pods.items[0].metadata.name
        
        # Try to get summary from pod logs or mounted volume
        # This is a simplified implementation - in production you'd want
        # to mount a shared volume or use a sidecar to extract results
        
        return jsonify({
            "job_id": job_id,
            "summary": {"status": "completed", "note": "Results available in GCS"},
            "gcp_output_path": f"gs://{os.environ.get('GCP_BUCKET', 'eval-artifacts-hackathon-demo-473203')}/{job_id}/"
        })
        
    except Exception as e:
        return jsonify({"error": str(e)}), 500

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
EOF

    # Create Dockerfile for API Gateway
    cat > Dockerfile.api << 'EOF'
FROM python:3.9-slim

RUN pip install flask google-cloud-container kubernetes pyyaml google-cloud-storage

WORKDIR /app

COPY api-gateway.py .
COPY k8s/ ./k8s/

ENV PORT=8080
EXPOSE 8080

CMD ["python", "api-gateway.py"]
EOF

    # Build and push API Gateway image
    echo "Building API Gateway image..."
    docker build -f ./Dockerfile.api -t "${IMAGE_REGISTRY}/api-gateway:latest" ..
    docker push "${IMAGE_REGISTRY}/api-gateway:latest"
    
    # Deploy to Cloud Run
    echo "Deploying to Cloud Run..."
    gcloud run deploy eval-api-gateway \
        --image="${IMAGE_REGISTRY}/api-gateway:latest" \
        --platform=managed \
        --region=us-central1 \
        --allow-unauthenticated \
        --service-account="${CLOUD_RUN_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
        --set-env-vars="PROJECT_ID=${PROJECT_ID},ZONE=${ZONE},CLUSTER=${CLUSTER},NAMESPACE=eval-system,GCP_BUCKET=${BUCKET_NAME}" \
        --memory=1Gi \
        --cpu=1 \
        --timeout=300 \
        --max-instances=10 \
        --quiet
    
    # Get the service URL
    SERVICE_URL=$(gcloud run services describe eval-api-gateway \
        --region=us-central1 \
        --format="value(status.url)")
    
    echo -e "${GREEN}✓ API Gateway deployed successfully$NC"
    echo -e "${GREEN}Service URL: $SERVICE_URL$NC"
    
    # Clean up temporary files
    rm -f api-gateway.py Dockerfile.api
}

# Main execution
main() {
    echo -e "${BLUE}Starting Cloud Run deployment...$NC"
    
    check_prerequisites
    setup_project
    setup_artifact_registry
    setup_service_account
    create_api_gateway
    
    echo -e "${GREEN}=== Cloud Run deployment completed successfully! ===$NC"
    echo -e "${YELLOW}Next steps:$NC"
    echo "1. Deploy the GKE cluster using: ./scripts/deploy-gke.sh"
    echo "2. Test the API endpoints:"
    echo "   - Health check: GET $SERVICE_URL/health"
    echo "   - Create job: POST $SERVICE_URL/api/v1/jobs"
    echo "   - Job status: GET $SERVICE_URL/api/v1/jobs/{job_id}/status"
    echo "   - Job results: GET $SERVICE_URL/api/v1/jobs/{job_id}/results"
}

# Run main function
main "$@"