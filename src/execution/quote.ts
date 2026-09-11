import {randomUUID} from 'node:crypto';
import type {Message,Tool} from '../types.js';
import type {RouteCandidate} from '../routing/index.js';
import type {ProviderAttemptBudget} from '../providers/types.js';
import {getBudgetCaps,projectBudgetPath} from '../budget.js';
import {throwIfCancelled} from '../cancellation.js';
import {ExecutionLimitError} from './types.js';
import {integer} from './authority.js';
import {requestCostNanos} from './ledger.js';
import {ProjectSpendLedger} from './project-spend.js';

export function costCapNanos(value:number):number {
  if(!Number.isFinite(value)||value<0)throw new ExecutionLimitError('budget','Configured cost cap is invalid.');
  const cap=Math.floor(value*1e9);integer(cap);return cap;
}
export function providerQuote(route:RouteCandidate|undefined,messages:Message[],tools:Tool[],streaming:boolean,maxOutputTokens:number) {
    integer(maxOutputTokens,1,100000000);
    if(!route || route.evidence!=='live' || !route.discoveredAt || !Number.isFinite(Date.parse(route.discoveredAt)) || Date.now()-Date.parse(route.discoveredAt)>300000 || Date.parse(route.discoveredAt)>Date.now()+1000)
      throw new ExecutionLimitError('authority','Bounded execution requires recent live model discovery.');
    if(route.capabilities.chat!==true || tools.length&&route.capabilities.tools!==true || streaming&&route.capabilities.streaming!==true)
      throw new ExecutionLimitError('authority','Live discovery did not confirm the required model capabilities.');
    // The full discovered input capacity is a conservative bound, not a tokenizer estimate.
    const inputTokens=route.contextLength,outputTokens=maxOutputTokens;
    if(!Number.isSafeInteger(inputTokens)||inputTokens!<1||inputTokens!>100000000||!Number.isSafeInteger(route.maxOutputTokens)||route.maxOutputTokens!<outputTokens)
      throw new ExecutionLimitError('budget','Bounded execution requires discovered input/output limits that cover the requested output.');
    if(messages.some(m=>typeof m.content!=='string'&&m.content.some(p=>p.type!=='text')))
      throw new ExecutionLimitError('budget','Multimodal requests require a separate verified billing bound.');
    const inputPrice=route.price?.input,outputPrice=route.price?.output;
    if(inputPrice===undefined||outputPrice===undefined||!Number.isFinite(inputPrice)||!Number.isFinite(outputPrice)||inputPrice<0||outputPrice<0)
      throw new ExecutionLimitError('budget','Live discovery did not provide bounded input/output prices; configure verified provider metadata before execution.');
    return {provider:route.provider,model:route.model,target:route.target,inputTokens:inputTokens!,outputTokens,inputPrice,outputPrice,costNanos:requestCostNanos(inputTokens!,outputTokens,inputPrice,outputPrice)};
}

/** Project-capped ordinary turns use the same pre-dispatch accounting as child turns. */
export function projectAttemptBudget(cwd:string,runId:string,route:RouteCandidate|undefined,messages:Message[],tools:Tool[],streaming:boolean,maxOutputTokens:number,signal?:AbortSignal,onEvent?:(id:string,stage:string)=>void):ProviderAttemptBudget {
  const quote=providerQuote(route,messages,tools,streaming,maxOutputTokens),ledger=new ProjectSpendLedger(projectBudgetPath(cwd));
  return {
    reserve:async actual=>{
      throwIfCancelled(signal);
      if(actual.provider!==quote.provider||actual.model!==quote.model||actual.target!==quote.target||actual.maxOutputTokens!==quote.outputTokens)throw new ExecutionLimitError('authority','Provider attempt changed after project budget admission.');
      const id=randomUUID(),cap=getBudgetCaps().maxCostPerProject;
      await ledger.reserve(id,runId,quote.costNanos,cap===undefined?Number.MAX_SAFE_INTEGER:costCapNanos(cap),signal);onEvent?.(id,'reserved');return id;
    },
    settle:async(id,outcome,usage)=>{
      const valid=!usage||[usage.inputTokens,usage.outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100000000);
      const exceeded=!valid||!!usage&&(usage.inputTokens>quote.inputTokens||usage.outputTokens>quote.outputTokens);
      await ledger.settle(id,outcome==='success'&&valid&&usage?requestCostNanos(usage.inputTokens,usage.outputTokens,quote.inputPrice,quote.outputPrice):null,exceeded);
      onEvent?.(id,exceeded?'exceeded':outcome==='success'&&usage?'settled':'unknown');
      if(exceeded)throw new ExecutionLimitError('budget','Provider usage exceeded the project reservation; further requests are stopped.');
    },
  };
}
