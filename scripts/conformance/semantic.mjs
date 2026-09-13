/** Fixed public semantic probes. No project input and no executed tools. */
import { BACKENDS, TOOL, PROBE_TEXT, invoke, normalize } from "./contract.mjs";
import { digest } from "./captures.mjs";
import { createRecorder } from "./recorder.mjs";

export const SEMANTIC_CHECKS = [
  "system-instructions",
  "tool-result-replay",
  "provider-error",
  "cancellation",
];
export const ROOT_DIRECTIVE =
  "The first word of your exact reply must be Hello.";
export const MODE_DIRECTIVE =
  "The second and final word must be π. Separate the two words with one space; add nothing else.";
export function semanticMessages(scenario, probeVersion = 2) {
  if (scenario === "system-instructions")
    return [
      { role: "system", content: ROOT_DIRECTIVE },
      { role: "user", content: "Follow both system directives." },
      { role: "system", content: MODE_DIRECTIVE },
    ];
  if (scenario === "tool-result-replay")
    return [
      {
        role: "user",
        content:
          probeVersion === 1
            ? 'Call echo exactly once with text="hello". After its result is supplied, reply with that result exactly. Do not invent the tool result.'
            : 'Call echo exactly once with text="hello". This is a conformance fixture: the tool supplies a marker that can differ from its input. After you receive it, output only its result string without punctuation, quotation marks, or explanation.',
      },
    ];
  return [{ role: "user", content: `Reply with exactly: ${PROBE_TEXT}` }];
}
export function appendToyResult(messages, result) {
  return [
    ...messages,
    {
      role: "assistant",
      content: result.content,
      toolCalls: result.toolCalls,
      ...(result.providerMetadata
        ? { providerMetadata: result.providerMetadata }
        : {}),
    },
    { role: "tool", toolCallId: result.toolCalls[0].id, content: PROBE_TEXT },
  ];
}
function object(value, keys, required = keys) {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !keys.includes(key)) ||
    required.some((key) => !Object.hasOwn(value, key))
  )
    throw new Error("Invalid semantic capture shape");
}
function bytes(value, hash, limit) {
  if (
    typeof value !== "string" ||
    value.length > Math.ceil(limit / 3) * 4 ||
    typeof hash !== "string"
  )
    throw new Error("Invalid semantic capture bytes");
  const decoded = Buffer.from(value, "base64");
  if (
    decoded.toString("base64") !== value ||
    decoded.length > limit ||
    digest(decoded) !== hash
  )
    throw new Error("Semantic capture checksum or size mismatch");
  return decoded;
}
function response(value, tool = false) {
  object(value, ["content", "finishReason", "usage", "tools"]);
  if (
    typeof value.content !== "string" ||
    value.content.length > 1024 * 1024 ||
    !Array.isArray(value.tools)
  )
    throw new Error("Invalid semantic response");
  if (value.usage !== null) {
    object(value.usage, ["inputTokens", "outputTokens"]);
    if (
      ![value.usage.inputTokens, value.usage.outputTokens].every(
        (n) => Number.isSafeInteger(n) && n >= 0,
      )
    )
      throw new Error("Invalid semantic usage");
  }
  if (tool) {
    if (value.finishReason !== "tool_use" || value.tools.length !== 1)
      throw new Error("Semantic tool call did not complete");
    object(value.tools[0], ["name", "arguments"]);
    object(value.tools[0].arguments, ["text"]);
    if (
      value.tools[0].name !== "echo" ||
      value.tools[0].arguments.text !== "hello"
    )
      throw new Error("Unexpected semantic tool call");
  } else if (
    value.finishReason !== "stop" ||
    value.content.trim() !== PROBE_TEXT ||
    value.tools.length
  )
    throw new Error("Semantic text did not complete");
}
/** Byte provenance is necessary but not sufficient: all entries also replay through the SDK. */
export function validateSemanticCapture(value) {
  const keys = [
    "version",
    "kind",
    "backend",
    "model",
    "scenario",
    "stream",
    "maxOutputTokens",
    "provenance",
    "turns",
  ];
  object(value, [...keys, "probeVersion"], keys);
  if (value.probeVersion !== undefined && ![1, 2].includes(value.probeVersion))
    throw new Error("Invalid semantic probe version");
  if (
    value.version !== 1 ||
    value.kind !== "provider-semantic" ||
    !BACKENDS.some((b) => b.id === value.backend) ||
    !SEMANTIC_CHECKS.includes(value.scenario) ||
    typeof value.stream !== "boolean" ||
    typeof value.model !== "string" ||
    !/^[\w./:@+-]{1,300}$/.test(value.model) ||
    !Number.isInteger(value.maxOutputTokens) ||
    value.maxOutputTokens < 1 ||
    value.maxOutputTokens > 512
  )
    throw new Error("Invalid semantic capture target");
  object(
    value.provenance,
    [
      "kind",
      "capturedAt",
      "sourceOrigin",
      "sdkVersions",
      "gateway",
      "maxPrice",
      "routingBoundsVersion",
      "reasoningReplayVersion",
    ],
    ["kind", "capturedAt", "sourceOrigin", "sdkVersions"],
  );
  if (value.provenance.gateway) {
    object(value.provenance.gateway, [
      "name",
      "version",
      "upstreamProvider",
      "upstreamModel",
    ]);
    if (
      Object.values(value.provenance.gateway).some(
        (v) => typeof v !== "string" || !/^[\w./:@+-]{1,300}$/.test(v),
      )
    )
      throw new Error("Invalid gateway provenance");
  }
  if (value.provenance.maxPrice) {
    object(value.provenance.maxPrice, ["input", "output"]);
    if (
      value.backend !== "openrouter" ||
      !Object.values(value.provenance.maxPrice).every(
        (n) => Number.isFinite(n) && n >= 0,
      )
    )
      throw new Error("Invalid routing price bound");
  }
  if (value.provenance.routingBoundsVersion !== undefined &&
      (value.provenance.routingBoundsVersion !== 1 || !value.provenance.maxPrice))
    throw new Error("Invalid routing bound version");
  const origin = new URL(value.provenance.sourceOrigin);
  if (
    value.provenance.kind !== "captured" ||
    !Number.isFinite(Date.parse(value.provenance.capturedAt)) ||
    !["http:", "https:"].includes(origin.protocol) ||
    origin.origin !== value.provenance.sourceOrigin ||
    origin.username ||
    origin.password
  )
    throw new Error("Invalid semantic provenance");
  const versions = value.provenance.sdkVersions;
  object(versions, ["openai", "@anthropic-ai/sdk", "@google/genai"]);
  if (
    Object.values(versions).some(
      (v) => typeof v !== "string" || !/^[\w.+-]{1,80}$/.test(v),
    )
  )
    throw new Error("Invalid SDK versions");
  if (
    !Array.isArray(value.turns) ||
    value.turns.length !== (value.scenario === "tool-result-replay" ? 2 : 1)
  )
    throw new Error("Invalid semantic turn count");
  for (const [index, turn] of value.turns.entries()) {
    object(turn, ["reservationId", "exchange", "expected"]);
    if (
      typeof turn.reservationId !== "string" ||
      !/^[0-9a-f-]{36}$/.test(turn.reservationId)
    )
      throw new Error("Invalid semantic reservation");
    const exchange = turn.exchange;
    object(exchange, [
      "request",
      "status",
      "headers",
      "body",
      "sha256",
      "complete",
      "bodyClosed",
    ]);
    object(exchange.request, ["method", "path", "body", "sha256"]);
    object(exchange.headers, ["content-type"]);
    if (
      exchange.request.method !== "POST" ||
      typeof exchange.request.path !== "string" ||
      !exchange.request.path.startsWith("/") ||
      exchange.request.path.length > 1024 ||
      /[?#\s]/.test(exchange.request.path) ||
      typeof exchange.headers["content-type"] !== "string" ||
      !/^[\w/+.;= -]{1,160}$/.test(exchange.headers["content-type"]) ||
      !Number.isInteger(exchange.status) ||
      exchange.status < 200 ||
      exchange.status > 599 ||
      typeof exchange.complete !== "boolean" ||
      exchange.bodyClosed !== true
    )
      throw new Error("Invalid semantic exchange");
    const body = bytes(exchange.body, exchange.sha256, 1024 * 1024);
    const request = bytes(
      exchange.request.body,
      exchange.request.sha256,
      4000,
    ).toString("utf8");
    const requestBody = JSON.parse(request);
    if (
      value.provenance.maxPrice &&
      (requestBody.provider?.allow_fallbacks !== false ||
        canonical(requestBody.provider?.max_price) !==
          canonical(value.provenance.routingBoundsVersion === 1
            ? { prompt: value.provenance.maxPrice.input, completion: value.provenance.maxPrice.output, request: 0, image: 0 }
            : value.provenance.maxPrice) ||
        value.provenance.routingBoundsVersion === 1 && requestBody.provider?.require_parameters !== true)
    )
      throw new Error("Routing bound missing from captured request");
    const expected = turn.expected;
    if (value.scenario === "cancellation") {
      object(expected, [
        "outcome",
        "abortedAfterBytes",
        "signalAborted",
        "adapterRejected",
      ]);
      if (
        !value.stream ||
        exchange.status !== 200 ||
        exchange.complete ||
        !body.length ||
        expected.outcome !== "cancelled" ||
        expected.abortedAfterBytes !== body.length ||
        expected.signalAborted !== true ||
        expected.adapterRejected !== true
      )
        throw new Error("Cancellation lacks observed live abort evidence");
    } else if (value.scenario === "provider-error") {
      object(expected, ["outcome", "httpStatus", "adapterRejected"]);
      if (
        expected.outcome !== "provider-error" ||
        exchange.status < 400 ||
        !exchange.complete ||
        !body.length ||
        expected.httpStatus !== exchange.status ||
        expected.adapterRejected !== true
      )
        throw new Error(
          "Provider error lacks a complete rejected HTTP response",
        );
    } else {
      object(expected, ["outcome", "response"]);
      if (
        expected.outcome !== "completed" ||
        exchange.status !== 200 ||
        !exchange.complete
      )
        throw new Error("Semantic completion is incomplete");
      response(
        expected.response,
        value.scenario === "tool-result-replay" && index === 0,
      );
      if (
        value.scenario === "system-instructions" &&
        (!request.includes(ROOT_DIRECTIVE) || !request.includes(MODE_DIRECTIVE))
      )
        throw new Error("System directive missing from captured request");
      if (
        value.scenario === "tool-result-replay" &&
        index === 1 &&
        !request.includes(PROBE_TEXT)
      )
        throw new Error("Tool result missing from captured request");
    }
  }
  if (
    new Set(value.turns.map((t) => t.reservationId)).size !== value.turns.length
  )
    throw new Error("Semantic turns must have independent reservations");
  if(value.provenance.reasoningReplayVersion!==undefined &&
    (value.provenance.reasoningReplayVersion!==1||!verifiedDeepSeekReasoningReplay(value)))
    throw new Error("Invalid DeepSeek reasoning replay provenance");
  return value;
}

// Read only the opaque field from the bounded recorded response, never infer it.
function recordedDeepSeekReasoning(capture) {
  try {
    const wire=Buffer.from(capture.turns[0].exchange.body,"base64").toString("utf8");
    if(!capture.stream){const value=JSON.parse(wire).choices?.[0]?.message?.reasoning_content;return typeof value==='string'?value:undefined;}
    let reasoning;
    for(const line of wire.split(/\r?\n/))if(line.startsWith('data:')&&line.slice(5).trim()!=='[DONE]'){
      const value=JSON.parse(line.slice(5)).choices?.[0]?.delta?.reasoning_content;
      if(value===null||value===undefined)continue;if(typeof value!=='string')return undefined;reasoning=(reasoning??'')+value;
    }
    return reasoning;
  }catch{return undefined;}
}
function verifiedDeepSeekReasoningReplay(capture) {
  if(capture.backend!=='deepseek'||capture.scenario!=='tool-result-replay')return false;
  const reasoning=recordedDeepSeekReasoning(capture);
  const messages=JSON.parse(Buffer.from(capture.turns[1].exchange.request.body,'base64').toString()).messages;
  const assistants=messages?.filter(m=>m.role==='assistant');
  return typeof reasoning==='string'&&assistants?.length===1&&assistants[0].reasoning_content===reasoning;
}

/** Serial caller only: adapters use global fetch. Each turn owns one reservation. */
export async function runSemanticProbe({
  adapters,
  backend,
  model,
  scenario,
  stream = false,
  maxOutputTokens = 128,
  originalFetch = globalThis.fetch,
  reserve,
  signal,
  sdkVersions,
  probeVersion = 2,
  maxPrice,
}) {
  if (
    !SEMANTIC_CHECKS.includes(scenario) ||
    !BACKENDS.some((b) => b.id === backend?.id) ||
    !Number.isInteger(maxOutputTokens) ||
    maxOutputTokens < 1 ||
    maxOutputTokens > 512 ||
    (scenario === "cancellation" && !stream)
  )
    throw new Error("Invalid semantic probe options");
  if (![1, 2].includes(probeVersion))
    throw new Error("Invalid semantic probe version");
  if (
    backend.id === "openrouter" && !maxPrice ||
    maxPrice &&
    (backend.id !== "openrouter" ||
      ![maxPrice.input, maxPrice.output].every(
        (n) => Number.isFinite(n) && n >= 0,
      ))
  )
    throw new Error("Invalid probe routing price bound");
  const turns = [];
  let messages = semanticMessages(scenario, probeVersion),
    sourceOrigin;
  for (
    let index = 0;
    index < (scenario === "tool-result-replay" ? 2 : 1);
    index++
  ) {
    signal?.throwIfAborted();
    const reservation = await reserve();
    const cancel = new AbortController();
    const combined = AbortSignal.any([
      cancel.signal,
      AbortSignal.timeout(30000),
      ...(signal ? [signal] : []),
    ]);
    let abortedAfterBytes = 0,
      result,
      error;
    const recorder = createRecorder(
      originalFetch,
      backend,
      maxOutputTokens,
      combined,
      {
        streamResponse: true,
        captureToyRequest: true,
        maxPrice,
        onChunk(size, status) {
          if (scenario === "cancellation" && status === 200) {
            abortedAfterBytes = size;
            cancel.abort(
              new DOMException("Conformance live cancellation", "AbortError"),
            );
          }
        },
      },
    );
    const previousFetch = globalThis.fetch;
    let outcome = "failed";
    try {
      globalThis.fetch = recorder.fetch;
      try {
        result = await invoke(
          adapters,
          backend,
          model,
          messages,
          scenario === "tool-result-replay" ? [TOOL] : [],
          stream ? () => {} : undefined,
          combined,
          { maxOutputTokens, priceCeiling: maxPrice },
        );
      } catch (caught) {
        error = caught;
      }
      await recorder.close();
      const exchange = recorder.exchanges[0];
      const httpStatus =
        exchange?.status ??
        (Number.isInteger(error?.status) ? error.status : null);
      if (!exchange || recorder.exchanges.length !== 1)
        return {
          outcome: combined.aborted ? "cancelled" : "failed",
          httpStatus,
          turns,
        };
      sourceOrigin ??= recorder.sourceOrigin();
      if (sourceOrigin !== recorder.sourceOrigin())
        throw new Error("Semantic replay switched origins");
      let expected;
      if (
        scenario === "cancellation" &&
        cancel.signal.aborted &&
        abortedAfterBytes > 0 &&
        error
      ) {
        expected = {
          outcome: "cancelled",
          abortedAfterBytes,
          signalAborted: true,
          adapterRejected: true,
        };
        outcome = "cancelled";
      } else if (scenario === "provider-error" && httpStatus >= 400 && error) {
        expected = {
          outcome: "provider-error",
          httpStatus,
          adapterRejected: true,
        };
        outcome = "captured";
      } else if (!error && result) {
        expected = { outcome: "completed", response: normalize(result) };
        try {
          response(
            expected.response,
            scenario === "tool-result-replay" && index === 0,
          );
        } catch {
          return {
            outcome: "incomplete",
            httpStatus,
            turns,
            observed: {
              finishReason: result.finishReason,
              toolCount: result.toolCalls?.length ?? 0,
              contentBytes: Buffer.byteLength(result.content),
              contentSha256: digest(Buffer.from(result.content)),
              usage: result.usage ?? null,
            },
          };
        }
        if (scenario === "cancellation" || scenario === "provider-error")
          return { outcome: "incomplete", httpStatus, turns };
        outcome = "captured";
      } else
        return {
          outcome: combined.aborted ? "cancelled" : "failed",
          httpStatus,
          turns,
        };
      turns.push({ reservationId: reservation.id, exchange, expected });
      if (scenario === "tool-result-replay" && index === 0)
        messages = appendToyResult(messages, result);
    } finally {
      globalThis.fetch = previousFetch;
      reservation.finish(outcome);
    }
  }
  const draft = {
    version: 1,
    kind: "provider-semantic",
    probeVersion,
    backend: backend.id,
    model,
    scenario,
    stream,
    maxOutputTokens,
    provenance: {
      kind: "captured",
      capturedAt: new Date().toISOString(),
      sourceOrigin,
      sdkVersions,
      ...(maxPrice ? { maxPrice, routingBoundsVersion: 1 } : {}),
    },
    turns,
  };
  if(verifiedDeepSeekReasoningReplay(draft))draft.provenance.reasoningReplayVersion=1;
  const capture=validateSemanticCapture(draft);
  return { outcome: "captured", capture };
}

/** Never opens a socket. Reconstructs both turns using actual adapter results. */
export async function replaySemanticCapture(capture, adapters) {
  validateSemanticCapture(capture);
  let index = 0, historicalReasoningOmission=false;
  // Historical captures used input/output instead of the API's prompt/completion
  // keys. Retain their bytes and replay model semantics, never treat those old
  // controls as spend evidence or reproduce the broken controls on a live call.
  const legacyRouting = capture.backend === 'openrouter' && capture.provenance.routingBoundsVersion === undefined;
  const source = async (input, init) => {
    const exchange = capture.turns[index++]?.exchange;
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    if (
      !exchange ||
      url.pathname !== exchange.request.path ||
      init.method !== "POST"
    )
      throw new Error("Unexpected semantic replay request");
    const actualRequest=JSON.parse(String(init.body)),recordedRequest=JSON.parse(Buffer.from(exchange.request.body,"base64").toString());
    if(capture.backend==='deepseek'&&capture.scenario==='tool-result-replay'&&index===2&&capture.provenance.reasoningReplayVersion===undefined){
      const previous=recordedRequest.messages.filter(m=>m.role==='assistant'),reasoning=recordedDeepSeekReasoning(capture);
      if(previous.length===1&&!Object.hasOwn(previous[0],'reasoning_content')&&reasoning!==undefined){
        const assistants=actualRequest.messages.filter(m=>m.role==='assistant');
        if(assistants.length!==1||assistants[0].reasoning_content!==reasoning)throw new Error('Current adapter did not restore the exact recorded DeepSeek reasoning');
        // Historical wire bytes omitted this field. Compare the remaining request
        // only after verifying the current adapter restored the original response.
        delete assistants[0].reasoning_content;historicalReasoningOmission=true;
      }
    }
    if (
      canonicalRequest(actualRequest, capture.backend, legacyRouting) !==
      canonicalRequest(recordedRequest,capture.backend,legacyRouting)
    )
      throw new Error(
        "Semantic replay request body differs from captured toy request",
      );
    const body = Buffer.from(exchange.body, "base64");
    let sent = false;
    return new Response(
      new ReadableStream(
        {
          pull(controller) {
            if (init.signal.aborted) {
              controller.error(init.signal.reason);
              return;
            }
            if (!sent) {
              sent = true;
              controller.enqueue(body);
            } else if (exchange.complete) controller.close();
            // A cancelled transcript intentionally ends without a terminal frame.
          },
        },
        { highWaterMark: 0 },
      ),
      { status: exchange.status, headers: exchange.headers },
    );
  };
  let reservationIndex = 0;
  const result = await runSemanticProbe({
    adapters,
    backend: BACKENDS.find((b) => b.id === capture.backend),
    model: capture.model,
    scenario: capture.scenario,
    stream: capture.stream,
    maxOutputTokens: capture.maxOutputTokens,
    sdkVersions: capture.provenance.sdkVersions,
    probeVersion: capture.probeVersion ?? 1,
    originalFetch: source,
    maxPrice: capture.provenance.maxPrice,
    reserve: () => ({
      id: capture.turns[reservationIndex++].reservationId,
      finish() {},
    }),
  });
  if (
    index !== capture.turns.length ||
    result.outcome !== "captured" ||
    JSON.stringify(result.capture.turns.map((t) => t.expected)) !==
      JSON.stringify(capture.turns.map((t) => t.expected))
  )
    throw new Error("Semantic adapter replay disagrees with captured evidence");
  // Replay is not a new live capture. Preserve the original provenance and bytes.
  return { ...result, ...(historicalReasoningOmission?{historicalReasoningOmission:true}:{}), capture: structuredClone(capture) };
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object")
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  return JSON.stringify(value);
}

function canonicalRequest(value, backend, legacyRouting = false) {
  if (legacyRouting) for (const key of ['provider', 'plugins', 'service_tier', 'modalities']) delete value[key];
  // Ollama does not supply streaming IDs; Calliope generates them locally and
  // sends tool results by position. Preserve all native provider IDs elsewhere.
  if (backend === "ollama")
    for (const message of value.messages ?? [])
      for (const call of message.tool_calls ?? []) delete call.id;
  return canonical(value);
}

/** Refuse rather than silently altering evidence bytes. Review before promotion. */
export function assertSafeSemanticCapture(capture, secrets = []) {
  validateSemanticCapture(capture);
  const text = [
    JSON.stringify(capture),
    ...capture.turns.flatMap((turn) =>
      [turn.exchange.body, turn.exchange.request.body].map((body) =>
        Buffer.from(body, "base64").toString("utf8"),
      ),
    ),
  ].join("\n");
  if (
    secrets.some(
      (secret) =>
        typeof secret === "string" &&
        secret.length >= 8 &&
        text.includes(secret),
    ) ||
    /\b(?:sk-(?:proj-|ant-|or-v1-)?[A-Za-z0-9_-]{16,}|AIza[A-Za-z0-9_-]{25,}|AKIA[A-Z0-9]{16})\b|-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(
      text,
    ) ||
    /"(?:api_key|apiKey|authorization|access_token|secret_access_key|password)"\s*:/i.test(
      text,
    )
  )
    throw new Error("Secret-bearing semantic capture refused");
}
