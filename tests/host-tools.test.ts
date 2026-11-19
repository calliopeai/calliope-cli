import { describe, expect, it, vi } from 'vitest';
import { bindHostToolRuntime, HOST_TOOL_RUNTIME_PROTOCOL_VERSION, type HostToolRuntime } from '../src/runtime/host-tools.js';

const tool = { name: 'workspace_read', description: 'Read the isolated workspace', parameters: { type: 'object' as const, properties: {} } };
const call = { id: 'original', name: tool.name, arguments: {} };
const runtime = (patch: Record<string, unknown> = {}) => ({ version: 1, tools: [tool],
  execute: vi.fn(async () => ({ toolCallId: call.id, result: 'confirmed', displayResult: 'display', isError: false })), ...patch }) as HostToolRuntime;

describe('host tool protocol', () => {
  it('requires an explicit SDK capability and snapshots definitions and results', async () => {
    expect(HOST_TOOL_RUNTIME_PROTOCOL_VERSION).toBe(1);
    expect(bindHostToolRuntime(undefined)).toBeUndefined();
    const source = runtime(), bound = bindHostToolRuntime(source)!;
    bound.tools()[0]!.name = 'changed'; expect(bound.tools()).toEqual([tool]);
    expect(bound.denial(call)).toBeUndefined(); expect(bound.denial({ ...call, name: 'shell' })).toContain('outside');
    const onOutput = vi.fn();
    expect(await bound.execute(call, { timeoutMs: 100, onOutput })).toMatchObject({ result: 'confirmed', displayResult: 'display', isError: false });
    expect(source.execute).toHaveBeenCalledWith(call, { timeoutMs: 100, onOutput });
    await expect(bound.execute({ ...call, name: 'shell' }, { timeoutMs: 100, onOutput })).rejects.toThrow('no local fallback');
    expect(source.execute).toHaveBeenCalledTimes(1);
  });

  it.each([null, runtime({ version: 2 }), runtime({ tools: {} }), runtime({ tools: Array(257).fill(tool) }),
    runtime({ execute: false }), runtime({ tools: [tool, tool] }), runtime({ tools: [null] }),
    runtime({ tools: [{ ...tool, name: 'invalid name' }] }), runtime({ tools: [{ ...tool, name: 2 }] }),
    runtime({ tools: [{ ...tool, description: '' }] }), runtime({ tools: [{ ...tool, description: null }] }),
    runtime({ tools: [{ ...tool, description: 'x'.repeat(16385) }] }),
    runtime({ tools: [{ ...tool, parameters: undefined }] }), runtime({ tools: [{ ...tool, parameters: { type: 'array' } }] }),
    runtime({ tools: [{ ...tool, parameters: { type: 'object', properties: [] } }] }),
    runtime({ tools: [{ ...tool, parameters: { type: 'object', properties: 2 } }] }),
    runtime({ tools: [{ ...tool, parameters: { type: 'object' } }] }),
    runtime({ tools: [{ ...tool, extra: () => {} }] }),
  ])('rejects a malformed host before any execution (%#)', value => {
    expect(() => bindHostToolRuntime(value as HostToolRuntime)).toThrow('unavailable or uncertain');
  });

  it.each([null, false, { toolCallId: 'other', result: 'ok' }, { toolCallId: call.id, result: 5 },
    { toolCallId: call.id, result: 'ok', isError: 1 }, { toolCallId: call.id, result: 'ok', displayResult: false },
    { toolCallId: call.id, result: 'ok', extra: 'unrecognized' },
  ])('rejects an uncorrelated or malformed transport result (%#)', async result => {
    const execute = vi.fn(async () => result);
    const bound = bindHostToolRuntime(runtime({ execute }))!;
    await expect(bound.execute(call, { timeoutMs: 100, onOutput: vi.fn() })).rejects.toThrow('unavailable or uncertain');
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('refuses already-cancelled execution without reaching the host', async () => {
    const source = runtime(), bound = bindHostToolRuntime(source)!;
    await expect(bound.execute(call, { timeoutMs: 100, signal: AbortSignal.abort(), onOutput: vi.fn() })).rejects.toThrow();
    expect(source.execute).not.toHaveBeenCalled();
  });
});


it('retains v1 host uncertainty and refuses later transport calls', async () => {
  const source = runtime({ execute: vi.fn(async () => { throw new Error('Transport reply lost'); }) });
  const bound = bindHostToolRuntime(source)!;
  await expect(bound.execute(call, { timeoutMs: 100, onOutput: vi.fn() })).rejects.toThrow('uncertain');
  expect(bound.denial(call)).toContain('uncertain');
  await expect(bound.execute(call, { timeoutMs: 100, onOutput: vi.fn() })).rejects.toThrow('uncertain');
  expect(source.execute).toHaveBeenCalledTimes(1);
});
