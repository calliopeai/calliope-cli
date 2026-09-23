import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  renameSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it, vi } from "vitest";
import { assemble, assetName, PLATFORMS } from "../scripts/release/assemble.mjs";
import { writeChecksum } from "../scripts/release/checksum.mjs";
// Stage exactly what each build job uploads: the binary, its checksum line and its bundle.
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-assembly-"));
  for (const platform of PLATFORMS) {
    const asset = join(root, assetName("3.2.0", platform));
    writeFileSync(asset, Buffer.from(platform));
    writeChecksum(asset);
    writeFileSync(asset + ".sigstore.json", "test boundary only");
  }
  return root;
}
it("assembles all five independently verified binaries into deterministic manifests", () => {
  const root = fixture();
  try {
    const verify = vi.fn();
    expect(assemble(root, "3.2.0", verify)).toEqual([
      "calliope-3.2.0-darwin-arm64",
      "calliope-3.2.0-darwin-x64",
      "calliope-3.2.0-linux-arm64",
      "calliope-3.2.0-linux-x64",
      "calliope-3.2.0-win-x64.exe",
    ]);
    expect(verify).toHaveBeenCalledTimes(5);
    const checksums = readFileSync(join(root, "checksums.txt"), "utf8");
    expect(checksums.trim().split("\n")).toHaveLength(5);
    const manifest = JSON.parse(readFileSync(join(root, "calliope-binaries.json"), "utf8"));
    expect(manifest.version).toBe("3.2.0");
    expect(manifest.files.map((file: { platform: string }) => file.platform)).toEqual(PLATFORMS);
    expect(manifest.files[4]).toEqual({
      platform: "win-x64",
      url: "https://github.com/calliopeai/calliope-cli/releases/download/v3.2.0/calliope-3.2.0-win-x64.exe",
      sha256: "d4109a44189c83fa115171c737362fb668cb2a49ce8f37e3b61e44ae8f4651ae",
      size: 7,
    });
    // Both manifests describe the same bytes.
    for (const file of manifest.files)
      expect(checksums).toContain(`${file.sha256}  ${file.url.split("/").at(-1)}\n`);
    expect(() => assemble(root, "3.2.0", verify)).toThrow("unexpected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("refuses to overwrite a checksum line", () => {
  const root = fixture();
  try {
    expect(() => writeChecksum(join(root, "calliope-3.2.0-linux-x64"))).toThrow("EEXIST");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it.each(["missing", "extra", "corrupt", "invalid-provenance", "windows-without-exe"])(
  "does not emit a publishable manifest for %s artifacts",
  (mode) => {
    const root = fixture();
    try {
      const asset = join(root, "calliope-3.2.0-linux-x64");
      if (mode === "missing") rmSync(asset);
      if (mode === "extra") writeFileSync(join(root, "unexpected"), "extra");
      if (mode === "corrupt") writeFileSync(asset, "different bytes");
      if (mode === "windows-without-exe")
        renameSync(join(root, "calliope-3.2.0-win-x64.exe"), join(root, "calliope-3.2.0-win-x64"));
      expect(() =>
        assemble(root, "3.2.0", () => {
          if (mode === "invalid-provenance")
            throw new Error("untrusted signer");
        }),
      ).toThrow();
      expect(existsSync(join(root, "checksums.txt"))).toBe(false);
      expect(existsSync(join(root, "calliope-binaries.json"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
