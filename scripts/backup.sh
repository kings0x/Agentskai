#!/usr/bin/env bash
set -euo pipefail
data_dir="${AGENTDOCK_DATA_DIR:-/var/lib/agentskai}"
backup_dir="${AGENTSKAI_BACKUP_DIR:-$data_dir/backups}"
mkdir -p "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_dir/agentskai-$stamp.db"
sqlite3 "$data_dir/agentskai.db" ".backup '$target'"
chmod 600 "$target"
printf '%s\n' "$target"
