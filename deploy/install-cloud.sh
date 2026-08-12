#!/usr/bin/env bash
set -euo pipefail

sudo apt-get update
sudo apt-get install -y ca-certificates curl
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs
curl -fsSL https://tailscale.com/install.sh | sh

sudo mkdir -p /opt/portfolio-dashboard/backtest-cache
sudo chown -R ubuntu:ubuntu /opt/portfolio-dashboard
sudo install -m 0644 /opt/portfolio-dashboard/deploy/portfolio-dashboard.service /etc/systemd/system/portfolio-dashboard.service
sudo systemctl daemon-reload
sudo systemctl enable --now portfolio-dashboard.service

echo "Dashboard service installed."
echo "Next: sudo tailscale up"
echo "Then: sudo tailscale serve --bg http://127.0.0.1:5177"
