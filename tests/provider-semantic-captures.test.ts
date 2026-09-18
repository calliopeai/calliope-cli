import { readFileSync, readdirSync } from "node:fs";
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import {
  validateSemanticCapture,
  replaySemanticCapture,
  assertSafeSemanticCapture,
} from "../scripts/conformance/semantic.mjs";
import { createReadiness } from "../scripts/conformance/readiness.mjs";
import * as anthropic from "../src/providers/anthropic.js";
import * as google from "../src/providers/google.js";
import * as openai from "../src/providers/openai.js";
import * as compat from "../src/providers/compat.js";
import * as ollama from "../src/providers/ollama.js";
import * as bedrock from "../src/providers/bedrock.js";
import * as config from "../src/config.js";
const adapters = { anthropic, google, openai, compat, ollama, bedrock };
function read(directory: string) {
  const root = new URL(`./fixtures/${directory}/`, import.meta.url);
  return readdirSync(root)
    .filter((file) => file.endsWith(".json"))
    .map((file) => JSON.parse(readFileSync(new URL(file, root), "utf8")));
}
const captures = read("provider-semantic").map(validateSemanticCapture);
const deferredProviders = new Set((process.env.CALLIOPE_RELEASE_DEFERRED_PROVIDERS ?? '').split(',').map(value => value.trim()).filter(Boolean));
beforeEach(() => {
  vi.spyOn(config, "getApiKey").mockReturnValue("offline-replay");
  vi.spyOn(config, "getBaseUrl").mockReturnValue("https://replay.invalid/v1");
  vi.spyOn(config, "getProviderCred").mockReturnValue({ region: "us-east-1" });
  vi.stubEnv("AWS_ACCESS_KEY_ID", "offline-replay");
  vi.stubEnv("AWS_SECRET_ACCESS_KEY", "offline-replay");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
for (const capture of captures)
  it(`semantic captured ${capture.backend}/${capture.scenario}/${capture.stream ? "stream" : "JSON"}`, async () => {
    assertSafeSemanticCapture(capture);
    const path = capture.turns[0].exchange.request.path;
    if (capture.backend === "google")
      vi.mocked(config.getBaseUrl).mockReturnValue(
        "https://replay.invalid" + path.replace(/\/v1beta\/models\/.*$/, ""),
      );
    else if (capture.backend === "ollama")
      vi.mocked(config.getBaseUrl).mockReturnValue(
        "https://replay.invalid" + path.replace(/\/api\/chat$/, ""),
      );
    else if (
      ![
        "anthropic",
        "openai-chat",
        "openai-responses",
        "bedrock-native",
      ].includes(capture.backend)
    )
      vi.mocked(config.getBaseUrl).mockReturnValue(
        "https://replay.invalid" + path.replace(/\/chat\/completions$/, ""),
      );
    await replaySemanticCapture(capture, adapters);
  });
it.skipIf(!process.env.CALLIOPE_REQUIRE_WIRE_CAPTURES)(
  "release product gate: every required provider behavior has real evidence",
  () => {
    const report = createReadiness(
      read("provider-wire"),
      {},
      new Date(),
      captures,
    );
    const missing = report.adapters.filter(adapter => !deferredProviders.has(adapter.id)).flatMap((adapter) =>
      Object.entries(adapter.checks)
        .filter(([, status]) => status !== "captured")
        .map(([check, status]) => `${adapter.id}/${check}:${status}`),
    );
    expect(
      missing,
      "Missing semantic evidence or usage cannot pass the product release gate",
    ).toEqual([]);
  },
);
