#!/usr/bin/env bash
# Explicit Google integration on the allowlisted copy; no production app.env is loaded.
set -euo pipefail
umask 077
root="${WORKSHOP_QA_ROOT:?owned QA root required}"
[[ "$root" =~ ^/opt/workshop-qa/run-[a-zA-Z0-9-]+$ ]]
test "$(realpath "$root")" = "$root"
test "$(cat "$root/.workshop-qa")" = workshop-qa-v1
image="${1:?test-runtime image required}"
credentials="${2:?read-only service-account file required}"
test -s "$credentials"
test -n "${GOOGLE_SPREADSHEET_ID:-}" && test -n "${QA_CONFIRM_SHEET:-}"
docker run --rm --network none -e GOOGLE_SPREADSHEET_ID -e QA_CONFIRM_SHEET "$image" \
  node --input-type=module -e "import {assertTestSheet} from './qa/safety.mjs'; assertTestSheet(process.env.GOOGLE_SPREADSHEET_ID,process.env.QA_CONFIRM_SHEET)"
directory="$root/integration"
test ! -e "$directory"
container="workshop-qa-integration-${root##*/}"
! docker container inspect "$container" >/dev/null 2>&1
mkdir -p "$directory/data"
printf 'workshop-qa-v1\n' > "$directory/.workshop-qa"
chown -R 1000:1000 "$directory"
cleanup() {
  local status=$?
  trap - EXIT
  docker logs "$container" > "$directory/server.log" 2>&1 || true
  docker rm -f "$container" >/dev/null 2>&1 || true
  echo "Integration stopped ($status); retain receipts/report until reviewed: $directory"
  exit "$status"
}
trap cleanup EXIT
docker run -d --name "$container" --restart no --read-only --tmpfs /tmp \
  -e GOOGLE_SPREADSHEET_ID -e QA_CONFIRM_SHEET \
  -e GOOGLE_CREDENTIALS_FILE=/run/secrets/google.json -e DATA_DIR=/qa/data -e QA_DIRECTORY=/qa \
  -e NODE_OPTIONS=--import=/app/qa/integration-preload.mjs -e APP_VERSION=qa-integration -e COOKIE_SECURE=false \
  -v "$directory:/qa" -v "$credentials:/run/secrets/google.json:ro" "$image" >/dev/null
ready=false
for _ in {1..60}; do
  if docker exec "$container" node -e "fetch('http://127.0.0.1:3000/api/health').then(r=>r.json()).then(v=>process.exit(v.status==='ok'?0:1)).catch(()=>process.exit(1))" 2>/dev/null; then ready=true; break; fi
  sleep 1
done
test "$ready" = true
docker exec "$container" node qa/integration.mjs
