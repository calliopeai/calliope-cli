import type {SpawnInput} from '../spawning/types.js';
import type {FailureKind,HealthProvider,HealthSnapshot} from '../health/types.js';

export type OptimizationPrinciple='speed'|'robustness'|'stability'|'security'|'performance'|'cost';
export type SupervisionAction='retry'|'replan'|'decompose';

/** Captured in the reviewed plan; resuming a run cannot expand this authority. */
export interface SupervisionPolicy {
  version:1;
  controllerId:string;
  reviewerId?:string;
  reasoningEffort?:Partial<Record<SupervisionRole,import('../models/index.js').ReasoningEffort>>;
  maxRounds:number;
  maxStalledRounds:number;
  maxOutputTokens:number;
  principle:OptimizationPrinciple;
  allowedActions:SupervisionAction[];
}

interface DecisionEvidence {
  version:1;
  reason:string;
  evidence:string[];
}
interface ImprovementHypothesis {
  hypothesis:string;
  expectedMetric:{name:string;direction:'increase'|'decrease'};
}

/** A decision proposes work; only the executor can establish acceptance. */
export type SupervisionDecision=
  |DecisionEvidence&{action:'continue'|'stop'}
  |DecisionEvidence&ImprovementHypothesis&{action:'retry';taskId:string}
  |DecisionEvidence&ImprovementHypothesis&{action:'replan';taskId:string;strategy:string}
  |DecisionEvidence&ImprovementHypothesis&{action:'decompose';children:SpawnInput};

export interface RetryReceipt {artifactId:string;sha256:string;exitCode:number;outcome:'passed'|'failed'|'timeout';cleanupConfirmed:true}
export type SupervisionRole='controller'|'reviewer';
export interface SupervisionProviderHealth {
  provider:HealthProvider;target:string;sampleCount:number;latencyMs:number|null;timeoutRate:number|null;retryRate:number|null;errorRate:number|null;
  lastSuccessAt:string|null;lastFailure:{at:string;kind:FailureKind;httpStatus:number|null}|null;
  discovery:HealthSnapshot['discovery'];lastSuccessfulConformanceAt:string|null;capabilities:HealthSnapshot['capabilities'];
  quarantine:HealthSnapshot['quarantine'];importedEvents:number;
}
/** Sanitized append-only health evidence captured before a review request. */
export type SupervisionHealthEvidence={version:1;observedAt:string;status:'available';historyHash:string;eventCount:number;providers:SupervisionProviderHealth[]}
  |{version:1;observedAt:string;status:'unavailable';historyHash:null;eventCount:0;providers:[];reason:'local-health-history-unavailable'};
export type ReviewerVerdict={version:1;draftHash:string}&(
  |{verdict:'approve'|'reject';reason:string}
  |{verdict:'revise';decision:SupervisionDecision}
);
export type SupervisionChange=
  |{type:'supervision_started';round:number;role:SupervisionRole;agentId:string;sessionId:string;evidenceIds:string[];evidenceHash:string;health?:SupervisionHealthEvidence;requestAttribution?:1}
  |{type:'supervision_decided';round:number;role:SupervisionRole;agentId:string;sessionId:string;decision:SupervisionDecision}
  |{type:'supervision_applied';round:number;decisionId:string;receipts:RetryReceipt[]}
  |{type:'supervision_halted';round:number;outcome:'stop'|'limit'|'failed'|'denied'|'cancelled'|'interrupted';reason:string}
  |{type:'supervision_reset';source:'cli'|'repl'}
  |{type:'supervision_withdrawn';decisionId:string;source:'cli'|'repl'}
  |{type:'supervision_proposed'|'supervision_approved';decisionId:string;proposalHash:string;source:'cli'|'repl'};

export interface SupervisionProjection {
  version:1;rounds:number;stalledRounds:number;
  phase:'ready'|'controller'|'draft-ready'|'reviewer'|'decision'|'halted';
  evidenceIds:string[];evidenceHash:string|null;reviewedHash:string|null;
  completedTasks:number;forceReview:boolean;
  operatorReview:boolean;review:{decisionId:string;proposalHash:string;approved:boolean;announced:boolean}|null;
  active:{agentId:string;sessionId:string;role:SupervisionRole}|null;
  draft:SupervisionDecision|null;decision:SupervisionDecision|null;decisionId:string|null;
  halt:{outcome:'stop'|'limit'|'failed'|'denied'|'cancelled'|'interrupted';reason:string}|null;
  strategies:Record<string,{decisionId:string;strategy:string;evidence:string[]}>;
}
