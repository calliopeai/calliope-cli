import {join,resolve,relative,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import {canonicalPath,canonicalJson} from '../approvals/index.js';
import {authorizeSessionAction} from '../session-management/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {withScope,validatePath} from '../scope.js';
import {isPolicyEnabled} from '../policy.js';
import {getHooksForEvent} from '../hooks.js';
import {ReservationLedger,assertExecutionStoreOutsideProject,manifestHash,ExecutionLimitError} from '../execution/index.js';
import {inspectExecution} from '../orchestration/coordinator-actions.js';
import {RunStore} from '../orchestration/store.js';
import {readArtifactBytes} from '../orchestration/execution-store.js';
import {agentStopped,MAX_EXECUTION_BYTES,MAX_EXECUTION_EVENTS,MAX_EXECUTION_EVENT_BYTES} from '../orchestration/execution-journal.js';
import {bindPlan,analyzePlan,pathName} from '../orchestration/validation.js';
import {OrchestrationError} from '../orchestration/types.js';
import type {RunActionOptions} from '../orchestration/actions.js';
import type {ExecutionInspection} from '../orchestration/coordinator-types.js';
import type {CoordinatorOptions} from '../orchestration/coordinator.js';
import {inspectSpawnAuthority} from './authority.js';
import {SpawnProposalStore} from './store.js';
import {makeSpawnProposal,validateSpawnInput,validateSpawnProposal,proposalGrant,MAX_SPAWN_BYTES} from './validation.js';
import type {SpawnProposal,SpawnAdmission} from './types.js';
import {assertSupervisionProposal} from '../supervision/journal.js';
const bytesHash=(bytes:Buffer)=>createHash('sha256').update(bytes).digest('hex');
export interface SpawnActionOptions extends RunActionOptions {approve?:CoordinatorOptions['approve']}
function boundedOptions(options:SpawnActionOptions,signal:AbortSignal):SpawnActionOptions {
  const approve=options.approve;return{...options,signal,approve:approve?decision=>approve(decision,signal):undefined};
}

async function context(cwd:string,runId:string,options:RunActionOptions) {
  const runs=options.store??new RunStore(),initial=await inspectExecution(cwd,runId,{...options,store:runs});
  assertExecutionStoreOutsideProject(initial.view.manifest.project.root,runs.root);
  if(!initial.execution)throw new OrchestrationError('unavailable','Start the reviewed run before proposing children; its original budget and deadline must already exist.');
  const ledger=new ReservationLedger(join(runs.root,runId,'budget'));
  const goalAuthority=(await import('../goals/index.js')).goalRunAuthority(initial.view.manifest,runs.root);
  const signal=AbortSignal.any([...(options.signal?[options.signal]:[]),AbortSignal.timeout(Math.max(1,initial.execution.header.deadline-Date.now()))]);options={...options,signal};
  const assertActive=(view:ExecutionInspection)=>{throwIfCancelled(options.signal);initial.store.assertApproval(view.header);goalAuthority?.assertActive();if(Date.now()>=view.header.deadline)throw new ExecutionLimitError('deadline','Original run deadline expired.');};
  assertActive(initial.execution);return{...initial,ledger,assertActive,signal,proposals:new SpawnProposalStore(initial.store)};
}
/** Preview binds exact source bytes and the current graph without reserving capacity. */
export async function inspectSpawn(cwd:string,runId:string,path:string,options:SpawnActionOptions&{dryRun?:boolean}={}) {
  const current=await context(cwd,runId,options),root=current.view.manifest.project.root,file=resolve(root,path),sourcePath=relative(root,file);pathName(sourcePath);
  options={...boundedOptions(options,current.signal),dryRun:options.dryRun};
  if(canonicalPath(file)!==file||canonicalPath(dirname(file))!==dirname(file))throw new OrchestrationError('invalid','Child proposal must be a canonical project file.');
  withScope(root,()=>validatePath(file,root));
  if(options.dryRun){if(isPolicyEnabled()||getHooksForEvent('pre-tool').length)throw new OrchestrationError('policy-denied','Dry-run cannot evaluate executable policy or hooks.');}
  else await authorizeSessionAction(root,'read_file',{path:file,operation:'orchestration-child-proposal'},options);
  throwIfCancelled(options.signal);const bytes=readArtifactBytes(file,MAX_SPAWN_BYTES);let input:unknown;
  try{input=JSON.parse(bytes.toString());}catch{throw new OrchestrationError('invalid','Child proposal is not valid JSON.');}
  const authority=inspectSpawnAuthority(current.store,current.ledger);current.assertActive(authority.view);
  const proposal=makeSpawnProposal(current.store.manifest,authority.view.header,authority.context.plan,validateSpawnInput(input),{path:sourcePath,sha256:bytesHash(bytes)});
  bindPlan(analyzePlan({...authority.context.plan,agents:[...authority.context.plan.agents,...proposal.agents],tasks:[...authority.context.plan.tasks,...proposal.tasks]}),root);
  return{proposal,deadline:authority.view.header.deadline,budget:authority.budget.projection,pending:authority.pending.map(record=>record.grant.proposalHash)};
}

/** Review precedes all writes; replaying an approved proposal reuses its original allocation. */
export async function admitSpawn(cwd:string,runId:string,input:SpawnProposal|string,approvedHash:string,options:SpawnActionOptions={}) {
  const current=await context(cwd,runId,options),proposal=typeof input==='string'?current.proposals.read(input):structuredClone(input),recovery=typeof input==='string';
  options=boundedOptions(options,current.signal);
  if(proposal.hash!==approvedHash)throw new OrchestrationError('policy-denied','Child admission requires the exact reviewed proposal hash.');
  const before=current.store.read(),existing=before.state.graph?.admissions.find(a=>a.proposal.hash===proposal.hash);
  if(existing){if(canonicalJson(existing.proposal)!==canonicalJson(proposal))throw new OrchestrationError('conflict','Child proposal differs from its admitted graph.');return{admission:existing,execution:before,alreadyAdmitted:true};}
  validateSpawnProposal(proposal,current.store.manifest,before.header,current.store.context(before).plan);
  await authorizeSessionAction(cwd,'orchestration_spawn',{path:cwd,operation:`Admit ${proposal.agents.length} children and ${proposal.tasks.length} tasks under ${proposal.parentId}, proposal ${proposal.hash}, original deadline ${new Date(before.header.deadline).toISOString()}.`,runId,parentId:proposal.parentId,proposalHash:proposal.hash,graphHash:proposal.graphHash,source:proposal.source,agents:proposal.agents,tasks:proposal.tasks,recovery},{...options,confirmation:options.source==='repl'?'mutating':options.confirmation});
  const checkSource=()=>{if(proposal.source.kind==='supervision')assertSupervisionProposal(proposal,current.store.read().state);else if(!recovery){const file=resolve(current.store.manifest.project.root,proposal.source.path);if(bytesHash(readArtifactBytes(file,MAX_SPAWN_BYTES))!==proposal.source.sha256)throw new OrchestrationError('conflict','Child proposal source changed after review.');}};
  let admission:SpawnAdmission|undefined,alreadyAdmitted=false;
  await current.store.transaction(async prior=>{
    current.assertActive(prior);const authority=inspectSpawnAuthority(current.store,current.ledger,prior);
    const existing=prior.state.graph?.admissions.find(a=>a.proposal.hash===proposal.hash);
    if(existing){if(canonicalJson(existing.proposal)!==canonicalJson(proposal))throw new OrchestrationError('conflict','Child proposal changed.');admission=existing;alreadyAdmitted=true;return[];}
    validateSpawnProposal(proposal,current.store.manifest,prior.header,authority.context.plan);checkSource();
    bindPlan(analyzePlan({...authority.context.plan,agents:[...authority.context.plan.agents,...proposal.agents],tasks:[...authority.context.plan.tasks,...proposal.tasks]}),current.store.manifest.project.root);
    if(prior.state.status==='completed'||agentStopped(prior.state,authority.context,proposal.parentId)||Object.values(prior.state.tasks).some(task=>task.agentId===proposal.parentId&&task.escalation))throw new OrchestrationError('conflict','Parent is completed, stopped or escalated; no child admission is available.');
    const grant=proposalGrant(proposal,prior.header);if(grant.accounts.some(a=>Date.now()>=a.deadline))throw new ExecutionLimitError('deadline','Original child deadline expired.');
    const reserve=4*authority.context.plan.limits.maxConcurrent+(authority.context.plan.supervision?4:2);
    if(prior.events.length+reserve>MAX_EXECUTION_EVENTS||Buffer.byteLength(JSON.stringify({header:prior.header,events:prior.events}))+reserve*MAX_EXECUTION_EVENT_BYTES>MAX_EXECUTION_BYTES)throw new OrchestrationError('limit','Execution retention cannot admit more children.');
    current.proposals.save(proposal);
    const state=await current.ledger.grantChildren(cwd,manifestHash(authority.budget.manifest),grant,options.signal,()=>{current.assertActive(prior);checkSource();});
    const recorded=state.childGrants!.find(r=>r.grant.id===grant.id)!;admission={version:1,proposal,grant:recorded};
    return[{change:{type:'graph_admitted',admission}}];
  },options.signal,()=>{current.assertActive(current.store.read());checkSource();});
  return{admission:admission!,execution:current.store.read(),alreadyAdmitted};
}
