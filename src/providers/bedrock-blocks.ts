import { StreamProtocolError } from '../errors.js';
import type { ToolCall } from '../types.js';
import { assertBedrockReasoning, parseCapturedToolArguments } from './stream-validation.js';

interface Block {
  kind: 'text' | 'tool' | 'reasoning';
  closed: boolean;
  id?: string;
  name?: string;
  input?: string;
  text?: string;
  signature?: string;
  redacted?: Buffer[];
}

const invalid = (): never => {
  throw new StreamProtocolError('Bedrock stream has inconsistent content blocks; its reservation remains charged.');
};

/** Indexed wire assembly only; no execution, checkpoint or accounting authority. */
export class BedrockBlocks {
  private readonly blocks = new Map<number, Block>();

  private index(value: unknown): number {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) invalid();
    return value as number;
  }

  private active(index: unknown, kind: Block['kind'], implicit = false): Block {
    const key = this.index(index);
    let block = this.blocks.get(key);
    if (!block) {
      if (!implicit) invalid();
      block = { kind, closed: false };
      this.blocks.set(key, block);
    }
    if (block.closed || block.kind !== kind) invalid();
    return block;
  }

  startTool(index: unknown, id: unknown, name: unknown): void {
    const key = this.index(index);
    if (this.blocks.has(key) || typeof id !== 'string' || !id || typeof name !== 'string' || !name ||
        [...this.blocks.values()].some(block => block.id === id)) invalid();
    this.blocks.set(key, { kind: 'tool', closed: false, id: id as string, name: name as string, input: '' });
  }

  toolDelta(index: unknown, input: unknown): void {
    if (typeof input !== 'string') invalid();
    const block = this.active(index, 'tool');
    block.input! += input as string;
  }

  textDelta(index: unknown): void {
    this.active(index, 'text', true);
  }

  reasoningDelta(index: unknown, fragment: unknown): void {
    assertBedrockReasoning(fragment, true);
    const value = fragment as Record<string, string>;
    const block = this.active(index, 'reasoning', true);
    if (value.redactedContent !== undefined) {
      if (block.text !== undefined || block.signature !== undefined) invalid();
      (block.redacted ??= []).push(Buffer.from(value.redactedContent, 'base64'));
    } else {
      if (block.redacted) invalid();
      block.text ??= '';
      if (value.text !== undefined) block.text += value.text;
      if (value.signature !== undefined) block.signature = (block.signature ?? '') + value.signature;
    }
  }

  stop(index: unknown): void {
    const block = this.blocks.get(this.index(index));
    if (!block || block.closed) invalid();
    block!.closed = true;
  }

  result(reason: 'stop' | 'tool_use' | 'length' | 'error'): {
    toolCalls: ToolCall[];
    truncatedToolCalls: boolean;
    reasoningContent: Record<string, unknown>[];
  } {
    const toolCalls: ToolCall[] = [], reasoningContent: Record<string, unknown>[] = [];
    let truncatedToolCalls = false;
    for (const [, block] of [...this.blocks].sort(([a], [b]) => a - b)) {
      if (block.kind === 'tool') {
        const args = parseCapturedToolArguments(block.input!, reason === 'length');
        if (!block.closed) {
          if (reason !== 'length') invalid();
          truncatedToolCalls = true;
          continue;
        }
        if (args === undefined) { truncatedToolCalls = true; continue; }
        toolCalls.push({ id: block.id!, name: block.name!, arguments: args });
      } else {
        if (!block.closed) invalid();
        if (block.kind === 'reasoning') {
          if (block.redacted) reasoningContent.push({ redactedContent: Buffer.concat(block.redacted).toString('base64') });
          else reasoningContent.push({ reasoningText: {
            text: block.text!,
            ...(block.signature === undefined ? {} : { signature: block.signature }),
          } });
        }
      }
    }
    return { toolCalls, truncatedToolCalls, reasoningContent };
  }
}
