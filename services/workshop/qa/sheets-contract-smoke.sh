#!/usr/bin/env bash
# Reuse the unchanged production dependencies; mount the candidate source read-only.
set -euo pipefail
umask 077
root="${WORKSHOP_QA_ROOT:?owned root required}"
[[ "$root" =~ ^/opt/workshop-qa/run-[a-zA-Z0-9-]+$ ]]
test "$(realpath "$root")" = "$root"
test "$(cat "$root/.workshop-qa")" = workshop-qa-v1
source="$root/source"
test "$(realpath "$source")" = "$source"
image="${1:?existing compatible runtime image required}"
export GOOGLE_SPREADSHEET_ID="${GOOGLE_SPREADSHEET_ID:?test ID required}" QA_CONFIRM_SHEET="${QA_CONFIRM_SHEET:?confirmation required}"
export GOOGLE_CREDENTIALS_FILE="${2:?credentials file required}" QA_DIRECTORY="$root/integration"
test ! -e "$QA_DIRECTORY"
mkdir -p "$QA_DIRECTORY/data"
printf workshop-qa-v1 > "$QA_DIRECTORY/.workshop-qa"
container="workshop-qa-contract-${root##*/}"
! docker container inspect "$container" >/dev/null 2>&1
cleanup() {
  local status=$?
  trap - EXIT
  docker logs "$container" > "$QA_DIRECTORY/server.log" 2>&1 || true
  docker rm -f "$container" >/dev/null 2>&1 || true
  if ! node "$source/qa/contract-copy.mjs" restore; then status=1; fi
  echo "Contract integration stopped ($status); review $QA_DIRECTORY"
  exit "$status"
}
trap cleanup EXIT
node "$source/qa/contract-copy.mjs" prepare
chown -R 1000:1000 "$QA_DIRECTORY"
chmod 755 "$root" "$source"
docker run -d --name "$container" --restart no --read-only --tmpfs /tmp \
  -e GOOGLE_SPREADSHEET_ID -e QA_CONFIRM_SHEET \
  -e GOOGLE_CREDENTIALS_FILE=/run/secrets/google.json -e DATA_DIR=/qa/data -e QA_DIRECTORY=/qa \
  -e NODE_OPTIONS=--import=/app/qa/integration-preload.mjs -e APP_VERSION=qa-sheets-contract -e COOKIE_SECURE=false \
  -v "$QA_DIRECTORY:/qa" -v "$GOOGLE_CREDENTIALS_FILE:/run/secrets/google.json:ro" \
  -v "$source/server:/app/server:ro" -v "$source/modules/orders/server:/app/modules/orders/server:ro" \
  -v "$source/qa:/app/qa:ro" -v "$source/dist:/app/dist:ro" "$image" >/dev/null
ready=false
for _ in {1..60}; do
  if docker exec "$container" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(v=>process.exit(v.status==='ok'?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then ready=true; break; fi
  sleep 1
done
test "$ready" = true
docker exec "$container" node qa/integration.mjs
docker exec "$container" node qa/contract-integration.mjs
