import { randomUUID } from 'node:crypto';
import {dirname,relative,resolve,isAbsolute} from 'node:path';
import {canonicalPath} from '../approvals/index.js';
import type { Tool, ToolCall, Message } from '../types.js';
import type { RouteCandidate } from '../routing/index.js';
import type { ProviderAttemptBudget } from '../providers/types.js';
import { throwIfCancelled } from '../cancellation.js';
import { executionToolDenial, executionPathDenial, accountLineage, checkExecutionIdentity, integer,assertExecutionStoreOutsideProject } from './authority.js';
import { ReservationLedger, requestCostNanos } from './ledger.js';
import { ExecutionLimitError, type ExecutionManifest } from './types.js';
import {getBudgetCaps,projectBudgetPath} from '../budget.js';
import {ProjectSpendLedger} from './project-spend.js';
import {providerQuote,costCapNanos} from './quote.js';
import {effectiveExecutionManifest} from './child-grants.js';
import {BRAIN_TOOLS,BRAIN_TOOL_NAMES,type BrainToolContext} from '../brain/tools.js';
import {readBillingEvidence} from './billing.js';
import {validateRequestAttribution,type RequestAttribution} from './attribution.js';

export interface AgentExecution {
  ledger: ReservationLedger; manifestHash: string; agentId: string; maxOutputTokens: number;
  measuredInputReservation?: boolean;
  attribution?:RequestAttribution;
  /** Trusted coordinator ownership/revocation check; may only narrow authority. */
  assertAuthority?: () => void;
  /** Supplied by the coordinator; policy and money remain bound to the source project. */
  workspace?: {filesRoot:string;assertIdentity:()=>void};
}
export class ExecutionGuard {
  readonly manifest:ExecutionManifest;
  readonly deadline:number;
  private readonly expectedHash:string;
  private readonly agentId:string;
  private readonly ledger:ReservationLedger;
  readonly maxOutputTokens:number;
  private readonly assertAuthority?:()=>void;
  readonly filesRoot:string;
  private readonly workspace?:AgentExecution['workspace'];
  private readonly attribution?:RequestAttribution;
  private readonly measuredInputReservation:boolean;
  constructor(execution:AgentExecution,private readonly cwd:string) {
    this.attribution=execution.attribution===undefined?undefined:validateRequestAttribution(execution.attribution); this.measuredInputReservation=execution.measuredInputReservation===true;
    this.assertAuthority=execution.assertAuthority;this.assertAuthority?.();this.workspace=execution.workspace;this.workspace?.assertIdentity();
    const saved=execution.ledger.read(cwd);
    assertExecutionStoreOutsideProject(saved.manifest.project.root,dirname(execution.ledger.root));
    if(saved.projection.manifestHash!==execution.manifestHash)throw new ExecutionLimitError('conflict','Execution contract does not match the budget ledger.');
    const effective=effectiveExecutionManifest(saved.manifest,saved.projection),agent=accountLineage(effective,execution.agentId)[0]!;
    integer(execution.maxOutputTokens,1,100000000);this.manifest=effective;this.expectedHash=execution.manifestHash;this.agentId=agent.id;this.ledger=execution.ledger;this.maxOutputTokens=execution.maxOutputTokens;
    this.deadline=Math.min(saved.manifest.deadline,agent.deadline);
    this.filesRoot=this.workspace?.filesRoot??this.manifest.project.root;
    if(this.workspace)assertExecutionStoreOutsideProject(this.manifest.project.root,this.filesRoot);
  }
  check= (call:ToolCall,cwd=this.cwd):string|undefined => {
    this.assertAuthority?.();this.workspace?.assertIdentity();
    if(this.workspace&&call.name==='shell')return 'Isolated workers cannot issue model-selected shell commands; use the declared coordinator verifier.';
    const denial=executionToolDenial(this.manifest,this.agentId,call,cwd);if(denial||!this.workspace)return denial;
    if(['read_file','write_file','edit_file','list_files'].includes(call.name))try{this.filePath(resolve(cwd,String(call.arguments.path??'.')));}catch{return 'Isolated file path is outside its workspace or aliases Git metadata.';}
    return undefined;
  };
  filePath(file:string):string {
    if(!this.workspace)return file;this.workspace.assertIdentity();
    const rel=relative(this.manifest.project.root,file);
    if(rel==='..'||rel.startsWith('../')||isAbsolute(rel)||rel.split('/').some(p=>p.toLowerCase()==='.git'))throw new ExecutionLimitError('authority','Isolated file path exceeds its project scope.');
    const path=resolve(this.filesRoot,rel);if(canonicalPath(path)!==path)throw new ExecutionLimitError('authority','Isolated file path became an alias.');return path;
  }
  tools(tools:Tool[]):Tool[] {
    const allowed=accountLineage(this.manifest,this.agentId)[0]!.allowedTools;
    return [...tools.filter(t=>!BRAIN_TOOL_NAMES.includes(t.name as typeof BRAIN_TOOL_NAMES[number])),...BRAIN_TOOLS].filter(tool=>allowed.includes(tool.name) && ['think','ask_question','create_plan','read_file','write_file','edit_file','list_files',...BRAIN_TOOL_NAMES].includes(tool.name));
  }
  brainContext():BrainToolContext {
    return {assertActive:signal=>this.assertActive(signal),sourceDenial:source=>{
      const locator=source.locator;
      if(locator.path&&!locator.projectKey)return 'Knowledge file locator lacks a project binding.';
      if(locator.projectKey&&locator.projectKey!==this.manifest.project.key)return 'Knowledge source belongs to another project.';
      return executionPathDenial(this.manifest,accountLineage(this.manifest,this.agentId)[0]!,locator.projectKey===this.manifest.project.key?locator.path??'.':'.','read');
    }};
  }
  assertActive(signal?:AbortSignal):void {
    throwIfCancelled(signal);this.assertAuthority?.();this.workspace?.assertIdentity();checkExecutionIdentity(this.manifest,this.cwd);
    if(Date.now()>=this.deadline)throw new ExecutionLimitError('deadline','Agent deadline expired.');
    const saved=this.ledger.read(this.cwd);if(saved.projection.manifestHash!==this.expectedHash)throw new ExecutionLimitError('conflict','Execution contract changed.');
    if(saved.projection.exceeded)throw new ExecutionLimitError('budget','Provider usage exceeded its reservation; further execution is stopped.');
    const project=new ProjectSpendLedger(projectBudgetPath(this.cwd)).read(),caps=getBudgetCaps();
    if(project.blocked||caps.maxCostPerProject!==undefined&&project.spentUsd>caps.maxCostPerProject || caps.maxTokensPerRun!==undefined&&saved.projection.spent.tokens>caps.maxTokensPerRun || caps.maxCostPerRun!==undefined&&saved.projection.spent.costNanos>costCapNanos(caps.maxCostPerRun))
      throw new ExecutionLimitError('budget','Current project or run policy no longer permits execution.');
  }
  budget(route:RouteCandidate|undefined,messages:Message[],tools:Tool[],streaming:boolean,signal?:AbortSignal,onEvent?:(event:{requestId:string;stage:string;revision:string;tokens:number;costNanos:number})=>void):ProviderAttemptBudget {
    this.assertActive(signal);
    route=structuredClone(route);const billing=readBillingEvidence(route,this.manifest.project.root);
    const base=providerQuote(route,messages,tools,streaming,this.maxOutputTokens,billing,undefined,this.measuredInputReservation);
    const projectLedger=new ProjectSpendLedger(projectBudgetPath(this.cwd));
    return {
      ...(base.provider==='openrouter'?{priceCeiling:Object.freeze({input:base.inputPrice,output:base.outputPrice})}:{}),
      ...(billing?.profile.admission==='provider-count-v1'?{inputCounting:'anthropic-count-tokens' as const}:{}),
      reserve:async actual=>{
        this.assertActive(signal);
        if(actual.provider!==base.provider||actual.model!==base.model||actual.target!==base.target||actual.maxOutputTokens!==base.outputTokens)
          throw new ExecutionLimitError('authority','Provider attempt does not match its discovered budget quote.');
        if(base.provider==='openrouter'&&(actual.priceCeiling?.input!==base.inputPrice||actual.priceCeiling?.output!==base.outputPrice))throw new ExecutionLimitError('authority','Provider price ceiling changed after budget admission.');
        if(billing&&((billing.profile.admission==='provider-count-v1'&&!actual.inputCount)||readBillingEvidence(route,this.manifest.project.root)?.hash!==billing.hash))throw new ExecutionLimitError('authority','Billing admission was revoked or omitted its count.');
        const quote=providerQuote(route,messages,tools,streaming,this.maxOutputTokens,billing,actual.inputCount,this.measuredInputReservation);
        const id=randomUUID(),caps=getBudgetCaps();
        await projectLedger.reserve(id,this.manifest.runId,quote.costNanos,caps.maxCostPerProject===undefined?Number.MAX_SAFE_INTEGER:costCapNanos(caps.maxCostPerProject),signal);
        const limits={...(caps.maxTokensPerRun===undefined?{}:{tokens:caps.maxTokensPerRun}),...(caps.maxCostPerRun===undefined?{}:{costNanos:costCapNanos(caps.maxCostPerRun)})};
        let state;
        try{state=await this.ledger.reserve(this.cwd,this.expectedHash,{id,agentId:this.agentId,...quote,limits,...(this.attribution?{attribution:this.attribution}:{})},signal);}
        catch(error){await projectLedger.settle(id,0);throw error;}
        onEvent?.({requestId:id,stage:'reserved',revision:state.revision,...state.spent});
        this.assertActive(signal);
        if(billing&&readBillingEvidence(route,this.manifest.project.root)?.hash!==billing.hash)throw new ExecutionLimitError('authority','Billing admission was revoked while committing its reservation.');
        return id;
      },
      settle:async(id,outcome,usage)=>{
        const valid=!usage||[usage.inputTokens,usage.outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100000000);
        const state=await this.ledger.settle(this.cwd,this.expectedHash,{requestId:id,outcome:valid?outcome:'invalid-usage',...(usage&&valid?{usage}: {})});
        const quote=state.requests[id]!.reservation;
        await projectLedger.settle(id,outcome==='success'&&valid&&usage?requestCostNanos(usage.inputTokens,usage.outputTokens,quote.inputPrice,quote.outputPrice):null,state.exceeded);
        onEvent?.({requestId:id,stage:state.requests[id]!.state,revision:state.revision,...state.spent});
        if(state.exceeded)throw new ExecutionLimitError('budget','Provider reported usage beyond the reserved bound; execution stopped.');
      },
    };
  }
}
