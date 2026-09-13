/** Manufactured responses test the harness only; never enter the real corpus. */
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  BACKENDS,
  invoke,
  probeMessages,
} from "../scripts/conformance/contract.mjs";
import {
  runSemanticProbe,
  validateSemanticCapture,
  replaySemanticCapture,
  assertSafeSemanticCapture,
} from "../scripts/conformance/semantic.mjs";
import { createReadiness } from "../scripts/conformance/readiness.mjs";
import { digest } from "../scripts/conformance/captures.mjs";
import { syntheticWire } from "./helpers/provider-wire.js";
import * as anthropic from "../src/providers/anthropic.js";
import * as google from "../src/providers/google.js";
import * as openai from "../src/providers/openai.js";
import * as compat from "../src/providers/compat.js";
import * as ollama from "../src/providers/ollama.js";
import * as bedrock from "../src/providers/bedrock.js";
import * as config from "../src/config.js";
const adapters = { anthropic, google, openai, compat, ollama, bedrock };
const sdkVersions = {
  openai: "test",
  "@anthropic-ai/sdk": "test",
  "@google/genai": "test",
};
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

async function manufacture(backend: any, scenario: string, stream = false) {
  let calls = 0;
  const outcomes: string[] = [];
  const source = vi.fn(async () => {
    const tool = scenario === "tool-result-replay" && calls === 0;
    calls++;
    if (scenario === "provider-error")
      return new Response(
        '{"error":{"message":"Toy quota error","type":"quota","code":"quota"}}',
        { status: 429, headers: { "content-type": "application/json" } },
      );
    const wire = syntheticWire(
      backend.protocol,
      tool ? "tool" : "text",
      stream,
    );
    return new Response(wire.body, { headers: { "content-type": wire.type } });
  });
  const reserve = vi.fn(() => ({
    id: randomUUID(),
    finish(status: string) {
      outcomes.push(status);
    },
  }));
  const result = await runSemanticProbe({
    adapters,
    backend,
    model: backend.protocol === "responses" ? "gpt-5-test" : "test-model",
    scenario,
    stream,
    maxOutputTokens: 64,
    ...(backend.id === 'openrouter' ? { maxPrice: { input: 1, output: 2 } } : {}),
    originalFetch: source,
    reserve,
    sdkVersions,
  });
  return { result, source, reserve, outcomes };
}

for (const backend of BACKENDS)
  for (const scenario of [
    "system-instructions",
    "tool-result-replay",
    "provider-error",
    "cancellation",
  ])
    for (const stream of scenario === "cancellation" ? [true] : [false, true]) {
      it(`${backend.id} ${scenario} ${stream ? "stream" : "JSON"} captures and replays actual SDK semantics`, async () => {
        const { result, source, reserve, outcomes } = await manufacture(
          backend,
          scenario,
          stream,
        );
        expect(result.outcome).toBe("captured");
        expect(source).toHaveBeenCalledTimes(
          scenario === "tool-result-replay" ? 2 : 1,
        );
        expect(reserve).toHaveBeenCalledTimes(source.mock.calls.length);
        expect(outcomes).toEqual(
          Array(source.mock.calls.length).fill(
            scenario === "cancellation" ? "cancelled" : "captured",
          ),
        );
        expect(validateSemanticCapture(result.capture)).toBe(result.capture);
        await replaySemanticCapture(result.capture, adapters);
      });
    }

it.each(BACKENDS)(
  "$id rejects cancellation from an emitted token even when remaining frames are already buffered",
  async (backend) => {
    const controller = new AbortController();
    const wire = syntheticWire(backend.protocol, "text", true);
    const fetch = vi.fn(
      async () =>
        new Response(wire.body, { headers: { "content-type": wire.type } }),
    );
    vi.stubGlobal("fetch", fetch);
    await expect(
      invoke(
        adapters,
        backend,
        backend.protocol === "responses" ? "gpt-5-test" : "test-model",
        probeMessages("text"),
        [],
        () => controller.abort(),
        controller.signal,
      ),
    ).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  },
);

it("rejects mutated bytes, extra fields, mismatched requests and invented cancellation evidence", async () => {
  const { result } = await manufacture(BACKENDS[0], "system-instructions");
  const altered = structuredClone(result.capture);
  altered.turns[0].exchange.body = Buffer.from("altered").toString("base64");
  expect(() => validateSemanticCapture(altered)).toThrow("checksum");
  const header = structuredClone(result.capture);
  header.turns[0].exchange.headers.authorization = "secret";
  expect(() => validateSemanticCapture(header)).toThrow("shape");
  const request = structuredClone(result.capture);
  const changed = JSON.parse(
    Buffer.from(request.turns[0].exchange.request.body, "base64").toString(),
  );
  changed.messages[0].content = "A different prompt";
  const body = Buffer.from(JSON.stringify(changed));
  request.turns[0].exchange.request.body = body.toString("base64");
  request.turns[0].exchange.request.sha256 = digest(body);
  await expect(replaySemanticCapture(request, adapters)).rejects.toThrow(
    "disagrees",
  );
  const cancelled = (await manufacture(BACKENDS[0], "cancellation", true))
    .result.capture;
  cancelled.turns[0].exchange.complete = true;
  expect(() => validateSemanticCapture(cancelled)).toThrow("abort evidence");
});

it("does not treat a quota failure, short output or pre-dispatch cancellation as semantic success", async () => {
  const backend = BACKENDS.find((b) => b.id === "openai-chat")!;
  const finish = vi.fn();
  const reserve = vi.fn(() => ({ id: randomUUID(), finish }));
  const options = {
    adapters,
    backend,
    model: "test-model",
    scenario: "system-instructions",
    sdkVersions,
    reserve,
  };
  const failed = await runSemanticProbe({
    ...options,
    originalFetch: async () =>
      new Response('{"error":{"message":"quota"}}', { status: 429 }),
  });
  expect(failed).toMatchObject({ outcome: "failed", httpStatus: 429 });
  expect(finish).toHaveBeenLastCalledWith("failed");
  const wire = syntheticWire("chat", "length", false);
  const incomplete = await runSemanticProbe({
    ...options,
    originalFetch: async () => new Response(wire.body),
  });
  expect(incomplete.outcome).toBe("incomplete");
  expect(finish).toHaveBeenLastCalledWith("failed");
  const calls = reserve.mock.calls.length;
  await expect(
    runSemanticProbe({ ...options, signal: AbortSignal.abort() }),
  ).rejects.toThrow();
  expect(reserve).toHaveBeenCalledTimes(calls);
});

it("retains the first reservation and stops when the replay turn cannot be admitted", async () => {
  let count = 0;
  const finish = vi.fn();
  const source = vi.fn(
    async () => new Response(syntheticWire("chat", "tool", false).body),
  );
  await expect(
    runSemanticProbe({
      adapters,
      backend: BACKENDS.find((b) => b.id === "openai-chat")!,
      model: "test-model",
      scenario: "tool-result-replay",
      sdkVersions,
      originalFetch: source,
      reserve() {
        if (count++) throw new Error("Run budget exhausted");
        return { id: randomUUID(), finish };
      },
    }),
  ).rejects.toThrow("budget exhausted");
  expect(source).toHaveBeenCalledTimes(1);
  expect(finish).toHaveBeenCalledExactlyOnceWith("captured");
});

it("counts only the observed semantic checks and keeps usage and basic coverage independent", async () => {
  const capture = (await manufacture(BACKENDS[0], "system-instructions")).result
    .capture;
  const report = createReadiness([], { anthropic: "missing" }, new Date(), [
    capture,
    capture,
  ]);
  expect(report.capturedWireCombinations).toBe(0);
  expect(report.adapters[0].checks["system-instructions"]).toBe("captured");
  expect(report.adapters[0].checks["tool-result-replay"]).toBe("unavailable");
  expect(report.adapters[0].checks.usage).toBe("unavailable");
  expect(report.productGateReady).toBe(false);
});
it('versions corrected OpenRouter routing evidence and rejects altered wire ceilings',async()=>{
  const backend=BACKENDS.find(b=>b.id==='openrouter')!;
  const {result}=await manufacture(backend,'system-instructions');const capture=result.capture;
  expect(capture.provenance.routingBoundsVersion).toBe(1);
  const replayed=await replaySemanticCapture(capture,adapters);expect(replayed.capture).toEqual(capture);expect(replayed.capture).not.toBe(capture);
  for(const routingBoundsVersion of [0,2,null])expect(()=>validateSemanticCapture({...capture,provenance:{...capture.provenance,routingBoundsVersion}})).toThrow(/version/);
  const noPrices=structuredClone(capture);delete noPrices.provenance.maxPrice;expect(()=>validateSemanticCapture(noPrices)).toThrow(/version/);
  for(const patch of [{max_price:{input:1,output:2}},{allow_fallbacks:true},{require_parameters:false}]){
    const changed=structuredClone(capture),exchange=changed.turns[0].exchange;
    const request=JSON.parse(Buffer.from(exchange.request.body,'base64').toString());Object.assign(request.provider,patch);
    const bytes=Buffer.from(JSON.stringify(request));exchange.request.body=bytes.toString('base64');exchange.request.sha256=digest(bytes);
    expect(()=>validateSemanticCapture(changed)).toThrow(/Routing bound/);
  }
  const reserve=vi.fn();await expect(runSemanticProbe({adapters,backend,model:'toy',scenario:'system-instructions',reserve,sdkVersions})).rejects.toThrow(/routing price/);
  expect(reserve).not.toHaveBeenCalled();
});

it("rejects credential values in decoded bodies without modifying captured evidence", async () => {
  const capture = (await manufacture(BACKENDS[0], "system-instructions")).result
    .capture;
  expect(() =>
    assertSafeSemanticCapture(capture, ["no-matching-private-value"]),
  ).not.toThrow();
  const raw = JSON.parse(
    Buffer.from(capture.turns[0].exchange.body, "base64").toString(),
  );
  raw.metadata = "a-private-credential-value";
  const body = Buffer.from(JSON.stringify(raw));
  capture.turns[0].exchange.body = body.toString("base64");
  capture.turns[0].exchange.sha256 = digest(body);
  expect(() =>
    assertSafeSemanticCapture(capture, ["a-private-credential-value"]),
  ).toThrow("Secret-bearing");
  expect(Buffer.from(capture.turns[0].exchange.body, "base64")).toEqual(body);
});

it("refuses incomplete/duplicate replay evidence, untrusted origins and unknown schema fields", async () => {
  const capture = (await manufacture(BACKENDS[0], "tool-result-replay")).result
    .capture;
  const duplicate = structuredClone(capture);
  duplicate.turns[1].reservationId = duplicate.turns[0].reservationId;
  expect(() => validateSemanticCapture(duplicate)).toThrow("independent");
  const incomplete = structuredClone(capture);
  incomplete.turns.pop();
  expect(() => validateSemanticCapture(incomplete)).toThrow("turn count");
  const secretOrigin = structuredClone(capture);
  secretOrigin.provenance.sourceOrigin = "https://user:secret@example.com";
  expect(() => validateSemanticCapture(secretOrigin)).toThrow("provenance");
  expect(() => validateSemanticCapture({ ...capture, key: "private" })).toThrow(
    "shape",
  );
});
