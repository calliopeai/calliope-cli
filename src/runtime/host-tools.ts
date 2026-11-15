import type { Tool, ToolCall, ToolResult } from '../types.js';
import { throwIfCancelled } from '../cancellation.js';

export const HOST_TOOL_RUNTIME_PROTOCOL_VERSION = 1;

/** Trusted SDK configuration, never loaded from task text or project configuration.
 * The host owns workspace confinement and must settle execution when signal aborts.
 * A thrown error means execution is uncertain, so the original turn must stop.
 */
export interface HostToolRuntime {
  version: 1;
  tools: readonly Tool[];
  execute(call: ToolCall, context: {
    signal?: AbortSignal;
    timeoutMs: number;
    onOutput: (chunk: string) => void;
  }): Promise<ToolResult>;
}

export class HostToolRuntimeError extends Error {
  constructor() { super('Host tool execution is unavailable or uncertain; no local fallback or automatic retry was admitted.'); this.name = 'HostToolRuntimeError'; }
}

/** Snapshot trusted definitions and transport before any inference. */
export function bindHostToolRuntime(runtime: HostToolRuntime | undefined) {
  if (runtime === undefined) return undefined;
  let tools: Tool[], execute: HostToolRuntime['execute'];
  try {
    if (!runtime || runtime.version !== HOST_TOOL_RUNTIME_PROTOCOL_VERSION ||
        !Array.isArray(runtime.tools) || runtime.tools.length > 256 || typeof runtime.execute !== 'function') throw new HostToolRuntimeError();
    tools = structuredClone(runtime.tools) as Tool[];
    const names = new Set<string>();
    for (const tool of tools) {
      if (!tool || typeof tool.name !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(tool.name) || names.has(tool.name) ||
          typeof tool.description !== 'string' || !tool.description.trim() || tool.description.length > 16384 ||
          tool.parameters?.type !== 'object' || !tool.parameters.properties || typeof tool.parameters.properties !== 'object' || Array.isArray(tool.parameters.properties)) throw new HostToolRuntimeError();
      names.add(tool.name);
    }
    execute = runtime.execute.bind(runtime);
  } catch { throw new HostToolRuntimeError(); }
  const names = new Set(tools.map(tool => tool.name));
  return {
    tools: () => structuredClone(tools),
    denial: (call: ToolCall) => names.has(call.name) ? undefined : 'Tool is outside the declared host runtime.',
    async execute(call: ToolCall, context: Parameters<HostToolRuntime['execute']>[1]): Promise<ToolResult> {
      throwIfCancelled(context.signal);
      if (!names.has(call.name)) throw new HostToolRuntimeError();
      try {
        const result = await execute(structuredClone(call), context);
        throwIfCancelled(context.signal);
        if (!result || typeof result !== 'object' || result.toolCallId !== call.id ||
            typeof result.result !== 'string' || (result.isError !== undefined && typeof result.isError !== 'boolean') ||
            (result.displayResult !== undefined && typeof result.displayResult !== 'string') ||
            Object.keys(result).some(key => !['toolCallId', 'result', 'isError', 'displayResult'].includes(key))) throw new HostToolRuntimeError();
        return structuredClone(result);
      } catch {
        throwIfCancelled(context.signal);
        throw new HostToolRuntimeError();
      }
    },
  };
}
