/**
 * Regression tests for the session-state cluster.
 *
 * Covers issue #152: autoCompress must not emit a message array with an
 * orphaned tool_use/tool_result across the keep boundary (would 400 on the
 * next provider call). Issues #151 (auto-checkpoint) and #153 (idle-eviction)
 * are covered in tests/auto-checkpoint.test.ts and tests/idle-eviction.test.ts.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { autoCompress, configureAutoCompressor, resetAutoCompressorState } from '../src/auto-compressor.js';
import { validateMessageHistory } from '../src/summarization.js';
import type { Message as LLMMessage, LLMProvider } from '../src/types.js';

// Provider is never actually called when useLlm is false (heuristic path),
// but the import graph still resolves it, so mock it to a no-op.
vi.mock('../src/providers/index.js', () => ({
  chat: vi.fn(),
  selectProvider: vi.fn((p: string) => p),
  getAvailableProviders: vi.fn(() => []),
}));

const provider = 'anthropic' as unknown as LLMProvider;

// Filler text large enough to push the conversation past the trigger threshold.
const filler = 'lorem ipsum dolor sit amet '.repeat(40);

function fillerPair(i: number): LLMMessage[] {
  return [
    { role: 'user', content: `request ${i}: ${filler}` },
    { role: 'assistant', content: `reply ${i}: ${filler}` },
  ];
}

describe('autoCompress tool-pairing at keep boundary (#152)', () => {
  beforeEach(() => {
    configureAutoCompressor({
      enabled: true,
      triggerThreshold: 50,
      targetThreshold: 25,
      preserveRecent: 2,
      useLlm: false, // force heuristic summary, no provider call
      compressionModel: undefined,
    });
    resetAutoCompressorState();
    vi.clearAllMocks();
  });

  it('does not orphan a tool_use/tool_result pair straddling the boundary', async () => {
    // 8 filler messages, then an assistant tool_use immediately followed by its
    // tool_result. With preserveRecent=2, the raw positional cut keeps the last
    // two messages — the tool_use and its result are the last two, so the cut
    // would land right before the tool_use (safe here) OR, by adding one more
    // trailing message, we force the result into the kept tail without its use.
    const messages: LLMMessage[] = [
      ...fillerPair(0),
      ...fillerPair(1),
      ...fillerPair(2),
      ...fillerPair(3), // 8 messages so far
      {
        role: 'assistant',
        content: `running a tool ${filler}`,
        toolCalls: [{ id: 'call_1', name: 'read_file', arguments: { path: '/x' } }],
      },
      { role: 'tool', toolCallId: 'call_1', content: `tool output ${filler}` },
      { role: 'user', content: `follow-up ${filler}` },
    ];
    // preserveRecent=2 keeps [tool_result, follow-up user] — the tool_result's
    // assistant tool_use (index 8) lands in toSummarize => orphaned result.

    const result = await autoCompress(messages, 4000, provider);

    expect(result.compressed).toBe(true);

    // The compressed output must already be free of orphaned tool blocks:
    // validating it again is a no-op.
    expect(validateMessageHistory(result.messages)).toEqual(result.messages);

    // Concretely, no role:'tool' message survives without its tool_use.
    const toolIds = new Set(
      result.messages.flatMap(m =>
        m.role === 'assistant' && m.toolCalls ? m.toolCalls.map(t => t.id) : [],
      ),
    );
    for (const m of result.messages) {
      if (m.role === 'tool') {
        expect(toolIds.has(m.toolCallId as string)).toBe(true);
      }
    }
  });

  it('keeps a complete tool_use/result pair intact when both fall in the kept tail', async () => {
    // Happy path: the pair is fully inside the preserved window, so nothing is
    // stripped and the pairing survives compression.
    const messages: LLMMessage[] = [
      ...fillerPair(0),
      ...fillerPair(1),
      ...fillerPair(2),
      ...fillerPair(3),
      ...fillerPair(4), // 10 filler messages
      {
        role: 'assistant',
        content: `running a tool ${filler}`,
        toolCalls: [{ id: 'call_keep', name: 'read_file', arguments: { path: '/y' } }],
      },
      { role: 'tool', toolCallId: 'call_keep', content: `tool output ${filler}` },
    ];

    // preserveRecent=2 keeps exactly [assistant tool_use, tool_result].
    const result = await autoCompress(messages, 4000, provider);

    expect(result.compressed).toBe(true);
    expect(validateMessageHistory(result.messages)).toEqual(result.messages);

    // The pair is preserved: both the tool_use and its result are present.
    const hasUse = result.messages.some(
      m => m.role === 'assistant' && m.toolCalls?.some(t => t.id === 'call_keep'),
    );
    const hasResult = result.messages.some(
      m => m.role === 'tool' && m.toolCallId === 'call_keep',
    );
    expect(hasUse).toBe(true);
    expect(hasResult).toBe(true);
  });
});
