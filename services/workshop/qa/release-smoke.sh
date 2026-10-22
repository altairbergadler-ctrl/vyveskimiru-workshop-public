#!/usr/bin/env bash
# Run on a Docker Linux host. Own resources are listed and removed; no production credentials.
set -euo pipefail
umask 077
source_root="$(cd "$(dirname "$0")/.." && pwd)"
export WORKSHOP_QA_ROOT="${WORKSHOP_QA_ROOT:?owned /opt/workshop-qa/run-* root required}"
export WORKSHOP_QA_PORT="${WORKSHOP_QA_PORT:-18260}"
source "$source_root/deploy/release-common.sh"
export WORKSHOP_LOCK_HELD="$base"
evidence="$WORKSHOP_QA_ROOT/evidence"
mkdir -p "$shared/data" "$evidence"
printf 'workshop-qa-v1\n' > "$shared/.workshop-qa"
printf '{}\n' > "$shared/google-service-account.json"
cat > "$shared/app.env" <<EOF
GOOGLE_SPREADSHEET_ID=offline-workshop
GOOGLE_CREDENTIALS_FILE=
DATA_DIR=$shared/data
QA_DIRECTORY=$shared
NODE_OPTIONS=--import=/app/qa/offline-preload.mjs
COOKIE_SECURE=false
EOF
chown -R 1000:1000 "$shared"
chmod 755 "$WORKSHOP_QA_ROOT" "$base" "$shared"
versions=(aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc dddddddddddddddddddddddddddddddddddddddd)
! docker container inspect "$container" >/dev/null 2>&1
for sha in "${versions[@]}"; do ! docker image inspect "finance-pwa:$sha" >/dev/null 2>&1; done
cleanup() {
  local status=$?
  trap - EXIT
  docker logs "$container" > "$evidence/final-container.log" 2>&1 || true
  docker rm -f "$container" >/dev/null 2>&1 || true
  docker network rm "${container}_offline" "${container}_default" >/dev/null 2>&1 || true
  for sha in "${versions[@]}"; do docker image rm "finance-pwa:$sha" >/dev/null 2>&1 || true; done
  printf 'exit=%s\n' "$status" > "$evidence/result"
  echo "Isolated release test finished ($status); evidence: $evidence"
  exit "$status"
}
trap cleanup EXIT
prepare() {
  local sha="$1" dest="$base/releases/$1"
  mkdir -p "$dest"
  tar -C "$source_root" --exclude=.git --exclude=node_modules --exclude=work --exclude=dist -cf - . | tar -C "$dest" -xf -
  if [[ "$sha" = "${versions[3]}" ]]; then printf "import test from 'node:test'; test('injected failure',()=>{throw new Error('QA_CHECK_FAILURE')});\n" > "$dest/qa/injected.test.mjs"; fi
}
pack() {
  local sha="$1" archive="$WORKSHOP_QA_ROOT/$1.tar.gz"
  tar -C "$base/releases/$sha" -czf "$archive" .
  sha256sum "$archive" | cut -d' ' -f1 > "$archive.sha256"
  printf '%s\n' "$sha" > "$archive.revision"
  # Only this function's newly created candidate source, inside the verified root.
  test "$(realpath "$base/releases/$sha")" = "$WORKSHOP_QA_ROOT/installation/releases/$sha"
  rm -r -- "$base/releases/$sha"
}
prepare "${versions[0]}"
compose "$base/releases/${versions[0]}" "${versions[0]}" build > "$evidence/build.log" 2>&1
compose "$base/releases/${versions[0]}" "${versions[0]}" up -d --no-build
ln -sfn "$base/releases/${versions[0]}" "$base/app"
health "${versions[0]}"
prepare "${versions[1]}"; pack "${versions[1]}"
bash "$source_root/deploy/install-workshop.sh" "${versions[1]}" "$WORKSHOP_QA_ROOT/${versions[1]}.tar.gz" > "$evidence/deploy.log" 2>&1
checkpoint="$(find "$backup_root/releases" -name DEPLOYED -printf '%h\n')"
test -n "$checkpoint"
docker exec -e NODE_OPTIONS= "$container" node qa/release-record.mjs create > "$evidence/record-created.json"
# A reserved order blocks rollback before stopping the live candidate.
mkdir -p "$shared/data/orders/creation"
printf '{"state":"reserved"}\n' > "$shared/data/orders/creation/qa-block.json"
if bash "$source_root/deploy/rollback-workshop.sh" "$checkpoint" > "$evidence/blocked-rollback.log" 2>&1; then exit 1; fi
health "${versions[1]}"
printf '{"state":"aborted"}\n' > "$shared/data/orders/creation/qa-block.json"
bash "$source_root/deploy/rollback-workshop.sh" "$checkpoint" > "$evidence/rollback.log" 2>&1
health "${versions[0]}"
docker exec -e NODE_OPTIONS= "$container" node qa/release-record.mjs verify > "$evidence/record-after-rollback.json"
# New image starts but cannot read its fake spreadsheet: automatic rollback must restore A.
prepare "${versions[2]}"; pack "${versions[2]}"
touch "$shared/fail-${versions[2]}"
if bash "$source_root/deploy/install-workshop.sh" "${versions[2]}" "$WORKSHOP_QA_ROOT/${versions[2]}.tar.gz" > "$evidence/failed-health.log" 2>&1; then exit 1; fi
health "${versions[0]}"
docker exec -e NODE_OPTIONS= "$container" node qa/release-record.mjs verify > "$evidence/record-after-failure.json"
# Failing tests in the image build must leave the running version and start time untouched.
started="$(docker inspect --format '{{.State.StartedAt}}' "$container")"
prepare "${versions[3]}"; pack "${versions[3]}"
if bash "$source_root/deploy/install-workshop.sh" "${versions[3]}" "$WORKSHOP_QA_ROOT/${versions[3]}.tar.gz" > "$evidence/failed-check.log" 2>&1; then exit 1; fi
test "$(docker inspect --format '{{.State.StartedAt}}' "$container")" = "$started"
health "${versions[0]}"
mkdir "$WORKSHOP_QA_ROOT/restore"
tar -xzf "$checkpoint/backup/files.tar.gz" -C "$WORKSHOP_QA_ROOT/restore"
test -f "$WORKSHOP_QA_ROOT/restore$shared/sheet.json"
cmp "$WORKSHOP_QA_ROOT/restore$shared/.workshop-qa" "$shared/.workshop-qa"
echo 'PASS: deploy, backup restore, rollback, command block, failed health recovery, failed check before stop, confirmed record and file retention' > "$evidence/assertions.txt"
