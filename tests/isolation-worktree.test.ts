import {beforeEach,afterEach,it,expect} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {execFileSync} from 'node:child_process';
import {pinWorktreeBase,createWorkerWorktree,WorkerWorktree,worktreeGit} from '../src/isolation/worktree.js';
let root:string,project:string,store:string;
const git=(...args:string[])=>execFileSync('git',args,{cwd:project,stdio:'pipe'}).toString();
beforeEach(()=>{
  root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-worktree-test-')));store=join(root,'store');project=join(root,'project');fs.mkdirSync(store,{mode:0o700});fs.mkdirSync(project);
  git('init','-q');git('config','user.name','Test');git('config','user.email','test@example.invalid');fs.mkdirSync(join(project,'src'));fs.writeFileSync(join(project,'src/input.txt'),'original');fs.writeFileSync(join(project,'.gitignore'),'private.env\nignored-output.txt\n');git('add','.');git('commit','-qm','fixture');fs.writeFileSync(join(project,'private.env'),'excluded-private-fixture');fs.writeFileSync(join(project,'plan.json'),'{}');
});
afterEach(()=>{fs.rmSync(root,{recursive:true,force:true});});
const pin=()=>pinWorktreeBase(store,project,'plan.json','a'.repeat(64));
it('pins one commit across concurrent creation/restart and retains a detached patch without changing the source',async()=>{
  const [base,again]=await Promise.all([pin(),pin()]);expect(base).toBe(again);expect(await pin()).toBe(base);
  const worker=await createWorkerWorktree(join(store,'worker'),project,base);
  expect(fs.existsSync(join(worker.filesRoot,'private.env'))).toBe(false);expect(fs.existsSync(join(worker.filesRoot,'plan.json'))).toBe(false);
  fs.writeFileSync(join(worker.filesRoot,'src/input.txt'),'changed');fs.writeFileSync(join(worker.filesRoot,'ignored-output.txt'),'new artifact');
  const patch=await worker.patch();expect(patch).toContain('+changed');expect(patch).toContain('+new artifact');expect(fs.readFileSync(join(project,'src/input.txt'),'utf8')).toBe('original');
  expect(git('status','--porcelain')).toBe('?? plan.json\n');expect(new WorkerWorktree(worker.root,project,base).filesRoot).toBe(worker.filesRoot);
  const mounts=worker.mounts([{path:'.',access:'write'}]);expect(mounts.map(m=>m.target)).toEqual(['/project','/project/.git']);
});
it('exposes only declared read scopes and rejects aliases, metadata access or a replaced identity',async()=>{
  const base=await pin(),worker=await createWorkerWorktree(join(store,'worker'),project,base);
  const mounts=worker.mounts([{path:'src',access:'write'},{path:'src/input.txt',access:'read'}]);expect(mounts.map(m=>m.target)).toEqual(['/project','/project/src']);
  expect(worker.mounts([{path:'src/input.txt',access:'read'}]).at(-1)!.target).toBe('/project/src/input.txt');
  expect(()=>worker.mounts([{path:'.git',access:'read'}])).toThrow(/metadata/);
  fs.symlinkSync('/tmp',join(worker.filesRoot,'src/escape'));expect(()=>worker.mounts([{path:'src',access:'read'}])).toThrow(/alias/);fs.unlinkSync(join(worker.filesRoot,'src/escape'));
  const metadata=join(worker.filesRoot,'.git');fs.writeFileSync(metadata,'gitdir: /tmp/other');expect(()=>worker.assertIdentity()).toThrow(/identity/);
});
it('mounts a placeholder for a missing declared output so verification can fail normally',async()=>{
  const base=await pin(),worker=await createWorkerWorktree(join(store,'worker'),project,base);
  const mounts=worker.mounts([{path:'new-output.txt',access:'read'}]);
  expect(mounts.at(-1)).toMatchObject({target:'/project/new-output.txt'});
  expect(fs.existsSync(mounts.at(-1)!.source)).toBe(true);
  expect(fs.readFileSync(mounts.at(-1)!.source,'utf8')).toBe('');
  expect(fs.existsSync(join(worker.filesRoot,'new-output.txt'))).toBe(false);
});
it('rejects dirty source, broken identity, traversal and non-Git roots without adopting partial workspaces',async()=>{
  fs.writeFileSync(join(project,'src/input.txt'),'dirty');await expect(pin()).rejects.toThrow(/pending/);git('checkout','--','src/input.txt');
  const base=await pin();await expect(createWorkerWorktree(join(project,'worker'),project,base)).rejects.toThrow(/outside/);
  await expect(createWorkerWorktree(join(project,'..still-inside'),project,base)).rejects.toThrow(/outside/);
  fs.mkdirSync(join(store,'partial'));await expect(createWorkerWorktree(join(store,'partial'),project,base)).rejects.toThrow();
  fs.writeFileSync(join(store,'workspace-base.json'),'{}');await expect(pin()).rejects.toThrow();
  await expect(worktreeGit(project,['not-a-command'])).rejects.toThrow(/Git workspace/);await expect(worktreeGit(project,['status'],AbortSignal.abort())).rejects.toThrow();
});
it('does not invoke checkout filters and rejects symlinks or submodules before creating workers',async()=>{
  git('config','filter.toy.smudge','touch filter-ran');git('config','filter.toy.clean','cat');git('config','filter.toy.required','true');fs.writeFileSync(join(project,'.gitattributes'),'src/input.txt filter=toy\n');git('add','.gitattributes');git('commit','-qm','filter fixture');
  const base=await pin(),worker=await createWorkerWorktree(join(store,'worker'),project,base);expect(fs.readFileSync(join(worker.filesRoot,'src/input.txt'),'utf8')).toBe('original');expect(fs.existsSync(join(worker.filesRoot,'filter-ran'))).toBe(false);
  fs.unlinkSync(join(store,'workspace-base.json'));fs.symlinkSync('src/input.txt',join(project,'link'));git('add','link');git('commit','-qm','link fixture');await expect(pin()).rejects.toThrow(/symlinks/);
});
it('disables filters selected only by the linked worktree Git configuration',async()=>{
  const include=join(root,'conditional.gitconfig'),marker=join(root,'filter-ran');
  git('config','--file',include,'filter.conditional.clean',`touch '${marker}'; cat`);git('config','--file',include,'filter.conditional.smudge',`touch '${marker}'; cat`);git('config','--file',include,'filter.conditional.required','true');
  git('config',`includeIf.gitdir:${project}/.git/worktrees/.path`,include);fs.writeFileSync(join(project,'.gitattributes'),'src/input.txt filter=conditional\n');git('add','.gitattributes');git('commit','-qm','conditional fixture');
  const base=await pin(),worker=await createWorkerWorktree(join(store,'worker'),project,base);expect(fs.existsSync(marker)).toBe(false);
  fs.writeFileSync(join(worker.filesRoot,'src/input.txt'),'changed');expect(await worker.patch()).toContain('+changed');expect(fs.existsSync(marker)).toBe(false);
});
it('rejects lazy-fetch configuration before workspace preparation',async()=>{
  git('config','remote.origin.promisor','true');await expect(pin()).rejects.toThrow(/complete local clone/);expect(fs.existsSync(join(store,'workspace-base.json'))).toBe(false);
});
