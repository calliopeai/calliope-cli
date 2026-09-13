import type { ToolCall } from '../types.js';
import { throwIfCancelled } from '../cancellation.js';
import { BrainError } from './types.js';
import { hasBrainSecrets } from './access.js';
import { queryBrain } from './queries.js';
import { BRAIN_TOOL_GUIDANCE, type BrainToolContext } from './tools.js';

export const BRAIN_TOOL_RESULT_BYTES = 32 * 1024;
/** Local retrieval with no journal mutation, global scope or model-selected store path. */
export async function queryBrainTool(call: ToolCall, cwd: string, context: BrainToolContext, signal?: AbortSignal): Promise<string> {
  context.assertActive(signal);
  const args = call.arguments, search = call.name === 'brain_search';
  if (!['brain_search', 'brain_entity'].includes(call.name) || !args || typeof args !== 'object' || Array.isArray(args) ||
      Object.keys(args).some(key => !['query', ...(search ? ['limit'] : [])].includes(key)) ||
      typeof args.query !== 'string' || !args.query.trim() || Buffer.byteLength(args.query) > 1024 || /[\x00-\x1f\x7f]/.test(args.query) ||
      args.limit !== undefined && (!Number.isSafeInteger(args.limit) || Number(args.limit) < 1 || Number(args.limit) > 10) || hasBrainSecrets(args))
    throw new BrainError('invalid', 'Use a nonempty query of at most 1024 bytes and a search limit of 1–10; no store or scope overrides.');
  const options = {
    scope: 'project' as const, signal, runlog: context.runlog, mode: context.mode,
    authorizeSource: (source: Parameters<BrainToolContext['sourceDenial']>[0]) => {
      context.assertActive(signal);
      const reason = context.sourceDenial(source);
      context.runlog?.policyEvent({tool: call.name, toolCallId: call.id, decision: reason ? 'deny' : 'allow', source: 'scope',
        reason: reason ?? 'Retained knowledge source is within the reviewed agent read scope.', durationMs: 0});
      if (reason) throw new BrainError('policy-denied', reason);
    },
  };
  const value = await queryBrain(cwd, search ? 'search' : 'entity', {query: args.query, ...(search ? {limit: Number(args.limit ?? 5)} : {})}, options);
  // Preserve full source hashes; excerpts are bounded UTF-8 prefixes, explicitly labelled.
  const result = Array.isArray(value.sources) ? {...value, sources: value.sources.map(({content, ...source}) => {
    const bytes=Buffer.from(content),excerpt=new TextDecoder().decode(bytes.subarray(0,4096),{stream:true});
    return {...source,excerpt,excerptTruncated:bytes.length>4096,contentOmitted:true};
  })} : value;
  context.assertActive(signal); throwIfCancelled(signal);
  if (hasBrainSecrets(result)) throw new BrainError('policy-denied', 'Retrieved metadata contains secret material; review it privately.');
  const output = JSON.stringify({version: 1, type: 'project-knowledge', guidance: BRAIN_TOOL_GUIDANCE, ...result});
  if (Buffer.byteLength(output) > BRAIN_TOOL_RESULT_BYTES)
    throw new BrainError('limit', 'Knowledge result exceeds 32 KiB; narrow the query or reduce its result limit.');
  return output;
}
