#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${DASHBOARD_APP_DIR:-/opt/portfolio-dashboard}"
REPO_URL="${DASHBOARD_GIT_REPO:-https://github.com/gunheeyyes-ui/portfolio-dashboard.git}"
BRANCH="${DASHBOARD_GIT_BRANCH:-main}"
HEALTH_URL="${DASHBOARD_HEALTH_URL:-http://127.0.0.1:5177/api/health}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
code_backup="/root/portfolio-dashboard-pre-autodeploy-$timestamp.tar.gz"
preserve_dir="$(mktemp -d)"

cleanup() {
  rm -rf "$preserve_dir"
}
trap cleanup EXIT

if [ "${EUID:-$(id -u)}" -ne 0 ]; then
  echo "Run this bootstrap as root (sudo)." >&2
  exit 1
fi
if [ ! -d "$APP_DIR" ]; then
  echo "$APP_DIR does not exist." >&2
  exit 1
fi
for command in git node npm curl systemctl tar flock; do
  command -v "$command" >/dev/null 2>&1 || {
    echo "Required command is missing: $command" >&2
    exit 1
  }
done

# Preserve the local-only files that intentionally never exist in the public
# mirror. They remain untracked after the checkout and must never be deleted.
for name in portfolio.js free-float.json .env; do
  if [ -f "$APP_DIR/$name" ]; then
    cp -a "$APP_DIR/$name" "$preserve_dir/$name"
  fi
done

# Full code backup plus the existing persistent-data backup before converting
# /opt/portfolio-dashboard into a git checkout.
tar -C "$APP_DIR" -czf "$code_backup" .
echo "Code backup: $code_backup"
if [ -f "$APP_DIR/deploy/cloud/backup.sh" ]; then
  bash "$APP_DIR/deploy/cloud/backup.sh" || {
    echo "Persistent-data backup failed; refusing bootstrap." >&2
    exit 1
  }
fi

rollback_code() {
  echo "Bootstrap failed; restoring the pre-bootstrap code tree." >&2
  systemctl disable --now portfolio-dashboard-autodeploy.timer >/dev/null 2>&1 || true
  find "$APP_DIR" -mindepth 1 -maxdepth 1 -exec rm -rf -- {} +
  tar -C "$APP_DIR" -xzf "$code_backup"
  systemctl daemon-reload || true
  systemctl restart portfolio-dashboard || true
}

cd "$APP_DIR"
if [ ! -d .git ]; then
  git init -q
fi
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REPO_URL"
else
  git remote add origin "$REPO_URL"
fi

git fetch --prune origin "$BRANCH"
git checkout -B "$BRANCH" "origin/$BRANCH" --force

for name in portfolio.js free-float.json .env; do
  if [ -f "$preserve_dir/$name" ]; then
    cp -a "$preserve_dir/$name" "$APP_DIR/$name"
  fi
done

if [ ! -f "$APP_DIR/portfolio.js" ]; then
  echo "Required local-only portfolio.js is missing after checkout." >&2
  rollback_code
  exit 1
fi

if ! node --check server.mjs || ! node --check cloud-dashboard-runtime.js || ! node --check public/simulator.js; then
  rollback_code
  exit 1
fi
if [ -f public/simulator-strategy-candidates.js ] && ! node --check public/simulator-strategy-candidates.js; then
  rollback_code
  exit 1
fi
if [ -f public/strategy-validation.js ] && ! node --check public/strategy-validation.js; then
  rollback_code
  exit 1
fi
if ! npm test; then
  rollback_code
  exit 1
fi

install -m 0644 "$APP_DIR/deploy/cloud/portfolio-dashboard-autodeploy.service" /etc/systemd/system/portfolio-dashboard-autodeploy.service
install -m 0644 "$APP_DIR/deploy/cloud/portfolio-dashboard-autodeploy.timer" /etc/systemd/system/portfolio-dashboard-autodeploy.timer
systemctl daemon-reload
systemctl restart portfolio-dashboard

healthy=0
for _ in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    healthy=1
    break
  fi
  sleep 1
done
if [ "$healthy" -ne 1 ]; then
  rollback_code
  exit 1
fi

systemctl enable --now portfolio-dashboard-autodeploy.timer

echo "Auto deploy enabled."
echo "Repository: $REPO_URL"
echo "Branch: $BRANCH"
echo "Current commit: $(git rev-parse HEAD)"
echo "Timer: $(systemctl is-active portfolio-dashboard-autodeploy.timer)"
echo "Future main commits will be checked every ~2 minutes, except 15:20-16:30 KST on weekdays."
