import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { bindProcessCancellation, detachedProcess } from '../process-cancellation.js';
import { throwIfCancelled } from '../cancellation.js';
import { redactSecrets } from '../runlog.js';
import { approvalDisplayText } from '../approvals/index.js';
import type { CommandEvidence, VerificationCommand } from './contracts.js';

const OUTPUT_BYTES = 65536;
export interface ReadMount { source: string; target: string }

/** Read-only admission check; never pull, create or run an image while planning. */
export async function assertLocalIsolationImage(image:string,signal?:AbortSignal):Promise<void> {
  throwIfCancelled(signal);
  if(!/^sha256:[a-f0-9]{64}$/.test(image))throw new Error('Verification requires a pinned local image ID.');
  const controller=new AbortController(),abort=()=>controller.abort();
  signal?.addEventListener('abort',abort,{once:true});if(signal?.aborted)abort();
  const timer=setTimeout(abort,5000);
  try {
    const child=spawn('docker',['--host','unix:///var/run/docker.sock','image','inspect','--format','{{.Id}} {{.Os}}',image],{env:{PATH:process.env.PATH??'/usr/local/bin:/usr/bin:/bin'},stdio:['ignore','pipe','pipe'],detached:detachedProcess});
    const stopped=bindProcessCancellation(child,controller.signal);let bytes=Buffer.alloc(0);
    child.stderr.resume();child.stdout.on('data',chunk=>{if(bytes.length+chunk.length>512)controller.abort();else bytes=Buffer.concat([bytes,chunk]);});
    const code=await new Promise<number|null>(resolve=>{child.once('error',()=>resolve(null));child.once('close',resolve);});
    await stopped;throwIfCancelled(signal);
    if(code!==0||controller.signal.aborted||bytes.toString().trim()!==`${image} linux`)throw new Error('The pinned verification image is unavailable from the local Docker daemon or is not Linux. Prepare that exact image before resuming; Calliope will not pull it.');
  } finally {clearTimeout(timer);signal?.removeEventListener('abort',abort);}
}
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
  const cleanupRequest = async(argv:string[],timeoutMs:number) => {
    const child=docker(argv),bounded=new AbortController(),stop=setTimeout(()=>bounded.abort(),timeoutMs);
    const stopped=bindProcessCancellation(child,bounded.signal),buffers={stdout:Buffer.alloc(0),stderr:Buffer.alloc(0)};let overflow=false;
    for(const key of ['stdout','stderr'] as const)child[key].on('data',chunk=>{if(buffers[key].length+chunk.length>4096)overflow=true;if(buffers[key].length<4096)buffers[key]=Buffer.concat([buffers[key],chunk]).subarray(0,4096);});
    const code=await new Promise<number|null>(resolve=>{child.once('error',()=>resolve(null));child.once('close',resolve);});
    clearTimeout(stop);await stopped;
    const absent=!overflow&&code===1&&!buffers.stdout.toString().trim()&&['container','object'].some(kind=>buffers.stderr.toString().trim()===`Error response from daemon: No such ${kind}: ${container}`);
    return{code,absent,timedOut:bounded.signal.aborted,present:code===0&&/^[a-f0-9]{64}$/.test(buffers.stdout.toString().trim())};
  };
  const remove = async():Promise<NonNullable<CommandEvidence['cleanup']>['removal']> => {
    const result=await cleanupRequest(['rm','--force',container],5000);
    return{outcome:result.timedOut?'timeout':result.code===0?'removed':result.absent?'absent':'error',exitCode:result.code};
  };
  let earlyRemoval: ReturnType<typeof remove> | undefined;
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
    const cleanup:NonNullable<CommandEvidence['cleanup']>={version:1,removal:await remove()};
    let removed=cleanup.removal.outcome==='removed'||cleanup.removal.outcome==='absent';
    // An acknowledged create cannot arrive later and recreate an absent container.
    // Inspect once after a lost removal response; never infer absence from a daemon error.
    if(!removed&&created===0){
      const result=await cleanupRequest(['container','inspect','--format','{{.Id}}',container],3000);
      cleanup.verification={outcome:result.timedOut?'timeout':result.absent?'absent':result.present?'present':'error',exitCode:result.code};
      removed=cleanup.verification.outcome==='absent';
    }
    const cleanupConfirmed=removed&&created===0;
    const outcome = signal?.aborted ? 'cancelled' : timedOut ? 'timeout' : code === 125 || !cleanupConfirmed ? 'unavailable' : code === 0 ? 'passed' : 'failed';
    const clean = (bytes: Buffer) => approvalDisplayText(String(redactSecrets(bytes.toString('utf8'))));
    return { version: 1, kind: 'isolated-command', argv: [...command.argv], image, container, cleanupConfirmed, cleanup,
      outcome, exitCode: outcome === 'cancelled' ? 130 : outcome === 'timeout' ? 124 : code,
      stdout: clean(output.stdout), stderr: clean(output.stderr), truncated, durationMs: Date.now() - start };
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
