#!/usr/bin/env bash
set -euo pipefail

APP_DIR="${DASHBOARD_APP_DIR:-/opt/portfolio-dashboard}"

# Protect the critical EOD window. The 15:50 KST full refresh creates the
# immutable daily snapshots; an automatic restart must never interrupt it.
dow="$(TZ=Asia/Seoul date +%u)"
hour="$(TZ=Asia/Seoul date +%H)"
minute="$(TZ=Asia/Seoul date +%M)"
minute_of_day=$((10#$hour * 60 + 10#$minute))

if [ "$dow" -le 5 ] && [ "$minute_of_day" -ge 920 ] && [ "$minute_of_day" -lt 990 ]; then
  echo "Auto deploy deferred during the 15:20-16:30 KST EOD protection window."
  exit 0
fi

exec "$APP_DIR/deploy/cloud/update.sh"
