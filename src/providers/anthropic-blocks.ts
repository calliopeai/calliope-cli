import type { ToolCall } from '../types.js';
import { StreamProtocolError } from '../errors.js';
import { assertToolArgumentObject, parseCapturedToolArguments } from './stream-validation.js';

const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
function invalid(): never { throw new StreamProtocolError('Invalid Anthropic block association; its reservation remains charged.'); }
interface Block { type: string; closed: boolean; text: string; id?: string; name?: string; initial?: Record<string, unknown>; partial?: string }

/** Capture only: indexed blocks cannot borrow identities, arguments or closure. */
export class AnthropicBlocks {
  private readonly blocks = new Map<number, Block>();
  private index(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
    return value;
  }
  private active(index: unknown): Block {
    const block = this.blocks.get(this.index(index));
    if (!block || block.closed) invalid();
    return block;
  }
  start(index: unknown, value: unknown): void {
    const key = this.index(index);
    if (this.blocks.has(key) || !object(value) || typeof value.type !== 'string') invalid();
    const block: Block = { type: value.type, closed: false, text: '' };
    if (value.type === 'tool_use') {
      if (typeof value.id !== 'string' || !value.id || typeof value.name !== 'string' || !value.name ||
          [...this.blocks.values()].some(saved => saved.id === value.id)) invalid();
      assertToolArgumentObject(value.input);
      block.id = value.id; block.name = value.name; block.initial = value.input;
    } else if (value.type === 'text') {
      if (typeof value.text !== 'string') invalid();
      block.text = value.text;
    }
    this.blocks.set(key, block);
  }
  delta(index: unknown, value: unknown): void {
    const block = this.active(index);
    if (!object(value)) invalid();
    if (value.type === 'input_json_delta' && block.type === 'tool_use' && typeof value.partial_json === 'string') {
      if (Object.keys(block.initial!).length) invalid();
      block.partial = (block.partial ?? '') + value.partial_json;
    } else if (value.type === 'text_delta' && block.type === 'text' && typeof value.text === 'string') block.text += value.text;
    else if (block.type === 'thinking' && (value.type === 'thinking_delta' && typeof value.thinking === 'string' ||
        value.type === 'signature_delta' && typeof value.signature === 'string')) return;
    else if (block.type === 'text' && value.type === 'citations_delta' && object(value.citation)) return;
    else invalid();
  }
  stop(index: unknown): void { this.active(index).closed = true; }
  result(reason: 'stop' | 'tool_use' | 'length' | 'error'): { content: string; toolCalls: ToolCall[]; truncatedToolCalls: boolean } {
    let content = '', truncatedToolCalls = false;
    const toolCalls: ToolCall[] = [];
    for (const [, block] of [...this.blocks].sort(([a], [b]) => a - b)) {
      if (block.type === 'tool_use' && reason === 'error' && block.partial !== undefined)
        parseCapturedToolArguments(block.partial, true);
      if (block.type === 'tool_use' && reason !== 'error') {
        const args = block.partial === undefined ? block.initial : parseCapturedToolArguments(block.partial, reason === 'length');
        if (!block.closed) {
          if (reason !== 'length') invalid();
          truncatedToolCalls = true;
          continue;
        }
        if (args === undefined) { truncatedToolCalls = true; continue; }
        assertToolArgumentObject(args);
        toolCalls.push({ id: block.id!, name: block.name!, arguments: args });
      } else {
        if (!block.closed) invalid();
        if (block.type === 'text') content += block.text;
      }
    }
    return { content, toolCalls, truncatedToolCalls };
  }
}
