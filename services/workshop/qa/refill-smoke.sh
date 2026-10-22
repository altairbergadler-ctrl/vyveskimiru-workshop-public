#!/usr/bin/env bash
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
container="workshop-qa-refill-${root##*/}"
cleanup() {
  local status=$?
  trap - EXIT
  docker rm -f "$container" >/dev/null 2>&1 || true
  if ! node "$source/qa/contract-copy.mjs" restore; then status=1; fi
  echo "Refill integration stopped ($status); review $QA_DIRECTORY"
  exit "$status"
}
trap cleanup EXIT
node "$source/qa/contract-copy.mjs" prepare
chown -R 1000:1000 "$QA_DIRECTORY"
chmod 755 "$root" "$source"
docker run --rm --name "$container" --read-only --tmpfs /tmp \
  -e GOOGLE_SPREADSHEET_ID -e QA_CONFIRM_SHEET \
  -e GOOGLE_CREDENTIALS_FILE=/run/secrets/google.json -e QA_DIRECTORY=/qa \
  -v "$QA_DIRECTORY:/qa" -v "$GOOGLE_CREDENTIALS_FILE:/run/secrets/google.json:ro" \
  -v "$source/server:/app/server:ro" -v "$source/qa:/app/qa:ro" \
  --entrypoint node "$image" qa/refill-integration.mjs > "$QA_DIRECTORY/result.log" 2>&1
cat "$QA_DIRECTORY/result.log"
