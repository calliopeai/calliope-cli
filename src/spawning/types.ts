import type {AgentContract,ProjectTask,ProjectPlan} from '../orchestration/types.js';
import type {RecordedChildGrant} from '../execution/types.js';
export interface SpawnInput {version:1;parentId:string;agents:AgentContract[];tasks:ProjectTask[]}
export interface SpawnProposal extends SpawnInput {
  runId:string;runManifestHash:string;approvalRevision:string;graphHash:string;planHash:string;
  source:{path:string;sha256:string;kind?:'supervision';eventId?:string};hash:string;
}
export interface SpawnAdmission {version:1;proposal:SpawnProposal;grant:RecordedChildGrant}
export interface SpawnGraph {version:1;plan:ProjectPlan;hash:string;admissions:SpawnAdmission[]}
