#!/usr/bin/env node
/** Independent v1 run-log verifier: only Node built-ins, no Calliope imports/state/network. */
import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { createHash } from "node:crypto";
import { parseArgs } from "node:util";
import { pathToFileURL } from "node:url";
import { setImmediate } from "node:timers/promises";
export const LIMITS = {
  bytes: 64 * 1024 * 1024,
  line: 1024 * 1024,
  events: 100000,
  depth: 64,
};
// ECMAScript UTF-16 key order and JSON.stringify primitive spelling are part of v1.
export function canonical(value, depth = 0) {
  if (depth > LIMITS.depth) throw new Error("nesting-limit");
  if (typeof value === "number" && !Number.isFinite(value))
    throw new Error("invalid-number");
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return "[" + value.map((v) => canonical(v, depth + 1)).join(",") + "]";
  return (
    "{" +
    Object.keys(value)
      .sort()
      .map((k) => JSON.stringify(k) + ":" + canonical(value[k], depth + 1))
      .join(",") +
    "}"
  );
}
export async function verifyRunLog(
  file,
  { expectedHead, expectedCount, signal } = {},
) {
  const anchored = expectedHead !== undefined && expectedCount !== undefined;
  if (
    (expectedHead !== undefined || expectedCount !== undefined) &&
    (!anchored ||
      !/^[a-f0-9]{64}$/.test(expectedHead) ||
      !Number.isSafeInteger(expectedCount) ||
      expectedCount < 1 ||
      expectedCount > LIMITS.events)
  )
    throw new Error("invalid-anchor");
  const result = {
    version: 1,
    type: "runlog-verification",
    ok: false,
    anchored,
    events: 0,
    head: null,
  };
  const fail = (reason, line) => ({
    ...result,
    reason,
    ...(line ? { line } : {}),
  });
  signal?.throwIfAborted();
  const info = await stat(file);
  if (!info.isFile() || info.size > LIMITS.bytes) return fail("file-limit");
  const chunks = [];
  let size = 0;
  for await (const chunk of createReadStream(file, {
    signal,
    highWaterMark: 65536,
  })) {
    size += chunk.length;
    if (size > LIMITS.bytes) return fail("file-limit");
    chunks.push(chunk);
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      Buffer.concat(chunks),
    );
  } catch {
    return fail("invalid-utf8");
  }
  if (!text.endsWith("\n")) return fail("missing-final-newline");
  const lines = text.slice(0, -1).split("\n");
  if (lines.length > LIMITS.events) return fail("event-limit");
  let previous = "";
  for (let i = 0; i < lines.length; i++) {
    if (i % 100 === 0) {
      await setImmediate();
      signal?.throwIfAborted();
    }
    if (!lines[i].trim() || Buffer.byteLength(lines[i]) > LIMITS.line)
      return fail("line-limit", i + 1);
    let event;
    try {
      event = JSON.parse(lines[i]);
    } catch {
      return fail("invalid-json", i + 1);
    }
    if (
      !event ||
      typeof event !== "object" ||
      Array.isArray(event) ||
      event.v !== 1 ||
      event.seq !== i ||
      typeof event.ts !== "string" ||
      !Number.isFinite(Date.parse(event.ts)) ||
      typeof event.type !== "string" ||
      !event.type ||
      !/^[a-f0-9]{64}$/.test(event.hash)
    )
      return fail("invalid-event", i + 1);
    const { prev_hash, hash, ...body } = event;
    if (prev_hash !== previous) return fail("prev-hash-mismatch", i + 1);
    let serialized;
    try {
      serialized = canonical(body);
    } catch (error) {
      return fail(error.message, i + 1);
    }
    if (
      createHash("sha256")
        .update(previous + serialized, "utf8")
        .digest("hex") !== hash
    )
      return fail("hash-mismatch", i + 1);
    result.events++;
    result.head = hash;
    previous = hash;
  }
  if (!result.events) return fail("empty-log");
  if (
    anchored &&
    (result.head !== expectedHead || result.events !== expectedCount)
  )
    return fail("anchor-mismatch");
  return { ...result, ok: true };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const signal = new AbortController();
  const abort = () =>
    signal.abort(new DOMException("Verification cancelled", "AbortError"));
  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  let json = process.argv.includes("--json");
  try {
    const { values, positionals } = parseArgs({
      allowPositionals: true,
      options: {
        json: { type: "boolean" },
        help: { type: "boolean" },
        "expected-head": { type: "string" },
        "expected-count": { type: "string" },
      },
    });
    if (values.help) {
      console.log(
        "Usage: node verify-runlog.mjs <trace.jsonl> [--json] [--expected-head <sha256> --expected-count <events>]",
      );
    } else {
      if (
        positionals.length !== 1 ||
        (values["expected-count"] !== undefined &&
          !/^[1-9][0-9]*$/.test(values["expected-count"]))
      )
        throw new Error("invalid-arguments");
      const result = await verifyRunLog(positionals[0], {
        expectedHead: values["expected-head"],
        expectedCount:
          values["expected-count"] === undefined
            ? undefined
            : Number(values["expected-count"]),
        signal: signal.signal,
      });
      console.log(
        json
          ? JSON.stringify(result)
          : `${result.ok ? "OK" : "FAILED"}: ${result.events} events; ${result.anchored ? "trusted anchor checked" : "unanchored chain only"}${result.reason ? `; ${result.reason}` : ""}`,
      );
      process.exitCode = result.ok ? 0 : 4;
    }
  } catch (error) {
    const reason = signal.signal.aborted
      ? "cancelled"
      : ["invalid-anchor", "invalid-arguments"].includes(error.message)
        ? error.message
        : "unreadable-or-invalid-input";
    const result = {
      version: 1,
      type: "runlog-verification",
      ok: false,
      reason,
    };
    console.log(json ? JSON.stringify(result) : `FAILED: ${reason}`);
    process.exitCode = signal.signal.aborted ? 130 : 1;
  } finally {
    process.removeListener("SIGINT", abort);
    process.removeListener("SIGTERM", abort);
  }
}
