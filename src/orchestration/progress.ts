import type {ProjectPlan,RunManifest} from './types.js';
import type {LLMProvider} from '../types.js';
import type {RunPlanContext,ExecutionInspection} from './coordinator-types.js';
import {readRunAccounting,type RunAccounting} from './accounting.js';
import type {ExecutionStore} from './execution-store.js';

export interface CoordinatorProgress {context:RunPlanContext;execution:ExecutionInspection;manifest?:RunManifest;accounting?:RunAccounting}
export function coordinatorProgress(store:ExecutionStore,execution=store.read()):CoordinatorProgress {
  return{context:store.context(execution),execution,manifest:store.manifest,accounting:readRunAccounting(store,execution)};
}

export function agentPreference(plan:ProjectPlan,agentId:string):{provider?:LLMProvider;model?:string|null} {
  let agent=plan.agents.find(a=>a.id===agentId),model:string|undefined;
  // An approved Smart pool is independent of the parent's pinned model.
  if(agent?.routing)return {provider:agent.preference.provider as LLMProvider,model:agent.preference.model??null};
  for(let n=0;agent&&n<plan.agents.length;n++){
    model??=agent.preference.model;
    if(agent.preference.provider!=='auto')return{provider:agent.preference.provider as LLMProvider,...(model?{model}:{})};
    agent=plan.agents.find(a=>a.id===agent!.parentId);
  }
  return model?{model}:{};
}
