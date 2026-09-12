import type {CollectedArtifact,CheckEvidence,TaskStatus} from '../orchestration/coordinator-types.js';
import type {ProjectPlan} from '../orchestration/types.js';
import type {OptimizationPrinciple,SupervisionDecision} from '../supervision/types.js';

export interface CycleEventRef {id:string;hash:string;at:string;sequence:number}
export interface CycleOutcome {
  taskId:string;attempt:number;status:Exclude<TaskStatus,'pending'|'running'>;event:CycleEventRef;
  checks:CheckEvidence[];artifacts:CollectedArtifact[];risks:string[];
  durationMs:number|null;toolCalls:number;toolFailures:number;
}
export interface CycleMetric {
  name:'acceptance-check-pass-rate'|'attempt-duration'|'tool-failure-rate';unit:'ratio'|'ms';
  before:number|null;after:number|null;delta:number|null;comparable:boolean;
  reason:string;direction:'increase'|'decrease';
}
/** Derived exclusively from the append-only execution history, at a named revision. */
export interface ImprovementCycle {
  version:1;id:string;runId:string;round:number;principle:OptimizationPrinciple;
  parentCycleId:string|null;previousCycleId:string|null;
  status:'proposed'|'running'|'verified'|'failed'|'partial'|'cancelled'|'withdrawn';
  trigger:{reason:string;events:CycleEventRef[]};
  hypothesis:{text:string;state:'proposed'};
  proposedChange:Extract<SupervisionDecision,{action:'retry'|'replan'|'decompose'}>;
  expectedMetric:{name:string;direction:'increase'|'decrease';state:'proposed'};
  budget:{deadline:number;limits:ProjectPlan['limits'];accounts:Pick<ProjectPlan['agents'][number],'id'|'parentId'|'tokenBudget'|'costBudgetUsd'|'timeBudgetMs'|'maxChildDepth'|'maxChildCount'|'allowedTools'|'allowedPaths'>[]};
  approval:{proposal:CycleEventRef|null;approval:CycleEventRef|null;execution:'reviewed-policy'|'pending';planHash:string;approvalRevision:string;production:'not-approved'};
  withdrawal:CycleEventRef|null;application:CycleEventRef|null;targetTaskIds:string[];baseline:CycleOutcome[];results:CycleOutcome[];
  metrics:CycleMetric[];risks:string[];
  isolation:{mode:'git-worktree'|'unavailable';image:string|null};
  rollback:{kind:'retained-source-and-artifacts';manifestHash:string;baselineEvents:CycleEventRef[];patches:CollectedArtifact[];productionChanged:false;baseCommit:string|null};
  source:{manifestHash:string;executionRevision:string;decision:CycleEventRef};
}
export interface ImprovementHistory {
  version:1;kind:'improvement.history';runId:string;revision:string;cycles:ImprovementCycle[];
}
