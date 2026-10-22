#!/usr/bin/env bash
# Ordinary unified-backend update. The completed migration is a separate procedure.
set -euo pipefail
source "$(dirname "$0")/release-common.sh"
sha="${1:?full release SHA required}"
archive="$(realpath "${2:?release archive required}")"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]]
test "$(cat "$archive.revision")" = "$sha"
test "$(sha256sum "$archive" | cut -d' ' -f1)" = "$(cat "$archive.sha256")"
previous="$(readlink -f "$base/app")"
if [[ -n "${WORKSHOP_EXPECTED_RELEASE:-}" && "$(basename "$previous")" != "$WORKSHOP_EXPECTED_RELEASE" ]]; then
  echo 'Live release changed; merge it before publishing.' >&2; exit 1
fi
test -f "$previous/compose.yaml"
grep -q 'FinanceSheetStore' "$previous/server/index.mjs" || { echo 'Use the separate migration procedure for a legacy installation' >&2; exit 1; }
test -s "$shared/app.env"
guard
release="$base/releases/$sha"
test ! -e "$release"
mkdir "$release"
# Archives cannot escape the new release or introduce external links.
python3 - "$archive" "$release" <<'PY'
import pathlib,sys,tarfile
with tarfile.open(sys.argv[1]) as tar:
    root=pathlib.Path(sys.argv[2]).resolve()
    for item in tar.getmembers():
        assert item.isfile() or item.isdir(), 'UNSUPPORTED_ARCHIVE_ENTRY'
        assert (root/item.name).resolve().is_relative_to(root), 'UNSAFE_ARCHIVE_PATH'
    tar.extractall(root)
PY
find "$release/deploy" "$release/qa" -name '*.sh' -exec sed -i 's/\r$//' {} +
chmod 755 "$release"/deploy/*.sh
python3 "$script_dir/check-commands.py" "$shared/data" "$release"
# The build stage runs npm run check before producing any runtime image.
compose "$release" "$sha" build
checkpoint="$backup_root/releases/$(date -u +%Y%m%dT%H%M%SZ)-$sha"
mkdir "$checkpoint"
printf '%s\n' "$previous" > "$checkpoint/previous-release"
docker inspect --format '{{.Config.Image}}' "$container" > "$checkpoint/previous-image"
printf '%s\n' "$release" > "$checkpoint/new-release"
cp -a "$release/deploy" "$checkpoint/procedure"
printf '%s\n' "$base" > "$checkpoint/base"
needs_recovery=false
recover() {
  local status=$?
  trap - EXIT
  if [[ "$needs_recovery" = true ]]; then
    echo 'Release failed; recovering previous code with current data.' >&2
    WORKSHOP_LOCK_HELD="$base" bash "$checkpoint/procedure/rollback-workshop.sh" "$checkpoint" --recovery || {
      echo "Automatic recovery blocked; maintenance remains. Checkpoint: $checkpoint" >&2; exit 1;
    }
  fi
  exit "$status"
}
trap recover EXIT
needs_recovery=true
maintenance "$checkpoint"
docker stop -t 90 "$container" >/dev/null
guard
python3 "$script_dir/check-commands.py" "$shared/data" "$release"
WORKSHOP_LOCK_HELD="$base" bash "$release/deploy/backup-workshop.sh" "$checkpoint/backup"
python3 "$release/deploy/check-backup.py" "$checkpoint/backup" "$previous" 900
if [[ "${WORKSHOP_UPDATE_CODEX_BRIDGE:-}" = 1 && -z "${WORKSHOP_QA_ROOT:-}" ]]; then
  node "$release/deploy/codex-bridge.mjs" install "$checkpoint" "$release"
fi
# Explicit v2 cutover: source steps remain intact; schema and import are atomic.
if [[ -z "${WORKSHOP_QA_ROOT:-}" ]]; then
  compose "$release" "$sha" run --rm --no-deps finance-pwa node server/document-migrate.mjs --check-pending
  compose "$release" "$sha" run --rm --no-deps finance-pwa node server/production-migrate.mjs --apply
  document_seed=()
  if test -f "$shared/secrets/document-sellers.json"; then document_seed=(-e DOCUMENT_SELLER_SEED_FILE=/run/secrets/workshop/document-sellers.json); fi
  compose "$release" "$sha" run --rm --no-deps "${document_seed[@]}" finance-pwa node server/document-migrate.mjs --apply
fi
compose "$release" "$sha" up -d --no-build
health "$sha"
ln -sfn "$release" "$base/app"
restore_routes "$checkpoint"
diagnose
needs_recovery=false
printf '%s\n' "$sha" > "$checkpoint/DEPLOYED"
echo "Workshop release verified. Rollback checkpoint: $checkpoint"
