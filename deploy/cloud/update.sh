#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/portfolio-dashboard
BRANCH="${DASHBOARD_GIT_BRANCH:-cloud-dashboard}"
cd "$APP_DIR"

if ! git remote get-url origin >/dev/null 2>&1; then
  echo "No origin remote is configured in $APP_DIR." >&2
  exit 1
fi

previous="$(git rev-parse HEAD)"
git fetch --prune origin "$BRANCH"
git checkout "$BRANCH"
git merge --ff-only "origin/$BRANCH"

node --check server.mjs
node --check cloud-dashboard-runtime.js
npm test

systemctl restart portfolio-dashboard
for _ in $(seq 1 20); do
  if curl -fsS http://127.0.0.1:5177/api/health >/dev/null; then
    echo "Updated to $(git rev-parse HEAD)"
    exit 0
  fi
  sleep 1
done

echo "Health check failed; rolling code back to $previous" >&2
git checkout --detach "$previous"
systemctl restart portfolio-dashboard
exit 1
