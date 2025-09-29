#!/bin/bash
set -euo pipefail

# Configuration (load from GCP.env)
source "$(dirname "$0")/../GCP.env"

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
CYAN='\033[0;36m'
NC='\033[0m' # No Color

# Check if running in non-interactive mode (for server usage)
NON_INTERACTIVE=false
if [[ "$#" -gt 0 ]]; then
    NON_INTERACTIVE=true
fi

if [[ "$NON_INTERACTIVE" == "false" ]]; then
    echo -e "${BLUE}=== Quick Job Creator for GKE Eval System ===$NC"
fi

# Check prerequisites
check_prerequisites() {
    if ! command -v kubectl &> /dev/null; then
        if [[ "$NON_INTERACTIVE" == "true" ]]; then
            echo "ERROR: kubectl is not installed" >&2
        else
            echo -e "${RED}ERROR: kubectl is not installed. Please install it first.$NC"
        fi
        exit 1
    fi
    
    # Check if we can access the cluster
    if ! kubectl get ns eval-system &>/dev/null; then
        if [[ "$NON_INTERACTIVE" == "true" ]]; then
            echo "ERROR: Cannot access eval-system namespace" >&2
        else
            echo -e "${RED}ERROR: Cannot access eval-system namespace. Make sure you're connected to the right cluster.$NC"
            echo "Run: gcloud container clusters get-credentials $CLUSTER --zone=$ZONE"
        fi
        exit 1
    fi
}

# Function to get user input for job type
get_job_type() {
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
        # Parse command line arguments
        if [[ "$#" -lt 1 ]]; then
            echo "ERROR: Job type required. Usage: $0 <baseline|submission> [repo_url] [users_count] [devices_count] [events_count]" >&2
            exit 1
        fi
        
        case "$1" in
            "baseline")
                JOB_TYPE="baseline"
                ;;
            "submission")
                JOB_TYPE="submission"
                ;;
            *)
                echo "ERROR: Invalid job type '$1'. Must be 'baseline' or 'submission'" >&2
                exit 1
                ;;
        esac
        return
    fi
    
    echo -e "${CYAN}Select job type:$NC"
    echo "1) Baseline (creates new dataset and runs baseline queries)"
    echo "2) Submission (loads existing dataset and runs submission queries)"
    echo ""
    
    while true; do
        read -p "Enter choice (1 or 2): " choice
        case $choice in
            1)
                JOB_TYPE="baseline"
                echo -e "${GREEN}Selected: Baseline job$NC"
                break
                ;;
            2)
                JOB_TYPE="submission"
                echo -e "${GREEN}Selected: Submission job$NC"
                break
                ;;
            *)
                echo -e "${RED}Invalid choice. Please enter 1 or 2.$NC"
                ;;
        esac
    done
}

# Function to get baseline job parameters
get_baseline_params() {
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
        # Default values
        USERS_COUNT_DEFAULT=50000
        DEVICES_COUNT_DEFAULT=50000
        EVENTS_COUNT_DEFAULT=1000000
        
        # Use command line arguments or defaults
        USERS_COUNT="${3:-$USERS_COUNT_DEFAULT}"
        DEVICES_COUNT="${4:-$DEVICES_COUNT_DEFAULT}"
        EVENTS_COUNT="${5:-$EVENTS_COUNT_DEFAULT}"
        return
    fi
    
    echo -e "${CYAN}Configure baseline dataset:$NC"
    
    # Default values
    USERS_COUNT_DEFAULT=50000
    DEVICES_COUNT_DEFAULT=50000
    EVENTS_COUNT_DEFAULT=1000000
    
    read -p "Users count (default: $USERS_COUNT_DEFAULT): " users_input
    USERS_COUNT=${users_input:-$USERS_COUNT_DEFAULT}
    
    read -p "Devices count (default: $DEVICES_COUNT_DEFAULT): " devices_input
    DEVICES_COUNT=${devices_input:-$DEVICES_COUNT_DEFAULT}
    
    read -p "Events count (default: $EVENTS_COUNT_DEFAULT): " events_input  
    EVENTS_COUNT=${events_input:-$EVENTS_COUNT_DEFAULT}
    
    echo -e "${GREEN}Dataset configuration:$NC"
    echo "  Users: $USERS_COUNT"
    echo "  Devices: $DEVICES_COUNT"  
    echo "  Events: $EVENTS_COUNT"
}

# Function to get submission job parameters
get_submission_params() {
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
        if [[ "$#" -lt 2 ]]; then
            echo "ERROR: Repository URL required for submission job" >&2
            exit 1
        fi
        
        if [[ ! "$2" =~ ^https://github\.com/.+/.+$ ]]; then
            echo "ERROR: Invalid GitHub repository URL format: $2" >&2
            exit 1
        fi
        
        REPO_URL="$2"
        return
    fi
    
    echo -e "${CYAN}Configure submission job:$NC"
    
    while true; do
        read -p "Enter GitHub repository URL: " repo_url
        if [[ $repo_url =~ ^https://github\.com/.+/.+$ ]]; then
            REPO_URL="$repo_url"
            echo -e "${GREEN}Repository: $REPO_URL$NC"
            break
        else
            echo -e "${RED}Invalid URL format. Please enter a valid GitHub repository URL (https://github.com/username/repo)$NC"
        fi
    done
    
    echo -e "${YELLOW}Note: This job will use the existing baseline dataset from GCS.$NC"
}

# Function to create and apply job
create_job() {
    # Generate unique job ID
    JOB_ID="${JOB_TYPE}-$(date +%Y%m%d-%H%M%S)"
    
    echo -e "${BLUE}Creating job: $JOB_ID$NC"
    
    # Create temporary job file
    TEMP_JOB_FILE="/tmp/${JOB_ID}.yml"
    
    if [ "$JOB_TYPE" = "baseline" ]; then
        # Create baseline job
        sed "s/{JOB_ID}/$JOB_ID/g; s/{USERS_COUNT}/$USERS_COUNT/g; s/{DEVICES_COUNT}/$DEVICES_COUNT/g; s/{EVENTS_COUNT}/$EVENTS_COUNT/g" \
            "$(dirname "$0")/../k8s/job-baseline.yml" > "$TEMP_JOB_FILE"
    else
        # Create submission job
        sed "s/{JOB_ID}/$JOB_ID/g; s|{REPO_URL}|$REPO_URL|g" \
            "$(dirname "$0")/../k8s/job-submission.yml" > "$TEMP_JOB_FILE"
    fi
    
    # Apply the job
    echo "Applying job to Kubernetes..."
    kubectl apply -f "$TEMP_JOB_FILE"
    
    # Clean up temp file
    rm -f "$TEMP_JOB_FILE"
    
    echo -e "${GREEN}✓ Job created successfully: eval-${JOB_TYPE}-${JOB_ID}$NC"
    
    return 0
}

# Function to monitor job
monitor_job() {
    local job_name="eval-${JOB_TYPE}-${JOB_ID}"
    
    echo -e "${BLUE}Monitoring job: $job_name$NC"
    echo ""
    
    # Wait for job to be created
    echo "Waiting for job to be scheduled..."
    local max_wait=60
    local wait_time=0
    
    while ! kubectl get job "$job_name" -n eval-system &>/dev/null; do
        if [ $wait_time -ge $max_wait ]; then
            echo -e "${RED}ERROR: Job creation timed out after ${max_wait}s$NC"
            return 1
        fi
        sleep 2
        wait_time=$((wait_time + 2))
        echo -n "."
    done
    echo ""
    
    # Show job status
    echo -e "${GREEN}Job created! Current status:$NC"
    kubectl get job "$job_name" -n eval-system
    echo ""
    
    # Wait for pod to be scheduled
    echo "Waiting for pod to be scheduled..."
    wait_time=0
    while ! kubectl get pods -n eval-system -l job-name="$job_name" --no-headers 2>/dev/null | grep -q .; do
        if [ $wait_time -ge $max_wait ]; then
            echo -e "${YELLOW}WARNING: Pod scheduling timed out after ${max_wait}s$NC"
            break
        fi
        sleep 2
        wait_time=$((wait_time + 2))
        echo -n "."
    done
    echo ""
    
    # Show pod status
    echo -e "${GREEN}Pod status:$NC"
    kubectl get pods -n eval-system -l job-name="$job_name"
    echo ""
    
    # Ask if user wants to follow logs
    echo -e "${CYAN}Would you like to follow the job logs? (y/n)$NC"
    read -p "Choice: " follow_logs
    
    if [[ $follow_logs =~ ^[Yy]$ ]]; then
        echo -e "${BLUE}Following logs (Press Ctrl+C to stop):$NC"
        echo ""
        kubectl logs -n eval-system -l job-name="$job_name" -f --max-log-requests=10
    else
        echo -e "${YELLOW}Job monitoring commands:$NC"
        echo "  Status: kubectl get job $job_name -n eval-system"
        echo "  Pods:   kubectl get pods -n eval-system -l job-name=$job_name"
        echo "  Logs:   kubectl logs -n eval-system -l job-name=$job_name -f"
        echo ""
        echo -e "${YELLOW}Results will be available in GCS bucket: gs://$BUCKET_NAME/$NC"
    fi
}

# Function to show job summary
show_summary() {
    echo -e "${GREEN}=== Job Summary ===$NC"
    echo "Job ID: $JOB_ID"
    echo "Job Type: $JOB_TYPE"
    echo "Full Job Name: eval-${JOB_TYPE}-${JOB_ID}"
    
    if [ "$JOB_TYPE" = "baseline" ]; then
        echo "Dataset Configuration:"
        echo "  Users: $USERS_COUNT"
        echo "  Devices: $DEVICES_COUNT"
        echo "  Events: $EVENTS_COUNT"
    else
        echo "Repository: $REPO_URL"
    fi
    
    echo ""
    echo -e "${YELLOW}Results Location:$NC gs://$BUCKET_NAME/"
    echo -e "${YELLOW}Cluster:$NC $PROJECT_ID/$ZONE/$CLUSTER"
    echo ""
}

# Main execution
main() {
    check_prerequisites
    
    if [[ "$NON_INTERACTIVE" == "true" ]]; then
        # Non-interactive mode for server usage
        get_job_type "$@"
        
        if [ "$JOB_TYPE" = "baseline" ]; then
            get_baseline_params "$@"
        else
            get_submission_params "$@"
        fi
        
        # Create job directly without confirmation
        if create_job; then
            # Output only the job ID for server to parse
            echo "eval-${JOB_TYPE}-${JOB_ID}"
        else
            echo "ERROR: Failed to create job" >&2
            exit 1
        fi
    else
        # Interactive mode for manual usage
        echo ""
        get_job_type "$@"
        echo ""
        
        if [ "$JOB_TYPE" = "baseline" ]; then
            get_baseline_params "$@"
        else
            get_submission_params "$@"
        fi
        
        echo ""
        echo -e "${CYAN}Ready to create job. Continue? (y/n)$NC"
        read -p "Choice: " confirm
        
        if [[ ! $confirm =~ ^[Yy]$ ]]; then
            echo -e "${YELLOW}Job creation cancelled.$NC"
            exit 0
        fi
        
        echo ""
        if create_job; then
            show_summary
            echo ""
            
            echo -e "${CYAN}Would you like to monitor the job? (y/n)$NC"
            read -p "Choice: " monitor
            
            if [[ $monitor =~ ^[Yy]$ ]]; then
                monitor_job
            fi
        else
            echo -e "${RED}Failed to create job.$NC"
            exit 1
        fi
        
        echo -e "${GREEN}Job creation completed!$NC"
    fi
}

# Run main function
main "$@"