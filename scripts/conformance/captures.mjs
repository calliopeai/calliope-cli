/** Capture validation and fail-closed offline replay. No networking. */
import { createHash } from 'node:crypto';
import { BACKENDS, PROBE_TEXT } from './contract.mjs';
export const digest = bytes => createHash('sha256').update(bytes).digest('hex');
export function validateCapture(value) {
  if (value?.version !== 1 || value.provenance?.kind !== 'captured' || !Number.isFinite(Date.parse(value.provenance.capturedAt))) throw new Error('A capture requires real-wire provenance and a capture timestamp');
  if (!BACKENDS.some(backend => backend.id === value.backend) || !['text', 'tool'].includes(value.scenario) || typeof value.stream !== 'boolean' || typeof value.model !== 'string' || !value.model) throw new Error('Invalid capture target');
  if (!value.expected || !Array.isArray(value.exchanges) || value.exchanges.length !== 1) throw new Error('A probe must contain exactly one exchange and its reviewed expected result');
  if (!value.provenance.sdkVersions || typeof value.provenance.sdkVersions !== 'object') throw new Error('SDK versions are required');
  if (value.scenario === 'text' && (value.expected.finishReason !== 'stop' || value.expected.content.trim() !== PROBE_TEXT || value.expected.tools?.length !== 0)) throw new Error('Text probe did not complete the expected task');
  if (value.scenario === 'tool' && (value.expected.finishReason !== 'tool_use' || value.expected.tools?.length !== 1 || value.expected.tools[0].name !== 'echo' || value.expected.tools[0].arguments?.text !== 'hello')) throw new Error('Tool probe did not complete the expected task');
  for (const exchange of value.exchanges) {
    const body = Buffer.from(exchange.body, 'base64');
    if (body.length > 1024 * 1024 || digest(body) !== exchange.sha256) throw new Error('Capture body checksum or size mismatch');
    if (exchange.status !== 200 || !exchange.request || exchange.request.method !== 'POST' || !exchange.request.path.startsWith('/') || exchange.request.path.includes('?')) throw new Error('Invalid exchange metadata');
    if (Object.keys(exchange.headers).some(key => key !== 'content-type')) throw new Error('Only content-type may be stored; remove credentials and unrelated headers');
  }
  return value;
}
export function replayFetch(capture, fragmentSize = 7) {
  validateCapture(capture);
  let index = 0;
  const fetch = async (input, init) => {
    const exchange = capture.exchanges[index++];
    if (!exchange) throw new Error('Unexpected request during offline replay');
    const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);
    if (url.pathname !== exchange.request.path || (init?.method ?? 'GET') !== exchange.request.method) throw new Error('Replay request does not match the captured endpoint');
    if (init?.signal?.aborted) throw init.signal.reason;
    const bytes = Buffer.from(exchange.body, 'base64'); let offset = 0;
    return new Response(new ReadableStream({ pull(controller) {
      if (init?.signal?.aborted) return controller.error(init.signal.reason);
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.subarray(offset, offset + fragmentSize)); offset += fragmentSize;
    } }), { status: exchange.status, headers: exchange.headers });
  };
  return { fetch, assertConsumed() { if (index !== capture.exchanges.length) throw new Error('Not all captured exchanges were consumed'); } };
}
export function missingCaptures(captures) {
  return BACKENDS.flatMap(backend => ['text', 'tool'].flatMap(scenario => [false, true].flatMap(stream =>
    captures.some(c => c.backend === backend.id && c.scenario === scenario && c.stream === stream) ? [] : [`${backend.id}/${scenario}/${stream ? 'stream' : 'json'}`])));
}
