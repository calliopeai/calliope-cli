import * as fs from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import {createHash} from 'node:crypto';
import { canonicalJson, canonicalPath, digest } from '../approvals/index.js';
import { bindProcessCancellation, detachedProcess } from '../process-cancellation.js';
import { throwIfCancelled } from '../cancellation.js';
import { OrchestrationError, type PathGrant } from '../orchestration/types.js';
import { pathName, shape } from '../orchestration/validation.js';
import { privateDirectory, readArtifactBytes } from '../orchestration/execution-store.js';
import type { ReadMount } from './process.js';

const unavailable = (message: string): never => { throw new OrchestrationError('unavailable', message); };
export async function worktreeGit(cwd: string, args: string[], signal?: AbortSignal, accepted = [0]): Promise<string> {
  throwIfCancelled(signal);
  const controller = new AbortController(), abort = () => controller.abort();
  signal?.addEventListener('abort', abort, { once: true }); if (signal?.aborted) abort();
  const timer = setTimeout(abort, 30000);
  try {
    const proc = spawn('git', ['-c', 'core.hooksPath=/dev/null', '-c', 'core.fsmonitor=false', '-c', 'checkout.workers=1', ...args], {
      cwd, detached: detachedProcess, stdio: ['ignore', 'pipe', 'pipe'],
      env: { PATH: process.env.PATH, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: '/dev/null', GIT_TERMINAL_PROMPT: '0', GIT_LFS_SKIP_SMUDGE: '1', GIT_NO_LAZY_FETCH: '1' },
    });
    const stopped = bindProcessCancellation(proc, controller.signal); let bytes = Buffer.alloc(0);
    proc.stdout.on('data', data => { if (bytes.length + data.length > 1024 * 1024) controller.abort(); else bytes = Buffer.concat([bytes, data]); });
    proc.stderr.resume();
    const code = await new Promise<number>(resolve => { proc.once('error', () => resolve(-1)); proc.once('close', code => resolve(code ?? -1)); });
    await stopped; throwIfCancelled(signal);
    if (controller.signal.aborted || !accepted.includes(code)) unavailable('Git workspace operation failed or exceeded its time/output bound; preserve the workspace for inspection.');
    return bytes.toString('utf8');
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', abort); }
}
function writeNew(file: string, value: string): void {
  const fd = fs.openSync(file, 'wx', 0o600); try { fs.writeFileSync(fd, value); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
}
function readJson(file: string): Record<string, unknown> {
  try { return JSON.parse(readArtifactBytes(file, 16384, true).toString()); } catch { return unavailable('Workspace identity is missing or damaged; preserve it before recovery.'); }
}
async function disabledFilters(project:string,signal?:AbortSignal):Promise<string[]> {
  const keys=(await worktreeGit(project,['config','--name-only','--get-regexp','^filter\\..*\\.(clean|smudge|process)$'],signal,[0,1])).trim().split('\n').filter(Boolean);
  if(keys.length>256||keys.some(k=>/[\x00-\x1f=]/.test(k)))unavailable('Git filter configuration exceeds safe workspace preparation bounds.');
  return keys.flatMap(key=>['-c',key+'=','-c',key.replace(/\.(clean|smudge|process)$/,'.required')+'=false']);
}

/** One pinned source revision per run; ignored credentials and untracked source are never copied. */
export async function pinWorktreeBase(root: string, project: string, sourcePlan: string, planHash: string, signal?: AbortSignal): Promise<string> {
  privateDirectory(root); const file = join(root, 'workspace-base.json');
  if (fs.existsSync(file)) {
    const v = readJson(file); shape(v, ['version', 'project', 'planHash', 'commit', 'hash']); const { hash, ...body } = v;
    if (v.version !== 1 || v.project !== project || v.planHash !== planHash || typeof v.commit !== 'string' || !/^[a-f0-9]{40,64}$/.test(v.commit) || hash !== digest(canonicalJson(body))) unavailable('Workspace source differs from this reviewed run.');
    return v.commit as string;
  }
  const top = (await worktreeGit(project, ['rev-parse', '--show-toplevel'], signal)).trim();
  if (canonicalPath(top) !== project) unavailable('Isolated execution requires the canonical Git repository root.');
  if((await worktreeGit(project,['config','--name-only','--get-regexp','^(extensions\\.partialclone|remote\\..*\\.promisor)$'],signal,[0,1])).trim())unavailable('Isolated execution requires a complete local clone without lazy-fetch configuration.');
  const filters=await disabledFilters(project,signal);
  const status = await worktreeGit(project, [...filters,'status', '--porcelain=v1', '-z', '--untracked-files=all'], signal);
  if (status.split('\0').filter(Boolean).some(line => line !== '?? ' + sourcePlan)) unavailable('Commit or preserve pending source changes before isolated execution; only the untracked plan is excluded.');
  const commit = (await worktreeGit(project, ['rev-parse', '--verify', 'HEAD^{commit}'], signal)).trim();
  if (!/^[a-f0-9]{40,64}$/.test(commit)) unavailable('Workspace needs a committed Git revision.');
  const tree = await worktreeGit(project, ['ls-tree', '-r', '-l', '-z', commit], signal); let count = 0, bytes = 0;
  for (const entry of tree.split('\0').filter(Boolean)) {
    const match = /^(100644|100755) blob [a-f0-9]+\s+(\d+)\t([\s\S]+)$/.exec(entry);
    if (!match) unavailable('Isolated source cannot contain symlinks or submodules.');
    pathName(match![3]);if(match![3]!.split('/').some(p=>p.toLowerCase()==='.git'))unavailable('Source contains a Git metadata alias.'); bytes += Number(match![2]);
    if (++count > 10000 || bytes > 50 * 1024 * 1024 || Number(match![2]) > 10 * 1024 * 1024) unavailable('Isolated source exceeds 10,000 files, 50 MiB total or 10 MiB per file.');
  }
  throwIfCancelled(signal); const body = { version: 1, project, planHash, commit };
  const record=canonicalJson({ ...body, hash: digest(canonicalJson(body)) });
  try{writeNew(file,record);}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST'||canonicalJson(readJson(file))!==record)throw error;}
  return commit;
}

export class WorkerWorktree {
  readonly filesRoot: string;
  private readonly identity: { ino: number; dev: number; git: string };
  private verified?:{grants:PathGrant[];hash:string};
  constructor(readonly root: string, readonly project: string, readonly base: string) {
    privateDirectory(root); this.filesRoot = join(root, 'files');
    const v = readJson(join(root, 'identity.json')); shape(v, ['version', 'project', 'base', 'ino', 'dev', 'git', 'hash']); const { hash, ...body } = v;
    if (v.version !== 1 || v.project !== project || v.base !== base || hash !== digest(canonicalJson(body))) unavailable('Worker workspace identity changed.');
    this.identity = v as unknown as typeof this.identity; this.assertIdentity();
  }
  assertIdentity = (): void => {
    privateDirectory(this.root); const stat = fs.lstatSync(this.filesRoot);
    if (!stat.isDirectory() || canonicalPath(this.filesRoot) !== this.filesRoot || stat.ino !== this.identity.ino || stat.dev !== this.identity.dev ||
        digest(readArtifactBytes(join(this.filesRoot, '.git'), 4096).toString()) !== this.identity.git) unavailable('Worker workspace was replaced or its Git identity changed.');
  };
  snapshot(grants:PathGrant[],signal?:AbortSignal):string {
    this.assertIdentity();const hash=createHash('sha256'),seen=new Set<string>();let bytes=0;
    const visit=(path:string):void=>{
      throwIfCancelled(signal);if(seen.has(path))return;seen.add(path);if(seen.size>10000)unavailable('Workspace snapshot exceeds 10,000 entries.');
      const file=resolve(this.filesRoot,path);if(canonicalPath(file)!==file)unavailable('Workspace snapshot contains an alias.');const s=fs.lstatSync(file);
      if(s.isDirectory()){hash.update(canonicalJson({path,mode:s.mode&0o777}));for(const name of fs.readdirSync(file).sort())visit(path==='.'?name:path+'/'+name);}
      else {const content=readArtifactBytes(file,10*1024*1024);bytes+=content.length;if(bytes>50*1024*1024)unavailable('Workspace snapshot exceeds 50 MiB.');hash.update(canonicalJson({path,mode:s.mode&0o777,bytes:content.length}));hash.update(content);}
    };
    for(const grant of [...grants].sort((a,b)=>a.path.localeCompare(b.path))){pathName(grant.path);visit(grant.path);}return hash.digest('hex');
  }
  rememberVerification(grants:PathGrant[],hash:string):void{this.verified={grants:structuredClone(grants),hash};}
  assertVerified(signal?:AbortSignal):void {if(this.verified&&this.snapshot(this.verified.grants,signal)!==this.verified.hash)throw new OrchestrationError('conflict','Workspace changed after verification; its test result cannot certify the changed files.');}
  async patch(signal?: AbortSignal): Promise<string> {
    this.assertIdentity();
    // An isolated index belongs only to this worktree; no source index/ref is changed.
    const filters=await disabledFilters(this.filesRoot,signal);
    await worktreeGit(this.filesRoot, ['--work-tree',this.filesRoot,...filters, 'add', '--all', '--force', '--', '.'], signal); this.assertIdentity();
    return worktreeGit(this.filesRoot, ['--work-tree',this.filesRoot,'diff', '--cached', '--binary', '--no-ext-diff', '--no-textconv', this.base, '--'], signal);
  }
  /** Read-only mounts enforce the task's read grants; no command can alter a host file. */
  mounts(grants: PathGrant[], signal?: AbortSignal): ReadMount[] {
    this.assertIdentity(); const view = join(this.root, 'view'); if (!fs.existsSync(view)) fs.mkdirSync(view, { mode: 0o700 });
    const paths = grants.map(g => g.path).filter((p, i, all) => !all.some((q, j) => i !== j && (q === '.' || p.startsWith(q + '/'))));
    const mounts: ReadMount[] = [{ source: view, target: '/project' }]; let count = 0;
    const scan = (file: string): void => {
      throwIfCancelled(signal); if (++count > 10000) unavailable('Command read scope exceeds 10,000 entries.');
      const s = fs.lstatSync(file); if (s.isSymbolicLink() || !s.isDirectory() && (!s.isFile() || s.nlink !== 1) || canonicalPath(file) !== file) unavailable('Command scope contains an alias or special file.');
      if (s.isDirectory()) for (const entry of fs.readdirSync(file)) scan(join(file, entry));
    };
    for (const path of paths) {
      pathName(path); if (path.split('/').some(p=>p.toLowerCase()==='.git')) unavailable('Git metadata is outside worker scope.');
      const file = resolve(this.filesRoot, path); scan(file);
      const target = path === '.' ? '/project' : '/project/' + path;
      if (path === '.') mounts[0] = { source: file, target }; else {
        const placeholder = join(view, path); fs.mkdirSync(dirname(placeholder), { recursive: true, mode: 0o700 });
        if (!fs.existsSync(placeholder)) { if (fs.statSync(file).isDirectory()) fs.mkdirSync(placeholder, { mode: 0o700 }); else writeNew(placeholder, ''); }
        mounts.push({ source: file, target });
      }
    }
    if (paths.includes('.')) { const mask = join(this.root, 'git-mask'); if (!fs.existsSync(mask)) writeNew(mask, 'Git metadata is unavailable to worker commands.\n'); mounts.push({ source: mask, target: '/project/.git' }); }
    return mounts;
  }
}

export async function createWorkerWorktree(root: string, project: string, base: string, signal?: AbortSignal): Promise<WorkerWorktree> {
  const rel=relative(project,root);
  if (canonicalPath(root) !== root || !(rel==='..'||rel.startsWith('../')||isAbsolute(rel))) unavailable('Worker workspace must be outside the source project without aliases.');
  privateDirectory(dirname(root)); throwIfCancelled(signal);
  // Every explicit attempt gets a new directory. Partial creation is never silently adopted.
  fs.mkdirSync(root, { mode: 0o700 }); const files = join(root, 'files');
  const filters=await disabledFilters(project,signal);
  await worktreeGit(project, [...filters, 'worktree', 'add', '--no-checkout', '--detach', '--', files, base], signal);
  const checkoutFilters=await disabledFilters(files,signal);
  await worktreeGit(files,['--work-tree',files,...checkoutFilters,'read-tree','--reset',base],signal);
  await worktreeGit(files,['--work-tree',files,...checkoutFilters,'checkout-index','--all','--force'],signal);
  fs.chmodSync(files, 0o700); const stat = fs.lstatSync(files), git = digest(readArtifactBytes(join(files, '.git'), 4096).toString());
  const body = { version: 1, project, base, ino: stat.ino, dev: stat.dev, git };
  writeNew(join(root, 'identity.json'), canonicalJson({ ...body, hash: digest(canonicalJson(body)) }));
  return new WorkerWorktree(root, project, base);
}
