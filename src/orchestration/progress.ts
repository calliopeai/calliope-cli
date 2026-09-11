import type {ProjectPlan} from './types.js';
import type {LLMProvider} from '../types.js';
import type {RunPlanContext,ExecutionInspection} from './coordinator-types.js';

export interface CoordinatorProgress {context:RunPlanContext;execution:ExecutionInspection}

export function agentPreference(plan:ProjectPlan,agentId:string):{provider?:LLMProvider;model?:string} {
  let agent=plan.agents.find(a=>a.id===agentId),model:string|undefined;
  for(let n=0;agent&&n<plan.agents.length;n++){
    model??=agent.preference.model;
    if(agent.preference.provider!=='auto')return{provider:agent.preference.provider as LLMProvider,...(model?{model}:{})};
    agent=plan.agents.find(a=>a.id===agent!.parentId);
  }
  return model?{model}:{};
}
