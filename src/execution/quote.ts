import {randomUUID} from 'node:crypto';
import type {Message,Tool} from '../types.js';
import type {RouteCandidate} from '../routing/index.js';
import {projectIdentity} from '../approvals/index.js';
import type {ProviderAttemptBudget} from '../providers/types.js';
import {getBudgetCaps,projectBudgetPath} from '../budget.js';
import {throwIfCancelled} from '../cancellation.js';
import {ExecutionLimitError} from './types.js';
import {integer} from './authority.js';
import {requestCostNanos} from './ledger.js';
import {ProjectSpendLedger} from './project-spend.js';
import {readBillingEvidence,assertBillingCurrent,validateInputCount,validateQuoteEvidence,fullContextTerms,type BillingEvidence,type InputCount,type QuoteEvidence} from './billing.js';
import {estimateTotalTokens} from '../summarization.js';

export function costCapNanos(value:number):number {
  if(!Number.isFinite(value)||value<0)throw new ExecutionLimitError('budget','Configured cost cap is invalid.');
  const cap=Math.floor(value*1e9);integer(cap);return cap;
}
export function providerQuote(route:RouteCandidate|undefined,messages:Message[],tools:Tool[],streaming:boolean,maxOutputTokens:number,billing?:BillingEvidence,count?:InputCount,measuredInput=false) {
    integer(maxOutputTokens,1,100000000);
    if(!route || route.evidence!=='live' || !route.discoveredAt || !Number.isFinite(Date.parse(route.discoveredAt)) || Date.now()-Date.parse(route.discoveredAt)>300000 || Date.parse(route.discoveredAt)>Date.now()+1000)
      throw new ExecutionLimitError('authority','Bounded execution requires recent live model discovery.');
    if(billing)assertBillingCurrent(billing,route);
    if(messages.some(m=>typeof m.content!=='string'&&m.content.some(p=>p.type!=='text')))
      throw new ExecutionLimitError('budget','Multimodal requests require a separate verified billing bound.');
    if(billing?.profile.admission==='reviewed-full-context-v1'){
      if(count)throw new ExecutionLimitError('authority','Full-context admission does not accept an unverified input count.');
      const quoteEvidence=validateQuoteEvidence({version:2,profileHash:billing.hash,profile:billing.profile,quotedAt:Date.now(),live:{discoveredAt:Date.parse(route.discoveredAt),contextLength:route.contextLength,maxOutputTokens:route.maxOutputTokens,capabilities:Object.fromEntries(['chat','tools','streaming'].filter(k=>route.capabilities[k as keyof typeof route.capabilities]!==undefined).map(k=>[k,route.capabilities[k as keyof typeof route.capabilities]])),prices:{input:route.price?.input??null,output:route.price?.output??null}},requirements:{tools:tools.length>0,streaming},...(measuredInput?{measuredInput:true}:{})});
      if(quoteEvidence.version!==2)throw new ExecutionLimitError('authority','Wrong reviewed admission evidence.');
      const terms=fullContextTerms(quoteEvidence), inputTokens=measuredInput?Math.min(terms.inputTokens,Math.max(1,estimateTotalTokens(messages)+Math.ceil(JSON.stringify(tools).length/4))):terms.inputTokens;
      const {maxOutputTokens:outputLimit,inputPrice,outputPrice}=terms;
      if(maxOutputTokens>outputLimit)throw new ExecutionLimitError('budget','Requested output exceeds live or reviewed model limits.');
      // Keep the signed live quote alongside measured input reservations. The
      // measured size changes accounting, while the quote remains the
      // replayable admission evidence for provider limits and pricing.
      return{provider:route.provider,model:route.model,target:route.target,inputTokens,outputTokens:maxOutputTokens,inputPrice,outputPrice,costNanos:requestCostNanos(inputTokens,maxOutputTokens,inputPrice,outputPrice),quoteEvidence};
    }
    const capabilities:RouteCandidate['capabilities']={...billing?.profile.capabilities,...Object.fromEntries(Object.entries(route.capabilities).filter(([,v])=>v!==undefined))};
    if(capabilities.chat!==true || tools.length&&capabilities.tools!==true || streaming&&capabilities.streaming!==true)
      throw new ExecutionLimitError('authority','Live discovery did not confirm the required model capabilities.');
    // The full discovered input capacity is a conservative bound, not a tokenizer estimate.
    const local=route.provider==='ollama'||route.provider==='litellm'||route.provider==='openai-compat';
    // Local servers expose a context window but no billable input reservation;
    // reserve the measured request size so token budgets remain meaningful.
    const contextLimit=route.contextLength??0;
    const measured=Math.max(1,estimateTotalTokens(messages)+Math.ceil(JSON.stringify(tools).length/4));
    let inputTokens=local?Math.min(contextLimit,measured):contextLimit;
    const outputTokens=maxOutputTokens;
    if(!Number.isSafeInteger(inputTokens)||inputTokens!<1||inputTokens!>100000000||!Number.isSafeInteger(route.maxOutputTokens)||route.maxOutputTokens!<outputTokens)
      throw new ExecutionLimitError('budget','Bounded execution requires discovered input/output limits that cover the requested output.');

    let quoteEvidence:QuoteEvidence|undefined;
    if(count){
      validateInputCount(count);
      if(!billing||billing.profile.admission!=='provider-count-v1'||route.provider!=='anthropic'||count.at>Date.now()+1000||Date.now()-count.at>60000)throw new ExecutionLimitError('authority','Provider input count requires current matching billing evidence.');
      if(count.inputTokens>inputTokens!)throw new ExecutionLimitError('budget','Counted request exceeds the discovered input capacity.');
      inputTokens=Math.min(inputTokens!,count.inputTokens*2+1024);
      quoteEvidence={version:1,profileHash:billing.hash,profile:structuredClone(billing.profile),count:structuredClone(count),multiplier:2,slackTokens:1024};
    }
    const inputPrice=billing?Math.max(billing.profile.prices.input,route.price?.input??0):route.price?.input??(local?0:undefined);
    const outputPrice=billing?Math.max(billing.profile.prices.output,route.price?.output??0):route.price?.output??(local?0:undefined);
    if(inputPrice===undefined||outputPrice===undefined||!Number.isFinite(inputPrice)||!Number.isFinite(outputPrice)||inputPrice<0||outputPrice<0)
      throw new ExecutionLimitError('budget','Live discovery did not provide bounded input/output prices; configure verified provider metadata before execution.');
    return {provider:route.provider,model:route.model,target:route.target,inputTokens:inputTokens!,outputTokens,inputPrice,outputPrice,costNanos:requestCostNanos(inputTokens!,outputTokens,inputPrice,outputPrice),...(quoteEvidence?{quoteEvidence}:{})};
}

/** Project-capped ordinary turns use the same pre-dispatch accounting as child turns. */
export function projectAttemptBudget(cwd:string,runId:string,route:RouteCandidate|undefined,messages:Message[],tools:Tool[],streaming:boolean,maxOutputTokens:number,signal?:AbortSignal,onEvent?:(id:string,stage:string,evidence?:QuoteEvidence)=>void,measuredInput=false):ProviderAttemptBudget {
  route=structuredClone(route);const project=projectIdentity(cwd).project,billing=readBillingEvidence(route,project);
  const base=providerQuote(route,messages,tools,streaming,maxOutputTokens,billing,undefined,measuredInput),ledger=new ProjectSpendLedger(projectBudgetPath(cwd));
  const quotes=new Map<string,ReturnType<typeof providerQuote>>();
  return {
    ...(base.provider==='openrouter'?{priceCeiling:Object.freeze({input:base.inputPrice,output:base.outputPrice})}:{}),
    ...(billing?.profile.admission==='provider-count-v1'?{inputCounting:'anthropic-count-tokens' as const}:{}),
    reserve:async actual=>{
      throwIfCancelled(signal);
      if(actual.provider!==base.provider||actual.model!==base.model||actual.target!==base.target||actual.maxOutputTokens!==base.outputTokens)throw new ExecutionLimitError('authority','Provider attempt changed after project budget admission.');
      if(base.provider==='openrouter'&&(actual.priceCeiling?.input!==base.inputPrice||actual.priceCeiling?.output!==base.outputPrice))throw new ExecutionLimitError('authority','Provider price ceiling changed after project budget admission.');
      if(billing&&((billing.profile.admission==='provider-count-v1'&&!actual.inputCount)||readBillingEvidence(route,project)?.hash!==billing.hash))throw new ExecutionLimitError('authority','Billing admission was revoked or omitted its count.');
      const quote=providerQuote(route,messages,tools,streaming,maxOutputTokens,billing,actual.inputCount,measuredInput);
      const id=randomUUID(),cap=getBudgetCaps().maxCostPerProject;
      await ledger.reserve(id,runId,quote.costNanos,cap===undefined?Number.MAX_SAFE_INTEGER:costCapNanos(cap),signal);quotes.set(id,quote);onEvent?.(id,'reserved',quote.quoteEvidence);
      throwIfCancelled(signal);
      if(billing&&readBillingEvidence(route,project)?.hash!==billing.hash)throw new ExecutionLimitError('authority','Billing admission was revoked while committing its reservation.');
      return id;
    },
    settle:async(id,outcome,usage)=>{
      const quote=quotes.get(id);if(!quote)throw new ExecutionLimitError('authority','Unknown project request reservation.');
      const valid=!usage||[usage.inputTokens,usage.outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100000000);
      const exceeded=!valid||!!usage&&(usage.inputTokens>quote.inputTokens||usage.outputTokens>quote.outputTokens);
      await ledger.settle(id,outcome==='success'&&valid&&usage?requestCostNanos(usage.inputTokens,usage.outputTokens,quote.inputPrice,quote.outputPrice):null,exceeded);
      onEvent?.(id,exceeded?'exceeded':outcome==='success'&&usage?'settled':'unknown');
      if(exceeded)throw new ExecutionLimitError('budget','Provider usage exceeded the project reservation; further requests are stopped.');
    },
  };
}
