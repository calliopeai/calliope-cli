# Release integrity

Release binaries and npm packages are promoted only from an existing `v<package.json version>` tag whose commit equals the workflow checkout and GitHub source identity. Version changes belong in a reviewed PR. The publisher no longer bumps versions, pushes tags, cleans user changes, or accepts version text as shell code.

Both publication workflows use `release-checks.yml`: TypeScript, full tests, coverage, offline conformance, mandatory real-wire release conformance, build, benchmarks and local doctor JSON. Missing provider evidence stops publication. Publishing a GitHub release starts these checks; creating the release page does not prove its artifacts passed.

## Standalone binaries

`release-binaries.yml` builds and smoke-tests all five targets on matching hosted runners: macOS arm64/x64, Linux arm64/x64 and Windows x64. Each executable must report its version (also as `calliope --version --json`), complete an ACP `initialize` and `session/new` over stdio, produce complete doctor and large replay JSON, preserve failure/denial exit codes, initialize a project brain, ingest a public fixture and find it through SQLite search from a fresh working directory. Windows currently denies brain mutations (#382), so the Windows smoke checks the denial path but skips the brain round trip until that is fixed. Completed headless commands set their exit code and let pending pipe writes drain before termination. Node installations use SQLite WASM; standalone builds bundle sql.js's JavaScript/asm engine so they require no SQLite sidecar file.

The workflow generates [GitHub build attestations](https://docs.github.com/en/actions/how-tos/secure-your-work/use-artifact-attestations/use-artifact-attestations) for every binary. It then downloads all five, checks their hashes and signed provenance, creates a complete `checksums.txt` and `calliope-binaries.json`, and attests both manifests. No release upload occurs until the complete set verifies. Uploads refuse to overwrite existing assets; after a partial upload, inspect retained CI artifacts and the release before deciding how to recover. A rerun does not silently replace earlier evidence.

Each binary and each manifest have an accompanying `.sigstore.json` bundle. Verification binds artifact bytes to this repository, `release-binaries.yml`, the version tag, its resolved commit, and a GitHub-hosted runner. Provenance establishes origin and build identity; it does not certify code correctness or replace source review. Tag protection and trusted source review remain part of the operator's trust boundary.

### macOS signing and notarisation

The macOS binaries are signed with the organisation's Developer ID certificate (`CSC_LINK`, `CSC_KEY_PASSWORD`) under the hardened runtime, with the Bun runtime's own entitlements (`packaging/entitlements.plist`), then notarised with `notarytool` (`APPLE_ID`, `APPLE_APP_SPECIFIC_PASSWORD`, `APPLE_TEAM_ID`). Signing happens before the smoke test, checksum and attestation, so all three cover the signed bytes. A standalone executable cannot carry a stapled ticket; Gatekeeper confirms notarisation online the first time a downloaded copy runs. A `release` event without these secrets fails the macOS jobs, so no unsigned macOS binary is attached; a manual preview without them builds unsigned with a warning. Without the entitlements the hardened runtime still runs the binary but silently disables the JavaScriptCore JIT. The Windows binary has no Authenticode signature; its provenance is the attestation alone.

### Embedder manifest

`calliope-binaries.json` lets an embedding application (Chat Studio) fetch the right binary without npm or a local Node:

```json
{
  "version": "3.2.2",
  "files": [
    {
      "platform": "darwin-arm64",
      "url": "https://github.com/calliopeai/calliope-cli/releases/download/v3.2.2/calliope-3.2.2-darwin-arm64",
      "sha256": "<64 hex characters>",
      "size": 65395360
    }
  ]
}
```

Platforms are `darwin-arm64`, `darwin-x64`, `linux-arm64`, `linux-x64` and `win-x64`; the Windows asset ends in `.exe`. The manifest is written only after every binary verifies and lists the same hashes as `checksums.txt`. Verify its bundle with the same certificate policy, download the platform's `url`, reject any size or SHA-256 mismatch, then run `calliope --version --json` (`{"version":"3.2.2","acp":1}`) to confirm the ACP protocol version before starting `calliope acp`.

The canonical `install.sh` requires `curl`, an authenticated GitHub CLI supporting the options below, and `sha256sum` or `shasum`. It verifies the signed manifest, its unique checksum entry, and the binary's provenance before creating any installation files. Downloads have time/size limits; staging and replacement occur in the destination filesystem. A failure preserves the previous executable. `CALLIOPE_VERSION` selects a strict version tag and `CALLIOPE_INSTALL_DIR` must be absolute.

```sh
CALLIOPE_VERSION=v3.2.0 bash install.sh
```

The compatibility entry at `packaging/install.sh` delegates to the canonical installer. The HTTPS bootstrap script itself is a trust input: inspect it or retrieve it from a reviewed commit before execution. Historical releases without attestations are refused; there is no unverified fallback. The old root script's automatic Node installation/npm fallback has been removed. An explicit npm installation remains available separately and requires Node 24 or later.

Independent binary verification, after downloading the binary and its bundle:

```sh
tag=v3.2.0
commit=$(gh api "repos/calliopeai/calliope-cli/commits/$tag" --jq .sha)
file=calliope-3.2.0-darwin-arm64
gh attestation verify "$file" --bundle "$file.sigstore.json" \
  --repo calliopeai/calliope-cli \
  --cert-identity "https://github.com/calliopeai/calliope-cli/.github/workflows/release-binaries.yml@refs/tags/$tag" \
  --source-ref "refs/tags/$tag" --source-digest "$commit" \
  --deny-self-hosted-runners
```

Use the same policy for `checksums.txt`. [GitHub CLI's verifier reference](https://cli.github.com/manual/gh_attestation_verify) describes bundle and certificate checks. Retain a trusted copy of the source commit and bundles for subsequent independent review; a mutable tag name alone is a weaker reference.

The exact certificate identity binds the repository, workflow path and reference. GitHub CLI treats `--cert-identity` and `--signer-workflow` as mutually exclusive; do not combine them. CI binary/manifest verification and assembly use the same certificate policy as the installer.

## Preview and publication

A manual `Release binaries` dispatch on **main** produces signed CI preview artifacts only. Its source guard rejects other branches and tags. Preview runs execute the quality suite but omit the currently blocked publication-evidence assertion; they cannot attach release assets. Their signed source reference is `refs/heads/main`, so the release installer rejects them as tagged-release evidence. This permits testing the real signing and all five binary paths without creating a release or spending on inference.

`Publish to npm` accepts a published release event or a manual dispatch **on an existing version tag**. Both stable and prerelease paths use `npm publish --provenance --access public`; prereleases keep the `alpha` distribution tag. The job uses GitHub OIDC and the existing npm trusted-publisher configuration, with no new long-lived publishing token. The operator must configure npm to trust this repository and `publish.yml`; repository code cannot prove that registry setting is correct. See [npm provenance](https://docs.npmjs.com/generating-provenance-statements/).

After an authorized publication, inspect the package's provenance link and run `npm audit signatures` in a clean project containing the exact version. Check that **this package** has provenance and that its source/workflow match the reviewed tag; a successful signature audit alone does not mean every dependency has a provenance attestation. Record the registry result before claiming a verified published release.

ECR `latest` and `sha-<commit>` remain development images. The image workflow uses the successful npm publisher's exact source commit for release promotion, and only that path creates `v<version>` and `stable` tags. Main pushes and manual development builds cannot promote `stable`. Existing historical version tags are not retroactively certified. A failed downstream rebuild may leave npm published while later promotion is incomplete; inspect the registry and workflow receipts before retrying.

Current release readiness remains blocked by provider evidence in [the conformance report](provider-semantic-followup.md). Tests, preview attestations, local installs and development images must not be described as a completed npm/binary release. Audit-log verification is specified separately in [governance](governance.md#independent-verification).
