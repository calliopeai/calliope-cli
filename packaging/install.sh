#!/usr/bin/env bash
# Compatibility entry point; install.sh at the repository root is canonical.
set -euo pipefail
source_file="${BASH_SOURCE[0]:-}"
if [ -n "$source_file" ] && [ -f "$source_file" ]; then
  root="$(cd -- "$(dirname -- "$source_file")/.." && pwd)"
  if [ -f "$root/install.sh" ]; then exec bash "$root/install.sh" "$@"; fi
fi
# curl | bash has no local checkout. The HTTPS bootstrap delegates all artifact
# verification to the canonical installer, exactly as downloading it directly.
script="$(mktemp "${TMPDIR:-/tmp}/calliope-bootstrap.XXXXXXXX")"
cleanup() { rm -f -- "$script"; }
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
  --connect-timeout 10 --max-time 30 --max-filesize 32768 \
  https://raw.githubusercontent.com/calliopeai/calliope-cli/main/install.sh --output "$script"
bash "$script" "$@"
