#!/usr/bin/env bash
set -euo pipefail
# The only installer for this repository is the complete workshop release.
exec bash "$(dirname "$0")/install-workshop.sh" "$@"
