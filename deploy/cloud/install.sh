#!/usr/bin/env bash
set -euo pipefail

APP_DIR=/opt/portfolio-dashboard
APP_USER=portfolio-dashboard
ENV_FILE=/etc/portfolio-dashboard.env

if [[ "$(id -u)" -ne 0 ]]; then
  echo "Run with sudo: sudo bash deploy/cloud/install.sh" >&2
  exit 1
fi

if command -v apt-get >/dev/null 2>&1; then
  apt-get update
  apt-get install -y ca-certificates curl git
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 20 ]]; then
    curl -fsSL https://deb.nodesource.com/setup_20.x | bash -
    apt-get install -y nodejs
  fi
elif command -v dnf >/dev/null 2>&1; then
  dnf install -y ca-certificates curl git
  if ! command -v node >/dev/null 2>&1 || [[ "$(node -p 'Number(process.versions.node.split(`.`)[0])')" -lt 20 ]]; then
    dnf module reset -y nodejs || true
    dnf module enable -y nodejs:20
    dnf install -y nodejs
  fi
else
  echo "Supported package manager not found (apt-get or dnf required)." >&2
  exit 1
fi

if ! id "$APP_USER" >/dev/null 2>&1; then
  useradd --system --home-dir /var/lib/portfolio-dashboard --shell /usr/sbin/nologin "$APP_USER"
fi

install -d -o root -g root -m 0755 "$APP_DIR"
install -d -o "$APP_USER" -g "$APP_USER" -m 0750 /var/lib/portfolio-dashboard /var/cache/portfolio-dashboard

if [[ ! -f "$ENV_FILE" ]]; then
  install -o root -g "$APP_USER" -m 0640 /dev/null "$ENV_FILE"
  cat >"$ENV_FILE" <<'EOF'
DASHBOARD_RUNTIME_MODE=cloud
HOST=127.0.0.1
PORT=5177
DASHBOARD_DATA_DIR=/var/lib/portfolio-dashboard
DASHBOARD_CACHE_DIR=/var/cache/portfolio-dashboard
KIS_APP_KEY=
KIS_APP_SECRET=
KIS_ACCOUNT_NO=
KIS_BASE_URL=https://openapi.koreainvestment.com:9443
KIS_CUSTTYPE=P
KIS_QUOTE_MARKET=UN
KIS_REQUEST_GAP_MS=300
SCREENER_CONCURRENCY=2
CLOUD_INTRADAY_INTERVAL_MINUTES=10
CLOUD_EOD_HOUR=15
CLOUD_EOD_MINUTE=50
EOF
  echo "Created $ENV_FILE. Fill in secrets before starting the service."
fi

install -o root -g root -m 0644 "$APP_DIR/deploy/cloud/portfolio-dashboard.service" /etc/systemd/system/portfolio-dashboard.service
systemctl daemon-reload
systemctl enable portfolio-dashboard.service

if ! command -v tailscale >/dev/null 2>&1; then
  curl -fsSL https://tailscale.com/install.sh | sh
fi

echo "Installation prepared. Next steps:"
echo "1. sudoedit $ENV_FILE"
echo "2. sudo systemctl start portfolio-dashboard"
echo "3. sudo tailscale up"
echo "4. sudo tailscale serve --bg http://127.0.0.1:5177"
