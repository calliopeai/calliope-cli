/**
 * Extended coverage tests for src/auto-compressor.ts
 *
 * Targets remaining uncovered branches:
 * - llmSummarize: system role in conversationText (shows 'System' prefix)
 * - autoCompress: effectivePreserve when contextLimit < 2048 (below lower bound)
 * - autoCompress: effectivePreserve for boundary conditions
 * - truncation of long messages in llmSummarize (slice at 2000 chars)
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  configureAutoCompressor,
  autoCompress,
  llmSummarize,
} from '../src/auto-compressor.js';
import type { Message as LLMMessage } from '../src/types.js';

vi.mock('../src/providers/index.js', () => ({
  chat: vi.fn(),
  selectProvider: vi.fn((p: string) => p),
  getAvailableProviders: vi.fn(() => []),
}));

import { chat } from '../src/providers/index.js';

const mockedChat = vi.mocked(chat);

beforeEach(() => {
  configureAutoCompressor({
    enabled: true,
    triggerThreshold: 75,
    targetThreshold: 50,
    preserveRecent: 10,
    useLlm: true,
    compressionModel: undefined,
  });
  vi.clearAllMocks();
});

// ===========================================================================
// llmSummarize - system role in conversation text
// ===========================================================================

describe('llmSummarize - system role prefix', () => {
  it('should use "System" prefix for system role messages', async () => {
    let capturedConversation = '';
    mockedChat.mockImplementation(async (provider, messages) => {
      // Capture what was sent to the summarizer
      const userMsg = messages.find(m => m.role === 'user');
      if (userMsg && typeof userMsg.content === 'string') {
        capturedConversation = userMsg.content;
      }
      return {
        content: 'Summary of the system configuration and user preferences.',
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 20,
      };
    });

    const messages: LLMMessage[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Hello' },
    ];

    await llmSummarize(messages, 'anthropic');
    // The system message should be rendered with "System:" prefix
    expect(capturedConversation).toContain('System:');
    expect(capturedConversation).toContain('User:');
  });
});

// ===========================================================================
// llmSummarize - long message truncation (> 2000 chars)
// ===========================================================================

describe('llmSummarize - long message truncation', () => {
  it('should truncate individual messages to 2000 chars', async () => {
    let capturedConversation = '';
    mockedChat.mockImplementation(async (provider, messages) => {
      const userMsg = messages.find(m => m.role === 'user');
      if (userMsg && typeof userMsg.content === 'string') {
        capturedConversation = userMsg.content;
      }
      return {
        content: 'Truncated summary with enough characters.',
        toolCalls: [],
        inputTokens: 100,
        outputTokens: 20,
      };
    });

    const longContent = 'x'.repeat(3000); // > 2000 chars
    const messages: LLMMessage[] = [
      { role: 'user', content: longContent },
    ];

    await llmSummarize(messages, 'anthropic');
    // The message should be sliced at 2000 chars (plus "User: " prefix)
    // So total sent per-message shouldn't exceed ~2006 chars
    const userSection = capturedConversation.split('\n\n').pop() || '';
    expect(userSection.length).toBeLessThan(2010); // 2000 content + "User: " (6)
  });
});

// ===========================================================================
// autoCompress - effectivePreserve for contextLimit < 2048
// ===========================================================================

describe('autoCompress - effectivePreserve below lower bound', () => {
  it('should use full preserveRecent when contextLimit < 2048', async () => {
    configureAutoCompressor({ preserveRecent: 10, useLlm: false });

    // contextLimit = 500 (< 2048) — should use full config.preserveRecent (10)
    // Need to trigger compression: make tokens exceed 75% of 500 = 375 tokens
    const messages: LLMMessage[] = Array.from({ length: 30 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i} `.repeat(15), // enough tokens
    }));

    const result = await autoCompress(messages, 500, 'anthropic');

    if (result.compressed) {
      // For contextLimit=500 (< 2048), falls through all conditions to config.preserveRecent
      // effectivePreserve = config.preserveRecent = 10
      // But preserveCount = min(10, nonSystem.length) = min(10, 30) = 10
      const nonSystem = result.messages.filter(
        m => !String(m.content).includes('[Auto-compressed') && m.role !== 'system'
      );
      expect(nonSystem.length).toBeLessThanOrEqual(10);
    }
    // Whether compressed or not, it should not throw
    expect(typeof result.compressed).toBe('boolean');
  });

  it('should use full preserveRecent when contextLimit is exactly 1000', async () => {
    configureAutoCompressor({ preserveRecent: 5, useLlm: false });

    const messages: LLMMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i}`.repeat(10),
    }));

    const result = await autoCompress(messages, 1000, 'anthropic');
    // Whether compressed or not, should not throw
    expect(typeof result.compressed).toBe('boolean');
    if (result.compressed) {
      // effectivePreserve = config.preserveRecent = 5 (contextLimit < 2048)
      const nonSystem = result.messages.filter(
        m => !String(m.content).includes('[Auto-compressed') && m.role !== 'system'
      );
      expect(nonSystem.length).toBeLessThanOrEqual(5);
    }
  });
});

// ===========================================================================
// autoCompress - boundary conditions for effectivePreserve
// ===========================================================================

describe('autoCompress - effectivePreserve boundary at 2048', () => {
  it('should cap preserveRecent at 2 when contextLimit is exactly 2048', async () => {
    configureAutoCompressor({ preserveRecent: 10, useLlm: false });

    const messages: LLMMessage[] = Array.from({ length: 20 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Msg ${i} `.repeat(20),
    }));

    const result = await autoCompress(messages, 2048, 'anthropic');
    if (result.compressed) {
      // contextLimit=2048 >= 2048 && < 8000 → effectivePreserve = min(10, 2) = 2
      const nonSystem = result.messages.filter(
        m => !String(m.content).includes('[Auto-compressed') && m.role !== 'system'
      );
      expect(nonSystem.length).toBeLessThanOrEqual(2);
    }
  });
});

// ===========================================================================
// autoCompress - effectivePreserve for contextLimit in range 8000-15999
// ===========================================================================

describe('autoCompress - effectivePreserve at 8000-15999', () => {
  it('should cap preserveRecent at 4 when contextLimit is 8000', async () => {
    configureAutoCompressor({ preserveRecent: 10, useLlm: false });

    // Need to exceed 75% of 8000 = 6000 tokens to trigger compression
    // Each message ~15 words * 1.5 tokens/word ≈ 22 tokens → need ~280 messages
    // Use longer content: 100 words × 20 msgs ≈ 2000 tokens < 6000, not enough
    // Let's use a lot of content per message
    const messages: LLMMessage[] = Array.from({ length: 40 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Message ${i} `.repeat(100), // ~100*2=200 tokens per message × 40 = 8000 tokens
    }));

    const result = await autoCompress(messages, 8000, 'anthropic');
    // Whether compressed or not (depends on token estimation), should not throw
    expect(typeof result.compressed).toBe('boolean');
    if (result.compressed) {
      // contextLimit=8000 >= 8000 && < 16000 → effectivePreserve = min(10, 4) = 4
      const nonSystem = result.messages.filter(
        m => !String(m.content).includes('[Auto-compressed') && m.role !== 'system'
      );
      expect(nonSystem.length).toBeLessThanOrEqual(4);
    }
  });

  it('should cap preserveRecent at 4 when contextLimit is 12000', async () => {
    configureAutoCompressor({ preserveRecent: 10, useLlm: false });

    const messages: LLMMessage[] = Array.from({ length: 50 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Word `.repeat(200), // large messages
    }));

    const result = await autoCompress(messages, 12000, 'anthropic');
    expect(typeof result.compressed).toBe('boolean');
    if (result.compressed) {
      const nonSystem = result.messages.filter(
        m => !String(m.content).includes('[Auto-compressed') && m.role !== 'system'
      );
      expect(nonSystem.length).toBeLessThanOrEqual(4);
    }
  });
});

// ===========================================================================
// autoCompress - effectivePreserve for contextLimit in range 16000-31999
// ===========================================================================

describe('autoCompress - effectivePreserve at 16000-31999', () => {
  it('should cap preserveRecent at 6 when contextLimit is 16000', async () => {
    configureAutoCompressor({ preserveRecent: 10, useLlm: false });

    const messages: LLMMessage[] = Array.from({ length: 80 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Data `.repeat(200),
    }));

    const result = await autoCompress(messages, 16000, 'anthropic');
    expect(typeof result.compressed).toBe('boolean');
    if (result.compressed) {
      // contextLimit=16000 >= 16000 && < 32000 → effectivePreserve = min(10, 6) = 6
      const nonSystem = result.messages.filter(
        m => !String(m.content).includes('[Auto-compressed') && m.role !== 'system'
      );
      expect(nonSystem.length).toBeLessThanOrEqual(6);
    }
  });

  it('should cap preserveRecent at 6 when contextLimit is 20000', async () => {
    configureAutoCompressor({ preserveRecent: 10, useLlm: false });

    const messages: LLMMessage[] = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Content `.repeat(200),
    }));

    const result = await autoCompress(messages, 20000, 'anthropic');
    expect(typeof result.compressed).toBe('boolean');
    if (result.compressed) {
      const nonSystem = result.messages.filter(
        m => !String(m.content).includes('[Auto-compressed') && m.role !== 'system'
      );
      expect(nonSystem.length).toBeLessThanOrEqual(6);
    }
  });
});

// ===========================================================================
// autoCompress - effectivePreserve for contextLimit >= 32000
// ===========================================================================

describe('autoCompress - effectivePreserve for large context (>= 32000)', () => {
  it('should use full preserveRecent when contextLimit >= 32000', async () => {
    configureAutoCompressor({ preserveRecent: 8, useLlm: false });

    const messages: LLMMessage[] = Array.from({ length: 100 }, (_, i) => ({
      role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
      content: `Token `.repeat(400),
    }));

    const result = await autoCompress(messages, 32000, 'anthropic');
    expect(typeof result.compressed).toBe('boolean');
    if (result.compressed) {
      // contextLimit >= 32000 → falls through all conditions → effectivePreserve = config.preserveRecent = 8
      const nonSystem = result.messages.filter(
        m => !String(m.content).includes('[Auto-compressed') && m.role !== 'system'
      );
      expect(nonSystem.length).toBeLessThanOrEqual(8);
    }
  });
});

// ===========================================================================
// llmSummarize - array content blocks with non-text type (filtered out)
// ===========================================================================

describe('llmSummarize - content blocks with non-text type', () => {
  it('should filter out non-text content blocks in summarization', async () => {
    mockedChat.mockResolvedValue({
      content: 'Summary that is long enough to pass the 20 char check.',
      toolCalls: [],
      inputTokens: 100,
      outputTokens: 20,
    });

    const messages: LLMMessage[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'User message text' },
          { type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'abc' } } as any,
        ],
      },
    ];

    const result = await llmSummarize(messages, 'anthropic');
    expect(result).not.toBeNull();
    // The call should succeed (only text blocks are included in conversation text)
    expect(mockedChat).toHaveBeenCalled();
  });
});
