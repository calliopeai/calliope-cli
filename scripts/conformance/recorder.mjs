import { digest } from './captures.mjs';

/** One bounded request, with a metadata allowlist and unchanged signed bodies. */
export function createRecorder(originalFetch, backend, maxOutput, signal) {
const exchanges = [];
let calls = 0;
let sourceOrigin;
const fetch = async (input, init) => {
  if (++calls > 1) throw new Error('Probe request limit reached; no automatic retry or fallback traffic is allowed');
  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
  sourceOrigin = url.origin;
  const body = JSON.parse(String(init.body));
  // Fixed toy prompts must fit the reserved 5,000-token input allowance. UTF-8
  // bytes conservatively bound prompt tokens; leave room for protocol overhead.
  if (Buffer.byteLength(String(init.body)) > 4000) throw new Error('Probe input exceeds the reserved token allowance');
  if (backend.protocol === 'google') body.generationConfig = { ...body.generationConfig, maxOutputTokens: maxOutput };
  else if (backend.protocol === 'ollama') body.options = { ...body.options, num_predict: maxOutput };
  else if (backend.protocol === 'bedrock') body.inferenceConfig.maxTokens = maxOutput;
  else if (backend.protocol === 'responses') body.max_output_tokens = maxOutput;
  else body.max_tokens = maxOutput;
  // Bedrock requests are signed; changing the serialized body after signing
  // would invalidate SigV4. Refuse rather than issue an unbounded request.
  if (backend.protocol === 'bedrock') {
    if (JSON.parse(String(init.body)).inferenceConfig.maxTokens > maxOutput) throw new Error('Native Bedrock request exceeds the signed output cap');
  }
  const signals = [signal, init.signal].filter(Boolean);
  const combinedSignal = signals.length ? AbortSignal.any(signals) : undefined;
  combinedSignal?.throwIfAborted();
  const response = await originalFetch(input, { ...init, body: backend.protocol === 'bedrock' ? init.body : JSON.stringify(body), signal: combinedSignal });
  const reader = response.body?.getReader(); if (!reader) throw new Error('Empty response body');
  const chunks = []; let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read(); if (done) break;
      size += value.byteLength; if (size > 1024 * 1024) throw new Error('Capture exceeds 1 MiB');
      chunks.push(Buffer.from(value));
    }
  } finally { await reader.cancel().catch(() => {}); reader.releaseLock(); }
  const bytes = Buffer.concat(chunks);
  const headers = { 'content-type': response.headers.get('content-type') || 'application/json' };
  exchanges.push({ request: { method: init.method, path: url.pathname }, status: response.status, headers, body: bytes.toString('base64'), sha256: digest(bytes) });
  // Preserve the first provider error instead of allowing the SDK to replace it
  // with a connection error when the one-request guard rejects its retry.
  // This local SDK control is not part of the captured wire headers.
  return new Response(bytes, { status: response.status, headers: { ...headers, 'x-should-retry': 'false' } });
};
  return { fetch, exchanges, sourceOrigin: () => sourceOrigin };
}
