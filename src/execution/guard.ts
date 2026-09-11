import { randomUUID } from 'node:crypto';
import type { Tool, ToolCall, Message } from '../types.js';
import type { RouteCandidate } from '../routing/index.js';
import type { ProviderAttemptBudget } from '../providers/types.js';
import { throwIfCancelled } from '../cancellation.js';
import { executionToolDenial, accountLineage, checkExecutionIdentity, integer } from './authority.js';
import { ReservationLedger, requestCostNanos } from './ledger.js';
import { ExecutionLimitError, type ExecutionManifest } from './types.js';
import {getBudgetCaps,projectBudgetPath} from '../budget.js';
import {ProjectSpendLedger} from './project-spend.js';
import {providerQuote,costCapNanos} from './quote.js';

export interface AgentExecution {
  ledger: ReservationLedger; manifestHash: string; agentId: string; maxOutputTokens: number;
}
export class ExecutionGuard {
  readonly manifest:ExecutionManifest;
  readonly deadline:number;
  private readonly expectedHash:string;
  private readonly agentId:string;
  private readonly ledger:ReservationLedger;
  readonly maxOutputTokens:number;
  constructor(execution:AgentExecution,private readonly cwd:string) {
    const saved=execution.ledger.read(cwd);
    if(saved.projection.manifestHash!==execution.manifestHash)throw new ExecutionLimitError('conflict','Execution contract does not match the budget ledger.');
    const agent=accountLineage(saved.manifest,execution.agentId)[0]!;
    integer(execution.maxOutputTokens,1,100000000);this.manifest=saved.manifest;this.expectedHash=execution.manifestHash;this.agentId=agent.id;this.ledger=execution.ledger;this.maxOutputTokens=execution.maxOutputTokens;
    this.deadline=Math.min(saved.manifest.deadline,agent.deadline);
  }
  check= (call:ToolCall,cwd=this.cwd):string|undefined => executionToolDenial(this.manifest,this.agentId,call,cwd);
  tools(tools:Tool[]):Tool[] {
    const allowed=accountLineage(this.manifest,this.agentId)[0]!.allowedTools;
    return tools.filter(tool=>allowed.includes(tool.name) && ['think','ask_question','create_plan','read_file','write_file','edit_file','list_files'].includes(tool.name));
  }
  assertActive(signal?:AbortSignal):void {
    throwIfCancelled(signal);checkExecutionIdentity(this.manifest,this.cwd);
    if(Date.now()>=this.deadline)throw new ExecutionLimitError('deadline','Agent deadline expired.');
    const saved=this.ledger.read(this.cwd);if(saved.projection.manifestHash!==this.expectedHash)throw new ExecutionLimitError('conflict','Execution contract changed.');
    if(saved.projection.exceeded)throw new ExecutionLimitError('budget','Provider usage exceeded its reservation; further execution is stopped.');
    const project=new ProjectSpendLedger(projectBudgetPath(this.cwd)).read(),caps=getBudgetCaps();
    if(project.blocked||caps.maxCostPerProject!==undefined&&project.spentUsd>caps.maxCostPerProject || caps.maxTokensPerRun!==undefined&&saved.projection.spent.tokens>caps.maxTokensPerRun || caps.maxCostPerRun!==undefined&&saved.projection.spent.costNanos>costCapNanos(caps.maxCostPerRun))
      throw new ExecutionLimitError('budget','Current project or run policy no longer permits execution.');
  }
  budget(route:RouteCandidate|undefined,messages:Message[],tools:Tool[],streaming:boolean,signal?:AbortSignal,onEvent?:(event:{requestId:string;stage:string;revision:string;tokens:number;costNanos:number})=>void):ProviderAttemptBudget {
    this.assertActive(signal);
    const quote=providerQuote(route,messages,tools,streaming,this.maxOutputTokens);
    const projectLedger=new ProjectSpendLedger(projectBudgetPath(this.cwd));
    return {
      reserve:async actual=>{
        this.assertActive(signal);
        if(actual.provider!==quote.provider||actual.model!==quote.model||actual.target!==quote.target||actual.maxOutputTokens!==quote.outputTokens)
          throw new ExecutionLimitError('authority','Provider attempt does not match its discovered budget quote.');
        const id=randomUUID(),caps=getBudgetCaps();
        await projectLedger.reserve(id,this.manifest.runId,quote.costNanos,caps.maxCostPerProject===undefined?Number.MAX_SAFE_INTEGER:costCapNanos(caps.maxCostPerProject),signal);
        const limits={...(caps.maxTokensPerRun===undefined?{}:{tokens:caps.maxTokensPerRun}),...(caps.maxCostPerRun===undefined?{}:{costNanos:costCapNanos(caps.maxCostPerRun)})};
        let state;
        try{state=await this.ledger.reserve(this.cwd,this.expectedHash,{id,agentId:this.agentId,...quote,limits},signal);}
        catch(error){await projectLedger.settle(id,0);throw error;}
        onEvent?.({requestId:id,stage:'reserved',revision:state.revision,...state.spent});
        this.assertActive(signal);return id;
      },
      settle:async(id,outcome,usage)=>{
        const valid=!usage||[usage.inputTokens,usage.outputTokens].every(n=>Number.isSafeInteger(n)&&n>=0&&n<=100000000);
        const state=await this.ledger.settle(this.cwd,this.expectedHash,{requestId:id,outcome:valid?outcome:'invalid-usage',...(usage&&valid?{usage}: {})});
        await projectLedger.settle(id,outcome==='success'&&valid&&usage?requestCostNanos(usage.inputTokens,usage.outputTokens,quote.inputPrice,quote.outputPrice):null,state.exceeded);
        onEvent?.({requestId:id,stage:state.requests[id]!.state,revision:state.revision,...state.spent});
        if(state.exceeded)throw new ExecutionLimitError('budget','Provider reported usage beyond the reserved bound; execution stopped.');
      },
    };
  }
}
