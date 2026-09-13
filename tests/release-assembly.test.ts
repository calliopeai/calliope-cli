import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { expect, it, vi } from "vitest";
import { assemble, PLATFORMS } from "../scripts/release/assemble.mjs";
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "release-assembly-"));
  for (const platform of PLATFORMS) {
    const asset = `calliope-3.2.0-${platform}`,
      bytes = Buffer.from(platform);
    writeFileSync(join(root, asset), bytes);
    writeFileSync(
      join(root, asset + ".sha256"),
      `${createHash("sha256").update(bytes).digest("hex")}  ${asset}\n`,
    );
    writeFileSync(join(root, asset + ".sigstore.json"), "test boundary only");
  }
  return root;
}
it("assembles exactly four independently verified binaries into a deterministic manifest", () => {
  const root = fixture();
  try {
    const verify = vi.fn();
    expect(assemble(root, "3.2.0", verify)).toHaveLength(4);
    expect(verify).toHaveBeenCalledTimes(4);
    expect(
      readFileSync(join(root, "checksums.txt"), "utf8").trim().split("\n"),
    ).toHaveLength(4);
    expect(() => assemble(root, "3.2.0", verify)).toThrow("unexpected");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it.each(["missing", "extra", "corrupt", "invalid-provenance"])(
  "does not emit a publishable manifest for %s artifacts",
  (mode) => {
    const root = fixture();
    try {
      const asset = join(root, "calliope-3.2.0-linux-x64");
      if (mode === "missing") rmSync(asset);
      if (mode === "extra") writeFileSync(join(root, "unexpected"), "extra");
      if (mode === "corrupt") writeFileSync(asset, "different bytes");
      expect(() =>
        assemble(root, "3.2.0", () => {
          if (mode === "invalid-provenance")
            throw new Error("untrusted signer");
        }),
      ).toThrow();
      expect(existsSync(join(root, "checksums.txt"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  },
);
