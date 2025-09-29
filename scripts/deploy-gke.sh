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

echo -e "${BLUE}=== Deploying GKE Cluster for eval-in-gke ===$NC"

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
        container.googleapis.com \
        artifactregistry.googleapis.com \
        storage.googleapis.com \
        cloudbuild.googleapis.com \
        iam.googleapis.com \
        compute.googleapis.com \
        --quiet
    
    echo -e "${GREEN}✓ Project setup completed$NC"
}

# Create GKE cluster if not exists
create_gke_cluster() {
    echo -e "${BLUE}Setting up GKE cluster...$NC"
    
    # Check if cluster exists
    if gcloud container clusters describe "$CLUSTER" --zone="$ZONE" &>/dev/null; then
        echo -e "${YELLOW}GKE cluster '$CLUSTER' already exists$NC"
    else
        echo "Creating GKE cluster with e2-micro nodes..."
        gcloud container clusters create "$CLUSTER" \
            --zone="$ZONE" \
            --machine-type=e2-micro \
            --num-nodes=3 \
            --enable-autorepair \
            --enable-autoupgrade \
            --enable-autoscaling \
            --min-nodes=1 \
            --max-nodes=5 \
            --workload-pool="${PROJECT_ID}.svc.id.goog" \
            --disk-size=20GB \
            --disk-type=pd-standard \
            --image-type=COS_CONTAINERD \
            --enable-ip-alias \
            --network=default \
            --subnetwork=default \
            --quiet
    fi
    
    # Get credentials for kubectl
    gcloud container clusters get-credentials "$CLUSTER" --zone="$ZONE"
    
    echo -e "${GREEN}✓ GKE cluster setup completed$NC"
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
            --description="Container images for eval system"
    fi
    
    # Configure Docker auth
    gcloud auth configure-docker us-docker.pkg.dev --quiet
    
    echo -e "${GREEN}✓ Artifact Registry setup completed$NC"
}

# Create GCS bucket if not exists
setup_gcs_bucket() {
    echo -e "${BLUE}Setting up GCS bucket...$NC"
    
    # Check if bucket exists
    if gsutil ls -b "gs://${BUCKET_NAME}" &>/dev/null; then
        echo -e "${YELLOW}GCS bucket '$BUCKET_NAME' already exists$NC"
    else
        echo "Creating GCS bucket..."
        gsutil mb -l us-central1 "gs://${BUCKET_NAME}"
        
        # Set bucket permissions for public read access to dumps
        gsutil iam ch allUsers:objectViewer "gs://${BUCKET_NAME}"
    fi
    
    echo -e "${GREEN}✓ GCS bucket setup completed$NC"
}

# Set up service accounts and workload identity
setup_service_accounts() {
    echo -e "${BLUE}Setting up service accounts...$NC"
    
    # Create Cloud Run service account if not exists
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

    # Create Kaniko service account for building images in-cluster
    if gcloud iam service-accounts describe "${KANIKO_SA}@${PROJECT_ID}.iam.gserviceaccount.com" &>/dev/null; then
        echo -e "${YELLOW}Service account '$KANIKO_SA' already exists$NC"
    else
        echo "Creating Kaniko service account..."
        gcloud iam service-accounts create "$KANIKO_SA" \
            --display-name="Kaniko Builder Service Account"
    fi
    
    # Grant Artifact Registry permissions to Kaniko SA
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:${KANIKO_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
        --role="roles/artifactregistry.writer" \
        --quiet
    
    gcloud projects add-iam-policy-binding "$PROJECT_ID" \
        --member="serviceAccount:${KANIKO_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
        --role="roles/storage.admin" \
        --quiet
    
    echo -e "${GREEN}✓ Service accounts setup completed$NC"
}

# Build and push container image
build_and_push_image() {
    echo -e "${BLUE}Building and pushing container image...$NC"
    
    # Build the main eval image
    echo "Building eval-db image..."
    docker build -t "${IMAGE_REGISTRY}/eval-db:latest" .
    
    # Push to Artifact Registry
    echo "Pushing image to Artifact Registry..."
    docker push "${IMAGE_REGISTRY}/eval-db:latest"
    
    echo -e "${GREEN}✓ Container image built and pushed$NC"
}

# Deploy Kubernetes resources
deploy_k8s_resources() {
    echo -e "${BLUE}Deploying Kubernetes resources...$NC"
    
    # Create namespace and service account
    echo "Applying namespace and service account..."
    kubectl apply -f k8s/namespace.yml
    
    # Set up Workload Identity binding
    echo "Setting up Workload Identity..."
    gcloud iam service-accounts add-iam-policy-binding \
        --role roles/iam.workloadIdentityUser \
        --member "serviceAccount:${PROJECT_ID}.svc.id.goog[eval-system/eval-sa]" \
        "${CLOUD_RUN_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
        --quiet
    
    # Annotate Kubernetes service account
    kubectl annotate serviceaccount eval-sa \
        --namespace eval-system \
        iam.gke.io/gcp-service-account="${CLOUD_RUN_SA}@${PROJECT_ID}.iam.gserviceaccount.com" \
        --overwrite
    
    # Create secrets (encode the credentials)
    echo "Creating secrets..."
    POSTGRES_PASSWORD_B64=$(echo -n "postgres" | base64)
    GCP_CREDENTIALS_B64=$(echo -n "$GCP_CREDENTIALS_JSON" | base64 -w 0)
    
    # Update config.yml with encoded secrets
    sed -i "s|<base64-encoded-password>|$POSTGRES_PASSWORD_B64|g" k8s/config.yml
    sed -i "s|<base64-encoded-service-account-json>|$GCP_CREDENTIALS_B64|g" k8s/config.yml
    
    # Apply config and secrets
    kubectl apply -f k8s/config.yml
    
    echo -e "${GREEN}✓ Kubernetes resources deployed$NC"
}

# Test the deployment
test_deployment() {
    echo -e "${BLUE}Testing deployment...$NC"
    
    # Create a test baseline job
    JOB_NAME="test-baseline-$(date +%Y%m%d-%H%M%S)"
    
    # Create job from template
    sed "s/{JOB_ID}/$JOB_NAME/g; s/{USERS_COUNT}/1000/g; s/{DEVICES_COUNT}/1000/g; s/{EVENTS_COUNT}/10000/g" \
        k8s/job-baseline.yml > "/tmp/${JOB_NAME}.yml"
    
    echo "Creating test job: $JOB_NAME"
    kubectl apply -f "/tmp/${JOB_NAME}.yml"
    
    # Wait a moment and check status
    sleep 10
    echo "Job status:"
    kubectl get job "$JOB_NAME" -n eval-system
    
    echo "Pod status:"
    kubectl get pods -n eval-system -l job-name="$JOB_NAME"
    
    # Clean up test job
    echo "Cleaning up test job..."
    kubectl delete -f "/tmp/${JOB_NAME}.yml" --ignore-not-found
    rm -f "/tmp/${JOB_NAME}.yml"
    
    echo -e "${GREEN}✓ Deployment test completed$NC"
}

# Provide usage examples
show_usage_examples() {
    echo -e "${BLUE}=== Usage Examples ===$NC"
    echo ""
    echo -e "${YELLOW}1. Create a baseline job manually:$NC"
    cat << 'EOF'
JOB_ID="baseline-$(date +%Y%m%d-%H%M%S)"
sed "s/{JOB_ID}/$JOB_ID/g; s/{USERS_COUNT}/50000/g; s/{DEVICES_COUNT}/50000/g; s/{EVENTS_COUNT}/1000000/g" \
    k8s/job-baseline.yml | kubectl apply -f -
EOF
    echo ""
    echo -e "${YELLOW}2. Create a submission job manually:$NC"
    cat << 'EOF'
JOB_ID="submission-$(date +%Y%m%d-%H%M%S)"
REPO_URL="https://github.com/your-username/db-submission"
sed "s/{JOB_ID}/$JOB_ID/g; s|{REPO_URL}|$REPO_URL|g" \
    k8s/job-submission.yml | kubectl apply -f -
EOF
    echo ""
    echo -e "${YELLOW}3. Monitor jobs:$NC"
    echo "kubectl get jobs -n eval-system"
    echo "kubectl get pods -n eval-system"
    echo "kubectl logs -n eval-system -l job-name=<job-name> -f"
    echo ""
    echo -e "${YELLOW}4. Check results in GCS:$NC"
    echo "gsutil ls gs://${BUCKET_NAME}/"
    echo ""
}

# Main execution
main() {
    echo -e "${BLUE}Starting GKE deployment...$NC"
    
    check_prerequisites
    setup_project
    create_gke_cluster
    setup_artifact_registry
    setup_gcs_bucket
    setup_service_accounts
    build_and_push_image
    deploy_k8s_resources
    test_deployment
    
    echo -e "${GREEN}=== GKE deployment completed successfully! ===$NC"
    echo ""
    echo -e "${GREEN}Cluster details:$NC"
    echo "Project: $PROJECT_ID"
    echo "Zone: $ZONE"
    echo "Cluster: $CLUSTER"
    echo "Image Registry: $IMAGE_REGISTRY"
    echo "GCS Bucket: $BUCKET_NAME"
    echo ""
    
    show_usage_examples
}

# Run main function
main "$@"