import {taskSmartSelection,recordAgentRoute} from '../orchestration/routing.js';
import {supervisionProposalHash} from './approval.js';
import {readRunAccounting} from '../orchestration/accounting.js';
import {linkedGoalAccounting} from '../goals/accounting.js';
import {projectImprovementHistory,improvementFeedback} from '../improvement/index.js';
import {randomUUID} from 'node:crypto';
import {canonicalJson,digest} from '../approvals/index.js';
import {runTurn} from '../runtime/index.js';
import {ExecutionGuard,ExecutionLimitError,reviewedOutputLimit,type AgentExecution} from '../execution/index.js';
import {throwIfCancelled,isCancellation} from '../cancellation.js';
import {SessionPolicyError} from '../session-management/index.js';
import {createSession,saveSessionConversation} from '../storage.js';
import {RunLog} from '../runlog.js';
import {resolvePreferences} from '../preferences/index.js';
import {formatRepositoryInstructions,loadRepositoryInstructions} from '../instructions.js';
import {selectRoute,RoutingUnavailableError} from '../routing/index.js';
import {agentPreference} from '../orchestration/progress.js';
import {agentStopped} from '../orchestration/execution-journal.js';
import {checkArtifactSnapshot,workerSummary} from '../orchestration/verification.js';
import {OrchestrationError} from '../orchestration/types.js';
import type {ExecutionStore} from '../orchestration/execution-store.js';
import type {CoordinatorOptions} from '../orchestration/coordinator.js';
import type {Message} from '../types.js';
import {admitSpawn} from '../spawning/actions.js';
import {makeSpawnProposal} from '../spawning/validation.js';
import {inspectSpawnAuthority} from '../spawning/authority.js';
import {SpawnProposalStore} from '../spawning/store.js';
import {supervisionEvidence} from './journal.js';
import {parseSupervisionReply} from './reply.js';
import {buildControllerContext,controllerInstructions} from './context.js';
import {supervisionAvailability} from './availability.js';
import {supervisionHealthEvidence} from './health.js';
import {reviewEvidence,retryEvidence} from './evidence.js';
import type {SupervisionRole,SupervisionProjection} from './types.js';

export function needsSupervision(store:ExecutionStore):boolean {
  const view=store.read(),s=view.state.supervision;if(!s||s.phase==='halted')return false;
  const evidence=supervisionEvidence(view.events);
  return s.phase!=='ready'||evidence.ids.length>0&&(s.forceReview||s.reviewedHash!==evidence.hash);
}

/** A review is a read-only runtime turn using an existing account and its original clock. */
async function controllerTurn(store:ExecutionStore,authority:AgentExecution,role:SupervisionRole,options:CoordinatorOptions,assertRun:()=>void):Promise<void> {
  const view=store.read(),context=store.context(view),plan=context.plan,policy=plan.supervision!,s=view.state.supervision!;
  const agentId=role==='controller'?policy.controllerId:policy.reviewerId!,agent=plan.agents.find(a=>a.id===agentId)!,round=role==='controller'?s.rounds+1:s.rounds;
  const evidence=supervisionEvidence(view.events),session=createSession(context.project.root,{activate:false}),log=RunLog.open(session.id),controller=new AbortController();
  const abort=()=>controller.abort();options.signal?.addEventListener('abort',abort,{once:true});if(options.signal?.aborted)abort();
  const agentDeadline=Date.parse(view.header.createdAt)+agent.timeBudgetMs;let authorityError:unknown,revision:string|null=null;
  const check=()=>{assertRun();throwIfCancelled(controller.signal);const current=store.read();if(Date.now()>=agentDeadline)throw new ExecutionLimitError('deadline','Original controller deadline expired.');if(agentStopped(current.state,store.context(current),agentId))throw new ExecutionLimitError('authority','The controller agent was stopped.');};
  const observe=()=>{try{check();}catch(error){authorityError??=error;controller.abort();}};
  const timer=setInterval(observe,100),deadline=setTimeout(observe,Math.max(0,agentDeadline-Date.now()));
  try {
    check();
    const health=supervisionHealthEvidence(plan,view.state);
    const start=await store.append({type:'supervision_started',round,role,agentId,sessionId:session.id,evidenceIds:evidence.ids,evidenceHash:evidence.hash,health,requestAttribution:1},controller.signal,undefined,check);
    const outcomes=await reviewEvidence(store,evidence.ids,{...options,signal:controller.signal},agentId,true),budget=authority.ledger.read(context.project.root);
    const current=store.read(),reviewContext=store.context(current),reviewPlan=reviewContext.plan,accounting=readRunAccounting(store,current),availability=supervisionAvailability(reviewPlan,current,Date.now());
    const {content,metrics}=buildControllerContext({role,round,plan:reviewPlan,availability,providerHealth:health,goalAccounting:linkedGoalAccounting(store,current,controller.signal),improvements:improvementFeedback(projectImprovementHistory(store.manifest,current,reviewContext,accounting.status==='available'?accounting.attribution:undefined)),tasks:current.state.tasks,outcomes,...(role==='reviewer'?{draft:s.draft}:{}),budget:{deadline:budget.manifest.deadline,spent:budget.projection.spent,accounts:budget.projection.accounts},strategies:s.strategies});
    const reasoningEffort=policy.reasoningEffort?.[role];
    log.policyEvent({tool:'controller',source:'controller-context',decision:'allow',reason:JSON.stringify({...metrics,role,round,reasoningEffort}),durationMs:0});
    const messages:{current:Message[]}={current:[{role:'system',content:controllerInstructions(policy,role)},{role:'user',content}]};
    if(reviewPlan.agents.some(a=>a.routing))messages.current[0]!.content+='\nSmart routing: proposed children must inherit or narrow their parent childRouting policy, or the parent routing policy when childRouting is absent. Copy the policy into every child routing field. Explicit child model pins and further childRouting grants must stay within that delegation authority. Your own inference pool does not replace the declared worker delegation pool.';
    messages.current[0]!.content+='\n'+formatRepositoryInstructions(loadRepositoryInstructions(context.project.root));
    const preference=resolvePreferences(context.project.root,{turn:agentPreference(plan,agentId)});
    const smart=agent.routing?taskSmartSelection(agent.routing,view.events):undefined;
    const route=await selectRoute({smart,provider:preference.provider,model:preference.model,messages:messages.current,requirements:{tools:false,reasoningEffort},signal:controller.signal});log.routingDecision(route);
    if(!route.selected)throw new RoutingUnavailableError(route);const maximum=reviewedOutputLimit(route.selected,store.manifest.project.root);if(!maximum)throw new ExecutionLimitError('budget','Controller model needs a live or reviewed output limit.');
    const attribution={version:1 as const,kind:'supervision' as const,eventId:start.id,eventHash:start.hash,sessionId:session.id,role,round};
    const execution={...authority,agentId,maxOutputTokens:Math.min(policy.maxOutputTokens,maximum),assertAuthority:check,attribution};
    new ExecutionGuard(execution,context.project.root).assertActive(controller.signal);
    const result=await runTurn({smart,...(smart?{onRoute:(decision)=>recordAgentRoute(store,agentId,session.id,decision,controller.signal,check)}:{}),cwd:context.project.root,sessionId:session.id,execution,reasoningEffort,provider:preference.provider,model:preference.model,messages,prompt:role==='reviewer'?'Review the supplied controller draft and return one explicit reviewer verdict bound to draftHash.':'Review the recorded outcomes and return one bounded decision.',tools:()=>[],onToolStart:()=>{throw new SessionPolicyError();},beforeTool:()=>{throw new SessionPolicyError();},maxIterations:1,maxRetries:0,parallel:false,mode:options.mode,confirmation:'mutating',signal:controller.signal,runlog:log,onCheckpoint:(messages,status)=>{revision=saveSessionConversation(session.id,messages,{expectedRevision:revision,status}).revision;}});
    check();
    let final=messages.current.filter(m=>m.role==='assistant').at(-1)?.content;
    const mechanicallyComplete=role==='controller'&&outcomes.length>0&&outcomes.every(outcome=>Array.isArray(outcome.checks)&&outcome.checks.length>0&&outcome.checks.every(check=>check.passed));
    if(result.reason!=='completed'){
      // Local models can spend their bounded output on reasoning before emitting a
      // decision. A truncated controller may stop only when every recorded check
      // already passed; missing or failed evidence remains a hard failure.
      if(!(mechanicallyComplete&&result.reason==='length'))throw new OrchestrationError(result.reason==='budget'?'policy-denied':'unavailable',`${role==='reviewer'?'Reviewer':'Controller'} stopped: ${result.reason}.`);
      final=JSON.stringify({version:1,action:'stop',reason:'All recorded acceptance checks passed; controller output was truncated.',evidence:evidence.ids});
    }
    let decision;
    try { decision=parseSupervisionReply(final,{role,draft:s.draft,policy,plan:reviewPlan,evidenceIds:new Set(evidence.ids)}); }
    catch(error) {
      if(!mechanicallyComplete)throw error;
      decision={version:1,action:'stop',reason:'All recorded acceptance checks passed; controller decision was malformed.',evidence:evidence.ids} as const;
    }
    await store.append({type:'supervision_decided',round,role,agentId,sessionId:session.id,decision},controller.signal,undefined,check);
  }catch(error){throw authorityError??error;}
  finally{clearInterval(timer);clearTimeout(deadline);options.signal?.removeEventListener('abort',abort);await log.flush();}
}

/** Resuming committed decisions never repeats the model call or creates a second child grant. */
async function applyDecision(store:ExecutionStore,authority:AgentExecution,options:CoordinatorOptions,assertRun:()=>void):Promise<void> {
  const view=store.read(),s=view.state.supervision!,decision=s.decision!,context=store.context(view);
  let evidence:Awaited<ReturnType<typeof retryEvidence>>={receipts:[],artifacts:[]};
  if(decision.action==='retry'||decision.action==='replan')evidence=await retryEvidence(store,decision.taskId,options);
  else if(decision.action==='decompose'){
    const existing=view.state.graph?.admissions.find(a=>a.proposal.source.eventId===s.decisionId);
    if(!existing){
      const pending=inspectSpawnAuthority(store,authority.ledger,view).pending,proposals=new SpawnProposalStore(store);
      const saved=pending.map(record=>proposals.read(record.grant.proposalHash)).find(proposal=>proposal.source.eventId===s.decisionId);
      if(pending.length&&!saved)throw new OrchestrationError('conflict','Recover the existing pending child grant before controller decomposition.');
      const proposal=saved??makeSpawnProposal(store.manifest,view.header,context.plan,decision.children,{kind:'supervision',eventId:s.decisionId!,path:`supervision/${s.decisionId}.json`,sha256:digest(canonicalJson(decision.children))});
      assertRun();await admitSpawn(context.project.root,context.id,saved?proposal.hash:proposal,proposal.hash,options);
    }
  }
  await store.append({type:'supervision_applied',round:s.rounds,decisionId:s.decisionId!,receipts:evidence.receipts},options.signal,randomUUID(),()=>{assertRun();for(const artifact of evidence.artifacts)checkArtifactSnapshot(store,artifact);});
}

/** At most one controller/reviewer round per barrier; all accounting is inherited. */
export async function supervise(store:ExecutionStore,authority:AgentExecution,options:CoordinatorOptions,assertRun:()=>void):Promise<SupervisionProjection> {
  try {
    assertRun();let s=store.read().state.supervision!;const policy=store.context().plan.supervision!;
    if(s.phase==='ready'){
      const complete=Object.values(store.read().state.tasks).filter(t=>t.status==='completed').length;
      if(s.rounds>=policy.maxRounds||complete<=s.completedTasks&&s.stalledRounds>=policy.maxStalledRounds){await store.append({type:'supervision_halted',round:s.rounds,outcome:'limit',reason:'The reviewed controller round or stalled-progress limit is exhausted.'});return store.read().state.supervision!;}
      await controllerTurn(store,authority,'controller',options,assertRun);s=store.read().state.supervision!;
    }
    if(s.phase==='draft-ready')await controllerTurn(store,authority,'reviewer',options,assertRun);
    const current=store.read(),pending=current.state.supervision!;
    if(options.proposalOnly&&pending.phase==='decision'&&pending.decision&&'hypothesis' in pending.decision&&!pending.review?.announced){
      const event=current.events.find(e=>e.id===pending.decisionId)!;
      await store.append({type:'supervision_proposed',decisionId:event.id,proposalHash:supervisionProposalHash(store.manifest,event,current.header.deadline),source:options.source==='repl'?'repl':'cli'},options.signal,undefined,assertRun);
    }
    if(!options.proposalOnly&&pending.phase==='decision')await applyDecision(store,authority,options,assertRun);
  }catch(error){
    const cancelled=options.signal?.aborted||isCancellation(error),denied=error instanceof SessionPolicyError||error instanceof ExecutionLimitError||error instanceof OrchestrationError&&error.code==='policy-denied';
    const s=store.read().state.supervision!;
    await store.append({type:'supervision_halted',round:s.rounds,outcome:cancelled?'cancelled':denied?'denied':'failed',reason:workerSummary(error instanceof Error?error.message:'Controller failed; inspect recorded evidence before explicit recovery.')});
  }
  return store.read().state.supervision!;
}
