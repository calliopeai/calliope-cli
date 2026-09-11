/** Synthetic protocol contracts. These are NOT captured provider responses. */
import { PROBE_TEXT } from '../../scripts/conformance/contract.mjs';
const args = { text: 'hello' };
const usage = { input_tokens: 7, output_tokens: 3 };
const sse = (events: unknown[], named = false) => events.map((event: any) => `${named ? `event: ${event.type}\n` : ''}data: ${JSON.stringify(event)}\n\n`).join('');
const buffer = (value: unknown) => Buffer.from(JSON.stringify(value));
function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) { crc ^= byte; for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ ((crc & 1) ? 0xedb88320 : 0); }
  return (crc ^ 0xffffffff) >>> 0;
}
function awsEvent(type: string, payload: unknown): Buffer {
  const header = (key: string, value: string) => { const keyBytes = Buffer.from(key), valueBytes = Buffer.from(value); const prefix = Buffer.alloc(keyBytes.length + 4); prefix[0] = keyBytes.length; keyBytes.copy(prefix, 1); prefix[keyBytes.length + 1] = 7; prefix.writeUInt16BE(valueBytes.length, keyBytes.length + 2); return Buffer.concat([prefix, valueBytes]); };
  const headers = Buffer.concat([header(':message-type', 'event'), header(':event-type', type), header(':content-type', 'application/json')]);
  const body = buffer(payload), prelude = Buffer.alloc(12), checksum = Buffer.alloc(4);
  prelude.writeUInt32BE(16 + headers.length + body.length, 0); prelude.writeUInt32BE(headers.length, 4); prelude.writeUInt32BE(crc32(prelude.subarray(0, 8)), 8);
  const frame = Buffer.concat([prelude, headers, body]); checksum.writeUInt32BE(crc32(frame)); return Buffer.concat([frame, checksum]);
}
export function syntheticWire(protocol: string, scenario: 'text' | 'tool' | 'length' | 'error', stream: boolean): { body: Buffer; type: string } {
  const tool = scenario === 'tool'; const text = tool ? '' : PROBE_TEXT;
  const finish = scenario === 'length' ? 'length' : scenario === 'error' ? 'content_filter' : tool ? 'tool_calls' : 'stop';
  let body: Buffer; let type = stream ? 'text/event-stream' : 'application/json';
  if (protocol === 'chat') {
    const tc = { id: 'call_1', type: 'function', function: { name: 'echo', arguments: JSON.stringify(args) } };
    const base = { id: 'chat_1', object: stream ? 'chat.completion.chunk' : 'chat.completion', created: 1, model: 'test-model' };
    body = stream ? Buffer.from(sse([
      { ...base, choices: [{ index: 0, delta: tool ? { tool_calls: [{ ...tc, index: 0, function: { name: 'echo', arguments: '{"text":' } }] } : { content: text } }] },
      ...(tool ? [{ ...base, choices: [{ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: '"hello"}' } }] } }] }] : []),
      { ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
      { ...base, choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } },
    ]) + 'data: [DONE]\n\n') : buffer({ ...base, choices: [{ index: 0, message: { role: 'assistant', content: text, ...(tool ? { tool_calls: [tc] } : {}) }, finish_reason: finish }], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } });
  } else if (protocol === 'anthropic') {
    const reason = tool ? 'tool_use' : scenario === 'length' ? 'max_tokens' : scenario === 'error' ? 'refusal' : 'end_turn';
    const block = tool ? { type: 'tool_use', id: 'call_1', name: 'echo', input: args } : { type: 'text', text };
    const base = { id: 'msg_1', type: 'message', role: 'assistant', model: 'test-model', stop_sequence: null, stop_reason: reason, usage };
    body = stream ? Buffer.from(sse([
      { type: 'message_start', message: { ...base, stop_reason: null, content: [], usage: { input_tokens: 7, output_tokens: 0 } } },
      { type: 'content_block_start', index: 0, content_block: tool ? { ...block, input: {} } : { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: tool ? { type: 'input_json_delta', partial_json: JSON.stringify(args) } : { type: 'text_delta', text } },
      { type: 'content_block_stop', index: 0 }, { type: 'message_delta', delta: { stop_reason: reason, stop_sequence: null }, usage: { output_tokens: 3 } }, { type: 'message_stop' },
    ], true)) : buffer({ ...base, content: [block] });
  } else if (protocol === 'responses') {
    const status = scenario === 'length' ? 'incomplete' : scenario === 'error' ? 'failed' : 'completed';
    const item = tool ? { type: 'function_call', id: 'fc_1', call_id: 'call_1', name: 'echo', arguments: JSON.stringify(args), status: 'completed' } : { type: 'message', id: 'msg_1', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text, annotations: [] }] };
    const base = { id: 'resp_1', object: 'response', created_at: 1, model: 'gpt-5-test', status, output: [item], usage, ...(status === 'incomplete' ? { incomplete_details: { reason: 'max_output_tokens' } } : {}) };
    body = stream ? Buffer.from(sse([
      { type: 'response.created', response: { ...base, status: 'in_progress', output: [] } },
      { type: 'response.output_item.added', output_index: 0, item: tool ? { ...item, arguments: '' } : { ...item, content: [] } },
      ...(tool ? [{ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: JSON.stringify(args) }] : [
        { type: 'response.content_part.added', item_id: 'msg_1', output_index: 0, content_index: 0, part: { type: 'output_text', text: '', annotations: [] } },
        { type: 'response.output_text.delta', item_id: 'msg_1', output_index: 0, content_index: 0, delta: text },
      ]),
      { type: 'response.output_item.done', output_index: 0, item }, { type: `response.${status}`, response: base },
    ], true)) : buffer(base);
  } else if (protocol === 'google') {
    const event = { candidates: [{ index: 0, content: { role: 'model', parts: [tool ? { functionCall: { name: 'echo', args } } : { text }] }, finishReason: scenario === 'length' ? 'MAX_TOKENS' : scenario === 'error' ? 'SAFETY' : 'STOP' }], usageMetadata: { promptTokenCount: 7, candidatesTokenCount: 3, totalTokenCount: 10 } };
    body = stream ? Buffer.from(sse([event])) : buffer(event);
  } else if (protocol === 'ollama') {
    type = stream ? 'application/x-ndjson' : 'application/json';
    const message = { role: 'assistant', content: text, ...(tool ? { tool_calls: [{ function: { name: 'echo', arguments: args } }] } : {}) };
    const result = { model: 'test-model', message, done: true, done_reason: scenario === 'length' ? 'length' : 'stop', prompt_eval_count: 7, eval_count: 3 };
    body = stream ? Buffer.from(JSON.stringify({ model: 'test-model', message, done: false }) + '\n' + JSON.stringify({ ...result, message: { role: 'assistant', content: '' } }) + '\n') : buffer(result);
  } else {
    const stopReason = tool ? 'tool_use' : scenario === 'length' ? 'max_tokens' : scenario === 'error' ? 'guardrail_intervened' : 'end_turn';
    const awsUsage = { inputTokens: 7, outputTokens: 3 };
    type = stream ? 'application/vnd.amazon.eventstream' : 'application/json';
    body = stream ? Buffer.concat([
      ...(tool ? [awsEvent('contentBlockStart', { contentBlockIndex: 0, start: { toolUse: { toolUseId: 'call_1', name: 'echo' } } }), awsEvent('contentBlockDelta', { contentBlockIndex: 0, delta: { toolUse: { input: JSON.stringify(args) } } })] : [awsEvent('contentBlockDelta', { contentBlockIndex: 0, delta: { text } })]),
      awsEvent('contentBlockStop', { contentBlockIndex: 0 }), awsEvent('messageStop', { stopReason }), awsEvent('metadata', { usage: awsUsage }),
    ]) : buffer({ output: { message: { role: 'assistant', content: [tool ? { toolUse: { toolUseId: 'call_1', name: 'echo', input: args } } : { text }] } }, stopReason, usage: awsUsage });
  }
  return { body, type };
}
export function wireResponse(body: Uint8Array, type: string, fragment = 7): Response {
  let offset = 0;
  return new Response(new ReadableStream({ pull(controller) {
    if (offset >= body.length) return controller.close();
    controller.enqueue(body.slice(offset, offset + fragment)); offset += fragment;
  } }), { status: 200, headers: { 'content-type': type } });
}
