/** Write a staged binary's `<sha256>  <name>` line, byte-identical on every runner OS. */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";
import { pathToFileURL } from "node:url";
export function writeChecksum(file) {
  const hash = createHash("sha256").update(readFileSync(file)).digest("hex");
  writeFileSync(`${file}.sha256`, `${hash}  ${basename(file)}\n`, { flag: "wx" });
  return hash;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  if (process.argv.length !== 3)
    throw new Error("Usage: checksum.mjs <file>");
  writeChecksum(process.argv[2]);
}
