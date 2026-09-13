import {dirname,relative,resolve} from 'node:path';
import {realpathSync} from 'node:fs';
import {canonicalPath,projectIdentity} from '../approvals/index.js';
import {readPrivateSessionFile} from '../sessions/index.js';
import {authorizeSessionAction} from '../session-management/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {withScope,validatePath} from '../scope.js';
import {validateSmartPolicy,type SmartRoutingPolicy} from '../routing/smart.js';
import {shape,fail,pathName} from '../orchestration/validation.js';
import type {RunActionOptions} from '../orchestration/actions.js';
import type {ProjectPlan} from '../orchestration/types.js';
import type {GoalManifest} from './types.js';

export interface GoalRouting {
  version:1;default:SmartRoutingPolicy;planner?:SmartRoutingPolicy;workers?:SmartRoutingPolicy;
  reviewer?:SmartRoutingPolicy;controller?:SmartRoutingPolicy;supervisionReviewer?:SmartRoutingPolicy;
}
export function validateGoalRouting(value:unknown):GoalRouting {
  shape(value,['version','default'],['planner','workers','reviewer','controller','supervisionReviewer']);
  if(value.version!==1)fail('Unsupported goal routing version.');
  for(const [key,policy]of Object.entries(value))if(key!=='version')try{validateSmartPolicy(policy);}catch{fail('Invalid Smart routing policy for '+key+'.');}
  return structuredClone(value) as unknown as GoalRouting;
}
export async function loadGoalRouting(cwd:string,path:string,options:RunActionOptions):Promise<GoalRouting> {
  throwIfCancelled(options.signal);const identity=projectIdentity(cwd),file=resolve(identity.project,path);pathName(relative(identity.project,file));
  if(canonicalPath(file)!==file||realpathSync(dirname(file))!==dirname(file))fail('Routing policy must be a regular file inside the canonical project.');
  withScope(identity.project,()=>validatePath(file,identity.project));
  await authorizeSessionAction(identity.project,'read_file',{path:file,operation:'smart-routing-policy'},options);throwIfCancelled(options.signal);
  if(canonicalPath(file)!==file||projectIdentity(cwd).projectKey!==identity.projectKey)fail('Routing policy path changed during authorization.');
  const raw=readPrivateSessionFile(file,65536);let value:unknown;try{value=JSON.parse(raw??'');}catch{fail('Routing policy must be valid JSON.');}return validateGoalRouting(value);
}
/** Captured operator choices overwrite model-proposed policies before hash review. */
export function applyGoalRouting(plan:ProjectPlan,manifest:GoalManifest,phase:'planning'|'execution'):ProjectPlan {
  const routing=manifest.routing;if(!routing)return plan;
  for(const agent of plan.agents){
    const role=phase==='planning'?(agent.parentId===null?'planner':'reviewer'):agent.parentId===null?'controller':agent.id===plan.supervision?.reviewerId?'supervisionReviewer':'workers';
    agent.routing=structuredClone(routing[role]??routing.default);
    if(phase==='execution'&&agent.maxChildCount&&agent.maxChildDepth)agent.childRouting=structuredClone(routing.workers??routing.default);else delete agent.childRouting;
  }
  return plan;
}
