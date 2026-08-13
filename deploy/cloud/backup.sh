#!/usr/bin/env bash
set -euo pipefail

SOURCE=/var/lib/portfolio-dashboard
DEST="${1:-/var/backups/portfolio-dashboard}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0750 "$DEST"
tar -C "$SOURCE" -czf "$DEST/portfolio-dashboard-$timestamp.tar.gz" \
  latest-snapshot.json refresh-state.json ranking-live-history.jsonl ranking-live-summary.json 2>/dev/null || {
    echo "Backup failed. Check whether the expected data files exist." >&2
    exit 1
  }
echo "$DEST/portfolio-dashboard-$timestamp.tar.gz"
