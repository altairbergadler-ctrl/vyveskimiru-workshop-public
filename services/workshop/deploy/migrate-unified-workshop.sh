#!/usr/bin/env bash
set -euo pipefail
umask 077
sha="${1:?full release SHA required}"
archive="${2:?release archive required}"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] && test -f "$archive"
base=/opt/finance-pwa
shared="$base/shared"
test -s "$shared/app.env" && test -s "$shared/google-service-account.json"
test -f "$shared/data/finance.sqlite3"
test "$(sqlite3 "$shared/data/finance.sqlite3" 'SELECT count(*) FROM transactions WHERE pending=1;')" = 0
if sqlite3 "$shared/data/finance.sqlite3" "SELECT 1 FROM sqlite_master WHERE name='finance_commands';" | grep -q 1; then
  test "$(sqlite3 "$shared/data/finance.sqlite3" "SELECT count(*) FROM finance_commands WHERE state='submitted';")" = 0
fi
test "$(systemctl is-active workshop-crm.service || true)" = inactive
release="$base/releases/$sha"
test ! -e "$release"
mkdir "$release"
tar -xzf "$archive" -C "$release"
find "$release/deploy" -name '*.sh' -exec sed -i 's/\r$//' {} +
chmod 755 "$release"/deploy/*.sh
cd "$release"
APP_VERSION="$sha" docker compose build
checkpoint="/opt/workshop-backups/releases/$(date -u +%Y%m%dT%H%M%SZ)-$sha"
mkdir -p "$checkpoint"
readlink -f "$base/app" > "$checkpoint/previous-release"
docker inspect --format '{{.Config.Image}}' finance-pwa > "$checkpoint/previous-image"
systemctl is-enabled orders-kanban.service > "$checkpoint/kanban-enabled" || true
systemctl is-active orders-kanban.service > "$checkpoint/kanban-active" || true
cp -a /etc/caddy/Caddyfile "$checkpoint/Caddyfile.before"
cp -a /etc/systemd/system/finance-pwa-backup.service "$checkpoint/backup.service.before"
cp -a /var/lib/private/orders-kanban "$checkpoint/orders-before"
cp -a "$release/deploy/rollback-migration.sh" "$checkpoint/rollback.sh"

# Prepare and validate both configurations before entering maintenance.
cp -a "$checkpoint/Caddyfile.before" "$checkpoint/Caddyfile.maintenance"
python3 "$release/deploy/route-workshop.py" "$checkpoint/Caddyfile.maintenance" maintenance
caddy validate --config "$checkpoint/Caddyfile.maintenance" --adapter caddyfile >/dev/null
cp -a "$checkpoint/Caddyfile.before" "$checkpoint/Caddyfile.unified"
python3 "$release/deploy/route-workshop.py" "$checkpoint/Caddyfile.unified" unified
caddy validate --config "$checkpoint/Caddyfile.unified" --adapter caddyfile >/dev/null
rollback() {
  echo 'Release failed; restoring previous service while preserving current Google records' >&2
  bash "$checkpoint/rollback.sh" "$checkpoint" || { echo "Rollback needs attention. Checkpoint: $checkpoint" >&2; exit 1; }
}
trap rollback ERR
cp -a "$checkpoint/Caddyfile.maintenance" /etc/caddy/Caddyfile
systemctl reload caddy
systemctl stop orders-kanban.service
# Wait for a full legacy sync after new public requests have been blocked.
if ! grep -q 'FinanceSheetStore' "$(cat "$checkpoint/previous-release")/server/index.mjs"; then
  before="$(sqlite3 "$shared/data/finance.sqlite3" "SELECT value FROM sync_state WHERE key='last_success_at';")"
  for _ in {1..45}; do
    after="$(sqlite3 "$shared/data/finance.sqlite3" "SELECT value FROM sync_state WHERE key='last_success_at';")"
    if test "$after" != "$before"; then break; fi
    sleep 2
  done
  test "$after" != "$before"
fi
docker stop -t 90 finance-pwa
test "$(sqlite3 "$shared/data/finance.sqlite3" 'SELECT count(*) FROM transactions WHERE pending=1;')" = 0
sqlite3 "$shared/data/finance.sqlite3" ".backup '$checkpoint/finance.sqlite3'"
if test "$(cat "$checkpoint/kanban-active")" = active; then
  mkdir -p "$shared/data/orders"
  cp -a /var/lib/private/orders-kanban/. "$shared/data/orders/"
  chown -R 1000:1000 "$shared/data/orders"
fi
# Exact reconciliation immediately before enabling the new writer.
if ! grep -q 'FinanceSheetStore' "$(cat "$checkpoint/previous-release")/server/index.mjs"; then
  cp "$checkpoint/finance.sqlite3" "$checkpoint/parity.sqlite3"
  docker run --rm --user 0 --env-file "$shared/app.env" \
  -e GOOGLE_CREDENTIALS_FILE=/run/secrets/google.json -e VERIFY_DATABASE=/verify/parity.sqlite3 \
  -v "$checkpoint:/verify" -v "$shared/google-service-account.json:/run/secrets/google.json:ro" \
  "finance-pwa:$sha" node server/verify-cutover.mjs
fi
APP_VERSION="$sha" docker compose up -d --no-build
ln -sfn "$release" "$base/app"
ready=false
for _ in {1..40}; do
  if curl -fsS http://127.0.0.1:18100/api/health | python3 -c 'import json,sys; v=json.load(sys.stdin); sys.exit(0 if v["status"]=="ok" and len(v.get("checks",{}))==3 else 1)' 2>/dev/null; then ready=true; break; fi
  sleep 2
done
test "$ready" = true
systemctl disable orders-kanban.service
mkdir -p /etc/systemd/system/orders-kanban.service.d
printf '[Unit]\nConditionPathExists=!/opt/orders-kanban/shared/RETIRED\n' > /etc/systemd/system/orders-kanban.service.d/retired.conf
printf 'Managed by unified workshop release %s\n' "$sha" > /opt/orders-kanban/shared/RETIRED
cp -a "$checkpoint/Caddyfile.unified" /etc/caddy/Caddyfile
systemctl reload caddy
install -m644 "$release/deploy/finance-pwa-backup.service" /etc/systemd/system/finance-pwa-backup.service
install -m644 "$release/deploy/workshop-monitor.service" /etc/systemd/system/workshop-monitor.service
install -m644 "$release/deploy/workshop-monitor.timer" /etc/systemd/system/workshop-monitor.timer
systemctl daemon-reload
systemctl enable --now workshop-monitor.timer
docker exec finance-pwa node server/diagnose-live.mjs
trap - ERR
printf '%s\n' "$sha" > "$checkpoint/DEPLOYED"
echo "Workshop release verified. Rollback checkpoint: $checkpoint"
