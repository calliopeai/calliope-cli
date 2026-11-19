import type { LLMResponse } from '../types.js';
import { StreamProtocolError } from '../errors.js';
const object = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const optionalText = (v: unknown) => v == null || typeof v === 'string';
const terminals = {
  chat: new Set(['stop','length','tool_calls','content_filter']),
  bedrock: new Set(['end_turn','tool_use','max_tokens','stop_sequence','guardrail_intervened','content_filtered','malformed_model_output','malformed_tool_use','model_context_window_exceeded']),
  ollama: new Set(['stop','length']),
  anthropic: new Set(['end_turn','max_tokens','stop_sequence','tool_use','pause_turn','refusal','model_context_window_exceeded']),
};
export function assertTerminalReason(value: unknown, protocol: keyof typeof terminals): void {
  if (typeof value !== 'string' || !terminals[protocol].has(value))
    throw new StreamProtocolError(`Unsupported or missing ${protocol} completion reason; its reservation remains charged.`);
}
const count = (v: unknown) => Number.isSafeInteger(v) && (v as number) >= 0;
function assertUniqueToolIds(values: unknown[]): void {
  const seen = new Set<string>();
  for (const value of values) {
    if (typeof value !== 'string' || !value || seen.has(value))
      throw new StreamProtocolError('Invalid or duplicate raw tool identity; its reservation remains charged.');
    seen.add(value);
  }
}
function validResponseItemStatus(item: Record<string, unknown>, parent: unknown): boolean {
  return item.status === undefined || typeof item.status === 'string' &&
    ['completed', 'incomplete', 'in_progress'].includes(item.status) &&
    (parent !== 'completed' || item.status === 'completed');
}

/** Validate frame shape before an event can change completion or reported usage. */
export function assertChatStreamChunk(v: unknown, previousUsage?: { inputTokens: number; outputTokens: number }): void {
  if (!object(v) || !Array.isArray(v.choices) || v.choices.length > 1 || !v.choices.every(choice => {
    if (!object(choice) || !optionalText(choice.finish_reason) || choice.index!==undefined && choice.index!==0) return false;
    if (choice.finish_reason != null) assertTerminalReason(choice.finish_reason, 'chat');
    if (choice.delta == null) return true;
    if (!object(choice.delta) || choice.delta.role!==undefined && choice.delta.role!=='assistant' || !optionalText(choice.delta.content) || !optionalText(choice.delta.reasoning_content)) return false;
    if (choice.delta.tool_calls === undefined) return true;
    return Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.every(tool =>
      object(tool) && count(tool.index) && optionalText(tool.id) && (tool.type === undefined || tool.type === 'function') &&
      (tool.function === undefined || object(tool.function) && optionalText(tool.function.name) && optionalText(tool.function.arguments)));
  }) || v.usage != null && (!object(v.usage) || !count(v.usage.prompt_tokens) || !count(v.usage.completion_tokens)))
    throw new StreamProtocolError('Invalid provider chat stream event fields; its reservation remains charged.');
  if (previousUsage && object(v.usage) &&
      ((v.usage.prompt_tokens as number) < previousUsage.inputTokens || (v.usage.completion_tokens as number) < previousUsage.outputTokens))
    throw new StreamProtocolError('Provider chat usage regressed; its reservation remains charged.');
}
export function assertOllamaTerminalResponse(v: unknown): void {
  if (object(v)) assertTerminalReason(v.done_reason, 'ollama');
  if (!object(v) || v.done !== true || !optionalText(v.done_reason) || !object(v.message) || v.message.role!==undefined && v.message.role!=='assistant' || typeof v.message.content !== 'string' ||
      [v.prompt_eval_count, v.eval_count].some(value => value !== undefined && !count(value)) ||
      v.message.tool_calls !== undefined && (!Array.isArray(v.message.tool_calls) || !v.message.tool_calls.every(tool =>
        object(tool) && optionalText(tool.id) && object(tool.function) && typeof tool.function.name === 'string' && !!tool.function.name && object(tool.function.arguments))))
    throw new StreamProtocolError('Invalid or incomplete Ollama terminal response; its reservation remains charged.');
}

/** Converse fields consumed by this adapter; optional invoice/cache fields stay descriptive. */
export function assertBedrockUsage(v: unknown, previous?: { inputTokens: number; outputTokens: number }): void {
  if (!object(v) || !count(v.inputTokens) || !count(v.outputTokens) ||
      !Number.isSafeInteger((v.inputTokens as number) + (v.outputTokens as number)) ||
      [v.cacheReadInputTokens,v.cacheWriteInputTokens].some(value => value !== undefined && !count(value)) ||
      v.totalTokens !== undefined && (!count(v.totalTokens) || v.totalTokens !== (v.inputTokens as number) + (v.outputTokens as number)))
    throw new StreamProtocolError('Invalid Bedrock usage fields; its reservation remains charged.');
  if (previous && ((v.inputTokens as number) < previous.inputTokens || (v.outputTokens as number) < previous.outputTokens))
    throw new StreamProtocolError('Bedrock usage regressed; its reservation remains charged.');
}
export function assertBedrockTerminalResponse(v: unknown): void {
  if (!object(v)) throw new StreamProtocolError('Invalid Bedrock terminal response; its reservation remains charged.');
  assertTerminalReason(v.stopReason, 'bedrock');
  if (!object(v.output) || !object(v.output.message) || v.output.message.role !== 'assistant' || !Array.isArray(v.output.message.content) ||
      !v.output.message.content.every(block => {
        if (!object(block)) return false;
        const payloads=['text','toolUse','reasoningContent'].filter(key=>block[key]!==undefined);
        if (payloads.length!==1) return false;
        if (block.text !== undefined) return typeof block.text==='string';
        if (block.reasoningContent !== undefined) { assertBedrockReasoning(block.reasoningContent,false); return true; }
        return object(block.toolUse) && typeof block.toolUse.toolUseId==='string' && !!block.toolUse.toolUseId &&
          typeof block.toolUse.name==='string' && !!block.toolUse.name && object(block.toolUse.input);
      })) throw new StreamProtocolError('Invalid Bedrock terminal message; its reservation remains charged.');
  assertUniqueToolIds(v.output.message.content.flatMap(block => object(block.toolUse) ? [block.toolUse.toolUseId] : []));
  if (v.usage!==undefined) assertBedrockUsage(v.usage);
}

export function assertUsagePair(v: unknown, input: string, output: string, previous?: { inputTokens: number; outputTokens: number }): void {
  if (!object(v) || !count(v[input]) || !count(v[output]) ||
      previous && ((v[input] as number) < previous.inputTokens || (v[output] as number) < previous.outputTokens))
    throw new StreamProtocolError('Invalid or regressed provider usage; its reservation remains charged.');
}
export function assertChatTerminalResponse(v: unknown): void {
  if (!object(v) || !Array.isArray(v.choices) || v.choices.length!==1 || !object(v.choices[0]) || !object(v.choices[0].message))
    throw new StreamProtocolError('Missing provider chat completion structure; its reservation remains charged.');
  const choice=v.choices[0], message=choice.message as Record<string,unknown>;
  if (choice.index!==undefined && choice.index!==0) throw new StreamProtocolError('Invalid provider chat choice index; its reservation remains charged.');
  assertTerminalReason(choice.finish_reason,'chat');
  if (!optionalText(message.content) || !optionalText(message.reasoning_content) || message.role!=='assistant' ||
      message.tool_calls!==undefined && (!Array.isArray(message.tool_calls) || !message.tool_calls.every(tool=>object(tool) && tool.type==='function' && typeof tool.id==='string' && !!tool.id && object(tool.function) && typeof tool.function.name==='string' && !!tool.function.name && typeof tool.function.arguments==='string')))
    throw new StreamProtocolError('Invalid provider chat completion message; its reservation remains charged.');
  assertUniqueToolIds(((message.tool_calls ?? []) as {id: string}[]).map(tool => tool.id));
  for (const tool of (message.tool_calls ?? []) as {function:{arguments:string}}[]) {
    let parsed: unknown;
    try { parsed=JSON.parse(tool.function.arguments); }
    catch { if (choice.finish_reason==='length') continue; throw new StreamProtocolError('Malformed provider tool arguments; its reservation remains charged.'); }
    assertToolArgumentObject(parsed);
  }
  if(v.usage!=null)assertUsagePair(v.usage,'prompt_tokens','completion_tokens');
}
export function assertResponsesTerminalResponse(v: unknown, expectedStatus?: string): void {
  if (!object(v) || !['completed','incomplete','failed'].includes(String(v.status)) || expectedStatus && v.status!==expectedStatus || !Array.isArray(v.output) ||
      !v.output.every(item=>object(item) && typeof item.type==='string' &&
        (item.type!=='function_call' || validResponseItemStatus(item,v.status) && typeof item.call_id==='string' && !!item.call_id && typeof item.name==='string' && !!item.name && (typeof item.arguments==='string' || object(item.arguments))) &&
        (item.type!=='message' || validResponseItemStatus(item,v.status) && item.role==='assistant' && Array.isArray(item.content) && item.content.every(block=>object(block) && typeof block.type==='string' &&
          (block.type!=='output_text' || typeof block.text==='string') && (block.type!=='refusal' || typeof block.refusal==='string')))))
    throw new StreamProtocolError('Invalid or incomplete Responses completion; its reservation remains charged.');
  assertUniqueToolIds(v.output.filter(item => item.type === 'function_call').map(item => item.call_id));
  if (v.status !== 'completed') for (const item of v.output) {
    if (item.type === 'function_call' && typeof item.arguments === 'string') parseCapturedToolArguments(item.arguments, true);
  }
  if(v.usage!=null)assertUsagePair(v.usage,'input_tokens','output_tokens');
}
export function assertAnthropicInputUsage(v: unknown): number {
  if(!object(v) || !count(v.input_tokens) || [v.cache_creation_input_tokens,v.cache_read_input_tokens].some(value=>value!=null&&!count(value)))
    throw new StreamProtocolError('Invalid Anthropic input usage; its reservation remains charged.');
  const total=(v.input_tokens as number)+(typeof v.cache_creation_input_tokens==='number'?v.cache_creation_input_tokens:0)+(typeof v.cache_read_input_tokens==='number'?v.cache_read_input_tokens:0);
  if(!count(total))throw new StreamProtocolError('Invalid Anthropic aggregate usage; its reservation remains charged.');
  return total;
}
export function assertAnthropicTerminalResponse(v: unknown): void {
  if(!object(v) || v.role!=='assistant' || !Array.isArray(v.content) || !v.content.every(block=>object(block) && typeof block.type==='string' &&
      (block.type!=='text' || typeof block.text==='string') &&
      (block.type!=='tool_use' || typeof block.id==='string' && !!block.id && typeof block.name==='string' && !!block.name && object(block.input))))
    throw new StreamProtocolError('Invalid Anthropic completion content; its reservation remains charged.');
  assertUniqueToolIds(v.content.filter(block => block.type === 'tool_use').map(block => block.id));
  assertTerminalReason(v.stop_reason,'anthropic');
  if(v.usage!=null){assertUsagePair(v.usage,'input_tokens','output_tokens');assertAnthropicInputUsage(v.usage);}
}
export function assertGoogleChunk(v: unknown, reasons: ReadonlySet<string>, previous?: {inputTokens:number;candidateTokens:number;thoughtTokens:number}, requireTerminal=false): void {
  if(!object(v) || v.candidates!==undefined && (!Array.isArray(v.candidates) || !v.candidates.every(candidate=>object(candidate) && (candidate.index===undefined || candidate.index===0) &&
      (candidate.finishReason==null || typeof candidate.finishReason==='string' && reasons.has(candidate.finishReason)) &&
      (candidate.content===undefined || object(candidate.content) && (candidate.content.role===undefined || candidate.content.role==='model') && Array.isArray(candidate.content.parts) && candidate.content.parts.every(part=>object(part) &&
        (part.text===undefined || typeof part.text==='string') &&
        (part.functionCall===undefined || object(part.functionCall) && typeof part.functionCall.name==='string' && !!part.functionCall.name && (part.functionCall.args===undefined || object(part.functionCall.args))))))))
    throw new StreamProtocolError('Invalid Google completion fields; its reservation remains charged.');
  if(requireTerminal && (!Array.isArray(v.candidates) || !v.candidates.some(candidate=>object(candidate) && typeof candidate.finishReason==='string' && candidate.finishReason!=='FINISH_REASON_UNSPECIFIED')))
    throw new StreamProtocolError('Missing Google completion reason; its reservation remains charged.');
  if(v.usageMetadata!==undefined){
    const usage=v.usageMetadata;
    if(!object(usage) || ['promptTokenCount','candidatesTokenCount','thoughtsTokenCount'].some(key=>usage[key]!==undefined&&!count(usage[key])) || previous &&
      (typeof usage.promptTokenCount==='number' && usage.promptTokenCount<previous.inputTokens ||
       typeof usage.candidatesTokenCount==='number' && usage.candidatesTokenCount<previous.candidateTokens ||
       typeof usage.thoughtsTokenCount==='number' && usage.thoughtsTokenCount<previous.thoughtTokens))
      throw new StreamProtocolError('Invalid or regressed Google usage; its reservation remains charged.');
  }
}

export function assertToolArgumentObject(value: unknown): asserts value is Record<string, unknown> {
  if (!object(value)) throw new StreamProtocolError("Invalid provider tool argument object; its reservation remains charged.");
}

/** Validate reasoning wire structure without changing opaque text, signatures or redacted bytes. */
export function assertBedrockReasoning(value: unknown, delta: boolean): void {
  const keys=delta?['text','signature','redactedContent']:['reasoningText','redactedContent'];
  if (!object(value) || Object.keys(value).length!==1 || !keys.some(key=>Object.hasOwn(value,key)))
    throw new StreamProtocolError('Invalid Bedrock reasoning fields; its reservation remains charged.');
  const valid=Object.hasOwn(value,'redactedContent')
    ? typeof value.redactedContent==='string' && Buffer.from(value.redactedContent,'base64').toString('base64')===value.redactedContent
    : delta ? typeof (value.text ?? value.signature)==='string'
    : object(value.reasoningText) && typeof value.reasoningText.text==='string' && (value.reasoningText.signature===undefined || typeof value.reasoningText.signature==='string');
  if (!valid) throw new StreamProtocolError('Invalid Bedrock reasoning fields; its reservation remains charged.');
}


/** A streamed tool slot cannot acquire another identity after its argument prefix. */
export function assertChatToolIdentity(
  index: number,
  delta: { id?: string; function?: { name?: string } },
  slots: Record<number, { id: string; name: string }>,
): void {
  const current=slots[index], id=delta.id, name=delta.function?.name;
  if (current && (id && current.id && id!==current.id || name && current.name && name!==current.name) ||
      id && Object.entries(slots).some(([key,slot])=>Number(key)!==index && slot.id===id))
    throw new StreamProtocolError('Provider chat tool identity changed or was reused; its reservation remains charged.');
}

/** Reject ambiguous tool effects before the host retains a completed response. */
export function assertResponseToolIdentities(response: LLMResponse): void {
  const seen = new Set<string>();
  for (const tool of response.toolCalls ?? []) {
    if (typeof tool.id !== 'string' || !tool.id || seen.has(tool.id) || typeof tool.name !== 'string' || !tool.name)
      throw new StreamProtocolError('Invalid or duplicate provider tool identity; its reservation remains charged.');
    seen.add(tool.id);
  }
}


/** Output limits tolerate incomplete JSON, never a complete non-object root. */
export function parseCapturedToolArguments(input: string, truncated: boolean): Record<string, unknown> | undefined {
  let value: unknown;
  try { value = JSON.parse(input); }
  catch (error) {
    if (truncated && error instanceof SyntaxError) return undefined;
    throw new StreamProtocolError('Malformed provider tool arguments; its reservation remains charged.');
  }
  assertToolArgumentObject(value);
  return value;
}
