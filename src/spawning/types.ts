import type {AgentContract,ProjectTask,ProjectPlan} from '../orchestration/types.js';
import type {RecordedChildGrant} from '../execution/types.js';
export interface DelegatedWorkspace {project:{root:string;key:string};reference:string;observationHash:string}
export type SpawnInput = {parentId:string;agents:AgentContract[];tasks:ProjectTask[]} & (
  {version:1;delegation?:never} | {version:2;delegation:DelegatedWorkspace}
);
export type SpawnProposal = SpawnInput & {
  runId:string;runManifestHash:string;approvalRevision:string;graphHash:string;planHash:string;
  source:{path:string;sha256:string;kind?:'supervision'|'delegation';eventId?:string};hash:string;
}
export interface SpawnAdmission {version:1;proposal:SpawnProposal;grant:RecordedChildGrant}
export interface SpawnGraph {version:1;plan:ProjectPlan;hash:string;admissions:SpawnAdmission[]}
