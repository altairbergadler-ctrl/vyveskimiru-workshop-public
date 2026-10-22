#!/usr/bin/env bash
set -euo pipefail
umask 077
script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
base=/opt/finance-pwa
container=finance-pwa
backup_root=/opt/workshop-backups
port=18100
target=production
if [[ -n "${WORKSHOP_QA_ROOT:-}" ]]; then
  [[ "$WORKSHOP_QA_ROOT" =~ ^/opt/workshop-qa/run-[a-zA-Z0-9-]+$ ]]
  test "$(realpath "$WORKSHOP_QA_ROOT")" = "$WORKSHOP_QA_ROOT"
  test "$(cat "$WORKSHOP_QA_ROOT/.workshop-qa")" = workshop-qa-v1
  base="$WORKSHOP_QA_ROOT/installation"
  container="workshop-qa-${WORKSHOP_QA_ROOT##*/}"
  backup_root="$WORKSHOP_QA_ROOT/backups"
  for owned_path in "$base" "$base/shared" "$base/shared/data" "$base/releases" "$backup_root"; do
    test "$(realpath -m "$owned_path")" = "$owned_path" || { echo 'QA path resolves outside its owned location' >&2; exit 1; }
  done
  port="${WORKSHOP_QA_PORT:?isolated loopback port required}"
  [[ "$port" =~ ^[0-9]+$ ]] && (( port >= 18200 && port <= 18999 ))
  target=test-runtime
fi
shared="$base/shared"
export WORKSHOP_BASE="$base" WORKSHOP_CONTAINER="$container" WORKSHOP_PORT="$port" WORKSHOP_BUILD_TARGET="$target"
export COMPOSE_PROJECT_NAME="$container"
mkdir -p "$base/releases" "$backup_root/releases"
exec 9>"$base/release.lock"
if [[ "${WORKSHOP_LOCK_HELD:-}" != "$base" ]]; then flock -n 9 || { echo 'Another release or backup is running' >&2; exit 1; }; fi

compose() {
  local options=(-p "$container" -f "$1/compose.yaml")
  if [[ -n "${WORKSHOP_QA_ROOT:-}" ]]; then options+=(-f "$script_dir/compose.qa.yaml"); fi
  APP_VERSION="$2" docker compose "${options[@]}" "${@:3}"
}
guard() { python3 "$script_dir/check-commands.py" "$shared/data"; }
health() {
  local expected="$1"
  for _ in {1..45}; do
    if health_json | python3 -c 'import json,sys; v=json.load(sys.stdin); sys.exit(0 if v.get("status")=="ok" and v.get("version")==sys.argv[1] and len(v.get("checks",{}))==3 and all(c.get("ok") for c in v["checks"].values()) else 1)' "$expected" 2>/dev/null; then return 0; fi
    sleep 1
  done
  return 1
}
health_json() {
  if [[ -n "${WORKSHOP_QA_ROOT:-}" ]]; then
    docker exec -e NODE_OPTIONS= "$container" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.text()).then(console.log).catch(()=>process.exit(1))" 2>/dev/null
  else
    curl -fsS "http://127.0.0.1:$port/api/health" 2>/dev/null
  fi
}
diagnose() {
  if [[ -n "${WORKSHOP_QA_ROOT:-}" ]]; then
    docker exec -e NODE_OPTIONS= -e DIAGNOSTICS_PUBLIC_URL=http://127.0.0.1:3000 "$container" node server/diagnose-live.mjs
  else
    docker exec "$container" node server/diagnose-live.mjs
  fi
}
maintenance() {
  local checkpoint="$1"
  if [[ -z "${WORKSHOP_QA_ROOT:-}" ]]; then
    cp -a /etc/caddy/Caddyfile "$checkpoint/Caddyfile.before"
    cp -a "$checkpoint/Caddyfile.before" "$checkpoint/Caddyfile.maintenance"
    if ! grep -q '@workshop_maintenance' "$checkpoint/Caddyfile.maintenance"; then
      python3 "$script_dir/route-workshop.py" "$checkpoint/Caddyfile.maintenance" maintenance
    fi
    caddy validate --config "$checkpoint/Caddyfile.maintenance" --adapter caddyfile >/dev/null
    cp -a "$checkpoint/Caddyfile.maintenance" /etc/caddy/Caddyfile
    systemctl reload caddy
  fi
}
restore_routes() {
  if [[ -z "${WORKSHOP_QA_ROOT:-}" ]]; then
    cp -a "$1/Caddyfile.before" /etc/caddy/Caddyfile
    systemctl reload caddy
  fi
}
