#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${DASHBOARD_APP_DIR:-/opt/portfolio-dashboard}"
BRANCH="${DASHBOARD_GIT_BRANCH:-main}"
HEALTH_URL="${DASHBOARD_HEALTH_URL:-http://127.0.0.1:5177/api/health}"
LOCK_FILE="${DASHBOARD_DEPLOY_LOCK:-/run/lock/portfolio-dashboard-update.lock}"
BACKUP_DIR="${DASHBOARD_BACKUP_DIR:-/var/backups/portfolio-dashboard}"
FAILED_SHA_FILE="${DASHBOARD_FAILED_SHA_FILE:-/var/lib/portfolio-dashboard/auto-deploy-failed-sha}"
GITHUB_REPOSITORY="${DASHBOARD_GITHUB_REPOSITORY:-gunheeyyes-ui/portfolio-dashboard}"
GITHUB_WORKFLOW_NAME="${DASHBOARD_GITHUB_WORKFLOW_NAME:-test}"
GITHUB_API_BASE="${DASHBOARD_GITHUB_API_BASE:-https://api.github.com}"
REQUIRE_GITHUB_CI="${DASHBOARD_REQUIRE_GITHUB_CI:-1}"

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
  rm -f "$FAILED_SHA_FILE"
  echo "Already up to date at $previous"
  exit 0
fi

if [ -f "$FAILED_SHA_FILE" ] && [ "$(cat "$FAILED_SHA_FILE" 2>/dev/null || true)" = "$target" ]; then
  echo "Skipping previously failed deployment $target; waiting for a newer main commit."
  exit 0
fi
# A newer target gets one fresh attempt.
rm -f "$FAILED_SHA_FILE"

if ! git merge-base --is-ancestor "$previous" "$target"; then
  echo "origin/$BRANCH is not a fast-forward from $previous; refusing automatic deployment." >&2
  exit 1
fi

# Production must not race ahead of GitHub CI. A direct push to main is still
# harmless to OCI until the exact target SHA has a successful push-triggered
# workflow named `test`. Missing/pending/failed API states are fail-closed by
# deferring deployment; the timer will check again later.
if [ "$REQUIRE_GITHUB_CI" != "0" ]; then
  ci_url="$GITHUB_API_BASE/repos/$GITHUB_REPOSITORY/actions/runs?head_sha=$target&event=push&per_page=20"
  if ! ci_payload="$(curl -fsSL --connect-timeout 5 --max-time 20 \
    -H "Accept: application/vnd.github+json" \
    -H "User-Agent: portfolio-dashboard-autodeploy" \
    "$ci_url")"; then
    echo "GitHub CI status unavailable for $target; deployment deferred."
    exit 0
  fi
  if ! ci_status="$(printf '%s' "$ci_payload" | node "$APP_DIR/deploy/cloud/github-ci-gate.mjs" "$target" "$GITHUB_WORKFLOW_NAME")"; then
    echo "GitHub CI status could not be parsed for $target; deployment deferred."
    exit 0
  fi
  if [ "$ci_status" != "SUCCESS" ]; then
    echo "GitHub CI is $ci_status for $target; deployment deferred until CI is green."
    exit 0
  fi
  echo "GitHub CI passed for $target"
fi

if [ -f "$APP_DIR/deploy/cloud/backup.sh" ]; then
  backup_path="$(bash "$APP_DIR/deploy/cloud/backup.sh" "$BACKUP_DIR")"
  echo "Persistent-data backup: $backup_path"
fi

rollback() {
  install -d -m 0755 "$(dirname "$FAILED_SHA_FILE")"
  printf '%s\n' "$target" > "$FAILED_SHA_FILE"
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

if ! node --check server.mjs || ! node --check cloud-dashboard-runtime.js || ! node --check public/simulator.js; then
  rollback
  exit 1
fi
if [ -f public/simulator-strategy-candidates.js ] && ! node --check public/simulator-strategy-candidates.js; then
  rollback
  exit 1
fi
if [ -f public/strategy-candidate-engine.js ] && ! node --check public/strategy-candidate-engine.js; then
  rollback
  exit 1
fi
if [ -f public/simulation-category.js ] && ! node --check public/simulation-category.js; then
  rollback
  exit 1
fi
if [ -f public/strategy-oos-registry.js ] && ! node --check public/strategy-oos-registry.js; then
  rollback
  exit 1
fi
if [ -f public/strategy-validation.js ] && ! node --check public/strategy-validation.js; then
  rollback
  exit 1
fi
if ! npm test; then
  rollback
  exit 1
fi

systemctl restart portfolio-dashboard
for _ in $(seq 1 30); do
  if curl -fsS "$HEALTH_URL" >/dev/null 2>&1; then
    rm -f "$FAILED_SHA_FILE"
    echo "Updated $previous -> $(git rev-parse HEAD)"
    exit 0
  fi
  sleep 1
done

rollback
exit 1
