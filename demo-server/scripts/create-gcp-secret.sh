#!/bin/bash
set -euo pipefail

# Script to create GCP credentials secret for the evaluation system
# Usage: ./create-gcp-secret.sh

NAMESPACE="eval-system"
SECRET_NAME="eval-secrets"
CREDS_FILE="gcp-credentials.json"

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m'

echo -e "${YELLOW}=== GCP Credentials Secret Creator ===${NC}"

# Check if credentials file exists
if [ ! -f "$CREDS_FILE" ]; then
    echo -e "${RED}ERROR: $CREDS_FILE not found${NC}"
    echo "Please create $CREDS_FILE with your GCP service account credentials"
    echo "Example content:"
    echo '{'
    echo '  "type": "service_account",'
    echo '  "project_id": "your-project-id",'
    echo '  "private_key_id": "...",'
    echo '  "private_key": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n",'
    echo '  "client_email": "service-account@your-project.iam.gserviceaccount.com",'
    echo '  "client_id": "...",'
    echo '  "auth_uri": "https://accounts.google.com/o/oauth2/auth",'
    echo '  "token_uri": "https://oauth2.googleapis.com/token",'
    echo '  "auth_provider_x509_cert_url": "https://www.googleapis.com/oauth2/v1/certs",'
    echo '  "client_x509_cert_url": "https://www.googleapis.com/robot/v1/metadata/x509/service-account%40your-project.iam.gserviceaccount.com",'
    echo '  "universe_domain": "googleapis.com"'
    echo '}'
    exit 1
fi

# Check if kubectl is available
if ! command -v kubectl &> /dev/null; then
    echo -e "${RED}ERROR: kubectl is not installed${NC}"
    exit 1
fi

# Check if namespace exists
if ! kubectl get namespace "$NAMESPACE" &>/dev/null; then
    echo -e "${YELLOW}Creating namespace $NAMESPACE...${NC}"
    kubectl create namespace "$NAMESPACE"
fi

# Check if secret already exists
if kubectl get secret "$SECRET_NAME" -n "$NAMESPACE" &>/dev/null; then
    echo -e "${YELLOW}Secret $SECRET_NAME already exists. Updating...${NC}"
    kubectl delete secret "$SECRET_NAME" -n "$NAMESPACE"
fi

# Create the secret
echo -e "${YELLOW}Creating secret $SECRET_NAME...${NC}"
kubectl create secret generic "$SECRET_NAME" \
    --from-file=GCP_CREDENTIALS_JSON="$CREDS_FILE" \
    --from-literal=POSTGRES_PASSWORD="postgres" \
    --namespace="$NAMESPACE"

echo -e "${GREEN}✓ Secret $SECRET_NAME created successfully in namespace $NAMESPACE${NC}"

# Verify the secret
echo -e "${YELLOW}Verifying secret...${NC}"
kubectl describe secret "$SECRET_NAME" -n "$NAMESPACE"

echo -e "${GREEN}✓ Setup complete!${NC}"
echo "You can now use the job templates with the secret-based credentials."