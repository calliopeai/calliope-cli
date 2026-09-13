import { digest } from "./captures.mjs";

/** One bounded request, with a metadata allowlist and unchanged signed bodies. */
export function createRecorder(
  originalFetch,
  backend,
  maxOutput,
  signal,
  options = {},
) {
  if (
    options.maxPrice &&
    (backend.id !== "openrouter" ||
      ![options.maxPrice.input, options.maxPrice.output].every(
        (n) => Number.isFinite(n) && n >= 0,
      ))
  )
    throw new Error("Invalid probe routing price bound");
  const exchanges = [];
  let calls = 0;
  let sourceOrigin;
  let settling = Promise.resolve();
  let close = () => settling;
  const fetch = async (input, init) => {
    if (++calls > 1)
      throw new Error(
        "Probe request limit reached; no automatic retry or fallback traffic is allowed",
      );
    const url = new URL(
      typeof input === "string" || input instanceof URL ? input : input.url,
    );
    sourceOrigin = url.origin;
    const body = JSON.parse(String(init.body));
    // Fixed toy prompts must fit the reserved 5,000-token input allowance. UTF-8
    // bytes conservatively bound prompt tokens; leave room for protocol overhead.
    if (Buffer.byteLength(String(init.body)) > 4000)
      throw new Error("Probe input exceeds the reserved token allowance");
    if (backend.protocol === "google")
      body.generationConfig = {
        ...body.generationConfig,
        maxOutputTokens: maxOutput,
      };
    else if (backend.protocol === "ollama")
      body.options = { ...body.options, num_predict: maxOutput };
    else if (backend.protocol === "bedrock")
      body.inferenceConfig.maxTokens = maxOutput;
    else if (backend.protocol === "responses")
      body.max_output_tokens = maxOutput;
    else if (Object.hasOwn(body, "max_completion_tokens"))
      body.max_completion_tokens = maxOutput;
    else body.max_tokens = maxOutput;
    if (options.maxPrice)
      body.provider = { ...body.provider, allow_fallbacks: false, require_parameters: true,
        max_price: { prompt: options.maxPrice.input, completion: options.maxPrice.output, request: 0, image: 0 } };
    // Bedrock requests are signed; changing the serialized body after signing
    // would invalidate SigV4. Refuse rather than issue an unbounded request.
    if (backend.protocol === "bedrock") {
      if (JSON.parse(String(init.body)).inferenceConfig.maxTokens > maxOutput)
        throw new Error("Native Bedrock request exceeds the signed output cap");
    }
    const signals = [signal, init.signal].filter(Boolean);
    const combinedSignal = signals.length
      ? AbortSignal.any(signals)
      : undefined;
    combinedSignal?.throwIfAborted();
    const requestBody =
      backend.protocol === "bedrock" ? init.body : JSON.stringify(body);
    if (Buffer.byteLength(String(requestBody)) > 4000)
      throw new Error("Probe input exceeds the reserved token allowance");
    const response = await originalFetch(input, {
      ...init,
      body: requestBody,
      signal: combinedSignal,
      redirect: "error",
    });
    const reader = response.body?.getReader();
    if (!reader) throw new Error("Empty response body");
    const chunks = [];
    let size = 0;
    const headers = {
      "content-type":
        response.headers.get("content-type") || "application/json",
    };
    const request = { method: init.method, path: url.pathname };
    if (options.captureToyRequest) {
      const bytes = Buffer.from(
        backend.protocol === "bedrock"
          ? String(init.body)
          : JSON.stringify(body),
      );
      request.body = bytes.toString("base64");
      request.sha256 = digest(bytes);
    }
    // Semantic probes must see the live stream, not an already completed buffer.
    // This path pulls on demand and retains a partial transcript on abort. The
    // caller may record only fixed public toy requests; headers are never copied.
    if (options.streamResponse) {
      let finished = false;
      const finish = (complete) => {
        if (finished) return settling;
        finished = true;
        combinedSignal?.removeEventListener("abort", abort);
        settling = (async () => {
          let bodyClosed = false;
          try {
            // Native fetch may already have errored the reader on abort. Its
            // cancellation then rejects even though reader.closed is terminal.
            await reader.cancel().catch(() => {});
            await reader.closed.catch(() => {});
            bodyClosed = true;
          } finally {
            reader.releaseLock();
            const bytes = Buffer.concat(chunks);
            exchanges.push({
              request,
              status: response.status,
              headers,
              body: bytes.toString("base64"),
              sha256: digest(bytes),
              complete,
              bodyClosed,
            });
          }
        })();
        return settling;
      };
      let controller;
      const abort = () => {
        controller?.error(combinedSignal.reason);
        void finish(false).catch(() => {});
      };
      close = () => finish(false);
      const stream = new ReadableStream(
        {
          start(value) {
            controller = value;
            combinedSignal?.addEventListener("abort", abort, { once: true });
            if (combinedSignal?.aborted) abort();
          },
          async pull(value) {
            try {
              combinedSignal?.throwIfAborted();
              const next = await reader.read();
              if (finished) return;
              if (next.done) {
                await finish(true);
                value.close();
                return;
              }
              size += next.value.byteLength;
              if (size > 1024 * 1024) throw new Error("Capture exceeds 1 MiB");
              chunks.push(Buffer.from(next.value));
              options.onChunk?.(size, response.status);
              combinedSignal?.throwIfAborted();
              value.enqueue(next.value);
            } catch (error) {
              if (!finished) {
                await finish(false);
                value.error(error);
              }
            }
          },
          async cancel() {
            await finish(false);
          },
        },
        { highWaterMark: 0 },
      );
      return new Response(stream, {
        status: response.status,
        headers: { ...headers, "x-should-retry": "false" },
      });
    }
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1024 * 1024) throw new Error("Capture exceeds 1 MiB");
        chunks.push(Buffer.from(value));
      }
    } finally {
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
    const bytes = Buffer.concat(chunks);
    exchanges.push({
      request,
      status: response.status,
      headers,
      body: bytes.toString("base64"),
      sha256: digest(bytes),
    });
    // Preserve the first provider error instead of allowing the SDK to replace it
    // with a connection error when the one-request guard rejects its retry.
    // This local SDK control is not part of the captured wire headers.
    return new Response(bytes, {
      status: response.status,
      headers: { ...headers, "x-should-retry": "false" },
    });
  };
  return {
    fetch,
    exchanges,
    sourceOrigin: () => sourceOrigin,
    settled: () => settling,
    close: () => close(),
  };
}
