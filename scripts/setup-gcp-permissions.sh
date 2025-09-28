#!/bin/bash
set -euo pipefail

PROJECT_ID="${PROJECT_ID}"
BUCKET_NAME="${BUCKET_NAME}"
SA_NAME="${SA_NAME}"
KSA_NAME="${KSA_NAME}"
NAMESPACE="${NAMESPACE}"

echo "Setting up GCP service account and permissions..."

# Create GCP service account
echo "Creating GCP service account: ${SA_NAME}"
gcloud iam service-accounts create ${SA_NAME} \
    --display-name "Baseline Evaluation Service Account" \
    --description "Service account for baseline evaluation jobs in GKE" || true

# Grant necessary permissions
echo "Granting storage permissions..."
gcloud projects add-iam-policy-binding ${PROJECT_ID} \
    --member="serviceAccount:${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com" \
    --role="roles/storage.objectAdmin"

# Grant access to the specific bucket
echo "Granting bucket access..."
gsutil iam ch serviceAccount:${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com:objectAdmin gs://${BUCKET_NAME}

# Enable Workload Identity on the cluster (if not already enabled)
echo "Enabling Workload Identity..."
gcloud container clusters update eval-baseline-cluster \
    --zone=us-central1-a \
    --workload-pool=${PROJECT_ID}.svc.id.goog || true

# Create Kubernetes service account and bind to GCP service account
echo "Setting up Kubernetes service account with Workload Identity..."
kubectl create serviceaccount ${KSA_NAME} \
    --namespace ${NAMESPACE} || true

kubectl annotate serviceaccount ${KSA_NAME} \
    --namespace ${NAMESPACE} \
    iam.gke.io/gcp-service-account=${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com \
    --overwrite

# Bind the Kubernetes service account to the GCP service account
gcloud iam service-accounts add-iam-policy-binding \
    ${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com \
    --role roles/iam.workloadIdentityUser \
    --member "serviceAccount:${PROJECT_ID}.svc.id.goog[${NAMESPACE}/${KSA_NAME}]"

# Create service account key for fallback authentication
echo "Creating service account key..."
gcloud iam service-accounts keys create /tmp/gcp-credentials.json \
    --iam-account=${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com

# Create Kubernetes secret with service account key
echo "Creating Kubernetes secret..."
kubectl create secret generic gcp-credentials \
    --from-file=credentials.json=/tmp/gcp-credentials.json \
    --namespace ${NAMESPACE} || true

# Clean up the local key file
rm -f /tmp/gcp-credentials.json

echo "GCP setup completed successfully!"
echo "Service Account: ${SA_NAME}@${PROJECT_ID}.iam.gserviceaccount.com"
echo "Bucket: gs://${BUCKET_NAME}"
echo "Kubernetes Service Account: ${KSA_NAME}"