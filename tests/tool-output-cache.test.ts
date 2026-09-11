import { expect, it } from 'vitest';
import { makeToolOutput, MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_CHARS, MAX_TOOL_OUTPUTS } from '../src/sessions/index.js';
import { ToolOutputCache } from '../src/ui/tool-output-cache.js';
import { wrapToolOutput } from '../src/ui/tool-output-wrap.js';
import { handleToolOutputCommand } from '../src/ui/tool-output-commands.js';
import type { CommandContext } from '../src/ui/commands.js';
import stringWidth from 'string-width';
it('bounds fallback output by count and bytes, avoids saved copies, and isolates sessions', () => {
  const cache = new ToolOutputCache(), record = makeToolOutput('call', 'read_file', 'small', false);
  cache.remember({ record, saved: true }, 'a'); expect(cache.read('a')).toEqual([]);
  cache.remember({ record, saved: false }, 'a'); cache.remember({ record, saved: false }, 'a'); expect(cache.read('a')).toHaveLength(1);
  for (let i = 0; i < MAX_TOOL_OUTPUTS; i++) cache.remember({ record: makeToolOutput('call', 'read_file', String(i), false), saved: false }, 'a');
  expect(cache.read('a')).toHaveLength(MAX_TOOL_OUTPUTS); expect(cache.read('a')[0]!.record.content).toBe('0');
  for (let i = 0; i < MAX_TOOL_OUTPUTS; i++) cache.remember({ record: makeToolOutput('call', 'read_file', '漢'.repeat(MAX_TOOL_OUTPUT_CHARS), false), saved: false }, 'a');
  expect(cache.read('a').length).toBeLessThan(MAX_TOOL_OUTPUTS);
  expect(cache.read('a').reduce((sum, value) => sum + Buffer.byteLength(JSON.stringify(value)), 0)).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES);
  expect(cache.read('b')).toEqual([]); cache.remember({ record, saved: false }, 'b'); cache.clear(); expect(cache.read('b')).toEqual([]);
});
it('wraps wide Unicode and combining graphemes to terminal columns and preserves line breaks', () => {
  const source = '漢字👩🏽‍💻e\u0301\tend\n\nlast', rows = wrapToolOutput(source, 4);
  expect(rows.join('')).toBe(source.replace(/\t/g, '    ').replace(/\n/g, ''));
  expect(rows.some(row => row.includes('👩🏽‍💻'))).toBe(true); expect(rows.some(row => row.includes('e\u0301'))).toBe(true);
  expect(rows).toContain(''); for (const row of rows) expect(stringWidth(row)).toBeLessThanOrEqual(4);
  expect(() => wrapToolOutput(source, NaN)).toThrow(/Invalid/);
});
it('inspects fallback output and provides useful errors for expired IDs or unsupported clients', () => {
  const output = { record: makeToolOutput('call', 'shell', 'TOKEN=opaque-secret', true), saved: false };
  const messages: string[] = [], opened: unknown[] = [];
  const ctx = { sessionRef: { current: null }, toolOutputs: () => [output], addMessage: (_: string, text: string) => messages.push(text), showToolOutput: (value: unknown) => opened.push(value) } as unknown as CommandContext;
  handleToolOutputCommand(['/tools'], ctx); expect(messages[0]).toContain('transcript only'); expect(messages[0]).not.toContain('opaque-secret');
  handleToolOutputCommand(['/tools', 'last'], ctx); expect(opened).toEqual([output]);
  expect(() => handleToolOutputCommand(['/tools', 'missing'], ctx)).toThrow(/expired/);
  expect(() => handleToolOutputCommand(['/tools', 'last', 'extra'], ctx)).toThrow(/Usage/);
  expect(() => handleToolOutputCommand(['/tools', 'last'], { ...ctx, showToolOutput: undefined })).toThrow(/viewer is unavailable/);
  handleToolOutputCommand(['/tools'], { ...ctx, toolOutputs: () => [] }); expect(messages.at(-1)).toContain('No retained');
});
