import type {ProjectIdentity,ProjectPlan,PathGrant,GoalRunLink} from '../orchestration/types.js';
import type {SupervisionPolicy} from '../supervision/types.js';

export interface GoalLimits {
  tokenBudget:number;costBudgetNanos:number;timeBudgetMs:number;
  planningTokens:number;planningCostNanos:number;planningTimeMs:number;maxOutputTokens:number;
  maxAgents:number;maxTasks:number;maxDepth:number;maxConcurrent:number;
}
export interface GoalManifest {
  version:1|2|3|4;id:string;createdAt:string;deadline:number;project:ProjectIdentity;runsRoot:string;goal:string;
  preference:{provider:string;model?:string};workspace:{allowedTools:string[];allowedPaths:PathGrant[]};
  limits:GoalLimits;team?:GoalTeam;supervision?:GoalSupervision;planningRepair?:{version:1;maxRetries:number};hash:string;
}
/** Operator intent captured before planning; the proposed graph supplies account IDs. */
export interface GoalSupervision extends Pick<SupervisionPolicy,'version'|'maxRounds'|'maxStalledRounds'|'maxOutputTokens'|'principle'|'allowedActions'|'reasoningEffort'> {
  image:string;
  controller?:GoalManifest['preference'];
  reviewer?:GoalManifest['preference'];
}
export interface GoalTeam {
  version:1;
  reviewer?:GoalManifest['preference'];
  workers?:GoalManifest['preference'];
  maxAttempts?:number;
}
export interface GoalAllocation {
  id:string;phase:'planning'|'execution';runId:string;planHash:string;
  tokens:number;costNanos:number;deadline:number;
}
export interface PlanningSpend {tokens:number;costNanos:number;revision:string}
export type ProposalSource=
  |{kind:'agent';runId:string;artifactId:string;artifactHash:string;eventId:string}
  |{kind:'human';path:string;sha256:string};
export interface GoalProposal {
  version:1;goalId:string;goalManifestHash:string;plan:ProjectPlan;planHash:string;
  knowledgeStatus:'proposed';confidence:null;inferred:boolean;source:ProposalSource;hash:string;
}
export type GoalStatus='created'|'planning'|'review_required'|'approved'|'running'|'partial'|'completed'|'failed'|'denied'|'cancelled';
export type GoalChange=
  |{type:'planning_allocated';allocation:GoalAllocation}
  |{type:'planning_finished';status:'review_required'|'failed'|'denied'|'cancelled';spend:PlanningSpend|null;proposalHash:string|null;reason:string}
  |{type:'proposal_revised';proposalHash:string}
  |{type:'execution_allocated';allocation:GoalAllocation;proposalHash:string;source:'cli'|'repl'}
  |{type:'execution_started';runId:string}
  |{type:'execution_interrupted';runId:string;status:'failed'|'denied'|'cancelled';reason:string}
  |{type:'execution_finished';runId:string;revision:string;status:'completed'|'partial'|'failed'|'denied'|'cancelled';completed:number;total:number}
  |{type:'cancelled';source:'cli'|'repl'};
export interface GoalEvent {version:1;id:string;goalId:string;sequence:number;at:string;previous:string;change:GoalChange;hash:string}
export interface GoalProjection {
  version:1;id:string;revision:string;status:GoalStatus;revoked:boolean;planning:GoalAllocation|null;execution:GoalAllocation|null;
  planningSpend:PlanningSpend|null;planningFrozen:boolean;proposalHash:string|null;approvedProposalHash:string|null;
  result:{runId:string;revision:string;status:GoalStatus;completed:number;total:number}|null;
}
export interface GoalInspection {manifest:GoalManifest;events:GoalEvent[];state:GoalProjection;proposal:GoalProposal|null}
export interface GoalOwner {id:string;check:()=>void;release:()=>void}
export interface BoundRun {id:string;createdAt:string;goal:GoalRunLink}
