import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { RunStore, analyzePlan, replayRun, validateRunEvent, validateRunManifest } from '../src/orchestration/index.js';
import { canonicalJson, digest } from '../src/approvals/index.js';
import { toyPlan } from './helpers/orchestration-plan.js';
vi.mock('node:fs', async original => ({...await original<typeof import('node:fs')>()}));
let root: string, project: string, store: RunStore;
beforeEach(() => { root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-run-store-'))); project = join(root,'project'); fs.mkdirSync(project); store = new RunStore(join(root,'store')); });
afterEach(() => { vi.restoreAllMocks(); fs.rmSync(root,{recursive:true,force:true}); });
const prepare = () => store.prepare(analyzePlan(toyPlan()),project,{path:'plan.json',sha256:'a'.repeat(64)});
it('persists an inactive run and replays approval/cancellation after separate store instances restart', async () => {
  expect(await store.list(project)).toEqual({runs:[],unavailable:0}); const initial = await prepare();
  expect(initial.run).toMatchObject({status:'prepared',approval:'pending',eventCount:1,executedTasks:0});
  const restarted = new RunStore(store.root); expect((await restarted.read(initial.run.id,project)).run).toEqual(initial.run);
  const approved = await restarted.transition(initial.run.id,project,initial.run.revision,{type:'approved',source:'cli'});
  expect(approved.run).toMatchObject({status:'approved',approval:'approved',eventCount:2,executedTasks:0});
  expect(approved.events[0]).toEqual(initial.events[0]);
  const cancelled = await store.transition(initial.run.id,project,approved.run.revision,{type:'cancelled',source:'repl'});
  expect(replayRun(cancelled.manifest,cancelled.events)).toEqual(cancelled.run); expect(cancelled.run.approval).toBe('revoked');
  expect((await store.list(project)).runs).toEqual([cancelled.run]);
  const dir = join(store.root,initial.run.id); expect(fs.statSync(dir).mode & 0o777).toBe(0o700);
  for (const file of ['manifest.json','head.json',`events/${initial.run.revision}.json`]) expect(fs.statSync(join(dir,file)).mode & 0o777).toBe(0o600);
  await expect(store.transition(initial.run.id,project,cancelled.run.revision,{type:'approved',source:'cli'})).rejects.toMatchObject({code:'conflict'});
});
it('rejects stale writers and leaves foreign locks untouched', async () => {
  const initial = await prepare(), dir = join(store.root,initial.run.id);
  fs.writeFileSync(join(dir,'writer.lock'),'another writer');
  await expect(store.transition(initial.run.id,project,initial.run.revision,{type:'approved',source:'cli'})).rejects.toMatchObject({code:'locked'});
  expect(fs.readFileSync(join(dir,'writer.lock'),'utf8')).toBe('another writer'); fs.unlinkSync(join(dir,'writer.lock'));
  const results = await Promise.allSettled([0,1].map(() => store.transition(initial.run.id,project,initial.run.revision,{type:'approved',source:'cli'})));
  expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1);
  const saved = await store.read(initial.run.id,project); expect(saved.events).toHaveLength(2);
  await expect(store.transition(initial.run.id,project,initial.run.revision,{type:'cancelled',source:'cli'})).rejects.toMatchObject({code:'conflict'});
  expect((await store.read(initial.run.id,project)).events).toEqual(saved.events);
  fs.writeFileSync(join(store.root,'create.lock'),'another preparation'); await expect(prepare()).rejects.toMatchObject({code:'locked'});
  expect(fs.readFileSync(join(store.root,'create.lock'),'utf8')).toBe('another preparation');
});
it('preserves the prior commit and orphan evidence after interruption and never adopts an uncommitted approval', async () => {
  const initial = await prepare(), dir = join(store.root,initial.run.id), head = fs.readFileSync(join(dir,'head.json'),'utf8');
  vi.spyOn(fs,'renameSync').mockImplementationOnce(() => { throw new Error('disk failure'); });
  await expect(store.transition(initial.run.id,project,initial.run.revision,{type:'approved',source:'cli'})).rejects.toThrow('disk failure');
  expect(fs.readFileSync(join(dir,'head.json'),'utf8')).toBe(head); expect(fs.readdirSync(join(dir,'events'))).toHaveLength(2);
  expect((await new RunStore(store.root).read(initial.run.id,project)).run.status).toBe('prepared');
  expect(fs.readdirSync(dir).some(name => name.endsWith('.lock') || name.endsWith('.tmp'))).toBe(false);
  const cancelled = await store.transition(initial.run.id,project,initial.run.revision,{type:'cancelled',source:'cli'});
  expect(cancelled.events.map(event => event.change.type)).toEqual(['prepared','cancelled']); expect(fs.readdirSync(join(dir,'events'))).toHaveLength(3);
});
it('cancels before mutation and during asynchronous journal reads', async () => {
  await expect(store.prepare(analyzePlan(toyPlan()),project,{path:'plan.json',sha256:'a'.repeat(64)},AbortSignal.abort())).rejects.toMatchObject({name:'AbortError'});
  expect(fs.existsSync(store.root)).toBe(false); const initial = await prepare();
  const controller = new AbortController(), pending = store.read(initial.run.id,project,controller.signal); controller.abort();
  await expect(pending).rejects.toMatchObject({name:'AbortError'});
  await expect(store.transition(initial.run.id,project,initial.run.revision,{type:'approved',source:'cli'},AbortSignal.abort())).rejects.toMatchObject({name:'AbortError'});
  await expect(store.list(project,AbortSignal.abort())).rejects.toMatchObject({name:'AbortError'});
  expect((await store.read(initial.run.id,project)).run.status).toBe('prepared');
});
it('refuses another project or a replaced project identity', async () => {
  const initial = await prepare(), foreign = join(root,'foreign'); fs.mkdirSync(foreign);
  await expect(store.read(initial.run.id,foreign)).rejects.toMatchObject({code:'policy-denied'}); expect((await store.list(foreign)).runs).toEqual([]);
  fs.renameSync(project,join(root,'old-project')); fs.mkdirSync(project);
  await expect(store.read(initial.run.id,project)).rejects.toMatchObject({code:'policy-denied'});
});
it('rejects malformed, forged and symlinked records without replacing them', async () => {
  const initial = await prepare(), dir = join(store.root,initial.run.id), file = join(dir,'head.json'), original = fs.readFileSync(file,'utf8');
  for (const raw of ['{','null','{}',original.replace('"version":1','"version":2')]) {
    fs.writeFileSync(file,raw); await expect(store.read(initial.run.id,project)).rejects.toThrow();
    await expect(store.transition(initial.run.id,project,initial.run.revision,{type:'approved',source:'cli'})).rejects.toThrow(); expect(fs.readFileSync(file,'utf8')).toBe(raw);
  }
  expect((await store.list(project)).unavailable).toBe(1); fs.writeFileSync(file,original);
  const event = join(dir,'events',initial.run.revision+'.json'), originalEvent = fs.readFileSync(event,'utf8');
  fs.writeFileSync(event,originalEvent.replace('"prepared"','"approved"')); await expect(store.read(initial.run.id,project)).rejects.toThrow(); fs.writeFileSync(event,originalEvent);
  const outside = join(root,'outside'); fs.writeFileSync(outside,'outside'); fs.unlinkSync(file); fs.symlinkSync(outside,file);
  await expect(store.read(initial.run.id,project)).rejects.toThrow(); expect(fs.readFileSync(outside,'utf8')).toBe('outside');
  fs.unlinkSync(file); fs.writeFileSync(file,original,{mode:0o600}); fs.chmodSync(file,0o644); await expect(store.read(initial.run.id,project)).rejects.toThrow();
});
it('checks event shape, causal links and manifest digests independently of cached state', async () => {
  const initial = await prepare(); expect(validateRunManifest(initial.manifest)).toEqual(initial.manifest); expect(validateRunEvent(initial.events[0])).toEqual(initial.events[0]);
  const resign = (value: any) => { const {hash,...body} = value; return {...body,hash:digest(canonicalJson(body))}; };
  for (const mutate of [(v: any) => {v.version=2;},(v: any) => {v.project.key='bad';},(v: any) => {v.planHash='b'.repeat(64);},(v: any) => {v.extra=true;}]) {
    const invalid=structuredClone(initial.manifest); mutate(invalid); expect(() => validateRunManifest(resign(invalid))).toThrow();
  }
  for (const mutate of [(v: any) => {v.sequence=0;},(v: any) => {v.previous={id:randomUUID(),hash:'b'.repeat(64)};},(v: any) => {v.change={type:'prepared',manifestHash:'b'.repeat(64)};},(v: any) => {v.runId=randomUUID();},(v: any) => {v.change={type:'approved',source:'agent'};}]) {
    const invalid=structuredClone(initial.events[0]!); mutate(invalid); expect(() => replayRun(initial.manifest,[resign(invalid)])).toThrow();
  }
  expect(() => replayRun(initial.manifest,[])).toThrow(); expect(() => replayRun(initial.manifest,[initial.events[0]!,initial.events[0]!])).toThrow();
});
it('rejects unsafe store directories and oversized evidence files', async () => {
  const initial = await prepare(), dir = join(store.root,initial.run.id);
  fs.writeFileSync(join(dir,'events',randomUUID()+'.json'),'x'.repeat(4097),{mode:0o600}); await expect(store.read(initial.run.id,project)).rejects.toThrow();
  const unsafe = join(root,'unsafe'); fs.symlinkSync(store.root,unsafe); await expect(new RunStore(unsafe).list(project)).rejects.toThrow();
  await expect(store.read('../outside',project)).rejects.toThrow(/UUID/);
});
it('refuses a symlinked store parent before creating anything outside its declared location', async () => {
  const outside=join(root,'outside-dir'), alias=join(root,'alias-parent'); fs.mkdirSync(outside); fs.symlinkSync(outside,alias);
  await expect(new RunStore(join(alias,'new-store')).prepare(analyzePlan(toyPlan()),project,{path:'plan.json',sha256:'a'.repeat(64)})).rejects.toThrow();
  expect(fs.readdirSync(outside)).toEqual([]);
});
it('detects a store or project directory replacement while a read yields', async () => {
  const initial=await prepare(), before=join(root,'old-store'); const pending=store.read(initial.run.id,project);
  fs.renameSync(store.root,before); fs.mkdirSync(store.root,{mode:0o700});
  await expect(pending).rejects.toThrow(); fs.rmSync(store.root,{recursive:true,force:true}); fs.renameSync(before,store.root);
  const reading=store.read(initial.run.id,project); fs.renameSync(project,join(root,'old-project')); fs.mkdirSync(project);
  await expect(reading).rejects.toMatchObject({code:'policy-denied'});
});
