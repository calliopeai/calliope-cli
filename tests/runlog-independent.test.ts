import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { expect, it } from "vitest";
import { RunLog, canonicalize } from "../src/runlog.js";
import { verifyRunLog, canonical, LIMITS } from "../scripts/verify-runlog.mjs";
const script = new URL("../scripts/verify-runlog.mjs", import.meta.url)
  .pathname;
async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "independent-runlog-"));
  const log = RunLog.open("portable", {
    enabled: true,
    dir: root,
    retention: 5,
  });
  log.runStart({
    session: "portable",
    cwd: root,
    provider: "toy",
    model: "toy",
    config: {
      unicode: "Hello π 😀",
      tiny: 1e-7,
      large: 1e21,
      negativeZero: -0,
    },
  });
  log.userPrompt("Public verification fixture");
  await log.flush();
  return { root, file: join(root, "portable.jsonl"), log };
}
it("independently verifies actual emitted JSONL, including Unicode and ECMAScript numbers", async () => {
  const { root, file } = await fixture();
  try {
    const result = await verifyRunLog(file);
    expect(result).toMatchObject({ ok: true, anchored: false, events: 2 });
    expect(
      await verifyRunLog(file, { expectedHead: result.head, expectedCount: 2 }),
    ).toMatchObject({ ok: true, anchored: true });
    const child = spawnSync(
      process.execPath,
      [
        script,
        file,
        "--json",
        "--expected-head",
        result.head,
        "--expected-count",
        "2",
      ],
      { encoding: "utf8" },
    );
    expect(child.status).toBe(0);
    expect(JSON.parse(child.stdout)).toMatchObject({
      version: 1,
      type: "runlog-verification",
      ok: true,
      anchored: true,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("makes terminal truncation detectable with a separately retained anchor", async () => {
  const { root, file } = await fixture();
  try {
    const original = await verifyRunLog(file);
    writeFileSync(file, readFileSync(file, "utf8").split("\n")[0] + "\n");
    expect((await verifyRunLog(file)).ok).toBe(true);
    expect(
      await verifyRunLog(file, {
        expectedHead: original.head,
        expectedCount: original.events,
      }),
    ).toMatchObject({ ok: false, reason: "anchor-mismatch" });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it.each([
  "tampered",
  "malformed",
  "sequence",
  "version",
  "torn",
  "empty",
  "invalid-utf8",
  "oversized",
])("rejects %s evidence without echoing its contents", async (mode) => {
  const { root, file } = await fixture();
  try {
    const lines = readFileSync(file, "utf8").trim().split("\n");
    const event = JSON.parse(lines[0]);
    if (mode === "tampered") event.config.private = "never print this";
    if (mode === "sequence") event.seq = 1;
    if (mode === "version") event.v = 99;
    lines[0] = JSON.stringify(event);
    let text = lines.join("\n") + "\n";
    if (mode === "malformed") text += "not json\n";
    if (mode === "torn") text = text.slice(0, -1);
    if (mode === "empty") text = "";
    if (mode === "oversized") text = "x".repeat(LIMITS.line + 1) + "\n";
    writeFileSync(
      file,
      mode === "invalid-utf8" ? Buffer.from([0xff, 10]) : text,
    );
    const child = spawnSync(process.execPath, [script, file, "--json"], {
      encoding: "utf8",
    });
    expect(child.status).toBe(4);
    expect(JSON.parse(child.stdout).ok).toBe(false);
    expect(child.stdout).not.toContain("never print this");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("uses documented UTF-16 key ordering, JSON escaping and number spelling", () => {
  const value = {
    "\uffff": 0,
    "😀": 1,
    "10": 2,
    "2": 3,
    n: [-0, 1e-7, 1e20, 1e21, "\ud800", "\n"],
  };
  const expected =
    '{"10":2,"2":3,"n":[0,1e-7,100000000000000000000,1e+21,"\\ud800","\\n"],"😀":1,"￿":0}';
  expect(canonical(value)).toBe(expected);
  expect(canonicalize(value)).toBe(expected);
});
it("rejects partial anchors and cancellation before reading", async () => {
  await expect(
    verifyRunLog("unused", { expectedHead: "a".repeat(64) }),
  ).rejects.toThrow("anchor");
  await expect(
    verifyRunLog("unused", { signal: AbortSignal.abort() }),
  ).rejects.toThrow();
});
it("verifies resumed writer output and preserves source bytes", async () => {
  const { root, file, log } = await fixture();
  try {
    await log.close();
    const resumed = RunLog.open("portable", {
      enabled: true,
      dir: root,
      retention: 5,
    });
    resumed.userPrompt("Restarted public fixture");
    await resumed.close();
    const before = readFileSync(file);
    expect(await verifyRunLog(file)).toMatchObject({ ok: true, events: 3 });
    expect(readFileSync(file)).toEqual(before);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
it("stops verification between bounded batches when cancelled", async () => {
  const { root, file, log } = await fixture();
  try {
    for (let i = 0; i < 200; i++) log.userPrompt("Public batch");
    await log.flush();
    const controller = new AbortController();
    const result = verifyRunLog(file, { signal: controller.signal });
    setTimeout(() => controller.abort(), 0);
    await expect(result).rejects.toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
