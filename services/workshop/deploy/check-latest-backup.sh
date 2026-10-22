#!/usr/bin/env bash
set -euo pipefail
source "$(dirname "$0")/release-common.sh"
mkdir -p "$backup_root/snapshots"
latest="$(find "$backup_root/snapshots" "$backup_root/releases" -name COMPLETE -printf '%T@ %h\n' 2>/dev/null | sort -nr | head -1 | cut -d' ' -f2-)"
test -n "$latest" || { echo 'No completed backup found' >&2; exit 1; }
python3 "$script_dir/check-backup.py" "$latest" "$(sed -n 's/^release=//p' "$latest/COMPLETE")" 93600
