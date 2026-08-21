#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${DASHBOARD_APP_DIR:-/opt/portfolio-dashboard}"
BRANCH="${DASHBOARD_GIT_BRANCH:-main}"
HEALTH_URL="${DASHBOARD_HEALTH_URL:-http://127.0.0.1:5177/api/health}"
LOCK_FILE="${DASHBOARD_DEPLOY_LOCK:-/run/lock/portfolio-dashboard-update.lock}"
BACKUP_DIR="${DASHBOARD_BACKUP_DIR:-/var/backups/portfolio-dashboard}"

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "Run this updater as root (sudo)." >&2
  exit 1
fi

install -d -m 0755 "$(dirname "$LOCK_FILE")"
exec 9>"$LOCK_FILE"
if ! flock -n 9; then
  echo "Another portfolio-dashboard deployment is already running; skipping."
  exit 0
fi

cd "$APP_DIR"

if [ ! -d .git ]; then
  echo "$APP_DIR is not a git checkout. Run deploy/cloud/bootstrap-auto-deploy.sh once first." >&2
  exit 1
fi
if ! git remote get-url origin >/dev/null 2>&1; then
  echo "No origin remote is configured in $APP_DIR." >&2
  exit 1
fi
if [ -n "$(git status --porcelain --untracked-files=no)" ]; then
  echo "Tracked files in $APP_DIR have local modifications; refusing automatic deployment." >&2
  git status --short --untracked-files=no >&2
  exit 1
fi

previous="$(git rev-parse HEAD)"
git fetch --prune origin "$BRANCH"
target="$(git rev-parse "origin/$BRANCH")"

if [ "$previous" = "$target" ]; then
  echo "Already up to date at $previous"
  exit 0
fi

if ! git merge-base --is-ancestor "$previous" "$target"; then
  echo "origin/$BRANCH is not a fast-forward from $previous; refusing automatic deployment." >&2
  exit 1
fi

if [ -x "$APP_DIR/deploy/cloud/backup.sh" ]; then
  backup_path="$(bash "$APP_DIR/deploy/cloud/backup.sh" "$BACKUP_DIR")"
  echo "Persistent-data backup: $backup_path"
fi

rollback() {
  echo "Deployment failed; rolling tracked code back to $previous" >&2
  git reset --hard "$previous" >/dev/null 2>&1 || true
  systemctl restart portfolio-dashboard || true
  for _ in $(seq 1 20); do
    if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
      echo "Rollback health check passed at $previous" >&2
      return
    fi
    sleep 1
  done
  echo "Rollback completed but health check is still failing." >&2
}

if git show-ref --verify --quiet "refs/heads/$BRANCH"; then
  git checkout -q "$BRANCH"
else
  git checkout -q -b "$BRANCH" --track "origin/$BRANCH"
fi

git merge --ff-only "origin/$BRANCH"

if ! node --check server.mjs \
  || ! node --check cloud-dashboard-runtime.js \
  || ! node --check public/simulator.js \
  || { [ -f public/simulator-strategy-candidates.js ] && ! node --check public/simulator-strategy-candidates.js; } \
  || { [ -f public/strategy-validation.js ] && ! node --check public/strategy-validation.js; } \
  || ! npm test; then
  rollback
  exit 1
fi

systemctl restart portfolio-dashboard
for _ in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    echo "Updated $previous -> $(git rev-parse HEAD)"
    exit 0
  fi
  sleep 1
done

rollback
exit 1
