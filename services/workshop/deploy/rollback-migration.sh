#!/usr/bin/env bash
set -euo pipefail
umask 077
checkpoint="${1:?checkpoint directory required}"
test -f "$checkpoint/previous-release"
test -f "$checkpoint/Caddyfile.before"
previous="$(cat "$checkpoint/previous-release")"
image="$(cat "$checkpoint/previous-image")"
test -f "$previous/compose.yaml"
check_unconfirmed() {
  database=/opt/finance-pwa/shared/data/finance.sqlite3
  if sqlite3 "$database" "SELECT 1 FROM sqlite_master WHERE name='finance_commands';" | grep -q 1; then
    if test "$(sqlite3 "$database" "SELECT count(*) FROM finance_commands WHERE state='submitted';")" != 0; then
      echo 'Rollback blocked: verify unconfirmed Google commands before switching writers.' >&2
      return 1
    fi
  fi
}
check_unconfirmed
docker stop -t 90 finance-pwa
if ! check_unconfirmed; then
  docker start finance-pwa >/dev/null
  echo 'Current release restarted; rollback was not applied.' >&2
  exit 1
fi
# Never restore an older business database over newly accepted Google records.
# Refresh the legacy replica with the single old writer before exposing its UI.
if test "$(cat "$checkpoint/kanban-active")" = active && test -d /opt/finance-pwa/shared/data/orders; then
  cp -a /opt/finance-pwa/shared/data/orders/. /var/lib/private/orders-kanban/
  chown -R --reference=/var/lib/private/orders-kanban /var/lib/private/orders-kanban
fi
if ! grep -q 'FinanceSheetStore' "$previous/server/index.mjs"; then
  docker run --rm --env-file /opt/finance-pwa/shared/app.env \
    -e DATA_DIR=/data -e GOOGLE_CREDENTIALS_FILE=/run/secrets/google.json \
    -v /opt/finance-pwa/shared/data:/data \
    -v /opt/finance-pwa/shared/google-service-account.json:/run/secrets/google.json:ro "$image" \
    node --input-type=module -e "import {openDatabase} from './server/db.mjs'; import {GoogleSheetsClient} from './server/google-sheets.mjs'; import {SheetSynchronizer} from './server/sync.mjs'; const db=openDatabase('/data/finance.sqlite3'); const sync=new SheetSynchronizer({db,client:new GoogleSheetsClient({credentialsFile:process.env.GOOGLE_CREDENTIALS_FILE,spreadsheetId:process.env.GOOGLE_SPREADSHEET_ID})}); for(let i=0;i<2;i++) {if(!(await sync.run()).success)process.exit(1);} db.close();"
fi
cd "$previous"
APP_VERSION="${image##*:}" docker compose up -d --no-build
ln -sfn "$previous" /opt/finance-pwa/app
if test "$(cat "$checkpoint/kanban-active")" = active; then rm -f /opt/orders-kanban/shared/RETIRED; fi
if test "$(cat "$checkpoint/kanban-enabled")" = enabled; then systemctl enable orders-kanban.service; fi
if test "$(cat "$checkpoint/kanban-active")" = active; then systemctl start orders-kanban.service; fi
cp -a "$checkpoint/Caddyfile.before" /etc/caddy/Caddyfile
caddy validate --config /etc/caddy/Caddyfile >/dev/null
systemctl reload caddy
if test -f "$checkpoint/backup.service.before"; then cp -a "$checkpoint/backup.service.before" /etc/systemd/system/finance-pwa-backup.service; fi
if ! grep -q 'FinanceSheetStore' "$previous/server/index.mjs"; then systemctl disable --now workshop-monitor.timer 2>/dev/null || true; fi
systemctl daemon-reload
echo 'Workshop rollback completed; current Google records preserved'
