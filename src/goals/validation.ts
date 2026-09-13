import {isAbsolute} from 'node:path';
import {canonicalJson,digest,projectIdentity,canonicalPath} from '../approvals/index.js';
import {getProviderNames} from '../config.js';
import {analyzePlan,bindPlan,array,shape,integer,text,strings,pathName,uuid,hex,iso,permits,fail,MAX_PLAN_BYTES} from '../orchestration/validation.js';
import {OrchestrationError} from '../orchestration/types.js';
import type {GoalRunLink} from '../orchestration/types.js';
import type {GoalManifest,GoalProposal,GoalAllocation,GoalLimits,PlanningSpend,ProposalSource} from './types.js';
import {validateGoalTeam} from './team.js';
import {validateGoalSupervision,validateSupervisedGoalPlan} from './supervised.js';

export const GOAL_TOOLS=['think','read_file','list_files','write_file','edit_file'];
export const MAX_GOAL_EVENTS=10000,MAX_GOAL_BYTES=16*1024*1024,MAX_GOAL_EVENT_BYTES=16384;
export const signed=<T extends object>(body:T):T&{hash:string}=>({...body,hash:digest(canonicalJson(body))});
export function verifyHash(value:Record<string,unknown>):void {const {hash,...body}=value;if(!hex(hash)||digest(canonicalJson(body))!==hash)fail('Goal record hash is invalid.');}
export function validateGoalLimits(value:unknown):GoalLimits {
  shape(value,['tokenBudget','costBudgetNanos','timeBudgetMs','planningTokens','planningCostNanos','planningTimeMs','maxOutputTokens','maxAgents','maxTasks','maxDepth','maxConcurrent']);
  integer(value.tokenBudget,2,100000000);integer(value.costBudgetNanos,0,1e13);integer(value.timeBudgetMs,2,86400000);
  integer(value.planningTokens,1,value.tokenBudget-1);integer(value.planningCostNanos,0,value.costBudgetNanos);integer(value.planningTimeMs,1,value.timeBudgetMs);integer(value.maxOutputTokens,1,value.planningTokens);
  integer(value.maxAgents,1,256);integer(value.maxTasks,1,1024);integer(value.maxDepth,0,8);integer(value.maxConcurrent,1,16);return value as unknown as GoalLimits;
}
export function validateGoalManifest(value:unknown):GoalManifest {
  shape(value,['version','id','createdAt','deadline','project','runsRoot','goal','preference','workspace','limits','hash'],['team','supervision','planningRepair']);
  if(![1,2,3,4].includes(Number(value.version))||typeof value.version!=='number'||!uuid(value.id)||!iso(value.createdAt))fail('Invalid goal identity or version.');text(value.goal);validateGoalLimits(value.limits);
  if(value.version===2||(value.version===3||value.version===4)&&value.team!==undefined){const team=validateGoalTeam(value.team),limits=value.limits as unknown as GoalLimits;if(team.reviewer&&(limits.maxAgents<2||limits.maxTasks<2||limits.maxDepth<1||limits.planningTokens<2))fail('A plan reviewer requires two agents, two tasks, depth one and two planning tokens.');}else if(value.team!==undefined)fail('Version 1 goals cannot contain team configuration.');
  if(value.version===3||value.version===4&&value.supervision!==undefined){const s=validateGoalSupervision(value.supervision),limits=value.limits as unknown as GoalLimits;if(limits.maxAgents<(s.reviewer?3:2)||limits.maxDepth<1||s.maxOutputTokens>limits.tokenBudget-limits.planningTokens)fail('Supervised goals need controller/worker capacity and output within their execution allowance.');}else if(value.supervision!==undefined)fail('Supervision requires a version 3 or 4 goal manifest.');
  if(value.version===4){shape(value.planningRepair,['version','maxRetries']);if(value.planningRepair.version!==1)fail('Unknown planning repair version.');integer(value.planningRepair.maxRetries,1,2);}else if(value.planningRepair!==undefined)fail('Planning repair requires a version 4 goal manifest.');
  integer(value.deadline,Date.parse(value.createdAt)+1,Date.parse(value.createdAt)+86400000);if(value.deadline!==Date.parse(value.createdAt)+(value.limits as unknown as GoalLimits).timeBudgetMs)fail('Goal deadline differs from its original allowance.');
  shape(value.project,['root','key']);text(value.project.root,4096);if(!isAbsolute(value.project.root)||!hex(value.project.key))fail('Invalid goal project identity.');
  text(value.runsRoot,4096);if(!isAbsolute(value.runsRoot))fail('Goal runs require an absolute private store.');
  shape(value.preference,['provider'],['model']);if(value.preference.provider!=='auto'&&!getProviderNames().includes(value.preference.provider as never))fail('Unknown goal provider.');if(value.preference.model!==undefined)text(value.preference.model,256);
  const allowedTools=value.supervision!==undefined?[...GOAL_TOOLS,'shell']:GOAL_TOOLS;
  shape(value.workspace,['allowedTools','allowedPaths']);strings(value.workspace.allowedTools,allowedTools.length);if(value.workspace.allowedTools.some(t=>!allowedTools.includes(t)))fail('Goal tools require supported containment.');if(value.supervision!==undefined&&!value.workspace.allowedTools.includes('shell'))fail('Supervised goals require contained verification authority.');array(value.workspace.allowedPaths,256);
  const paths=new Set<string>();for(const grant of value.workspace.allowedPaths){shape(grant,['path','access']);pathName(grant.path);if(!['read','write'].includes(String(grant.access))||paths.has(grant.path))fail('Invalid goal path grant.');paths.add(grant.path);}
  verifyHash(value);if(Buffer.byteLength(canonicalJson(value))>MAX_PLAN_BYTES)fail('Goal manifest exceeds its size limit.');return value as unknown as GoalManifest;
}
export function validateGoalLink(value:unknown):GoalRunLink {
  shape(value,['version','root','id','manifestHash','allocationId','phase']);text(value.root,4096);
  if(value.version!==1||!isAbsolute(value.root)||!uuid(value.id)||!hex(value.manifestHash)||!uuid(value.allocationId)||!['planning','execution'].includes(String(value.phase)))fail('Invalid parent goal linkage.');return value as unknown as GoalRunLink;
}
export function validateAllocation(value:unknown,manifest:GoalManifest,phase:'planning'|'execution'):GoalAllocation {
  shape(value,['id','phase','runId','planHash','tokens','costNanos','deadline']);if(!uuid(value.id)||!uuid(value.runId)||!hex(value.planHash)||value.phase!==phase)fail('Invalid goal allocation.');
  integer(value.tokens,1,phase==='planning'?manifest.limits.planningTokens:manifest.limits.tokenBudget);integer(value.costNanos,0,phase==='planning'?manifest.limits.planningCostNanos:manifest.limits.costBudgetNanos);
  integer(value.deadline,Date.parse(manifest.createdAt)+1,phase==='planning'?Date.parse(manifest.createdAt)+manifest.limits.planningTimeMs:manifest.deadline);return value as unknown as GoalAllocation;
}
export function validatePlanningSpend(value:unknown):PlanningSpend {
  shape(value,['tokens','costNanos','revision']);integer(value.tokens,0,Number.MAX_SAFE_INTEGER);integer(value.costNanos,0,Number.MAX_SAFE_INTEGER);if(!hex(value.revision))fail('Planning spend needs its ledger revision.');return value as unknown as PlanningSpend;
}
export function validateProposalSource(value:unknown):ProposalSource {
  shape(value,['kind'],['runId','artifactId','artifactHash','eventId','path','sha256']);
  if(value.kind==='agent'){shape(value,['kind','runId','artifactId','artifactHash','eventId']);if(!uuid(value.runId)||!uuid(value.eventId)||!hex(value.artifactHash))fail('Invalid proposal provenance.');text(value.artifactId,64);}
  else if(value.kind==='human'){shape(value,['kind','path','sha256']);pathName(value.path);if(!hex(value.sha256))fail('Invalid human proposal source.');}else fail('Unknown proposal source.');return value as unknown as ProposalSource;
}
export function validateGoalProposal(value:unknown,manifest:GoalManifest,spend?:PlanningSpend):GoalProposal {
  if(spend!==undefined)validatePlanningSpend(spend);
  shape(value,['version','goalId','goalManifestHash','plan','planHash','knowledgeStatus','confidence','inferred','source','hash']);
  if(value.version!==1||value.goalId!==manifest.id||value.goalManifestHash!==manifest.hash||value.knowledgeStatus!=='proposed'||value.confidence!==null||typeof value.inferred!=='boolean')fail('Invalid proposed knowledge state.');
  const source=validateProposalSource(value.source);if(value.inferred!==(source.kind==='agent'))fail('Proposal inference marker differs from its source.');
  const analysis=analyzePlan(value.plan),p=analysis.plan,l=manifest.limits;if(value.planHash!==analysis.hash)fail('Proposal plan hash is invalid.');
  if(p.limits.tokenBudget>l.tokenBudget-(spend?.tokens??0)||Math.floor(p.limits.costBudgetUsd*1e9)>l.costBudgetNanos-(spend?.costNanos??0)||p.limits.timeBudgetMs>l.timeBudgetMs||p.limits.maxAgents>l.maxAgents||p.limits.maxTasks>l.maxTasks||p.limits.maxDepth>l.maxDepth||p.limits.maxConcurrent>l.maxConcurrent)fail('Proposed plan exceeds the remaining goal allowance.');
  if(manifest.team?.maxAttempts!==undefined&&p.agents.some(agent=>agent.escalationPolicy.maxRetries>=manifest.team!.maxAttempts!))fail('Proposal exceeds the goal task attempt limit.');
  if(p.workspace.allowedTools.some(t=>!manifest.workspace.allowedTools.includes(t))||p.workspace.allowedPaths.some(g=>!permits(manifest.workspace.allowedPaths,g.path,g.access)))fail('Proposed workspace exceeds the reviewed goal scope.');
  validateSupervisedGoalPlan(p,manifest);
  verifyHash(value);if(Buffer.byteLength(JSON.stringify(value))>MAX_PLAN_BYTES+8192)fail('Proposal exceeds its byte limit.');return value as unknown as GoalProposal;
}
export function assertGoalProject(manifest:GoalManifest,cwd=manifest.project.root):void {
  const identity=projectIdentity(cwd);if(identity.project!==manifest.project.root||identity.projectKey!==manifest.project.key)throw new OrchestrationError('policy-denied','Goal belongs to another or replaced project.');
}
