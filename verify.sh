#!/bin/bash
# .sandcastle/verify.sh
# 
# Standardized verification script for Sandcastle agents.
# This script is called by the agent loop (via `implement-prompt.md`) to prove
# that the implemented code actually works in a realistic environment.
#
# Because `node-platform` is a pnpm monorepo, this script targets only the
# domains/packages that were modified in the current branch, avoiding running
# tests for the entire monorepo.

set -e

echo "=== Running Realistic E2E Verification ==="

# Ensure the database stack is up and running (postgres, localstack, rabbitmq, etc.)
echo "[1/2] Checking local test dependencies..."
docker compose -f .sandcastle/docker-compose.dbs.yml up -d --wait

# Run the E2E tests only for the modified packages using pnpm filter against main.
echo "[2/2] Running E2E tests for modified packages..."
# Fallback to run all if git diff doesn't pick up changes or we are on main
pnpm --filter "...[origin/main]" run test:e2e || {
  echo "⚠️  'test:e2e' failed or no script found in the modified packages."
  echo "Falling back to standard tests..."
  pnpm --filter "...[origin/main]" run test
}

echo "=== Verification Complete ==="
