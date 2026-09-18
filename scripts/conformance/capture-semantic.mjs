#!/usr/bin/env node
/** Opt-in capture; credentials must be supplied through the process/config. */
import { parseArgs } from "node:util";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { BACKENDS } from "./contract.mjs";
import { reserveProbe } from "./budget.mjs";
import {
  SEMANTIC_CHECKS,
  runSemanticProbe,
  assertSafeSemanticCapture,
} from "./semantic.mjs";

const { values } = parseArgs({
  options: {
    live: { type: "boolean" },
    help: { type: "boolean" },
    provider: { type: "string" },
    model: { type: "string" },
    scenario: { type: "string" },
    stream: { type: "boolean", default: false },
    output: { type: "string" },
    "max-output-tokens": { type: "string", default: "128" },
    "reasoning-effort": { type: "string" },
    "probe-version": { type: "string", default: "2" },
    ledger: { type: "string" },
    "max-cost-usd": { type: "string" },
    "run-id": { type: "string" },
    "max-run-cost-usd": { type: "string" },
    "input-usd-per-million": { type: "string" },
    "output-usd-per-million": { type: "string" },
  },
});
if (values.help || !values.live) {
  console.log(
    "Usage: node scripts/conformance/capture-semantic.mjs --live --provider <adapter> --model <model> --scenario <check> [--stream] --output <new-file>",
  );
  console.log(
    `Checks: ${SEMANTIC_CHECKS.join(", ")}. Cancellation requires --stream. Tool replay makes two independently reserved requests; other checks make one.`,
  );
  console.log(
    "Required budgets: --ledger <file> --max-cost-usd <total> --run-id <existing-id> --max-run-cost-usd <cap> --input-usd-per-million <verified-rate> --output-usd-per-million <verified-rate>.",
  );
  console.log(
    "Fixed public prompts only, no tool execution, <=512 output tokens per request, 30s per request, no retries. Provider-error expects a rejected HTTP response; a normal response is incomplete evidence.",
  );
  process.exit(values.help ? 0 : 2);
}
const backend = BACKENDS.find((b) => b.id === values.provider);
const maxOutputTokens = Number(values["max-output-tokens"]);
if (
  !backend ||
  !values.model ||
  !/^[\w./:@+-]{1,300}$/.test(values.model) ||
  !SEMANTIC_CHECKS.includes(values.scenario) ||
  !values.output ||
  !values.ledger ||
  !values["run-id"] ||
  ![
    "max-cost-usd",
    "max-run-cost-usd",
    "input-usd-per-million",
    "output-usd-per-million",
  ].every((key) => values[key]?.trim()) ||
  !Number.isInteger(maxOutputTokens) ||
  maxOutputTokens < 1 ||
  maxOutputTokens > 512 ||
  (values["reasoning-effort"] !== undefined && !["low", "medium", "high", "max"].includes(values["reasoning-effort"])) ||
  !["1", "2"].includes(values["probe-version"]) ||
  (values.scenario === "cancellation" && !values.stream)
)
  throw new Error("Invalid semantic probe arguments; see --help");
const output = resolve(values.output);
if (existsSync(output) || output === resolve(values.ledger))
  throw new Error("Output must be a new file separate from the ledger");
const adapters = Object.fromEntries(
  await Promise.all(
    ["anthropic", "google", "openai", "compat", "ollama", "bedrock"].map(
      async (name) => [name, await import(`../../dist/providers/${name}.js`)],
    ),
  ),
);
if (
  backend.provider === "openai" &&
  adapters.openai.requiresResponsesAPI(values.model) !==
    (backend.protocol === "responses")
)
  throw new Error("Model routing does not match the requested OpenAI path");
const config = await import("../../dist/config.js");
const secrets = [
  ...Object.entries(process.env)
    .filter(([key]) => /key|token|secret|password|credential/i.test(key))
    .map(([, value]) => value),
  ...BACKENDS.map((b) => config.getApiKey(b.provider)),
].filter((value) => typeof value === "string" && value.length >= 8);
const sdkVersions = Object.fromEntries(
  ["openai", "@anthropic-ai/sdk", "@google/genai"].map((name) => [
    name,
    JSON.parse(
      readFileSync(
        new URL(`../../node_modules/${name}/package.json`, import.meta.url),
        "utf8",
      ),
    ).version,
  ]),
);
const attempts = [];
const signal = new AbortController();
const abort = () =>
  signal.abort(new DOMException("Operator cancelled capture", "AbortError"));
process.once("SIGINT", abort);
process.once("SIGTERM", abort);
const report = {
  version: 1,
  kind: "semantic-probe-result",
  backend: backend.id,
  model: values.model,
  scenario: values.scenario,
  stream: values.stream,
  maxOutputTokens,
  attempts,
  outcome: "failed",
};
try {
  const result = await runSemanticProbe({
    adapters,
    backend,
    model: values.model,
    scenario: values.scenario,
    stream: values.stream,
    maxOutputTokens,
    probeVersion: Number(values["probe-version"]),
    ...(values["reasoning-effort"] ? { reasoningEffort: values["reasoning-effort"] } : {}),
    signal: signal.signal,
    sdkVersions,
    ...(backend.id === "openrouter"
      ? {
          maxPrice: {
            input: Number(values["input-usd-per-million"]),
            output: Number(values["output-usd-per-million"]),
          },
        }
      : {}),
    reserve() {
      const reservation = reserveProbe(resolve(values.ledger), {
        maxCostUsd: Number(values["max-cost-usd"]),
        runId: values["run-id"],
        maxRunCostUsd: Number(values["max-run-cost-usd"]),
        inputRate: Number(values["input-usd-per-million"]),
        outputRate: Number(values["output-usd-per-million"]),
        maxOutputTokens,
      });
      const attempt = { reservationId: reservation.id, outcome: "reserved" };
      attempts.push(attempt);
      return {
        id: reservation.id,
        finish(status) {
          reservation.finish(status);
          attempt.outcome = status;
        },
      };
    },
  });
  report.outcome = result.outcome;
  if (result.httpStatus) report.httpStatus = result.httpStatus;
  if (result.observed) report.observed = result.observed;
  if (result.capture) {
    assertSafeSemanticCapture(result.capture, secrets);
    mkdirSync(dirname(output), { recursive: true, mode: 0o700 });
    writeFileSync(output, JSON.stringify(result.capture, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    report.captureFile = output;
  } else process.exitCode = 1;
} catch {
  // SDK exceptions can carry raw prompts, credentials or upstream account data.
  report.outcome = signal.signal.aborted ? "cancelled" : "failed";
  report.reason =
    "Capture failed validation, storage or admission; reservations remain retained. No raw exception is printed.";
  process.exitCode = signal.signal.aborted ? 130 : 1;
} finally {
  process.removeListener("SIGINT", abort);
  process.removeListener("SIGTERM", abort);
}
console.log(JSON.stringify(report));
