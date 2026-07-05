#!/usr/bin/env bash
#
# Calliope single-binary installer (issue #187).
#
#   curl -fsSL https://raw.githubusercontent.com/calliopeai/calliope-cli/main/packaging/install.sh | bash
#
# Downloads the standalone `calliope` binary for this OS/arch from the latest
# GitHub Release, verifies its SHA-256 against the release checksums.txt, and
# installs it to /usr/local/bin (if writable) or ~/.local/bin. No Node.js, npm,
# or Bun required on the target machine.
#
# Overrides (env vars):
#   CALLIOPE_VERSION   install a specific version tag instead of "latest" (e.g. v3.0.0)
#   CALLIOPE_INSTALL_DIR   force the install directory
#
set -euo pipefail

REPO="calliopeai/calliope-cli"
BIN_NAME="calliope"

# ── Output helpers ──────────────────────────────────────────────────────────
if [ -t 1 ]; then
  BOLD=$'\033[1m'; GREEN=$'\033[0;32m'; YELLOW=$'\033[0;33m'; RED=$'\033[0;31m'; DIM=$'\033[2m'; NC=$'\033[0m'
else
  BOLD=""; GREEN=""; YELLOW=""; RED=""; DIM=""; NC=""
fi

info() { printf '%s\n' "${DIM}$*${NC}"; }
ok()   { printf '%s\n' "${GREEN}✓${NC} $*"; }
warn() { printf '%s\n' "${YELLOW}!${NC} $*" >&2; }
err()  { printf '%s\n' "${RED}error:${NC} $*" >&2; exit 1; }

# ── Prerequisites ───────────────────────────────────────────────────────────
have() { command -v "$1" >/dev/null 2>&1; }
have curl || err "curl is required but was not found on PATH."

# Pick an available SHA-256 tool (macOS ships shasum; most Linux ship sha256sum).
sha256_of() {
  if have sha256sum; then
    sha256sum "$1" | awk '{print $1}'
  elif have shasum; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    err "need sha256sum or shasum to verify the download."
  fi
}

# ── Detect platform ─────────────────────────────────────────────────────────
detect_platform() {
  local os arch
  os="$(uname -s)"
  arch="$(uname -m)"
  case "$os" in
    Darwin) os="darwin" ;;
    Linux)  os="linux" ;;
    *) err "unsupported operating system: $os (macOS and Linux only)." ;;
  esac
  case "$arch" in
    arm64|aarch64) arch="arm64" ;;
    x86_64|amd64)  arch="x64" ;;
    *) err "unsupported architecture: $arch (arm64 and x64 only)." ;;
  esac
  printf '%s-%s' "$os" "$arch"
}

# ── Resolve the release tag ─────────────────────────────────────────────────
# Uses the public GitHub API (no auth needed for public repos). Parses the JSON
# with grep/sed so no jq dependency is imposed on the target machine.
resolve_tag() {
  if [ -n "${CALLIOPE_VERSION:-}" ]; then
    printf '%s' "$CALLIOPE_VERSION"
    return
  fi
  local api tag
  api="https://api.github.com/repos/${REPO}/releases/latest"
  tag="$(curl -fsSL "$api" | grep '"tag_name"' | head -n1 | sed -E 's/.*"tag_name": *"([^"]+)".*/\1/')"
  [ -n "$tag" ] || err "could not determine the latest release tag from $api"
  printf '%s' "$tag"
}

# ── Choose install directory ────────────────────────────────────────────────
choose_dir() {
  if [ -n "${CALLIOPE_INSTALL_DIR:-}" ]; then
    printf '%s' "$CALLIOPE_INSTALL_DIR"
  elif [ -w /usr/local/bin ] 2>/dev/null; then
    printf '/usr/local/bin'
  else
    printf '%s/.local/bin' "$HOME"
  fi
}

main() {
  local platform tag version base binary_url checks_url tmp bin_path sums_path expected actual install_dir dest

  platform="$(detect_platform)"
  tag="$(resolve_tag)"
  version="${tag#v}"   # asset names use the bare version (no leading "v")

  base="https://github.com/${REPO}/releases/download/${tag}"
  binary_url="${base}/${BIN_NAME}-${version}-${platform}"
  checks_url="${base}/checksums.txt"

  printf '%s\n' "${BOLD}Installing ${BIN_NAME} ${tag} (${platform})${NC}"

  tmp="$(mktemp -d)"
  # shellcheck disable=SC2064  # expand $tmp now so cleanup targets this dir.
  trap "rm -rf '$tmp'" EXIT
  bin_path="${tmp}/${BIN_NAME}"
  sums_path="${tmp}/checksums.txt"

  info "Downloading ${binary_url}"
  curl -fSL --progress-bar "$binary_url" -o "$bin_path" || err "download failed: $binary_url"

  # Verify against checksums.txt when present; refuse to install on a mismatch.
  if curl -fsSL "$checks_url" -o "$sums_path" 2>/dev/null; then
    expected="$(grep " ${BIN_NAME}-${version}-${platform}\$" "$sums_path" | head -n1 | awk '{print $1}')"
    if [ -z "$expected" ]; then
      warn "no checksum entry for ${BIN_NAME}-${version}-${platform} in checksums.txt; skipping verification."
    else
      actual="$(sha256_of "$bin_path")"
      if [ "$expected" != "$actual" ]; then
        err "checksum mismatch!\n  expected $expected\n  actual   $actual"
      fi
      ok "Checksum verified (${actual})"
    fi
  else
    warn "checksums.txt not found for ${tag}; skipping verification."
  fi

  chmod +x "$bin_path"

  install_dir="$(choose_dir)"
  mkdir -p "$install_dir"
  dest="${install_dir}/${BIN_NAME}"
  if mv "$bin_path" "$dest" 2>/dev/null; then
    :
  else
    err "cannot write to ${install_dir}. Re-run with CALLIOPE_INSTALL_DIR=<dir>, or:\n  sudo mv '$bin_path' '$dest'"
  fi
  ok "Installed to ${dest}"

  # PATH advice if the install dir is not already reachable.
  case ":${PATH}:" in
    *":${install_dir}:"*) : ;;
    *)
      warn "${install_dir} is not on your PATH. Add this to your shell profile:"
      printf '%s\n' "    export PATH=\"${install_dir}:\$PATH\""
      ;;
  esac

  printf '\n%s\n' "${GREEN}Done.${NC} Run ${BOLD}${BIN_NAME} --setup${NC} to configure a provider, then ${BOLD}${BIN_NAME}${NC}."
}

main "$@"
