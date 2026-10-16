import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {spawnSync} from 'node:child_process';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomUUID} from 'node:crypto';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {executionManifest} from './helpers/execution-manifest.js';
import {ReservationLedger,manifestHash,LedgerServerState,mintLedgerToken,verifyLedgerToken,createLedgerServer,type LedgerTokenClaims,type ChildGrant} from '../src/execution/index.js';

let root:string,project:string,ledger:ReservationLedger,state:LedgerServerState,server:Server,url:string,run:string,deadline:number,hash:string;
beforeEach(async()=>{
  root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-owner-scope-')));project=join(root,'project');fs.mkdirSync(project);
  const manifest=executionManifest(project);ledger=new ReservationLedger(join(root,'budget'));ledger.create(manifest);run=manifest.runId;deadline=manifest.deadline;hash=manifestHash(manifest);state=new LedgerServerState(join(root,'server'));
  server=createLedgerServer({ledger,cwd:project,state});await new Promise<void>(resolve=>server.listen(0,'127.0.0.1',resolve));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async()=>{
  vi.restoreAllMocks();await new Promise<void>(resolve=>server.close(()=>resolve()));
  if(process.platform==='darwin'){const open=spawnSync('/usr/sbin/lsof',['-nP','+D',root],{encoding:'utf8'});expect({status:open.status,stdout:open.stdout,stderr:open.stderr}).toEqual({status:1,stdout:'',stderr:''});}
  fs.rmSync(root,{recursive:true,force:true});
});
const owner=(id='a')=>mintLedgerToken(state.secret(),{v:2,role:'parent',run,owner:id,exp:deadline});
const post=async(token:string,op:string,body:object)=>{const response=await fetch(`${url}/v1/${op}`,{method:'POST',headers:{authorization:`Bearer ${token}`},body:JSON.stringify(body)});return {status:response.status,body:await response.json() as {ok:boolean;token?:string;code?:string}};};
function grant(parentId='a'):ChildGrant{
  const saved=ledger.read(project),parent=saved.manifest.accounts.find(a=>a.id===parentId)!;
  return {version:1,id:randomUUID(),proposalHash:randomUUID().replaceAll('-','').padEnd(64,'0'),previousGraphHash:saved.projection.childGrants?.at(-1)?.grant.planHash??saved.manifest.planHash,planHash:randomUUID().replaceAll('-','').padEnd(64,'0'),runManifestHash:'a'.repeat(64),approvalRevision:randomUUID(),parentId,accounts:[{...parent,id:'child-'+parentId,parentId,tokenBudget:100,costBudgetNanos:1000}]};
}
it('scope-only parent tokens stay inside their subtree even at an unrestricted server',async()=>{
  const a=owner(),child=grant(),issued=await post(a,'grant',{manifestHash:hash,grant:child});expect(issued.status).toBe(200);
  const sibling=grant('b');expect((await post(a,'grant',{manifestHash:hash,grant:sibling})).status).toBe(403);
  expect((await post(owner('b'),'grant',{manifestHash:hash,grant:sibling})).status).toBe(200);
  expect((await post(a,'revoke',{grant:sibling.id})).status).toBe(403);expect(state.isRevoked(sibling.id)).toBe(false);
  expect((await post(a,'revoke',{grant:child.id})).status).toBe(200);expect(state.isRevoked(child.id)).toBe(true);
});
it.each([
  {v:1,owner:'a'},{v:2,owner:undefined},{v:2,owner:'../a'},
  {v:1,authority:'a'.repeat(64)},{v:2,owner:'a',authority:'bad'},
  {v:2,role:'child',owner:undefined,grant:randomUUID(),epoch:1,accounts:['a']},
  {v:1,role:'child',owner:undefined,grant:randomUUID(),epoch:0,accounts:['a']},
])('rejects malformed version/scope claims %#',async patch=>{
  const token=mintLedgerToken(state.secret(),{v:2,role:'parent',run,owner:'a',exp:deadline,...patch} as LedgerTokenClaims);
  expect(()=>verifyLedgerToken(state.secret(),token,run)).toThrow();expect((await post(token,'hello',{})).status).toBe(403);
});
it('revocation serializes independent writers without forgetting prior fences',()=>{
  const first=randomUUID(),second=randomUUID(),other=new LedgerServerState(state.dir),lock=join(state.dir,'writer.lock');
  expect(state.revoke(first)).toBe(2);fs.writeFileSync(lock,String(process.pid),{mode:0o600,flag:'wx'});
  try{expect(()=>other.revoke(second)).toThrow(/another writer/);expect(other.isRevoked(first)).toBe(true);expect(other.isRevoked(second)).toBe(false);}finally{fs.unlinkSync(lock);}
  expect(other.revoke(second)).toBe(2);expect(state.revoke(first)).toBe(3);expect(state.epochs()).toEqual({[first]:3,[second]:2});
});
it.each(['bad-json','bad-shape','bad-epoch','symlink','public'] as const)('does not overwrite %s revocation state',kind=>{
  const id=randomUUID();state.revoke(id);const file=join(state.dir,'epochs.json');
  if(kind==='bad-json')fs.writeFileSync(file,'{');
  if(kind==='bad-shape')fs.writeFileSync(file,'[]');
  if(kind==='bad-epoch')fs.writeFileSync(file,JSON.stringify({[id]:-1}));
  if(kind==='symlink'){const original=join(root,'epochs.json');fs.renameSync(file,original);fs.symlinkSync(original,file);}
  if(kind==='public'){if(process.platform==='win32')return;fs.chmodSync(file,0o644);}
  const before=fs.readFileSync(file);expect(()=>state.revoke(randomUUID())).toThrow(/damaged/);expect(fs.readFileSync(file)).toEqual(before);expect(fs.existsSync(join(state.dir,'writer.lock'))).toBe(false);
});
it.each(['symlink','truncated','public'] as const)('rejects a %s signing key without replacing it',kind=>{
  const file=join(state.dir,'server.key');
  if(kind==='symlink'){const original=join(root,'key');fs.renameSync(file,original);fs.symlinkSync(original,file);}
  if(kind==='truncated')fs.writeFileSync(file,'x');
  if(kind==='public'){if(process.platform==='win32')return;fs.chmodSync(file,0o644);}
  const before=fs.readFileSync(file);expect(()=>state.secret()).toThrow(/key is damaged/);expect(fs.readFileSync(file)).toEqual(before);
});

it('never recreates missing revocation history beside a retained signing key',()=>{
  const id=randomUUID();state.revoke(id);const key=fs.readFileSync(join(state.dir,'server.key'));fs.unlinkSync(join(state.dir,'epochs.json'));
  const restarted=new LedgerServerState(state.dir);expect(()=>restarted.secret()).toThrow(/epochs are damaged/);expect(()=>restarted.revoke(randomUUID())).toThrow(/epochs are damaged/);
  expect(fs.readFileSync(join(state.dir,'server.key'))).toEqual(key);expect(fs.existsSync(join(state.dir,'epochs.json'))).toBe(false);
});
it('recovers only a confirmed dead state writer and retains every revocation',()=>{
  const first=randomUUID(),second=randomUUID();state.revoke(first);
  const dead=spawnSync(process.execPath,['-e',''],{encoding:'utf8'});expect(dead.status).toBe(0);
  fs.writeFileSync(join(state.dir,'writer.lock'),String(dead.pid),{mode:0o600,flag:'wx'});
  expect(state.revoke(second)).toBe(2);expect(state.epochs()).toEqual({[first]:2,[second]:2});
  expect(fs.existsSync(join(state.dir,'writer.lock'))).toBe(false);
});
it('refuses epoch overflow without forgetting a fence or leaving a writer lock',()=>{
  const id=randomUUID(),file=join(state.dir,'epochs.json');fs.writeFileSync(file,JSON.stringify({[id]:Number.MAX_SAFE_INTEGER}),{mode:0o600});const before=fs.readFileSync(file);
  expect(()=>state.revoke(id)).toThrow(/retention/);expect(fs.readFileSync(file)).toEqual(before);expect(fs.existsSync(join(state.dir,'writer.lock'))).toBe(false);
});

it('does not rotate a missing signing key while retaining the old revocation history',()=>{
  const file=join(state.dir,'server.key'),history=fs.readFileSync(join(state.dir,'epochs.json'));fs.unlinkSync(file);
  expect(()=>new LedgerServerState(state.dir).secret()).toThrow(/key is missing/);expect(fs.existsSync(file)).toBe(false);expect(fs.readFileSync(join(state.dir,'epochs.json'))).toEqual(history);
});
