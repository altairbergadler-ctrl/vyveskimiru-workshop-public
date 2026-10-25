#!/usr/bin/env bash
set -euo pipefail
source /opt/finance-pwa/app/deploy/release-common.sh
dest="${1:-$backup_root/snapshots/$(date -u +%Y%m%dT%H%M%SZ)}"
test ! -e "$dest"
mkdir -p "$dest"
started="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
release="$(readlink -f "$base/app")"
image="$(docker inspect --format '{{.Config.Image}}' "$container")"
if [[ -n "${WORKSHOP_QA_ROOT:-}" ]]; then
  docker run --rm --name "${VPS_BACKUP_CONTAINER:?}" --label "vps-drive.attempt=${VPS_BACKUP_ATTEMPT:?}" --network none --user 0 --env-file "$shared/app.env" \
    -v "$WORKSHOP_QA_ROOT:$WORKSHOP_QA_ROOT" -v "$dest:/backup" "$image" \
    node server/backup-google.mjs /backup/google-full.json
else
  docker run --rm --name "${VPS_BACKUP_CONTAINER:?}" --label "vps-drive.attempt=${VPS_BACKUP_ATTEMPT:?}" --user 0 --env-file "$shared/app.env" \
    -e GOOGLE_CREDENTIALS_FILE=/run/secrets/google.json \
    -v "$shared/google-service-account.json:/run/secrets/google.json:ro" -v "$dest:/backup" "$image" \
    node server/backup-google.mjs /backup/google-full.json
fi
sqlite3 "$shared/data/finance.sqlite3" ".backup '$dest/finance.sqlite3'"
test "$(sqlite3 "$dest/finance.sqlite3" 'PRAGMA integrity_check;')" = ok
analytics=absent
manifest=(finance.sqlite3 google-full.json.gz files.tar.gz)
if test -f "$shared/data/analytics.sqlite3"; then
  sqlite3 "$shared/data/analytics.sqlite3" ".backup '$dest/analytics.sqlite3'"
  test "$(sqlite3 "$dest/analytics.sqlite3" 'PRAGMA integrity_check;')" = ok
  analytics=present
  manifest+=(analytics.sqlite3)
fi
sales=absent
if test -f "$shared/data/sales.sqlite3"; then
  sqlite3 "$shared/data/sales.sqlite3" ".backup '$dest/sales.sqlite3'"
  test "$(sqlite3 "$dest/sales.sqlite3" 'PRAGMA integrity_check;')" = ok
  sales=present
  manifest+=(sales.sqlite3)
fi
# These two files are process coordination, not recoverable application data.
volatile=("$shared/data/mail-assistant-v2/lock" "$shared/data/mail-assistant-v2/lease.json")
find "$shared/data" -type f ! -name 'finance.sqlite3*' ! -name 'analytics.sqlite3*' ! -name 'sales.sqlite3*' ! -path "${volatile[0]}" ! -path "${volatile[1]}" -print0 | sort -z | xargs -0 -r sha256sum > "$dest/files-before.sha256"
paths=("$shared" "$release")
if [[ -z "${WORKSHOP_QA_ROOT:-}" ]]; then
  paths+=(/etc/caddy/Caddyfile /etc/systemd/system/finance-pwa-backup.service /etc/systemd/system/finance-pwa-backup.timer /etc/systemd/system/workshop-monitor.service /etc/systemd/system/workshop-monitor.timer)
fi
tar -czpf "$dest/files.tar.gz" --exclude='finance.sqlite3' --exclude='finance.sqlite3-wal' --exclude='finance.sqlite3-shm' --exclude='analytics.sqlite3' --exclude='analytics.sqlite3-wal' --exclude='analytics.sqlite3-shm' --exclude='sales.sqlite3' --exclude='sales.sqlite3-wal' --exclude='sales.sqlite3-shm' --exclude="${volatile[0]#/}" --exclude="${volatile[1]#/}" "${paths[@]}"
find "$shared/data" -type f ! -name 'finance.sqlite3*' ! -name 'analytics.sqlite3*' ! -name 'sales.sqlite3*' ! -path "${volatile[0]}" ! -path "${volatile[1]}" -print0 | sort -z | xargs -0 -r sha256sum > "$dest/files-after.sha256"
cmp "$dest/files-before.sha256" "$dest/files-after.sha256"
gzip "$dest/google-full.json"
(cd "$dest" && sha256sum "${manifest[@]}" > SHA256SUMS)
printf 'started=%s\nfinished=%s\nrelease=%s\nanalytics=%s\nsales=%s\n' "$started" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$release" "$analytics" "$sales" > "$dest/COMPLETE"
python3 /usr/local/lib/vps-drive/check-backup-immutable.py "$dest" "$release" 900
echo "Workshop backup verified: $dest"
