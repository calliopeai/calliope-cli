# Homebrew formula TEMPLATE for the Calliope single binary (issue #187).
#
# This file is the source template. It is NOT a tap by itself — publishing it
# means copying this formula into a tap repository (e.g. calliopeai/homebrew-tap
# as Formula/calliope.rb) so users can:
#
#   brew install calliopeai/tap/calliope
#
# ── Release-time update step ────────────────────────────────────────────────
# After `Release binaries` (.github/workflows/release-binaries.yml) attaches the
# binaries and checksums.txt to a published release, update this formula in the
# tap:
#
#   1. Bump `version` to the released version (no leading "v").
#   2. Read the SHA-256s from the release's checksums.txt and replace the two
#      placeholders below:
#        - calliope-<version>-darwin-arm64  -> sha256 for on_arm
#        - calliope-<version>-darwin-x64    -> sha256 for on_intel
#      e.g.  curl -fsSL https://github.com/calliopeai/calliope-cli/releases/download/v<version>/checksums.txt
#   3. Commit to the tap. `brew audit --strict --new calliope` should pass.
#
# Only macOS assets are shipped via Homebrew; Linux users use packaging/install.sh
# or `brew` on Linux is intentionally out of scope for this template.

class Calliope < Formula
  desc "Private-AI agent CLI — one terminal agent for any model backend"
  homepage "https://github.com/calliopeai/calliope-cli"
  version "3.0.0"
  license "MIT"

  on_macos do
    on_arm do
      url "https://github.com/calliopeai/calliope-cli/releases/download/v#{version}/calliope-#{version}-darwin-arm64"
      sha256 "REPLACE_WITH_DARWIN_ARM64_SHA256"
    end
    on_intel do
      url "https://github.com/calliopeai/calliope-cli/releases/download/v#{version}/calliope-#{version}-darwin-x64"
      sha256 "REPLACE_WITH_DARWIN_X64_SHA256"
    end
  end

  def install
    # The downloaded file is named after the URL basename; rename it to `calliope`.
    suffix = Hardware::CPU.arm? ? "darwin-arm64" : "darwin-x64"
    bin.install "calliope-#{version}-#{suffix}" => "calliope"
  end

  test do
    assert_match version.to_s, shell_output("#{bin}/calliope --version")
  end
end
