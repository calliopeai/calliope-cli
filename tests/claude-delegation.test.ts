import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
const spawn = vi.hoisted(() => vi.fn());
vi.mock('node:child_process', () => ({ spawn }));
import { parseClaudeArgs, claudeEnvironment, claudeArguments, runClaudeProcess, runClaudeCommand } from '../src/delegation/index.js';
function child(result: { code?: number; output?: string; error?: boolean } = {}) {
  const p = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => { queueMicrotask(() => p.emit('close', null, 'SIGTERM')); return true; }) });
  queueMicrotask(() => { if (result.error) p.emit('error', Error('secret')); else { if (result.output) p.stdout.emit('data', Buffer.from(result.output)); p.emit('close', result.code ?? 0, null); } }); return p;
}
afterEach(() => { vi.clearAllMocks(); vi.restoreAllMocks(); });
describe('local Claude delegation', () => {
  it('parses explicit prompts and preserves literal shell metacharacters', () => {
    const opts = parseClaudeArgs(['--print', '--model', 'discovered-model', '--', 'read $(touch bad); `false`']);
    const args = claudeArguments(opts); expect(args.slice(-2)).toEqual(['--', 'read $(touch bad); `false`']); expect(args).toContain('discovered-model'); expect(args).not.toContain('--dangerously-skip-permissions'); expect(args).toContain('--permission-prompts');
  });
  it.each([['--god-mode'], ['--max-cost', '1'], ['--permission-mode', 'bypassPermissions'], ['--model'], ['--print'], ['--print', '--print'], ['prompt-without-delimiter'], ['--model', '--print']])('rejects unsupported or misleading options %j', args => expect(() => parseClaudeArgs(args)).toThrow());
  it('supports interactive mode, status and plan permissions', () => { expect(parseClaudeArgs([]).print).toBe(false); expect(parseClaudeArgs(['status']).status).toBe(true); expect(parseClaudeArgs(['--permission-mode', 'plan']).permissionMode).toBe('plan'); });
  it('strips billing selectors without modifying the parent environment', () => {
    const env = { PATH: '/bin', ANTHROPIC_API_KEY: 'secret', ANTHROPIC_AUTH_TOKEN: 'secret', ANTHROPIC_BASE_URL: 'https://proxy', CLAUDE_CODE_USE_BEDROCK: '1', CLAUDE_CODE_USE_VERTEX: '1', CLAUDE_CODE_OAUTH_TOKEN: 'secret', CLAUDE_CONFIG_DIR: '/private/claude' };
    expect(claudeEnvironment(env)).toEqual({ PATH: '/bin', CLAUDE_CONFIG_DIR: '/private/claude' }); expect(env.ANTHROPIC_API_KEY).toBe('secret');
  });
  it('runs an argv process without a shell and propagates its exit code', async () => {
    spawn.mockImplementationOnce(() => child({ code: 7 }));
    expect(await runClaudeProcess(['--', '$(x)'], { cwd: '/project', env: {} })).toEqual({ code: 7, output: '' });
    expect(spawn).toHaveBeenCalledWith('claude', ['--', '$(x)'], expect.objectContaining({ shell: false, stdio: 'inherit', cwd: '/project' }));
  });
  it('reports installation failures without leaking subprocess errors', async () => { spawn.mockImplementationOnce(() => child({ error: true })); await expect(runClaudeProcess([], { cwd: '/project', env: {} })).rejects.toThrow('Install the official'); });
  it('cancels before launch', async () => { const c = new AbortController(); c.abort(); await expect(runClaudeProcess([], { cwd: '/', env: {}, signal: c.signal })).rejects.toThrow('cancelled'); expect(spawn).not.toHaveBeenCalled(); });
  it('forwards cancellation to the running child', async () => {
    const c = new AbortController(); const p = Object.assign(new EventEmitter(), { stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(() => { queueMicrotask(() => p.emit('close', null, 'SIGTERM')); return true; }) }); spawn.mockReturnValueOnce(p);
    const result = runClaudeProcess([], { cwd: '/', env: {}, signal: c.signal }); c.abort(); await expect(result).rejects.toThrow('cancelled'); expect(p.kill).toHaveBeenCalledWith('SIGTERM');
  });
  it('rejects oversized status output', async () => { spawn.mockImplementationOnce(() => child({ output: 'x'.repeat(65537) })); await expect(runClaudeProcess([], { cwd: '/', env: {}, capture: true })).rejects.toThrow('limit'); });
  it.each(['api_key', 'oauth_token', 'api_key_helper', 'third_party', 'none'])('refuses %s before launching inference', async authMethod => { spawn.mockImplementationOnce(() => child({ output: JSON.stringify({ authMethod }) })); await expect(runClaudeCommand(['--print', '--', 'hi'])).rejects.toThrow('saved claude.ai'); expect(spawn).toHaveBeenCalledTimes(1); });
  it('shows status without exposing account details or credentials', async () => { spawn.mockImplementationOnce(() => child({ output: JSON.stringify({ authMethod: 'claude.ai', email: 'private', token: 'secret' }) })); const log = vi.spyOn(console, 'log').mockImplementation(() => {}); expect(await runClaudeCommand(['status'])).toBe(0); expect(JSON.stringify(log.mock.calls)).not.toContain('private'); expect(JSON.stringify(log.mock.calls)).not.toContain('secret'); });
  it('checks login before delegation and preserves failure exit codes', async () => { spawn.mockImplementationOnce(() => child({ output: '{"authMethod":"claude.ai"}' })).mockImplementationOnce(() => child({ code: 5 })); vi.spyOn(console, 'error').mockImplementation(() => {}); expect(await runClaudeCommand(['--print', '--', 'hi'])).toBe(5); expect(spawn).toHaveBeenCalledTimes(2); });
  it('rejects malformed status', async () => { spawn.mockImplementationOnce(() => child({ output: 'not JSON' })); await expect(runClaudeCommand(['status'])).rejects.toThrow('unsupported auth status'); });
});
