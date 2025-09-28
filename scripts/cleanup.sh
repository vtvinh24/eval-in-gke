#!/usr/bin/env bash
set -euo pipefail

# Cleanup script for eval-in-gke
# Removes all output, temp, and data directories/files

echo "🧹 Cleaning up eval-in-gke workspace..."

# Change to the project root directory
cd "$(dirname "$0")"

# Remove output directories
echo "Removing output directories..."
rm -rf out/ tmp/ data/

# Remove log files
echo "Removing log files..."
find . -name "*.log" -delete 2>/dev/null || true

# Remove dump files
echo "Removing database dump files..."
find . -name "*_dump.sql" -delete 2>/dev/null || true

# Remove completion markers
echo "Removing completion markers..."
find . -name "*_done" -delete 2>/dev/null || true
find . -name ".*_ready" -delete 2>/dev/null || true

# Remove temporary files
echo "Removing temporary files..."
find . -name "*.tmp*" -delete 2>/dev/null || true
find . -name ".DS_Store" -delete 2>/dev/null || true

# Stop and remove any running containers
echo "Stopping and removing containers..."
docker compose down --remove-orphans 2>/dev/null || true

# Remove dangling images (optional - uncomment if needed)
# echo "Removing dangling Docker images..."
# docker image prune -f 2>/dev/null || true

echo "✅ Cleanup complete!"
echo ""
echo "To run evaluation:"
echo "1. Copy environment: cp .env.example .env"
echo "2. Edit .env with your values"
echo "3. Run: docker compose --profile baseline up --build"
echo "   or: docker compose --profile submission up --build"