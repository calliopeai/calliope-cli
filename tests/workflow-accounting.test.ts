import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {ReservationLedger,requestCostNanos,type RequestReservation} from '../src/execution/index.js';
import {readRunAccounting,ExecutionStore,runOrchestrationCommand} from '../src/orchestration/index.js';
import {coordinatorProgress} from '../src/orchestration/progress.js';
import {workflowSnapshot,retainWorkflows} from '../src/ui/workflow-progress.js';
import {coordinatorRun} from './helpers/coordinator-run.js';

let root:string;
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-accounting-')));});
afterEach(()=>{config.resetConfig();vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
const request=(agentId='a'):RequestReservation=>({id:randomUUID(),agentId,provider:'deepseek',model:'public-toy',target:'b'.repeat(64),inputTokens:900,outputTokens:100,inputPrice:1,outputPrice:2,costNanos:requestCostNanos(900,100,1,2)});
it('accounts concurrent requests once per run and through ancestors, then refreshes HUD on settlement alone',async()=>{
  const {authority,store,project}=await coordinatorRun(root),{ledger,manifestHash}=authority,a=request(),b=request('b');
  const before=store.read();await Promise.all([a,b].map(r=>ledger.reserve(project,manifestHash,r)));
  const pending=readRunAccounting(store);expect(pending.status).toBe('available');if(pending.status!=='available')throw Error('Missing accounting');
  expect(pending.run).toMatchObject({accounted:{tokens:2000,costNanos:2200000},remaining:{tokens:2000,costNanos:37800000},requests:{pending:2}});
  expect(pending.accounts.coordinator!.accounted).toEqual(pending.run.accounted);expect(pending.accounts.a!.accounted.tokens).toBe(1000);expect(pending.accounts.b!.requests.pending).toBe(1);
  const prior=workflowSnapshot(coordinatorProgress(store));expect(prior.summary).toContain('accounted $0.0022/$0.0400');expect(prior.agents[0]!.label).toContain('(subtree)');
  await ledger.settle(project,manifestHash,{requestId:a.id,outcome:'success',usage:{inputTokens:10,outputTokens:2}});
  await ledger.settle(project,manifestHash,{requestId:b.id,outcome:'cancelled'});
  const restarted=new ExecutionStore(join(store.root,'..'),store.manifest),next=readRunAccounting(restarted);
  expect(next).toMatchObject({status:'available',run:{accounted:{tokens:1012,costNanos:1114000},requests:{settled:1,unknown:1,pending:0}},accounts:{a:{remaining:{tokens:988}},b:{remaining:{tokens:0}}}});
  expect(store.read()).toEqual(before);const after=workflowSnapshot(coordinatorProgress(restarted));expect(after.revision).toBe(prior.revision);expect(after.accountingRevision).not.toBe(prior.accountingRevision);
  const retained=retainWorkflows([prior],after);expect(retained[0]).toEqual(after);expect(retainWorkflows(retained,after)).toBe(retained);expect(after.summary).toContain('unknown 1');
  expect(JSON.stringify(next)).not.toMatch(/public-toy|target|quoteEvidence|inputPrice/);
});
it.each(['error','cancelled'] as const)('keeps %s and unfinished reservations charged after restart and cancelled inspection',async outcome=>{
  const {authority,store,project,runs,view}=await coordinatorRun(root),{ledger,manifestHash}=authority,r=request();await ledger.reserve(project,manifestHash,r);await ledger.settle(project,manifestHash,{requestId:r.id,outcome,usage:{inputTokens:0,outputTokens:0}});
  await ledger.reserve(project,manifestHash,request('b'));const expected=readRunAccounting(store),raw=fs.readFileSync(join(ledger.root,'history.json'),'utf8');
  vi.stubGlobal('fetch',vi.fn(()=>{throw Error('Inspection must not dispatch');}));const rows:string[]=[],options={cwd:project,store:runs,write:(line:string)=>rows.push(line)};
  for(const action of ['status','replay']){expect(await runOrchestrationCommand('run',[action,view.run.id,'--json'],options)).toBe(0);expect(JSON.parse(rows.at(-1)!).version).toBe(2);expect(JSON.parse(rows.at(-1)!).data.accounting).toEqual(expected);}
  const signal=AbortSignal.abort();expect(await runOrchestrationCommand('run',['status',view.run.id,'--json'],{...options,signal})).toBe(130);
  expect(fs.readFileSync(join(ledger.root,'history.json'),'utf8')).toBe(raw);expect(fetch).not.toHaveBeenCalled();
  expect(new ReservationLedger(ledger.root).read(project).projection.spent.tokens).toBe(2000);
});
it('reports exceeded usage without a negative balance or claiming the reservation was refunded',async()=>{
  const {authority,store,project}=await coordinatorRun(root),r=request();await authority.ledger.reserve(project,authority.manifestHash,r);
  await authority.ledger.settle(project,authority.manifestHash,{requestId:r.id,outcome:'success',usage:{inputTokens:1200,outputTokens:100}});
  expect(readRunAccounting(store)).toMatchObject({status:'available',exceeded:true,accounts:{a:{accounted:{tokens:1300},remaining:{tokens:0},requests:{exceeded:1}}}});
  expect(workflowSnapshot(coordinatorProgress(store)).summary).toContain('reservation exceeded');
});
it('makes damaged, missing and foreign budgets unavailable without hiding inspection or recreating history',async()=>{
  const {authority,store,project,runs,view}=await coordinatorRun(root),file=join(authority.ledger.root,'history.json'),original=fs.readFileSync(file,'utf8'),initial=workflowSnapshot(coordinatorProgress(store));
  const secondRoot=join(root,'second');fs.mkdirSync(secondRoot,{mode:0o700});const foreign=await coordinatorRun(secondRoot);const foreignRaw=fs.readFileSync(join(foreign.authority.ledger.root,'history.json'),'utf8');
  for(const raw of ['private malformed input',foreignRaw,null]){
    if(raw===null)fs.unlinkSync(file);else fs.writeFileSync(file,raw);
    const data=readRunAccounting(store);expect(data).toMatchObject({version:1,status:'unavailable'});expect(JSON.stringify(data)).not.toContain('private malformed input');
    const snapshot=workflowSnapshot(coordinatorProgress(store));expect(snapshot.summary).toContain('budget unavailable');expect(snapshot.summary).not.toContain('accounted $0');expect(retainWorkflows([initial],snapshot)[0]).toEqual(snapshot);
    const rows:string[]=[];expect(await runOrchestrationCommand('run',['status',view.run.id,'--json'],{cwd:project,store:runs,write:line=>rows.push(line)})).toBe(0);expect(JSON.parse(rows.at(-1)!).data.accounting.status).toBe('unavailable');
    expect(fs.existsSync(file)).toBe(raw!==null);if(raw!==null)expect(fs.readFileSync(file,'utf8')).toBe(raw);
  }
  const stopped:any[]=[];expect(await runOrchestrationCommand('agents',['stop','a','--run',view.run.id,'--json'],{cwd:project,store:runs,approve:async()=> 'allow',onProgress:value=>stopped.push(value),write:()=>{}})).toBe(0);expect(stopped.at(-1).accounting.status).toBe('unavailable');expect(fs.existsSync(file)).toBe(false);
  fs.writeFileSync(file,original,{mode:0o600});const mismatch=store.read();mismatch.header.deadline++;expect(readRunAccounting(store,mismatch).status).toBe('unavailable');expect(readRunAccounting(store).status).toBe('available');
});

it('retains accounting evidence when run inspection is denied by project identity',async()=>{
  const {authority,project,runs,view}=await coordinatorRun(root),r=request();await authority.ledger.reserve(project,authority.manifestHash,r);const before=authority.ledger.read(project);
  const elsewhere=join(root,'elsewhere');fs.mkdirSync(elsewhere);const rows:string[]=[];
  expect(await runOrchestrationCommand('run',['status',view.run.id,'--json'],{cwd:elsewhere,store:runs,write:line=>rows.push(line)})).toBe(3);
  expect(JSON.parse(rows.at(-1)!).data).toBeUndefined();expect(authority.ledger.read(project)).toEqual(before);
});

it('keeps very small accounted costs visible rather than rounding them to free usage',async()=>{
  const {authority,store,project}=await coordinatorRun(root),r=request();await authority.ledger.reserve(project,authority.manifestHash,r);await authority.ledger.settle(project,authority.manifestHash,{requestId:r.id,outcome:'success',usage:{inputTokens:1,outputTokens:0}});
  expect(workflowSnapshot(coordinatorProgress(store)).summary).toContain('accounted <$0.0001/');expect(readRunAccounting(store)).toMatchObject({status:'available',run:{accounted:{costNanos:1000}}});
});
