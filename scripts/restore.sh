#!/usr/bin/env bash
set -euo pipefail
if [[ $# -ne 1 ]]; then echo "Usage: sudo scripts/restore.sh /path/to/agentskai-backup.db" >&2; exit 2; fi
source_db="$(realpath "$1")"
data_dir="${AGENTDOCK_DATA_DIR:-/var/lib/agentskai}"
target="$data_dir/agentskai.db"
[[ -f "$source_db" ]] || { echo "Backup does not exist: $source_db" >&2; exit 1; }
sqlite3 "$source_db" 'PRAGMA integrity_check;' | grep -qx ok || { echo 'Backup integrity check failed' >&2; exit 1; }
systemctl stop agentskai
install -m 600 "$source_db" "$target.restore"
mv "$target.restore" "$target"
rm -f "$target-wal" "$target-shm"
systemctl start agentskai
echo "Restored $source_db"
