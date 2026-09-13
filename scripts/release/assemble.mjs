/** All-or-nothing artifact inventory before any release upload. */
import { readFileSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
export const PLATFORMS = [
  "darwin-arm64",
  "darwin-x64",
  "linux-arm64",
  "linux-x64",
];
export function assemble(directory, version, verify) {
  if (!/^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    throw new Error("Invalid artifact version");
  const assets = PLATFORMS.map((p) => `calliope-${version}-${p}`);
  const expected = assets
    .flatMap((a) => [a, `${a}.sha256`, `${a}.sigstore.json`])
    .sort();
  if (
    JSON.stringify(readdirSync(directory).sort()) !== JSON.stringify(expected)
  )
    throw new Error("Incomplete or unexpected binary artifact set");
  const lines = [];
  for (const asset of assets) {
    for (const name of [asset, `${asset}.sha256`, `${asset}.sigstore.json`]) {
      const stat = lstatSync(join(directory, name));
      const limit = name === asset ? 512 * 1024 * 1024 : 1024 * 1024;
      if (!stat.isFile() || stat.size < 1 || stat.size > limit)
        throw new Error("Invalid binary artifact file");
    }
    const hash = createHash("sha256")
      .update(readFileSync(join(directory, asset)))
      .digest("hex");
    const line = `${hash}  ${asset}\n`;
    if (readFileSync(join(directory, `${asset}.sha256`), "utf8") !== line)
      throw new Error("Binary artifact checksum mismatch");
    verify(join(directory, asset), join(directory, `${asset}.sigstore.json`));
    lines.push(line);
  }
  writeFileSync(join(directory, "checksums.txt"), lines.join(""), {
    flag: "wx",
  });
  return assets;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 4)
    throw new Error("Usage: assemble.mjs <directory> <version>");
  const { SOURCE_REF, SOURCE_SHA } = process.env;
  if (
    !/^refs\/(tags\/v[\w.-]+|heads\/main)$/.test(SOURCE_REF ?? "") ||
    !/^[a-f0-9]{40}$/.test(SOURCE_SHA ?? "")
  )
    throw new Error("Missing artifact source identity");
  const assets = assemble(
    resolve(process.argv[2]),
    process.argv[3],
    (file, bundle) =>
      execFileSync(
        "gh",
        [
          "attestation",
          "verify",
          file,
          "--bundle",
          bundle,
          "--repo",
          "calliopeai/calliope-cli",
          "--signer-workflow",
          "calliopeai/calliope-cli/.github/workflows/release-binaries.yml",
          "--source-ref",
          SOURCE_REF,
          "--source-digest",
          SOURCE_SHA,
          "--deny-self-hosted-runners",
        ],
        { timeout: 120000, stdio: ["ignore", "ignore", "inherit"] },
      ),
  );
  console.log(JSON.stringify({ version: 1, assets, verified: true }));
}
