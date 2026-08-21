#!/usr/bin/env bash
set -euo pipefail

SOURCE=/var/lib/portfolio-dashboard
DEST="${1:-/var/backups/portfolio-dashboard}"
RETENTION_DAYS="${DASHBOARD_BACKUP_RETENTION_DAYS:-30}"
MIN_KEEP="${DASHBOARD_BACKUP_MIN_KEEP:-30}"
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
install -d -m 0750 "$DEST"

if ! [[ "$RETENTION_DAYS" =~ ^[0-9]+$ && "$MIN_KEEP" =~ ^[0-9]+$ ]]; then
  echo "Backup retention settings must be non-negative integers." >&2
  exit 1
fi

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

archive="$DEST/portfolio-dashboard-$timestamp.tar.gz"
tar -C "$SOURCE" -czf "$archive" \
  "${required[@]}" ${extra[@]+"${extra[@]}"} 2>/dev/null || {
    echo "Backup failed. Check whether the expected data files exist." >&2
    exit 1
  }

# Retention policy: always keep at least the newest MIN_KEEP archives. Beyond
# that floor, delete only archives older than RETENTION_DAYS. This bounds old
# backup growth without ever pruning the newest recovery points just because a
# burst of deployments happened on the same day.
mapfile -t archives < <(
  find "$DEST" -maxdepth 1 -type f -name 'portfolio-dashboard-*.tar.gz' -printf '%T@ %p\n' \
    | sort -nr \
    | cut -d' ' -f2-
)
if [ "${#archives[@]}" -gt "$MIN_KEEP" ]; then
  for ((i=MIN_KEEP; i<${#archives[@]}; i++)); do
    candidate="${archives[$i]}"
    if find "$candidate" -maxdepth 0 -type f -mtime "+$RETENTION_DAYS" -print -quit | grep -q .; then
      rm -f -- "$candidate"
    fi
  done
fi

echo "$archive"
