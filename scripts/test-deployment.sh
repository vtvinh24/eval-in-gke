#!/bin/bash
set -euo pipefail

# Configuration
source "$(dirname "$0")/GCP.env"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo -e "${BLUE}=== Testing eval-in-gke Deployment ===$NC"

# Test Cloud Run API (if deployed)
test_cloudrun_api() {
    echo -e "${BLUE}Testing Cloud Run API...$NC"
    
    # Get Cloud Run service URL
    if SERVICE_URL=$(gcloud run services describe eval-api-gateway \
        --region=us-central1 \
        --format="value(status.url)" 2>/dev/null); then
        
        echo "Testing health endpoint..."
        if curl -s "$SERVICE_URL/health" | jq -e '.status == "healthy"' >/dev/null; then
            echo -e "${GREEN}✓ Cloud Run API health check passed$NC"
        else
            echo -e "${RED}✗ Cloud Run API health check failed$NC"
        fi
        
        echo "Service URL: $SERVICE_URL"
    else
        echo -e "${YELLOW}Cloud Run API not deployed or not found$NC"
    fi
}

# Test GKE cluster
test_gke_cluster() {
    echo -e "${BLUE}Testing GKE cluster...$NC"
    
    # Check if cluster exists and is accessible
    if gcloud container clusters describe "$CLUSTER" --zone="$ZONE" &>/dev/null; then
        echo -e "${GREEN}✓ GKE cluster exists$NC"
        
        # Get credentials
        gcloud container clusters get-credentials "$CLUSTER" --zone="$ZONE" --quiet
        
        # Test kubectl connectivity
        if kubectl get nodes &>/dev/null; then
            echo -e "${GREEN}✓ kubectl connectivity works$NC"
            echo "Cluster nodes:"
            kubectl get nodes
        else
            echo -e "${RED}✗ kubectl connectivity failed$NC"
        fi
        
        # Check namespace
        if kubectl get namespace eval-system &>/dev/null; then
            echo -e "${GREEN}✓ eval-system namespace exists$NC"
        else
            echo -e "${RED}✗ eval-system namespace missing$NC"
        fi
        
        # Check service account
        if kubectl get serviceaccount eval-sa -n eval-system &>/dev/null; then
            echo -e "${GREEN}✓ eval-sa service account exists$NC"
        else
            echo -e "${RED}✗ eval-sa service account missing$NC"
        fi
        
        # Check configmap and secrets
        if kubectl get configmap eval-config -n eval-system &>/dev/null; then
            echo -e "${GREEN}✓ eval-config configmap exists$NC"
        else
            echo -e "${RED}✗ eval-config configmap missing$NC"
        fi
        
        if kubectl get secret eval-secrets -n eval-system &>/dev/null; then
            echo -e "${GREEN}✓ eval-secrets secret exists$NC"
        else
            echo -e "${RED}✗ eval-secrets secret missing$NC"
        fi
        
    else
        echo -e "${RED}✗ GKE cluster not found$NC"
    fi
}

# Test Artifact Registry
test_artifact_registry() {
    echo -e "${BLUE}Testing Artifact Registry...$NC"
    
    if gcloud artifacts repositories describe "$ARTIFACT_REPO" \
        --location=us &>/dev/null; then
        echo -e "${GREEN}✓ Artifact Registry repository exists$NC"
        
        # Check if eval-db image exists
        if gcloud artifacts docker images list "${IMAGE_REGISTRY}" \
            --include-tags --format="value(IMAGE)" | grep -q "eval-db"; then
            echo -e "${GREEN}✓ eval-db image found in registry$NC"
        else
            echo -e "${YELLOW}⚠ eval-db image not found in registry$NC"
        fi
    else
        echo -e "${RED}✗ Artifact Registry repository not found$NC"
    fi
}

# Test GCS bucket
test_gcs_bucket() {
    echo -e "${BLUE}Testing GCS bucket...$NC"
    
    if gsutil ls -b "gs://${BUCKET_NAME}" &>/dev/null; then
        echo -e "${GREEN}✓ GCS bucket exists$NC"
        
        # List contents
        echo "Bucket contents:"
        gsutil ls "gs://${BUCKET_NAME}/" 2>/dev/null || echo "(empty)"
    else
        echo -e "${RED}✗ GCS bucket not found$NC"
    fi
}

# Run a quick test job
run_test_job() {
    echo -e "${BLUE}Running test job...$NC"
    
    # Create a small test job
    JOB_NAME="test-$(date +%Y%m%d-%H%M%S)"
    
    # Create job manifest
    cat > "/tmp/${JOB_NAME}.yml" << EOF
apiVersion: batch/v1
kind: Job
metadata:
  name: $JOB_NAME
  namespace: eval-system
spec:
  ttlSecondsAfterFinished: 300
  template:
    spec:
      serviceAccountName: eval-sa
      restartPolicy: Never
      containers:
      - name: eval
        image: ${IMAGE_REGISTRY}/eval-db:latest
        resources:
          requests:
            memory: "512Mi"
            cpu: "200m"
          limits:
            memory: "1Gi"
            cpu: "500m"
        env:
        - name: INIT_MODE
          value: "CREATE"
        - name: USERS_COUNT
          value: "100"
        - name: DEVICES_COUNT
          value: "100"
        - name: EVENTS_COUNT
          value: "1000"
        - name: QUERIES_DIR
          value: "/source"
        - name: JOB_ID
          value: "$JOB_NAME"
        - name: TIMEOUT
          value: "30000"
        envFrom:
        - configMapRef:
            name: eval-config
        - secretRef:
            name: eval-secrets
        volumeMounts:
        - name: output-storage
          mountPath: /output
      volumes:
      - name: output-storage
        emptyDir: {}
EOF

    echo "Creating test job: $JOB_NAME"
    if kubectl apply -f "/tmp/${JOB_NAME}.yml"; then
        echo "Waiting for job to start..."
        sleep 10
        
        echo "Job status:"
        kubectl get job "$JOB_NAME" -n eval-system
        
        echo "Pod status:"
        kubectl get pods -n eval-system -l job-name="$JOB_NAME"
        
        # Get pod logs if available
        if POD_NAME=$(kubectl get pods -n eval-system -l job-name="$JOB_NAME" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null); then
            echo "Recent logs from $POD_NAME:"
            kubectl logs "$POD_NAME" -n eval-system --tail=20 || echo "No logs available yet"
        fi
        
        # Clean up
        echo "Cleaning up test job..."
        kubectl delete -f "/tmp/${JOB_NAME}.yml" --ignore-not-found
        rm -f "/tmp/${JOB_NAME}.yml"
        
        echo -e "${GREEN}✓ Test job completed$NC"
    else
        echo -e "${RED}✗ Failed to create test job$NC"
        rm -f "/tmp/${JOB_NAME}.yml"
    fi
}

# Show useful commands
show_useful_commands() {
    echo -e "${BLUE}=== Useful Commands ===$NC"
    echo ""
    echo -e "${YELLOW}Monitor jobs:$NC"
    echo "kubectl get jobs -n eval-system"
    echo "kubectl get pods -n eval-system"
    echo ""
    echo -e "${YELLOW}View logs:$NC"
    echo "kubectl logs -n eval-system -l job-name=<job-name> -f"
    echo ""
    echo -e "${YELLOW}Check GCS outputs:$NC"
    echo "gsutil ls gs://${BUCKET_NAME}/"
    echo ""
    echo -e "${YELLOW}Create jobs using templates:$NC"
    echo "# Baseline job:"
    echo 'JOB_ID="baseline-$(date +%Y%m%d-%H%M%S)"'
    echo 'sed "s/{JOB_ID}/$JOB_ID/g; s/{USERS_COUNT}/50000/g; s/{DEVICES_COUNT}/50000/g; s/{EVENTS_COUNT}/1000000/g" k8s/job-baseline.yml | kubectl apply -f -'
    echo ""
    echo "# Submission job:"
    echo 'JOB_ID="submission-$(date +%Y%m%d-%H%M%S)"'
    echo 'REPO_URL="https://github.com/your-username/db-submission"'
    echo 'sed "s/{JOB_ID}/$JOB_ID/g; s|{REPO_URL}|$REPO_URL|g" k8s/job-submission.yml | kubectl apply -f -'
    echo ""
    echo -e "${YELLOW}Clean up old jobs:$NC"
    echo "kubectl delete jobs -n eval-system --field-selector status.successful=1"
    echo ""
}

# Main execution
main() {
    echo -e "${BLUE}Starting deployment test...$NC"
    
    test_cloudrun_api
    echo ""
    test_gke_cluster
    echo ""
    test_artifact_registry
    echo ""
    test_gcs_bucket
    echo ""
    run_test_job
    echo ""
    show_useful_commands
    
    echo -e "${GREEN}=== Deployment test completed! ===$NC"
}

# Run main function
main "$@"