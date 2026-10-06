/** A headless child run (--ledger-url/--ledger-token-file/--ledger-agent) is admitted by the parent's ledger (#415). */
import {describe,it,expect,vi,beforeEach,afterEach} from 'vitest';
import * as fs from 'node:fs';
import type {Server} from 'node:http';
import type {AddressInfo} from 'node:net';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';

vi.mock('../src/config.js', async original => ({
  ...await original<typeof import('../src/config.js')>(),
  get: vi.fn((key: string) => key === 'maxIterations' ? 10 : key === 'audit' ? {enabled:false} : undefined),
}));
const captured: Array<Record<string, unknown>> = [];
vi.mock('../src/runtime/index.js', async original => ({
  ...await original<typeof import('../src/runtime/index.js')>(),
  runTurn: vi.fn(async (options: Record<string, unknown>) => { captured.push(options); throw new Error('stop after capture'); }),
}));

import {runHeadless} from '../src/headless.js';
import {ReservationLedger,manifestHash,createLedgerServer,LedgerServerState,mintLedgerToken,ExecutionGuard,type ChildGrant,type AgentExecution} from '../src/execution/index.js';
import {executionManifest} from './helpers/execution-manifest.js';

let root:string,project:string,server:Server,url:string,parent:string,hash:string,ledger:ReservationLedger,manifest:ReturnType<typeof executionManifest>;
beforeEach(async()=>{
  captured.length=0;
  root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-headless-child-')));fs.chmodSync(root,0o700);project=join(root,'project');fs.mkdirSync(project);
  manifest=executionManifest(project);manifest.tokenBudget=manifest.accounts[0]!.tokenBudget=10000;manifest.costBudgetNanos=manifest.accounts[0]!.costBudgetNanos=50000000;
  ledger=new ReservationLedger(join(root,'budget'));ledger.create(manifest);hash=manifestHash(manifest);
  const state=new LedgerServerState(join(root,'ledger-server'));parent=mintLedgerToken(state.secret(),{v:1,run:manifest.runId,role:'parent',exp:manifest.deadline});
  server=createLedgerServer({ledger,cwd:project,state});await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));url=`http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  vi.spyOn(process.stdout,'write').mockImplementation(()=>true);vi.spyOn(process.stderr,'write').mockImplementation(()=>true);
});
afterEach(async()=>{vi.restoreAllMocks();await new Promise(r=>server.close(r));fs.rmSync(root,{recursive:true,force:true});});

const grantChild=async()=>{
  const g:ChildGrant={version:1,id:randomUUID(),proposalHash:'b'.repeat(64),previousGraphHash:manifest.planHash,planHash:'c'.repeat(64),runManifestHash:'d'.repeat(64),approvalRevision:randomUUID(),parentId:'root',
    accounts:[{...structuredClone(manifest.accounts[1]!),id:'child',parentId:'root',tokenBudget:2000,costBudgetNanos:5000000}]};
  const r=await fetch(`${url}/v1/grant`,{method:'POST',headers:{authorization:`Bearer ${parent}`},body:JSON.stringify({manifestHash:hash,grant:g})});
  const token=(await r.json() as {token:string}).token,file=join(root,'child.token');fs.writeFileSync(file,token,{mode:0o600});return {g,file};
};

describe('headless delegated child',()=>{
  it('runs the turn under the parent ledger for its granted account',async()=>{
    const {file}=await grantChild();
    await runHeadless({prompt:'work',outputMode:'json',cwd:project,ledger:{url,tokenFile:file,agentId:'child'}});
    expect(captured).toHaveLength(1);
    const execution=captured[0]!.execution as AgentExecution;
    expect(execution).toMatchObject({agentId:'child',manifestHash:hash});
    // The guard built from it inherits the child's grant, not the root's authority.
    const guard=new ExecutionGuard(execution,project);expect(guard.manifest.accounts.map(a=>a.id)).toContain('child');
  });
  it('refuses to start when the parent has revoked the child',async()=>{
    const {g,file}=await grantChild();
    await fetch(`${url}/v1/revoke`,{method:'POST',headers:{authorization:`Bearer ${parent}`},body:JSON.stringify({grant:g.id})});
    expect(await runHeadless({prompt:'work',outputMode:'json',cwd:project,ledger:{url,tokenFile:file,agentId:'child'}})).toBe(1);
    expect(captured).toHaveLength(0);
  });
});
