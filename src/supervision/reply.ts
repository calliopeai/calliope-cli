import {canonicalJson,digest} from '../approvals/index.js';
import {OrchestrationError,type ProjectPlan} from '../orchestration/types.js';
import {shape,text} from '../orchestration/validation.js';
import {MAX_SUPERVISION_DECISION_BYTES,validateSupervisionDecision} from './contracts.js';
import type {SupervisionDecision,SupervisionPolicy,SupervisionRole} from './types.js';

export function supervisionDraftHash(draft:SupervisionDecision):string {return digest(canonicalJson(draft));}

/** A single explicit JSON block is data. Surrounding commentary grants no authority. */
function replyJson(content:unknown,role:SupervisionRole):unknown {
  const name=role==='reviewer'?'Reviewer':'Controller';
  const invalid=()=>new OrchestrationError('invalid',`${name} returned malformed or ambiguous decision JSON.`);
  if(typeof content!=='string')throw invalid();
  if(Buffer.byteLength(content)>MAX_SUPERVISION_DECISION_BYTES)throw new OrchestrationError('invalid',`${name} reply exceeds its byte limit.`);
  try{return JSON.parse(content.trim());}catch{/* Accept one explicitly tagged block only. */}
  const fences=[...content.matchAll(/^[ \t]*```[^\r\n]*\r?$/gm)];
  if(fences.length!==2||!/^```json[ \t]*$/.test(fences[0]![0].trim())||fences[1]![0].trim()!=='```')throw invalid();
  const body=content.slice(fences[0]!.index!+fences[0]![0].length,fences[1]!.index);
  try{return JSON.parse(body);}catch{throw invalid();}
}

/** Normalize explicit reviewer verdicts; a legacy continue never means approval. */
export function parseSupervisionReply(content:unknown,context:{role:SupervisionRole;draft?:SupervisionDecision|null;policy:SupervisionPolicy;plan:ProjectPlan;evidenceIds:ReadonlySet<string>}):SupervisionDecision {
  const value=replyJson(content,context.role),validate=(decision:unknown)=>validateSupervisionDecision(decision,context.policy,context.plan,context.evidenceIds);
  if(!value||typeof value!=='object'||!Object.hasOwn(value,'verdict'))return validate(value);
  if(context.role!=='reviewer'||!context.draft)throw new OrchestrationError('invalid','Reviewer verdict requires the current controller draft.');
  shape(value,['version','verdict','draftHash'],['reason','decision']);
  if(value.version!==1||value.draftHash!==supervisionDraftHash(context.draft))throw new OrchestrationError('invalid','Reviewer verdict does not match the current draft.');
  if(value.verdict==='approve'||value.verdict==='reject'){
    shape(value,['version','verdict','draftHash','reason']);text(value.reason);
    return validate(value.verdict==='approve'?{...context.draft,reason:value.reason}:{version:1,action:'stop',reason:value.reason,evidence:context.draft.evidence});
  }
  if(value.verdict==='revise'){
    shape(value,['version','verdict','draftHash','decision']);return validate(value.decision);
  }
  throw new OrchestrationError('invalid','Unknown reviewer verdict.');
}
