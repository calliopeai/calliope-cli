import {canonicalJson,digest} from '../approvals/index.js';
import {array,fail,hex,integer,shape,text,uuid} from '../orchestration/validation.js';
import {supervisionProposalHash} from './approval.js';
import type {ProjectPlan,RunManifest} from '../orchestration/types.js';
import type {ExecutionEvent,ExecutionProjection} from '../orchestration/coordinator-types.js';
import {validateSupervisionDecision} from './contracts.js';
import {validateSupervisionHealthEvidence} from './health.js';
import type {SupervisionChange,SupervisionProjection,RetryReceipt} from './types.js';
import type {SpawnProposal} from '../spawning/types.js';

export function newSupervision():SupervisionProjection {
  return{version:1,rounds:0,stalledRounds:0,phase:'ready',evidenceIds:[],evidenceHash:null,reviewedHash:null,completedTasks:0,forceReview:false,operatorReview:false,review:null,active:null,draft:null,decision:null,decisionId:null,halt:null,strategies:Object.create(null)};
}
export function supervisionEvidence(events:ExecutionEvent[]):{ids:string[];hash:string} {
  const latest=new Map<string,string>();
  for(const event of events)if(event.change.type==='task_finished'||event.change.type==='task_accepted')latest.set(event.change.taskId,event.id);
  const ids=[...latest.values()];return{ids,hash:digest(canonicalJson(ids))};
}
export function validateSupervisionChange(value:unknown,plan:ProjectPlan):SupervisionChange {
  if(!plan.supervision)fail('Supervision events require a reviewed supervision policy.');
  shape(value,['type'],['round','role','agentId','sessionId','evidenceIds','evidenceHash','health','decision','decisionId','receipts','outcome','reason','source','proposalHash','requestAttribution']);
  if(value.requestAttribution!==undefined&&(value.type!=='supervision_started'||value.requestAttribution!==1))fail('Invalid supervision request attribution.');
  if(value.type==='supervision_started'||value.type==='supervision_decided'){
    shape(value,['type','round','role','agentId','sessionId',...(value.type==='supervision_started'?['evidenceIds','evidenceHash']:['decision'])],value.type==='supervision_started'?['health','requestAttribution']:[]);
    integer(value.round,1,plan.supervision.maxRounds);
    if(!['controller','reviewer'].includes(String(value.role))||value.agentId!==(value.role==='controller'?plan.supervision.controllerId:plan.supervision.reviewerId))fail('Controller event does not match its reviewed agent.');
    text(value.sessionId,128);if(!/^[a-zA-Z0-9_-]+$/.test(value.sessionId))fail('Invalid controller session.');
    if(value.type==='supervision_started'){
      array(value.evidenceIds,1024,1);
      if(value.evidenceIds.some(ref=>!uuid(ref))||new Set(value.evidenceIds).size!==value.evidenceIds.length||!hex(value.evidenceHash)||value.evidenceHash!==digest(canonicalJson(value.evidenceIds)))fail('Invalid controller evidence snapshot.');
      if(value.health!==undefined)validateSupervisionHealthEvidence(value.health);
    }
  }else if(value.type==='supervision_applied'){
    shape(value,['type','round','decisionId','receipts']);integer(value.round,1,plan.supervision.maxRounds);
    if(!uuid(value.decisionId))fail('Invalid controller decision reference.');array(value.receipts,8);
    for(const receipt of value.receipts){
      shape(receipt,['artifactId','sha256','exitCode','outcome','cleanupConfirmed']);text(receipt.artifactId,64);integer(receipt.exitCode,-1,2147483647);
      if(!hex(receipt.sha256)||!['passed','failed','timeout'].includes(String(receipt.outcome))||receipt.cleanupConfirmed!==true)fail('Automatic retries require confirmed verification cleanup.');
    }
  }else if(value.type==='supervision_halted'){
    shape(value,['type','round','outcome','reason']);integer(value.round,0,plan.supervision.maxRounds);text(value.reason);
    if(!['stop','limit','failed','denied','cancelled','interrupted'].includes(String(value.outcome)))fail('Invalid supervision stop reason.');
  }else if(value.type==='supervision_proposed'||value.type==='supervision_approved'){
    shape(value,['type','decisionId','proposalHash','source']);if(!uuid(value.decisionId)||!hex(value.proposalHash)||!['cli','repl'].includes(String(value.source)))fail('Improvement review requires an exact proposal hash and operator source.');
  }else if(value.type==='supervision_withdrawn'){
    shape(value,['type','decisionId','source']);if(!uuid(value.decisionId)||!['cli','repl'].includes(String(value.source)))fail('Improvement withdrawal requires an explicit operator and decision ID.');
  }else if(value.type==='supervision_reset'){
    shape(value,['type','source']);if(!['cli','repl'].includes(String(value.source)))fail('Controller recovery requires an explicit operator action.');
  }else fail('Unknown supervision event.');
  return value as unknown as SupervisionChange;
}

/** Replay checks references; the executor checks artifact bytes immediately before applying. */
export function assertSupervisedRetry(plan:ProjectPlan,state:ExecutionProjection,events:ExecutionEvent[],taskId:string,receipts?:RetryReceipt[]):void {
  const task=state.tasks[taskId],spec=plan.tasks.find(value=>value.id===taskId),agent=plan.agents.find(value=>value.id===spec?.agentId);
  const retainedPartial=task?.status==='review_required'&&/truncat/i.test(task.output?.summary??'')&&task.output?.checks?.length&&task.output.checks.every(check=>check.passed);
  if(!task||!spec||!agent||!(task.status==='failed'||retainedPartial)||task.escalation||task.attempts>agent.escalationPolicy.maxRetries||plan.tasks.some(other=>other.dependencies.includes(taskId)&&state.tasks[other.id]!.attempts>0))fail('Supervised retry requires a failed, unconsumed task with attempts remaining.');
  let ancestor=agent;for(let n=0;n<plan.agents.length;n++){
    if(state.stoppedAgents.includes(ancestor.id)||Object.values(state.tasks).some(t=>t.agentId===ancestor.id&&t.escalation))fail('A stopped or escalated agent cannot be retried automatically.');
    const parent=plan.agents.find(value=>value.id===ancestor.parentId);if(!parent)break;ancestor=parent;
  }
  let lastStart=-1;for(let i=events.length-1;i>=0;i--)if(events[i]!.change.type==='task_started'&&'taskId' in events[i]!.change&&(events[i]!.change as {taskId:string}).taskId===taskId){lastStart=i;break;}
  const tools=new Map<string,{name:string;finished:boolean}>();
  for(const event of events.slice(lastStart+1))if(event.change.type==='tool'&&event.change.taskId===taskId){const c=event.change;if(c.stage==='started')tools.set(c.callId,{name:c.name,finished:false});else if(tools.has(c.callId))tools.get(c.callId)!.finished=true;}
  if(task.mutations&&(!plan.workspace.isolation||!spec.isolation||[...tools.values()].some(tool=>!tool.finished)))fail('Uncertain mutation outcomes require explicit recovery.');
  if(receipts===undefined)return;
  const artifacts=task.output?.artifacts??[],shellCount=[...tools.values()].filter(tool=>tool.name==='shell').length;
  if(task.mutations&&(!shellCount||receipts.length!==shellCount||!artifacts.some(a=>a.id===spec.isolation?.patchArtifactId))||!task.mutations&&receipts.length)fail('An isolated retry requires its original verification and patch evidence.');
  if(new Set(receipts.map(receipt=>receipt.artifactId)).size!==receipts.length)fail('Duplicate retry evidence.');
  for(const receipt of receipts)if(!spec.isolation?.commands.some(command=>command.artifactId===receipt.artifactId)||!artifacts.some(artifact=>artifact.id===receipt.artifactId&&artifact.sha256===receipt.sha256&&artifact.kind==='test_result'))fail('Retry receipts differ from the recorded task artifacts.');
}

export function replaySupervisionChange(event:ExecutionEvent,plan:ProjectPlan,state:ExecutionProjection,prior:ExecutionEvent[],createdAt:number,manifest:RunManifest):void {
  const c=validateSupervisionChange(event.change,plan),s=state.supervision!,policy=plan.supervision!;
  const active=()=>{if(state.status!=='running'||!state.ownerId||Object.values(state.tasks).some(task=>task.status==='running'))fail('Supervision requires an owned execution barrier with no active workers.');};
  if(c.type==='supervision_withdrawn'){
    if(state.ownerId||!['ready','decision','halted'].includes(s.phase))fail('Stop active execution before withdrawing an improvement.');
    if(s.decisionId&&s.decisionId!==c.decisionId)fail('Resolve the current pending decision before withdrawing an older improvement.');
    const target=prior.find(e=>e.id===c.decisionId),change=target?.change;
    if(change?.type!=='supervision_decided'||change.role==='controller'&&policy.reviewerId||!('hypothesis'in change.decision)||prior.some(e=>e.change.type==='supervision_withdrawn'&&e.change.decisionId===c.decisionId))fail('Withdrawal requires an unwithdrawn final improvement decision.');
    const d=change.decision;
    if(d.action==='replan'&&s.strategies[d.taskId]?.decisionId===c.decisionId){
      const withdrawn=new Set(prior.filter(e=>e.change.type==='supervision_withdrawn').map(e=>(e.change as Extract<SupervisionChange,{type:'supervision_withdrawn'}>).decisionId));withdrawn.add(c.decisionId);
      delete s.strategies[d.taskId];
      for(const applied of [...prior].reverse())if(applied.change.type==='supervision_applied'&&!withdrawn.has(applied.change.decisionId)){
        const decision=prior.find(e=>e.id===(applied.change as Extract<SupervisionChange,{type:'supervision_applied'}>).decisionId),value=decision?.change;
        if(value?.type==='supervision_decided'&&value.decision.action==='replan'&&value.decision.taskId===d.taskId){s.strategies[d.taskId]={decisionId:decision!.id,strategy:value.decision.strategy,evidence:[...value.decision.evidence]};break;}
      }
    }
    if(d.action==='decompose')for(const agent of d.children.agents)if(state.graph?.plan.agents.some(a=>a.id===agent.id)&&!state.stoppedAgents.includes(agent.id))state.stoppedAgents.push(agent.id);
    // A withdrawal is a restriction: retain evidence, allocations and task outcomes, then stop.
    s.phase='halted';s.operatorReview=false;s.review=null;s.active=null;s.decision=null;s.decisionId=null;s.draft=null;s.halt={outcome:'stop',reason:'An improvement was withdrawn by the operator; inspect retained results before explicit recovery.'};return;
  }
  if(c.type==='supervision_reset'){
    if(state.ownerId||s.phase!=='halted'||!s.decision&&s.rounds>=policy.maxRounds||Date.parse(event.at)>=state.deadline)fail('Controller recovery requires an inactive, unexpired run with rounds remaining.');
    s.phase=s.decision?'decision':'ready';s.active=null;s.halt=null;s.forceReview=!s.decision;
    if(!s.decision){s.draft=null;s.decisionId=null;}return;
  }
  active();
  if(c.type==='supervision_proposed'||c.type==='supervision_approved'){
    const decision=prior.find(e=>e.id===c.decisionId);
    if(s.phase!=='decision'||s.decisionId!==c.decisionId||!s.decision||!('hypothesis' in s.decision)||!decision||Date.parse(event.at)>=state.deadline||c.proposalHash!==supervisionProposalHash(manifest,decision,state.deadline))fail('Improvement review differs from the current unexpired proposal.');
    if(c.type==='supervision_proposed'){if(s.review?.announced)fail('This proposal already has a review hold.');s.review={decisionId:c.decisionId,proposalHash:c.proposalHash,approved:false,announced:true};}
    else {if(!s.review||s.review.approved||s.review.decisionId!==c.decisionId||s.review.proposalHash!==c.proposalHash)fail('Approval requires its pending proposal hold.');s.review.approved=true;s.operatorReview=false;}return;
  }
  if(c.type==='supervision_started'){
    const evidence=supervisionEvidence(prior);
    if(canonicalJson(c.evidenceIds)!==canonicalJson(evidence.ids)||c.evidenceHash!==evidence.hash||Date.parse(event.at)>=state.deadline)fail('Controller evidence changed or its deadline expired.');
    const account=plan.agents.find(a=>a.id===c.agentId)!;
    let ancestor=account;for(let n=0;n<plan.agents.length;n++){if(state.stoppedAgents.includes(ancestor.id)||Object.values(state.tasks).some(task=>task.agentId===ancestor.id&&task.escalation))fail('Stopped agents cannot supervise.');const parent=plan.agents.find(a=>a.id===ancestor.parentId);if(!parent)break;ancestor=parent;}
    if(Date.parse(event.at)>=createdAt+account.timeBudgetMs)fail('Controller account deadline expired.');
    if(c.role==='controller'){
      if(s.phase!=='ready'||c.round!==s.rounds+1||!s.forceReview&&s.reviewedHash===evidence.hash)fail('Controller round is duplicated or not ready.');
      const completed=Object.values(state.tasks).filter(task=>task.status==='completed').length;
      if(completed<=s.completedTasks&&s.stalledRounds>=policy.maxStalledRounds)fail('Controller stalled-round limit reached.');
      s.stalledRounds=completed>s.completedTasks?0:s.stalledRounds+1;s.completedTasks=completed;
      s.rounds=c.round;s.evidenceIds=[...c.evidenceIds];s.evidenceHash=c.evidenceHash;s.draft=null;s.decision=null;s.decisionId=null;s.forceReview=false;
    }else if(s.phase!=='draft-ready'||c.round!==s.rounds||s.evidenceHash!==c.evidenceHash)fail('Reviewer needs the recorded controller draft in this round.');
    s.phase=c.role;s.active={agentId:c.agentId,sessionId:c.sessionId,role:c.role};
  }else if(c.type==='supervision_decided'){
    if(Date.parse(event.at)>=Math.min(state.deadline,createdAt+plan.agents.find(a=>a.id===c.agentId)!.timeBudgetMs))fail('Controller result arrived after its original deadline.');
    if(c.round!==s.rounds||s.phase!==c.role||s.active?.agentId!==c.agentId||s.active.sessionId!==c.sessionId||s.evidenceHash!==supervisionEvidence(prior).hash)fail('Controller result does not match its active evidence snapshot.');
    const decision=validateSupervisionDecision(c.decision,policy,plan,new Set(s.evidenceIds));s.active=null;
    if(c.role==='controller'&&policy.reviewerId){s.draft=decision;s.phase='draft-ready';}
    else {s.decision=decision;s.decisionId=event.id;s.phase='decision';
      if(s.operatorReview){if('hypothesis' in decision)s.review={decisionId:event.id,proposalHash:supervisionProposalHash(manifest,event,state.deadline),approved:false,announced:false};else s.operatorReview=false;}
    }
  }else if(c.type==='supervision_applied'){
    if(Date.parse(event.at)>=state.deadline)fail('Controller action exceeded the original run deadline.');
    if(s.phase!=='decision'||c.round!==s.rounds||s.decisionId!==c.decisionId||!s.decision)fail('Controller action has no unapplied decision.');
    const d=s.decision;if(s.review&&!s.review.approved)fail('The proposed improvement requires its exact reviewed approval.');s.review=null;
    if(d.action==='retry'||d.action==='replan'){
      assertSupervisedRetry(plan,state,prior,d.taskId,c.receipts);
      const last=[...prior].reverse().find(e=>e.change.type==='task_finished'&&e.change.taskId===d.taskId);
      if(!last||!d.evidence.includes(last.id))fail('A retry must reference the current failed attempt.');
      const task=state.tasks[d.taskId]!;
      task.status='pending';task.output=null;task.artifactIds=[];task.changedFiles=[];task.mutations=false;task.escalation=null;
      if(d.action==='replan')s.strategies[d.taskId]={decisionId:c.decisionId,strategy:d.strategy,evidence:[...d.evidence]};
    }else {
      if(c.receipts.length)fail('Only retry decisions may carry verification receipts.');
      if(d.action==='decompose'&&!state.graph?.admissions.some(admission=>admission.proposal.source.eventId===c.decisionId))fail('Child decomposition needs a recorded budget-backed graph admission.');
    }
    s.phase=d.action==='stop'?'halted':'ready';s.reviewedHash=s.evidenceHash;
    if(d.action==='stop')s.halt={outcome:'stop',reason:d.reason};
    s.decision=null;s.decisionId=null;s.draft=null;
  }else if(c.type==='supervision_halted'){
    if(c.round!==s.rounds)fail('Controller stop refers to another round.');
    s.phase='halted';s.active=null;s.halt={outcome:c.outcome,reason:c.reason};
  }
}

/** A controller proposal is authorized by one recorded decision, never by its filename. */
export function assertSupervisionProposal(proposal:SpawnProposal,state:ExecutionProjection):void {
  const s=state.supervision,d=s?.decision;
  if(proposal.source.kind!=='supervision'||!s||s.phase!=='decision'||s.decisionId!==proposal.source.eventId||!d||d.action!=='decompose'||!state.ownerId||state.status!=='running'||Object.values(state.tasks).some(task=>task.status==='running'))fail('Child admission requires the active, recorded controller decision.');
  if(s.review&&!s.review.approved)fail('Child admission requires the exact reviewed improvement approval.');
  const children={version:proposal.version,parentId:proposal.parentId,agents:proposal.agents,tasks:proposal.tasks};
  if(canonicalJson(children)!==canonicalJson(d.children)||proposal.source.sha256!==digest(canonicalJson(d.children)))fail('Child proposal differs from the recorded controller decision.');
}
