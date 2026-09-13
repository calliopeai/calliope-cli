import type {ArtifactSpec,RunManifest} from './types.js';
import type {SpawnAdmission,SpawnGraph} from '../spawning/types.js';

export type TaskStatus='pending'|'running'|'completed'|'review_required'|'failed'|'denied'|'cancelled'|'unknown';
export type ExecutionStatus='ready'|'running'|'completed'|'partial'|'failed'|'denied'|'cancelled';
export interface CollectedArtifact {
  id:string;taskId:string;agentId:string;kind:ArtifactSpec['kind'];
  location:'project'|'run';path:string;sha256:string;bytes:number;
  createdAt:string;source:{runId:string;eventId:string};confidence:number;
}
export interface CheckEvidence {
  id:string;artifactId:string;kind:string;criteria:string[];passed:boolean;observedHash:string|null;
}
export interface TaskOutput {
  version:1;taskId:string;agentId:string;status:'success'|'partial'|'failed'|'denied'|'cancelled';
  summary:string;changedFiles:string[];artifacts:CollectedArtifact[];testEvidence:string[];
  unresolvedRisks:string[];recommendedNextAction:string;checks:CheckEvidence[];
}
export type ExecutionChange=
  |import('../supervision/types.js').SupervisionChange
  |{type:'graph_admitted';admission:SpawnAdmission}
  |{type:'started';ownerId:string;proposalOnly?:true}
  |{type:'task_started';taskId:string;attempt:number;sessionId:string}
  |{type:'task_recovery_started';taskId:string;outcomeId:string}
  |{type:'agent_started';agentId:string;taskId:string}
  |{type:'agent_finished';agentId:string;taskId:string;status:Exclude<TaskStatus,'pending'|'running'>}
  |{type:'escalated';agentId:string;taskId:string;target:'stop'|'parent'|'human'}
  |{type:'tool';taskId:string;callId:string;name:string;path:string|null;stage:'started'|'finished';mutating:boolean;success:boolean}
  |{type:'artifact';artifact:CollectedArtifact}
  |{type:'task_finished';taskId:string;status:Exclude<TaskStatus,'pending'|'running'>;output:TaskOutput}
  |{type:'task_reset';taskId:string;source:'automatic'|'manual'}
  |{type:'task_accepted';taskId:string;artifactsHash:string}
  |{type:'agent_stop';agentId:string}
  |{type:'agent_reset';agentId:string}
  |{type:'finished';ownerId:string;status:Exclude<ExecutionStatus,'ready'|'running'>};
export interface ExecutionEvent {
  version:1|2|3;id:string;runId:string;sequence:number;at:string;previous:string;change:ExecutionChange;hash:string;
}
export interface TaskState {
  id:string;agentId:string;status:TaskStatus;attempts:number;sessionId:string|null;output:TaskOutput|null;escalation:'stop'|'parent'|'human'|null;
  artifactIds:string[];changedFiles:string[];mutations:boolean;
}
export interface ExecutionProjection {
  version:1|2|3;runId:string;revision:string;status:ExecutionStatus;ownerId:string|null;deadline:number;graph?:SpawnGraph;
  supervision?:import('../supervision/types.js').SupervisionProjection;
  tasks:Record<string,TaskState>;artifacts:Record<string,CollectedArtifact>;stoppedAgents:string[];
}
export interface ExecutionHeader {
  version:1;runId:string;manifestHash:string;approvalRevision:string;createdAt:string;deadline:number;
}
export interface ExecutionInspection {header:ExecutionHeader;events:ExecutionEvent[];state:ExecutionProjection}
export interface ExecutionLease {id:string;check:()=>void;release:()=>void}
export interface ExecutionJournal {version:1;header:ExecutionHeader;events:ExecutionEvent[];hash:string}
export interface BoundExecution {manifest:RunManifest;header:ExecutionHeader}
export type RunPlanContext=Pick<RunManifest,'id'|'project'|'plan'>;
