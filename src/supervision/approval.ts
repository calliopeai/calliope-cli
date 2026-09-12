import {canonicalJson,digest} from '../approvals/index.js';
import type {ExecutionEvent} from '../orchestration/coordinator-types.js';
import type {RunManifest} from '../orchestration/types.js';
export function supervisionProposalHash(manifest:Pick<RunManifest,'id'|'hash'>,event:ExecutionEvent,deadline:number):string {
  if(event.change.type!=='supervision_decided')throw new Error('A proposal must reference a recorded supervision decision.');
  return digest(canonicalJson({version:1,runId:manifest.id,manifestHash:manifest.hash,decision:{id:event.id,hash:event.hash,at:event.at,sequence:event.sequence},proposal:event.change.decision,deadline}));
}
