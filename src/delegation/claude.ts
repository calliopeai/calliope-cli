import { spawn } from 'node:child_process';
export class ClaudeDelegationError extends Error { constructor(message: string) { super(message); this.name = 'ClaudeDelegationError'; } }
export interface ClaudeOptions { print: boolean; model?: string; permissionMode: 'default' | 'plan'; prompt?: string; status: boolean }
export function parseClaudeArgs(args: string[]): ClaudeOptions {
  const result: ClaudeOptions = { print: false, permissionMode: 'default', status: false };
  if (args.length === 1 && args[0] === 'status') return { ...result, status: true };
  const seen = new Set<string>();
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--') { result.prompt = args.slice(i + 1).join(' '); break; }
    if (seen.has(arg)) throw new ClaudeDelegationError('Duplicate Claude option.'); seen.add(arg);
    if (arg === '--print') result.print = true;
    else if (arg === '--model' || arg === '--permission-mode') {
      const value = args[++i];
      if (!value || value.startsWith('-')) throw new ClaudeDelegationError('Claude option requires a value.');
      if (arg === '--model') result.model = value;
      else if (value === 'default' || value === 'plan') result.permissionMode = value;
      else throw new ClaudeDelegationError('Claude delegation supports default or plan permissions.');
    } else throw new ClaudeDelegationError('Usage: calliope claude [--print] [--model <model>] [--permission-mode default|plan] [-- <prompt>], or calliope claude status.');
  }
  if (result.print && !result.prompt) throw new ClaudeDelegationError('Print mode requires a prompt after --.');
  return result;
}
export function claudeEnvironment(source: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env = { ...source };
  for (const key of Object.keys(env)) if (/^(ANTHROPIC_|CLAUDE_CODE_USE_|CLAUDE_CODE_OAUTH_TOKEN$|CLAUDE_CODE_API_KEY_HELPER|CLAUDE_CODE_SUBAGENT_MODEL$)/i.test(key)) delete env[key];
  return env;
}
// Load no user/project settings that could re-inject an API key or provider.
// Managed policy remains authoritative; incompatible auth is refused in preflight.
export const CLAUDE_SETTINGS = ['--setting-sources', '', '--settings', JSON.stringify({ forceLoginMethod: 'claudeai' })];
export function claudeArguments(options: ClaudeOptions): string[] {
  return [...CLAUDE_SETTINGS, '--permission-mode', options.permissionMode,
    ...(options.print ? ['--print', '--permission-prompts', 'none'] : []),
    ...(options.model ? ['--model', options.model] : []), ...(options.prompt ? ['--', options.prompt] : [])];
}
interface ProcessOptions { cwd: string; env: NodeJS.ProcessEnv; signal?: AbortSignal; capture?: boolean; timeoutMs?: number }
export function runClaudeProcess(args: string[], options: ProcessOptions): Promise<{ code: number; output: string }> {
  return new Promise((resolve, reject) => {
    if (options.signal?.aborted) { reject(new ClaudeDelegationError('Claude delegation cancelled.')); return; }
    const child = spawn('claude', args, { cwd: options.cwd, env: options.env, shell: false, stdio: options.capture ? ['ignore', 'pipe', 'pipe'] : 'inherit' });
    let output = '', stopped = false, overflow = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => { stopped = true; child.kill('SIGTERM'); killTimer ??= setTimeout(() => child.kill('SIGKILL'), 2000); };
    const timeout = options.timeoutMs ? setTimeout(stop, options.timeoutMs) : undefined;
    options.signal?.addEventListener('abort', stop, { once: true });
    child.stdout?.on('data', (data: Buffer) => { if (Buffer.byteLength(output) + data.length > 65536) { overflow = true; stop(); } else output += data.toString(); });
    // Never expose auth diagnostic stderr: it can contain credential sources.
    child.stderr?.on('data', () => {});
    const cleanup = () => { clearTimeout(timeout); clearTimeout(killTimer); options.signal?.removeEventListener('abort', stop); };
    child.once('error', () => { cleanup(); reject(new ClaudeDelegationError('Could not launch Claude. Install the official Claude Code CLI and run claude auth login.')); });
    child.once('close', (code, signal) => {
      cleanup();
      if (stopped || signal || overflow) reject(new ClaudeDelegationError('Claude delegation cancelled, timed out or exceeded its status-output limit.'));
      else resolve({ code: code ?? 1, output });
    });
  });
}
export async function runClaudeCommand(args: string[], signal?: AbortSignal): Promise<number> {
  const options = parseClaudeArgs(args);
  if (!options.print && !options.status && !process.stdin.isTTY) throw new ClaudeDelegationError('Interactive Claude delegation requires a terminal. Use --print -- <prompt> for unattended requests.');
  const processOptions = { cwd: process.cwd(), env: claudeEnvironment(process.env), signal };
  const status = await runClaudeProcess([...CLAUDE_SETTINGS, 'auth', 'status'], { ...processOptions, capture: true, timeoutMs: 15000 });
  let auth: { authMethod?: string };
  try { auth = JSON.parse(status.output) as typeof auth; } catch { throw new ClaudeDelegationError('Claude returned an unsupported auth status. Update Claude Code and run claude auth login.'); }
  if (status.code !== 0 || auth?.authMethod !== 'claude.ai') throw new ClaudeDelegationError('Claude plan delegation requires a saved claude.ai login. Run claude auth login in the official CLI first.');
  if (options.status) { console.log('Claude plan login available. Authentication and plan usage are managed by the installed Claude CLI.'); return 0; }
  console.error('Delegating to your local Claude agent. Claude owns tools, permissions, sessions and plan usage; Calliope runtime budgets and sandbox controls do not apply.');
  return (await runClaudeProcess(claudeArguments(options), processOptions)).code;
}
