import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { bindProcessCancellation, detachedProcess } from '../process-cancellation.js';
import { throwIfCancelled } from '../cancellation.js';
import { redactSecrets } from '../runlog.js';
import { approvalDisplayText } from '../approvals/index.js';
import type { CommandEvidence, VerificationCommand } from './contracts.js';

const OUTPUT_BYTES = 65536;
export interface ReadMount { source: string; target: string }
export function containerArguments(image: string, name: string, argv: string[], mounts: ReadMount[]): string[] {
  if (!/^sha256:[a-f0-9]{64}$/.test(image) || !/^calliope-check-[a-f0-9-]{36}$/.test(name) || !argv.length || argv.length>64 || argv.some(a=>typeof a!=='string'||!a.length||a.length>8192||/[\x00-\x1f\x7f]/.test(a)) ||
      mounts.some(m => !m.source.startsWith('/') || /[,\x00-\x1f]/.test(m.source) || !/^\/project(?:\/[^,\x00-\x1f]*)?$/.test(m.target)||m.target.split('/').includes('..')))
    throw new Error('Invalid isolated command identity or mount.');
  return ['create', '--pull=never', '--name', name, '--network=none', '--read-only', '--cap-drop=ALL',
    '--security-opt=no-new-privileges', '--pids-limit=64', '--memory=256m', '--memory-swap=256m', '--cpus=1',
    `--user=${process.getuid?.() ?? 65534}:${process.getgid?.() ?? 65534}`, '--workdir=/project', '--tmpfs=/tmp:rw,nosuid,nodev,size=64m,mode=1777',
    ...mounts.flatMap(m => ['--mount', `type=bind,source=${m.source},target=${m.target},readonly`]),
    '--entrypoint', argv[0]!, image, ...argv.slice(1)];
}

/** Only the local daemon is used; the container receives no host environment or writable host mount. */
export async function runIsolatedCommand(image: string, command: VerificationCommand, mounts: ReadMount[], signal?: AbortSignal): Promise<CommandEvidence> {
  throwIfCancelled(signal);
  if(!Number.isSafeInteger(command.timeoutMs)||command.timeoutMs<1||command.timeoutMs>60000)throw new Error('Invalid verification deadline.');
  const container = `calliope-check-${randomUUID()}`, start = Date.now();
  const args = containerArguments(image, container, command.argv, mounts);
  const env = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin' };
  const docker = (argv: string[]) => spawn('docker', ['--host', 'unix:///var/run/docker.sock', ...argv], { env, stdio: ['ignore', 'pipe', 'pipe'], detached: detachedProcess });
  const controller = new AbortController(); let timedOut = false, truncated = false;
  const abort = () => controller.abort(); signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(() => { timedOut = true; controller.abort(); }, command.timeoutMs);
  const output = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  const capture = (key: 'stdout' | 'stderr', data: Buffer) => {
    const remaining = OUTPUT_BYTES - output[key].length;
    if (data.length > remaining) truncated = true;
    if (remaining > 0) output[key] = Buffer.concat([output[key], data.subarray(0, remaining)]);
  };
  const remove = (): Promise<boolean> => new Promise(resolve => {
    const cleanup = docker(['rm', '--force', container]); let error = Buffer.alloc(0);
    const stop = setTimeout(() => cleanup.kill('SIGKILL'), 5000);
    cleanup.stderr.on('data', chunk => { if (error.length < 4096) error = Buffer.concat([error, chunk]).subarray(0, 4096); });
    cleanup.stdout.resume();
    cleanup.once('error', () => { clearTimeout(stop); resolve(false); });
    cleanup.once('close', code => { clearTimeout(stop); resolve(code === 0 || /No such container/.test(error.toString())); });
  });
  let earlyRemoval: Promise<boolean> | undefined;
  try {
    const execute = async(argv:string[],creating=false):Promise<number>=>{
      const child=docker(argv),stopped=bindProcessCancellation(child,controller.signal,()=>{earlyRemoval??=remove();});
      if(creating)child.stdout.resume();else child.stdout.on('data',data=>capture('stdout',data));
      child.stderr.on('data',data=>capture('stderr',data));
      const code=await new Promise<number>(resolve=>{child.once('error',()=>resolve(125));child.once('close',value=>resolve(value??125));});
      await stopped;return code;
    };
    // Creation cannot execute the entrypoint. Once its response arrives, cancellation
    // can remove this known container without a late start request recreating it.
    const created=await execute(args,true);
    const code=created===0&&!controller.signal.aborted?await execute(['start','--attach',container]):125;
    clearTimeout(timer);if(earlyRemoval)await earlyRemoval;
    const removed=await remove(),cleanupConfirmed=removed&&(created===0||!controller.signal.aborted);
    const outcome = signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : code === 125 || !cleanupConfirmed ? 'unavailable' : code === 0 ? 'passed' : 'failed';
    const clean = (bytes: Buffer) => approvalDisplayText(String(redactSecrets(bytes.toString('utf8'))));
    return { version: 1, kind: 'isolated-command', argv: [...command.argv], image, container, cleanupConfirmed,
      outcome, exitCode: outcome === 'cancelled' ? 130 : outcome === 'timeout' ? 124 : code,
      stdout: clean(output.stdout), stderr: clean(output.stderr), truncated, durationMs: Date.now() - start };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
