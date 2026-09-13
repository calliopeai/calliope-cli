#!/usr/bin/env bash
# Verified standalone Calliope AI CLI installation. Node/npm/Bun are not required.
# Requires curl, GitHub CLI (gh auth login), and sha256sum or shasum.
# CALLIOPE_VERSION=vX.Y.Z selects a release; CALLIOPE_INSTALL_DIR selects its destination.
set -euo pipefail
umask 077
REPO=calliopeai/calliope-cli
SIGNER="$REPO/.github/workflows/release-binaries.yml"
scratch=''
staged=''
cleanup() {
  [ -z "$staged" ] || rm -f -- "$staged"
  [ -z "$scratch" ] || rm -rf -- "$scratch"
}
trap cleanup EXIT
trap 'exit 130' INT
trap 'exit 143' TERM
fail() { printf 'error: %s\n' "$*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }
for tool in curl gh; do have "$tool" || fail "$tool is required; see docs/release-integrity.md."; done
have sha256sum || have shasum || fail 'sha256sum or shasum is required.'

os="$(uname -s)"; arch="$(uname -m)"
case "$os" in Darwin) os=darwin;; Linux) os=linux;; *) fail 'Only macOS and Linux are supported.';; esac
case "$arch" in arm64|aarch64) arch=arm64;; x86_64|amd64) arch=x64;; *) fail 'Only arm64 and x64 are supported.';; esac

tag="${CALLIOPE_VERSION:-}"
if [ -z "$tag" ]; then tag="$(gh api "repos/$REPO/releases/latest" --jq .tag_name)" || fail 'Cannot resolve the latest release.'; fi
[ "${#tag}" -le 128 ] && [[ "$tag" =~ ^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z]+([.-][0-9A-Za-z]+)*)?$ ]] || fail 'Expected a version tag such as v3.2.0 or v3.2.0-alpha.1.'
commit="$(gh api "repos/$REPO/commits/$tag" --jq .sha)" || fail 'Cannot resolve the release commit.'
[[ "$commit" =~ ^[0-9a-f]{40}$ ]] || fail 'Invalid release commit.'
asset="calliope-${tag#v}-${os}-${arch}"
base="https://github.com/$REPO/releases/download/$tag"
scratch="$(mktemp -d "${TMPDIR:-/tmp}/calliope-install.XXXXXXXX")"

fetch() {
  curl --fail --silent --show-error --location --proto '=https' --proto-redir '=https' \
    --connect-timeout 10 --max-time 180 --retry 0 --max-filesize "$3" \
    "$base/$1" --output "$2" || fail "Download failed: $1. Nothing was installed."
}
verify() {
  gh attestation verify "$1" --bundle "$2" --repo "$REPO" \
    --source-ref "refs/tags/$tag" --source-digest "$commit" \
    --cert-identity "https://github.com/$SIGNER@refs/tags/$tag" \
    --deny-self-hosted-runners >/dev/null || fail 'Provenance verification failed. Nothing was installed.'
}
printf 'Verifying Calliope AI CLI %s (%s-%s)\n' "$tag" "$os" "$arch"
fetch checksums.txt "$scratch/checksums.txt" 32768
fetch checksums.txt.sigstore.json "$scratch/checksums.txt.sigstore.json" 1048576
verify "$scratch/checksums.txt" "$scratch/checksums.txt.sigstore.json"
expected="$(awk -v asset="$asset" '$2 == asset { if (NF != 2) exit 1; count++; hash=$1 } END { if (count != 1) exit 1; print hash }' "$scratch/checksums.txt")" || fail 'Missing or duplicate checksum entry.'
[[ "$expected" =~ ^[0-9a-f]{64}$ ]] || fail 'Invalid checksum entry.'
fetch "$asset" "$scratch/binary" 536870912
fetch "$asset.sigstore.json" "$scratch/binary.sigstore.json" 1048576
if have sha256sum; then actual="$(sha256sum "$scratch/binary" | awk '{print $1}')"; else actual="$(shasum -a 256 "$scratch/binary" | awk '{print $1}')"; fi
[ "$actual" = "$expected" ] || fail 'Binary checksum mismatch. Nothing was installed.'
verify "$scratch/binary" "$scratch/binary.sigstore.json"

install_dir="${CALLIOPE_INSTALL_DIR:-}"
if [ -z "$install_dir" ]; then
  if [ -w /usr/local/bin ]; then install_dir=/usr/local/bin; else install_dir="$HOME/.local/bin"; fi
fi
case "$install_dir" in /*) ;; *) fail 'CALLIOPE_INSTALL_DIR must be an absolute path.';; esac
[ ! -d "$install_dir/calliope" ] || fail 'The destination is a directory.'
mkdir -p -- "$install_dir"
staged="$(mktemp "$install_dir/.calliope.XXXXXXXX")"
cp -- "$scratch/binary" "$staged"
chmod 755 "$staged"
mv -f -- "$staged" "$install_dir/calliope"
staged=''
printf 'Installed verified Calliope AI CLI to %s/calliope\n' "$install_dir"
case ":$PATH:" in *":$install_dir:"*) ;; *) printf 'Add %s to PATH, then run calliope --setup.\n' "$install_dir";; esac
