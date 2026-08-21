#!/usr/bin/env bash
set -euo pipefail

SOURCE=/var/lib/portfolio-dashboard
DEST="${1:-/var/backups/portfolio-dashboard}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0750 "$DEST"
required=(latest-snapshot.json refresh-state.json ranking-live-history.jsonl ranking-live-summary.json)
# Strategy OOS and simulator files only exist once the first EOD run recorded
# them, so a fresh install must still back up cleanly.
optional=(strategy-oos-history.jsonl strategy-oos-selections.jsonl strategy-oos-summary.json strategy-oos-state.json simulation-ledger.json)
extra=()
for name in "${optional[@]}"; do
  if [ -f "$SOURCE/$name" ]; then
    extra+=("$name")
  fi
done

tar -C "$SOURCE" -czf "$DEST/portfolio-dashboard-$timestamp.tar.gz" \
  "${required[@]}" ${extra[@]+"${extra[@]}"} 2>/dev/null || {
    echo "Backup failed. Check whether the expected data files exist." >&2
    exit 1
  }
echo "$DEST/portfolio-dashboard-$timestamp.tar.gz"
