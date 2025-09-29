#!/bin/bash
set -euo pipefail

# Check if job name provided
if [ $# -eq 0 ]; then
    echo "Usage: $0 <job-name>"
    echo "Example: $0 eval-baseline-baseline-20250929-235815"
    exit 1
fi

JOB_NAME="$1"

echo "=== Monitoring Job: $JOB_NAME ==="
echo ""

# Check if job exists
if ! kubectl get job "$JOB_NAME" -n eval-system &>/dev/null; then
    echo "ERROR: Job '$JOB_NAME' not found in eval-system namespace"
    exit 1
fi

# Show job status
echo "Job Status:"
kubectl get job "$JOB_NAME" -n eval-system
echo ""

# Show pod status
echo "Pod Status:"
kubectl get pods -n eval-system -l job-name="$JOB_NAME"
echo ""

# Show recent events
echo "Recent Events:"
kubectl get events -n eval-system --field-selector involvedObject.name="$JOB_NAME" --sort-by='.lastTimestamp' | tail -10
echo ""

# Show logs if pod exists and is not pending
POD_NAME=$(kubectl get pods -n eval-system -l job-name="$JOB_NAME" -o jsonpath='{.items[0].metadata.name}' 2>/dev/null || true)
if [ -n "$POD_NAME" ]; then
    POD_STATUS=$(kubectl get pod "$POD_NAME" -n eval-system -o jsonpath='{.status.phase}' 2>/dev/null || true)
    if [ "$POD_STATUS" != "Pending" ]; then
        echo "Pod Logs:"
        kubectl logs "$POD_NAME" -n eval-system --tail=50
    else
        echo "Pod is still pending - no logs available yet"
    fi
else
    echo "No pod found for this job"
fi