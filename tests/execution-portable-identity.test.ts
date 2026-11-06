import {beforeEach,afterEach,it,expect,describe} from 'vitest';
import * as fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {digest} from '../src/approvals/index.js';
import {requestCostNanos} from '../src/execution/ledger.js';
import {ExecutionGuard,ReservationLedger,manifestHash,validateExecutionManifest,type ExecutionManifest} from '../src/execution/index.js';
import {checkExecutionIdentity,executionPathDenial,executionToolDenial,validateExecutionProject} from '../src/execution/authority.js';
import {portableProjectIdentity,normalizeOrigin} from '../src/execution/portable-identity.js';
import {validateChildGrant} from '../src/execution/child-grants.js';
import {executionManifest} from './helpers/execution-manifest.js';

const ORIGIN='https://example.invalid/r.git';
const env={...process.env,GIT_AUTHOR_NAME:'t',GIT_AUTHOR_EMAIL:'t@example.invalid',GIT_COMMITTER_NAME:'t',GIT_COMMITTER_EMAIL:'t@example.invalid',GIT_AUTHOR_DATE:'2020-01-01T00:00:00Z',GIT_COMMITTER_DATE:'2020-01-01T00:00:00Z',GIT_CONFIG_GLOBAL:'/dev/null'};
const git=(cwd:string,...args:string[])=>execFileSync('git',args,{cwd,env,encoding:'utf8',stdio:['ignore','pipe','pipe']}).trim();
function repo(path:string,file='one',origin:string|null=ORIGIN){
  fs.mkdirSync(path,{recursive:true});git(path,'init','-q','-b','main');
  fs.mkdirSync(join(path,'src'));fs.writeFileSync(join(path,'src','x.ts'),file);git(path,'add','.');git(path,'commit','-q','-m','root');
  if(origin)git(path,'remote','add','origin',origin);return path;
}
const clone=(from:string,to:string,origin:string|null=ORIGIN)=>{git(tmp,'clone','-q',from,to);if(origin)git(to,'remote','set-url','origin',origin);return to;};
let tmp:string,A:string,B:string,ledger:ReservationLedger;
const portableManifest=(project:string):ExecutionManifest=>{const m=executionManifest(project);m.project.portable=portableProjectIdentity(project)!;m.accounts[0]!.allowedPaths=[{path:'src',access:'write'}];m.accounts[1]!.allowedPaths=[{path:'src',access:'write'}];m.accounts[2]!.allowedPaths=[{path:'src',access:'read'}];return m;};
beforeEach(()=>{tmp=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-portable-')));fs.chmodSync(tmp,0o700);A=repo(join(tmp,'a'));B=clone(A,join(tmp,'b'));ledger=new ReservationLedger(join(tmp,'budget'));});
afterEach(()=>fs.rmSync(tmp,{recursive:true,force:true}));
const reject=/different or replaced project/;
const reserveAndSettle=async(l:ReservationLedger,cwd:string,hash:string)=>{
  const id='11111111-1111-4111-8111-111111111111';
  await l.reserve(cwd,hash,{id,agentId:'a',provider:'deepseek',model:'toy',target:'a'.repeat(64),inputTokens:9,outputTokens:1,inputPrice:1,outputPrice:2,costNanos:requestCostNanos(9,1,1,2)});
  return l.settle(cwd,hash,{requestId:id,outcome:'success',usage:{inputTokens:1,outputTokens:1}});
};

describe('derivation',()=>{
  it('is the same for clones and differs for another origin or another root',()=>{
    expect(portableProjectIdentity(A)).toEqual(portableProjectIdentity(B));
    expect(portableProjectIdentity(A)).toMatchObject({version:1,origin:digest('example.invalid/r')});
    expect(portableProjectIdentity(clone(A,join(tmp,'c'),'https://example.invalid/other.git'))!.origin).not.toBe(portableProjectIdentity(A)!.origin);
    expect(portableProjectIdentity(repo(join(tmp,'d'),'two'))!.roots).not.toEqual(portableProjectIdentity(A)!.roots);
  });
  it('is unavailable when it cannot be derived exactly',()=>{
    const plain=join(tmp,'plain');fs.mkdirSync(plain);expect(portableProjectIdentity(plain)).toBeUndefined();
    expect(portableProjectIdentity(repo(join(tmp,'noorigin'),'x',null))).toBeUndefined();
    expect(portableProjectIdentity(repo(join(tmp,'fileorigin'),'y','file:///srv/r.git'))).toBeUndefined();
    expect(portableProjectIdentity(repo(join(tmp,'pathorigin'),'z','/srv/r.git'))).toBeUndefined();
    expect(portableProjectIdentity(join(A,'src'))).toBeUndefined();
    const shallow=join(tmp,'shallow');git(tmp,'clone','-q','--depth','1',`file://${A}`,shallow);git(shallow,'remote','set-url','origin',ORIGIN);
    fs.writeFileSync(join(A,'two'),'2');git(A,'add','.');git(A,'commit','-q','-m','two');
    const shallow2=join(tmp,'shallow2');git(tmp,'clone','-q','--depth','1',`file://${A}`,shallow2);git(shallow2,'remote','set-url','origin',ORIGIN);
    expect(portableProjectIdentity(shallow2)).toBeUndefined();
    const wt=join(tmp,'wt');git(A,'worktree','add','-q',wt,'-b','wt');expect(portableProjectIdentity(wt)).toBeUndefined();
  });
  it('is unavailable without a git binary',()=>{
    const path=process.env.PATH;process.env.PATH='';try{expect(portableProjectIdentity(A)).toBeUndefined();}finally{process.env.PATH=path;}
  });
  it('normalizes equivalent origins and refuses local ones',()=>{
    for(const url of ['git@Example.com:org/repo.git','ssh://git@example.com:2222/org/repo','https://user:pw@EXAMPLE.com/org/repo.git/','http://example.com/org/repo','git://example.com/org/repo.git'])expect(normalizeOrigin(url)).toBe('example.com/org/repo');
    expect(normalizeOrigin('https://example.com/Org/Repo')).toBe('example.com/Org/Repo');
    for(const url of ['','/srv/r.git','file:///srv/r.git','../r','C:\\r','ftp://example.com/r','https://example.com'])expect(normalizeOrigin(url)).toBeUndefined();
  });
});

describe('shape and hashes',()=>{
  it('keeps the hash of a manifest without portable stable',()=>{
    const m=executionManifest(A,1000);m.runId='11111111-1111-4111-8111-111111111111';
    const before=manifestHash(m);expect(manifestHash(validateExecutionManifest(m))).toBe(before);expect(Object.hasOwn(validateExecutionManifest(m).project,'portable')).toBe(false);
  });
  it('rejects malformed portable values and round-trips a valid one',()=>{
    const good=portableProjectIdentity(A)!,base={root:A,key:'a'.repeat(64)};
    expect(validateExecutionProject({...base,portable:good}).portable).toEqual(good);
    const h1='a'.repeat(40),h2='b'.repeat(40);
    for(const portable of [{...good,roots:[]},{...good,roots:Array.from({length:17},(_,i)=>i.toString(16).padStart(40,'0'))},{...good,roots:[h2,h1]},{...good,roots:[h1,h1]},{...good,roots:['z'.repeat(40)]},{...good,roots:['a'.repeat(39)]},{...good,origin:'abc'},{...good,version:2},{...good,extra:1},{...good,roots:undefined}])
      expect(()=>validateExecutionProject({...base,portable}),JSON.stringify(portable)).toThrow(/Invalid execution authority/);
    expect(validateExecutionProject({...base,portable:{...good,roots:[h1,h2]}}).portable!.roots).toEqual([h1,h2]);
  });
  it('rejects a v2 child grant that carries a portable identity',()=>{
    const grant:any={version:2,id:'11111111-1111-4111-8111-111111111111',proposalHash:'a'.repeat(64),previousGraphHash:'b'.repeat(64),planHash:'c'.repeat(64),runManifestHash:'d'.repeat(64),approvalRevision:'11111111-1111-4111-8111-111111111111',parentId:'a',accounts:[{id:'c',parentId:'a',tokenBudget:1,costBudgetNanos:0,deadline:2,allowedTools:[],allowedPaths:[]}],project:{root:A,key:'a'.repeat(64)}};
    expect(()=>validateChildGrant(grant)).not.toThrow();
    expect(()=>validateChildGrant({...grant,project:{...grant.project,portable:portableProjectIdentity(A)}})).toThrow(/Invalid execution authority/);
  });
});

describe('creator side',()=>{
  it('rejects a declared identity that the creator mount does not derive, and writes nothing',()=>{
    const wrongRoot=portableManifest(A);wrongRoot.project.portable={...wrongRoot.project.portable!,roots:['a'.repeat(40)]};
    const wrongOrigin=portableManifest(A);wrongOrigin.project.portable={...wrongOrigin.project.portable!,origin:'f'.repeat(64)};
    for(const m of [wrongRoot,wrongOrigin]){expect(()=>ledger.create(m)).toThrow(reject);expect(fs.existsSync(ledger.root)).toBe(false);}
    const plain=join(tmp,'plain');fs.mkdirSync(plain);const m=executionManifest(plain);m.project.portable=portableProjectIdentity(A)!;
    expect(()=>ledger.create(m)).toThrow(reject);expect(fs.existsSync(ledger.root)).toBe(false);
  });
});

describe('another checkout',()=>{
  it('accepts a portable manifest in a second clone through read, reserve, settle and the guard',async()=>{
    const m=portableManifest(A);ledger.create(m);const hash=manifestHash(m);
    expect(ledger.read(B).manifest.project.root).toBe(A);
    const guard=new ExecutionGuard({ledger,manifestHash:hash,agentId:'a',maxOutputTokens:100},B);
    expect(guard.check({id:'1',name:'write_file',arguments:{path:'src/x.ts'}})).toBeUndefined();
    expect(guard.filesRoot).toBe(B);
    expect((await reserveAndSettle(ledger,B,hash)).spent.tokens).toBeGreaterThan(0);
    expect(()=>guard.assertActive()).not.toThrow();
  });
  it('rejects a manifest without a portable identity from the second clone',()=>{
    const m=executionManifest(A);ledger.create(m);expect(()=>ledger.read(B)).toThrow(reject);
  });
  it('rejects other repositories, other roots and other origins with the existing error',()=>{
    ledger.create(portableManifest(A));
    const otherRoot=repo(join(tmp,'o2'),'different content');
    const otherOrigin=clone(A,join(tmp,'o3'),'https://example.invalid/fork.git');
    const noOrigin=clone(A,join(tmp,'o4'),null);
    const plain=join(tmp,'plain');fs.mkdirSync(plain);
    for(const dir of [otherRoot,otherOrigin,noOrigin,plain,join(B,'src')])expect(()=>ledger.read(dir),dir).toThrow(reject);
  });
  it('replacing the creator path: another repo is rejected, a fresh clone is accepted only when portable',()=>{
    const m=portableManifest(A);ledger.create(m);
    const plainLedger=new ReservationLedger(join(tmp,'budget2'));const plain=executionManifest(A);plainLedger.create(plain);
    const saved=join(tmp,'a-original');fs.renameSync(A,saved);
    repo(A,'other');expect(()=>ledger.read(A)).toThrow(reject);
    fs.rmSync(A,{recursive:true,force:true});clone(saved,A);
    expect(()=>ledger.read(A)).not.toThrow();expect(()=>plainLedger.read(A)).toThrow(reject);
  });
  it('never applies the portable match to a manifest funded by a parent ledger',()=>{
    const m=portableManifest(A);
    expect(checkExecutionIdentity(m,B,{portable:true})).toEqual({root:B,key:expect.any(String)});
    expect(()=>checkExecutionIdentity({...m,version:2,parent:{} as never},B,{portable:true})).toThrow(reject);
    expect(()=>checkExecutionIdentity(m,B)).toThrow(reject);
  });
  it('fails closed once the repository metadata changes after the guard is built',()=>{
    const m=portableManifest(A);ledger.create(m);
    const guard=new ExecutionGuard({ledger,manifestHash:manifestHash(m),agentId:'a',maxOutputTokens:100},B);
    git(B,'remote','set-url','origin','https://example.invalid/fork.git');
    expect(guard.check({id:'1',name:'read_file',arguments:{path:'src/x.ts'}})).toBeUndefined();
    expect(()=>new ExecutionGuard({ledger,manifestHash:manifestHash(m),agentId:'a',maxOutputTokens:100},B)).toThrow(reject);
  });
});

describe('path scope in the second clone',()=>{
  it('keeps every grant on the local mount and denies Git metadata writes',()=>{
    const m=portableManifest(A);m.accounts[0]!.allowedPaths=[{path:'.',access:'write'}];m.accounts[1]!.allowedPaths=[{path:'src',access:'write'}];m.accounts[2]!.allowedPaths=[{path:'src',access:'read'}];ledger.create(m);
    const guard=new ExecutionGuard({ledger,manifestHash:manifestHash(m),agentId:'a',maxOutputTokens:100},B);
    const call=(path:string,name='write_file')=>guard.check({id:'1',name,arguments:{path}});
    expect(call('src/x.ts')).toBeUndefined();
    expect(call('../a/src/x.ts')).toMatch(/outside the project/);
    expect(call(join(A,'src','x.ts'))).toMatch(/outside the project/);
    fs.symlinkSync(join(A,'src'),join(B,'src','link'));
    expect(call('src/link/x.ts')).toMatch(/outside the project|alias/);
    expect(executionPathDenial({root:B,protectGit:true},m.accounts[0]!,'.git/config','write')).toMatch(/Git metadata/);
    expect(executionPathDenial({root:B,protectGit:true},m.accounts[0]!,'.git/hooks/x','write')).toMatch(/Git metadata/);
    expect(executionPathDenial({root:B,protectGit:true},m.accounts[0]!,'.GIT/config','write')).toMatch(/Git metadata/);
    expect(executionPathDenial({root:B,protectGit:true},m.accounts[0]!,'.git/config','read')).toBeUndefined();
    expect(executionPathDenial({root:B,protectGit:false},m.accounts[0]!,'.git/config','write')).toBeUndefined();
  });
  it('denies a knowledge locator keyed to the origin checkout',()=>{
    const m=portableManifest(A);ledger.create(m);
    const guard=new ExecutionGuard({ledger,manifestHash:manifestHash(m),agentId:'a',maxOutputTokens:100},B);
    expect(guard.brainContext().sourceDenial({locator:{path:'src/x.ts',projectKey:m.project.key}} as any)).toMatch(/another project/);
  });
  it('denies .git writes through the tool check when the identity is portable',()=>{
    const m=portableManifest(A);m.accounts[0]!.allowedPaths=[{path:'.',access:'write'}];m.accounts[1]!.allowedPaths=[{path:'.',access:'write'}];m.accounts[2]!.allowedPaths=[{path:'.',access:'read'}];
    expect(executionToolDenial({...m,project:{...m.project,root:A}},'a',{id:'1',name:'write_file',arguments:{path:'.git/config'}},A)).toMatch(/Git metadata/);
  });
});
