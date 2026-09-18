import {canonicalJson} from '../approvals/index.js';
import {getProviderNames} from '../config.js';
import {isReasoningEffort} from '../models/index.js';
import {validateIsolation} from '../isolation/contracts.js';
import {fail,integer,shape,strings,text} from '../orchestration/validation.js';
import type {ProjectPlan} from '../orchestration/types.js';
import type {GoalManifest,GoalSupervision} from './types.js';

export function validateGoalSupervision(value:unknown):GoalSupervision {
  shape(value,['version','image','maxRounds','maxStalledRounds','maxOutputTokens','principle','allowedActions'],['controller','reviewer','reasoningEffort']);
  validateIsolation({version:value.version,image:value.image});
  integer(value.maxRounds,1,64);integer(value.maxStalledRounds,1,value.maxRounds);integer(value.maxOutputTokens,1,8192);
  if(!['speed','robustness','stability','security','performance','cost'].includes(String(value.principle)))fail('Unknown supervision optimization principle.');
  strings(value.allowedActions,3);if(value.allowedActions.some(action=>!['retry','replan','decompose'].includes(action)))fail('Unknown supervised action.');
  for(const role of ['controller','reviewer'])if(value[role]!==undefined){
    const preference=value[role];shape(preference,['provider'],['model']);
    if(preference.provider!=='auto'&&!getProviderNames().includes(preference.provider as never))fail('Unknown supervised goal provider.');
    if(preference.model!==undefined)text(preference.model,256);
  }
  if(value.reasoningEffort!==undefined){
    shape(value.reasoningEffort,[],['controller','reviewer']);
    if(!Object.keys(value.reasoningEffort).length||Object.values(value.reasoningEffort).some(effort=>!isReasoningEffort(effort)))fail('Unknown or empty supervision reasoning effort.');
    if(value.reasoningEffort.reviewer!==undefined&&value.reviewer===undefined)fail('Reviewer effort requires a supervision reviewer.');
  }
  return JSON.parse(canonicalJson(value)) as GoalSupervision;
}

/** Revisions can narrow captured bounds, never discard supervision. */
export function validateSupervisedGoalPlan(plan:ProjectPlan,manifest:GoalManifest):void {
  const requested=manifest.supervision;if(!requested)return;
  const policy=plan.supervision;
  if(plan.version!==4||!policy||plan.workspace.isolation?.image!==requested.image)fail('Supervised goals require a version 4 plan with the captured isolation image.');
  if(policy.principle!==requested.principle||policy.maxRounds>requested.maxRounds||policy.maxStalledRounds>requested.maxStalledRounds||policy.maxOutputTokens>requested.maxOutputTokens||policy.allowedActions.some(action=>!requested.allowedActions.includes(action))||canonicalJson(policy.reasoningEffort??null)!==canonicalJson(requested.reasoningEffort??null))fail('Proposed supervision exceeds or changes the captured goal settings.');
  if(Boolean(policy.reviewerId)!==Boolean(requested.reviewer))fail('Proposed supervision reviewer differs from the captured goal team.');
  const supervisors=[policy.controllerId,...(policy.reviewerId?[policy.reviewerId]:[])];
  if(plan.tasks.some(task=>supervisors.includes(task.agentId)))fail('Supervised goal controllers and reviewers must have dedicated accounts without worker tasks.');
  if(plan.tasks.some(task=>!task.isolation?.commands.length))fail('Every supervised goal task requires declared isolated command verification.');
  if(policy.reviewerId){
    const reviewer=plan.agents.find(agent=>agent.id===policy.reviewerId)!;
    if(reviewer.allowedTools.some(tool=>!['think','read_file','list_files'].includes(tool))||reviewer.maxChildCount||reviewer.maxChildDepth)fail('A supervision reviewer must be a read-only leaf account.');
  }
}

/** Older goal contracts remain byte-for-byte intact for linked-run recovery. */
export function supervisedPlanContract(original:string):string {
  return original.replace('version:2','version:4').replace('No shell/network/custom execution is available.','Inherited shell authority is only for declared executor verification in the isolated image; model-selected shell/network/custom execution is unavailable.')+`
Supervised execution: use the captured supervision-settings input. Add workspace.isolation:{version:1,image:<captured image>} and supervision:{version:1,controllerId:<root id>,reviewerId?:<distinct reviewer id>,maxRounds,maxStalledRounds,maxOutputTokens,principle,allowedActions,reasoningEffort?}. Copy the captured principle/effort; bounds and allowed actions may only narrow. The image must match exactly. Keep the root controller and optional supervision reviewer separate from worker tasks. Include a reviewer account only when a supervision reviewer preference is captured; it must be a read-only leaf. Planning reviewer and execution reviewer are separate accounts in separate runs.
Every worker task requires isolation:{patchArtifactId,commands:[{artifactId,argv:[<executable>,<literal arguments>],timeoutMs}]}, a declared pathless patch output and pathless test_result output for every command. Require 1..8 verification commands per task, each <=60000ms and within the worker deadline. Each command needs an acceptance check {id,artifactId,kind:"command",criteria:["task:0","agent:0"]}. Inspect existing tests and propose meaningful commands for the requested criteria; never substitute an unconditional success command. Commands run inside the existing local Linux image with no network and only read-only granted paths mounted under /project; dependencies must already be available there. Worker and ancestor tool grants must include shell for these declared checks only. No image pulls, host shell execution or source checkout changes are authorized. Reserve controller/reviewer accounts enough of the remaining original budget for the bounded reviews and leave child capacity for any allowed decomposition.
For a one-file smoke task, keep the worker contract minimal: state the exact single mutation, require one write_file or edit_file call, then stop and return the bounded report. Do not add exploratory reads, repeated retries, or extra prose when the requested content is already explicit.`;
}
