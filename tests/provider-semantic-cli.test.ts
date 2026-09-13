import { spawnSync } from "node:child_process";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
  existsSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
const script = new URL(
  "../scripts/conformance/capture-semantic.mjs",
  import.meta.url,
);
it("requires explicit live opt-in and documents the separate per-turn reservations", () => {
  const denied = spawnSync(process.execPath, [script.pathname], {
    encoding: "utf8",
  });
  expect(denied.status).toBe(2);
  expect(denied.stdout).toContain("two independently reserved requests");
  const help = spawnSync(process.execPath, [script.pathname, "--help"], {
    encoding: "utf8",
  });
  expect(help.status).toBe(0);
  expect(help.stdout).toContain("no retries");
});
it("refuses existing output and malformed arguments before touching credentials or reservations", () => {
  const root = mkdtempSync(join(tmpdir(), "semantic-cli-"));
  try {
    const output = join(root, "capture.json"),
      ledger = join(root, "ledger.json");
    writeFileSync(output, "existing evidence");
    const args = [
      "--live",
      "--provider",
      "anthropic",
      "--model",
      "test-model",
      "--scenario",
      "system-instructions",
      "--output",
      output,
      "--ledger",
      ledger,
      "--run-id",
      "test",
      "--max-run-cost-usd",
      "1",
      "--max-cost-usd",
      "1",
      "--input-usd-per-million",
      "1",
      "--output-usd-per-million",
      "1",
    ];
    const result = spawnSync(process.execPath, [script.pathname, ...args], {
      encoding: "utf8",
    });
    expect(result.status).toBe(1);
    expect(result.stderr).toContain("Output must be a new file");
    expect(readFileSync(output, "utf8")).toBe("existing evidence");
    expect(existsSync(ledger)).toBe(false);
    const invalid = spawnSync(
      process.execPath,
      [script.pathname, ...args, "--max-output-tokens", "513"],
      { encoding: "utf8" },
    );
    expect(invalid.status).toBe(1);
    expect(invalid.stderr).toContain("Invalid semantic probe arguments");
    expect(existsSync(ledger)).toBe(false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
