#!/usr/bin/env bash
set -euo pipefail

data_dir=/opt/finance-pwa/shared/data
backup_dir=/opt/finance-pwa/backups
database="$data_dir/finance.sqlite3"

test -f "$database"
mkdir -p "$backup_dir"
stamp="$(date -u +%Y%m%dT%H%M%SZ)"
target="$backup_dir/finance-$stamp.sqlite3"
sqlite3 "$database" ".backup '$target'"
gzip -9 "$target"
find "$backup_dir" -maxdepth 1 -type f -name 'finance-*.sqlite3.gz' -mtime +30 -delete
