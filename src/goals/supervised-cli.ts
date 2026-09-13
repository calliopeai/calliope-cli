import {OrchestrationError} from '../orchestration/index.js';
import {validateGoalSupervision} from './supervised.js';
import type {GoalSupervision} from './types.js';

export const supervisionFlags=['isolation-image','principle','supervision-rounds','supervision-stall-rounds','supervision-output-tokens','controller-provider','controller-model','supervision-reviewer-provider','supervision-reviewer-model','controller-effort','supervision-reviewer-effort'] as const;

/** Capture independent execution roles before the read-only planner runs. */
export function goalSupervisionFlags(values:Record<string,unknown>,defaults?:GoalSupervision):GoalSupervision|undefined {
  const invalid=(message:string):never=>{throw new OrchestrationError('invalid',message);};
  if(!values.supervise){
    if(supervisionFlags.some(flag=>values[flag]!==undefined))invalid('Supervision controls require --supervise.');
    return defaults===undefined?undefined:validateGoalSupervision(defaults);
  }
  const value:Record<string,unknown>={version:1,maxRounds:4,maxStalledRounds:2,maxOutputTokens:1024,principle:'robustness',allowedActions:['retry','replan','decompose'],...defaults};
  if(values['isolation-image']!==undefined)value.image=values['isolation-image'];
  if(!value.image)invalid('--supervise requires --isolation-image sha256:<local Linux image ID>.');
  if(values.principle!==undefined)value.principle=values.principle;
  for(const [flag,key]of [['supervision-rounds','maxRounds'],['supervision-stall-rounds','maxStalledRounds'],['supervision-output-tokens','maxOutputTokens']] as const){
    if(values[flag]===undefined)continue;
    const raw=String(values[flag]);if(!/^\d+$/.test(raw))invalid('Invalid --'+flag+'.');
    value[key]=Number(raw);
  }
  if(values['supervision-rounds']!==undefined&&values['supervision-stall-rounds']===undefined&&!defaults)value.maxStalledRounds=Math.min(2,Number(value.maxRounds));
  for(const [flag,key]of [['controller','controller'],['supervision-reviewer','reviewer']] as const){
    if(values[flag+'-model']!==undefined&&values[flag+'-provider']===undefined)invalid('--'+flag+'-model requires --'+flag+'-provider.');
    if(values[flag+'-provider']!==undefined)value[key]={provider:values[flag+'-provider'],...(values[flag+'-model']!==undefined?{model:values[flag+'-model']}:{})};
  }
  const effort:Record<string,unknown>={...defaults?.reasoningEffort};
  if(values['controller-effort']!==undefined)effort.controller=values['controller-effort'];
  if(values['supervision-reviewer-effort']!==undefined)effort.reviewer=values['supervision-reviewer-effort'];
  if(Object.keys(effort).length)value.reasoningEffort=effort;
  return validateGoalSupervision(value);
}
