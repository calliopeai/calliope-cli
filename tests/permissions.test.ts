import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolvePermission, type PermissionContext } from '../src/runtime/index.js';
import { executeTool } from '../src/tools.js';
import { scopeManager } from '../src/scope.js';
import * as hooks from '../src/hooks.js';
import * as policy from '../src/policy.js';
import * as sandbox from '../src/sandbox/index.js';
import type { ToolCall } from '../src/types.js';

vi.mock('../src/hooks.js', () => ({ checkHooksAllow: vi.fn(), executeHooks: vi.fn() }));
vi.mock('../src/policy.js', () => ({ isPolicyEnabled: vi.fn(), evaluatePolicy: vi.fn() }));
vi.mock('../src/sandbox/index.js', async importOriginal => ({
  ...await importOriginal<typeof import('../src/sandbox/index.js')>(),
  getSandboxMode: vi.fn(), isDockerAvailable: vi.fn(), isNativeSandboxAvailable: vi.fn(),
}));
let cwd: string;
let context: PermissionContext;
const read: ToolCall = { id: 'read', name: 'read_file', arguments: { path: 'file.txt' } };
const write: ToolCall = { id: 'write', name: 'write_file', arguments: { path: 'file.txt', content: 'new' } };
const shell: ToolCall = { id: 'shell', name: 'shell', arguments: { command: 'rm file.txt' } };
beforeEach(() => {
  cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-permissions-')));
  scopeManager.reset(cwd);
  context = { cwd, confirmation: 'none', audit: vi.fn() };
  vi.mocked(hooks.checkHooksAllow).mockReset().mockResolvedValue({ allowed: true });
  vi.mocked(policy.isPolicyEnabled).mockReset().mockReturnValue(false);
  vi.mocked(policy.evaluatePolicy).mockReset();
  vi.mocked(sandbox.getSandboxMode).mockReturnValue('off');
  vi.mocked(sandbox.isDockerAvailable).mockReturnValue(false);
  vi.mocked(sandbox.isNativeSandboxAvailable).mockReturnValue(false);
});
afterEach(() => fs.rmSync(cwd, { recursive: true, force: true }));

describe('canonical permission resolver', () => {
  it.each(['none', 'risk', 'mutating'] as const)('allows reads under %s and records the exact decision', async confirmation => {
    const result = await resolvePermission(read, { ...context, confirmation });
    expect(result).toMatchObject({ decision: 'allow', layer: 'default' });
    expect(context.audit).toHaveBeenCalledWith(expect.objectContaining({ tool: 'read_file', toolCallId: 'read', source: result.layer, reason: result.reason, decision: result.decision }));
  });
  it('keeps plan restrictions ahead of confirmation and hard hooks', async () => {
    const approve = vi.fn();
    const result = await resolvePermission(write, { ...context, mode: 'plan', confirmation: 'mutating', approve });
    expect(result).toMatchObject({ decision: 'deny', layer: 'mode', reason: expect.stringContaining('Plan mode') });
    expect(approve).not.toHaveBeenCalled();
    expect(hooks.checkHooksAllow).not.toHaveBeenCalled();
  });
  it('preserves the terminal risk toggle and ACP mutation approval defaults', async () => {
    expect((await resolvePermission(write, { ...context, confirmation: 'risk' })).decision).toBe('allow');
    expect((await resolvePermission(shell, { ...context, confirmation: 'risk' })).decision).toBe('confirm');
    expect((await resolvePermission(shell, context)).decision).toBe('allow');
    expect((await resolvePermission(write, { ...context, confirmation: 'mutating' })).decision).toBe('confirm');
  });
  it.each(['reject', 'cancelled'] as const)('stops at a %s permission reply', async answer => {
    const result = await resolvePermission(write, { ...context, confirmation: 'mutating', approve: async () => answer });
    expect(result).toMatchObject({ decision: answer === 'reject' ? 'deny' : 'cancelled', layer: 'confirmation' });
    expect(hooks.checkHooksAllow).not.toHaveBeenCalled();
  });
  it('an approval never overrides scope, hooks or policy', async () => {
    const approved = { ...context, confirmation: 'mutating' as const, approve: vi.fn(async () => 'allow' as const) };
    expect((await resolvePermission({ ...write, arguments: { ...write.arguments, path: '../outside.txt' } }, approved)).layer).toBe('scope');
    vi.mocked(hooks.checkHooksAllow).mockResolvedValueOnce({ allowed: false, reason: 'hook refuses' });
    expect((await resolvePermission(write, approved)).reason).toBe('[hook] Blocked by hook: hook refuses');
    vi.mocked(policy.isPolicyEnabled).mockReturnValue(true);
    vi.mocked(policy.evaluatePolicy).mockResolvedValue({ decision: 'deny', source: 'policy', reason: 'policy refuses', durationMs: 1 });
    expect((await resolvePermission(write, approved)).reason).toBe('[policy] Policy denied: policy refuses');
  });
  it.each(['native', 'docker'] as const)('fails closed when required %s containment is unavailable', async mode => {
    vi.mocked(sandbox.getSandboxMode).mockReturnValue(mode);
    expect(await resolvePermission(shell, context)).toMatchObject({ decision: 'deny', layer: 'sandbox' });
    expect(hooks.checkHooksAllow).not.toHaveBeenCalled();
  });
  it('identifies the advisory blocklist separately from containment', async () => {
    expect(await resolvePermission({ ...shell, arguments: { command: 'sudo whoami' } }, context)).toMatchObject({ decision: 'deny', layer: 'blocklist' });
  });
  it('records successful external policy decisions', async () => {
    vi.mocked(policy.isPolicyEnabled).mockReturnValue(true);
    vi.mocked(policy.evaluatePolicy).mockResolvedValue({ decision: 'allow', source: 'policy', durationMs: 2 });
    expect(await resolvePermission(read, context)).toMatchObject({ decision: 'allow', layer: 'policy' });
  });
  it('fails closed when a gate throws', async () => {
    vi.mocked(hooks.checkHooksAllow).mockRejectedValue(new Error('broken gate'));
    expect(await resolvePermission(read, context)).toMatchObject({ decision: 'deny', layer: 'resolver', reason: '[resolver] Permission check failed: broken gate' });
  });
  it('cancels a pending approval and ignores a late allow', async () => {
    const controller = new AbortController();
    let reply!: (answer: 'allow') => void;
    const run = resolvePermission(write, { ...context, confirmation: 'mutating', signal: controller.signal, approve: () => new Promise(resolve => { reply = resolve; }) });
    controller.abort();
    await expect(run).rejects.toMatchObject({ name: 'AbortError' });
    reply('allow');
    await Promise.resolve();
    expect(hooks.checkHooksAllow).not.toHaveBeenCalled();
    expect(context.audit).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'cancelled', source: 'cancellation' }));
  });
  it('rechecks changed filesystem boundaries at execution and audits the denial', async () => {
    expect((await resolvePermission(write, context)).decision).toBe('allow');
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-permission-outside-'));
    try {
      fs.symlinkSync(path.join(outside, 'file.txt'), path.join(cwd, 'file.txt'));
      const result = await executeTool(write, cwd, 1000, undefined, { auditPermission: context.audit });
      expect(result).toMatchObject({ isError: true, result: expect.stringContaining('[scope]') });
      expect(fs.existsSync(path.join(outside, 'file.txt'))).toBe(false);
      expect(context.audit).toHaveBeenLastCalledWith(expect.objectContaining({ decision: 'deny', source: 'scope', reason: result.result }));
    } finally { fs.rmSync(outside, { recursive: true, force: true }); }
  });
});
