import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {ProjectSpendLedger} from '../src/execution/index.js';
vi.mock('node:fs',async original=>({...await original<typeof import('node:fs')>()}));
let root:string,file:string,store:ProjectSpendLedger;
beforeEach(()=>{root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-project-cost-')));file=join(root,'private','budget.json');store=new ProjectSpendLedger(file);});
afterEach(()=>{vi.restoreAllMocks();fs.rmSync(root,{recursive:true,force:true});});
it('imports prior spend and serializes competing run reservations without double spending',async()=>{
  fs.mkdirSync(join(root,'private'),{mode:0o700});fs.writeFileSync(file,JSON.stringify({spentUsd:1,updatedAt:new Date().toISOString()}));
  const ids=[randomUUID(),randomUUID()];const results=await Promise.allSettled(ids.map(id=>store.reserve(id,randomUUID(),1e9,2e9)));
  expect(results.filter(r=>r.status==='fulfilled')).toHaveLength(1);expect(store.read().spentUsd).toBe(2);expect(store.read().events[0]!.change.type).toBe('import');
  const winner=ids[results.findIndex(r=>r.status==='fulfilled')]!;await new ProjectSpendLedger(file).settle(winner,2e8);expect(store.read().spentUsd).toBe(1.2);
  store.charge(0.3);expect(store.read().spentUsd).toBe(1.5);expect(store.read().events.map(e=>e.change.type)).toEqual(['import','reserve','settle','charge']);expect(fs.statSync(file).mode&0o777).toBe(0o600);
});
it('retains unknown outcomes across restart and forbids resetting pending requests',async()=>{
  const id=randomUUID();await store.reserve(id,randomUUID(),100,100);
  expect(()=>store.reset()).toThrow(/Pending/);await store.settle(id,null);expect(new ProjectSpendLedger(file).read().spentUsd).toBe(1e-7);
  await expect(store.settle(id,0)).rejects.toMatchObject({code:'conflict'});
  const count=store.read().events.length;store.reset();expect(store.read().spentUsd).toBe(0);expect(store.read().events).toHaveLength(count+1);
});
it('freezes all runs after excess or invalid reported usage',async()=>{
  const id=randomUUID();await store.reserve(id,randomUUID(),100,1000);await store.settle(id,101);expect(store.read()).toMatchObject({blocked:true,spentUsd:101e-9});await expect(store.reserve(randomUUID(),randomUUID(),1,1000)).rejects.toMatchObject({code:'budget'});
  store.reset();const invalid=randomUUID();await store.reserve(invalid,randomUUID(),100,1000);await store.settle(invalid,null,true);expect(store.read().blocked).toBe(true);
});
it('fails closed on removed, malformed, forged, unsafe or symlinked history',async()=>{
  store.charge(1);const original=fs.readFileSync(file,'utf8');for(const raw of ['{','{}',original.replace('"spentUsd":1','"spentUsd":0')]){
    fs.writeFileSync(file,raw);expect(()=>store.read()).toThrow();expect(()=>store.charge(1)).toThrow();expect(()=>store.reset()).toThrow();expect(fs.readFileSync(file,'utf8')).toBe(raw);
  }
  fs.unlinkSync(file);expect(()=>store.read()).toThrow();await expect(store.reserve(randomUUID(),randomUUID(),1,1000)).rejects.toThrow();
  const outside=join(root,'outside');fs.writeFileSync(outside,original);fs.symlinkSync(outside,file);expect(()=>store.read()).toThrow();expect(fs.readFileSync(outside,'utf8')).toBe(original);
  fs.unlinkSync(file);fs.writeFileSync(file,original);fs.chmodSync(file,0o666);expect(()=>store.read()).toThrow();
});
it('preserves the last committed spend if settlement cannot be saved',async()=>{
  const id=randomUUID();await store.reserve(id,randomUUID(),100,1000);const original=fs.readFileSync(file,'utf8');vi.spyOn(fs,'renameSync').mockImplementationOnce(()=>{throw new Error('disk failure');});
  await expect(store.settle(id,0)).rejects.toThrow('disk failure');expect(fs.readFileSync(file,'utf8')).toBe(original);expect(store.read().spentUsd).toBe(1e-7);expect(()=>store.reset()).toThrow(/Pending/);
});
it('cancels waiting reservations without altering a foreign lock and rejects aliased directories',async()=>{
  store.charge(1);fs.writeFileSync(file+'.lock','foreign');const controller=new AbortController(),pending=store.reserve(randomUUID(),randomUUID(),1,2e9,controller.signal);controller.abort();await expect(pending).rejects.toMatchObject({name:'AbortError'});expect(fs.readFileSync(file+'.lock','utf8')).toBe('foreign');
  const alias=join(root,'alias');fs.symlinkSync(join(root,'private'),alias);await expect(new ProjectSpendLedger(join(alias,'new.json')).reserve(randomUUID(),randomUUID(),1,100)).rejects.toThrow();expect(fs.existsSync(join(root,'private/new.json'))).toBe(false);
});
it('retains legacy timestamps and refuses a damaged initialization marker or failed first commit',async()=>{
  fs.mkdirSync(join(root,'private'),{mode:0o700});const at='2026-01-01T00:00:00.000Z';fs.writeFileSync(file,JSON.stringify({spentUsd:1,updatedAt:at}));expect(store.read().updatedAt).toBe(at);fs.unlinkSync(file);
  vi.spyOn(fs,'renameSync').mockImplementationOnce(()=>{throw new Error('disk failure');});await expect(store.reserve(randomUUID(),randomUUID(),100,1000)).rejects.toThrow();expect(()=>store.read()).toThrow();
  fs.unlinkSync(file+'.initialized');fs.symlinkSync(join(root,'missing'),file+'.initialized');expect(()=>store.read()).toThrow();await expect(store.reserve(randomUUID(),randomUUID(),100,1000)).rejects.toThrow();expect(fs.existsSync(file)).toBe(false);
});
