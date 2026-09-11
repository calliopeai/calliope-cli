import {canonicalJson,digest} from '../approvals/index.js';
import {analyzePlan,array,shape,id,hex,uuid,integer,pathName,fail} from '../orchestration/validation.js';
import type {ProjectPlan,RunManifest} from '../orchestration/types.js';
import type {ExecutionHeader} from '../orchestration/coordinator-types.js';
import {validateChildGrant} from '../execution/child-grants.js';
import type {ChildGrant} from '../execution/types.js';
import type {SpawnInput,SpawnProposal,SpawnAdmission} from './types.js';

export const MAX_SPAWN_BYTES=65536,MAX_SPAWN_PROPOSALS=256;
export function validateSpawnInput(value:unknown):SpawnInput {
  shape(value,['version','parentId','agents','tasks']);if(value.version!==1)fail('Unsupported child proposal version.');id(value.parentId);array(value.agents,16,1);array(value.tasks,64,1);
  if(Buffer.byteLength(canonicalJson(value))>MAX_SPAWN_BYTES)fail('Child proposal exceeds 64 KiB.');return value as unknown as SpawnInput;
}
/** Existing agents, tasks, scopes and limits remain byte-for-byte unchanged. */
export function extendPlan(base:ProjectPlan,input:SpawnInput):ProjectPlan {
  validateSpawnInput(input);if(!base.agents.some(a=>a.id===input.parentId))fail('Child proposal names an unknown parent.');
  const addedAgents=new Set(input.agents.map(agent=>agent?.id));
  if(input.tasks.some(task=>!task||!addedAgents.has(task.agentId)))fail('New tasks must belong to the proposed child hierarchy.');
  const next=analyzePlan({...base,agents:[...base.agents,...input.agents],tasks:[...base.tasks,...input.tasks]}).plan;
  for(const child of input.agents){let current=next.agents.find(a=>a.id===child.id),found=false;for(let n=0;current?.parentId&&n<next.agents.length;n++){if(current.parentId===input.parentId){found=true;break;}current=next.agents.find(a=>a.id===current!.parentId);}if(!found)fail('Every proposed agent must descend from the named parent.');}
  return next;
}
export function proposalId(hash:string):string {
  if(!hex(hash))fail('Invalid proposal hash.');const raw=hash.slice(0,12)+'4'+hash.slice(13,16)+(8+(parseInt(hash[16]!,16)%4)).toString(16)+hash.slice(17,32);return `${raw.slice(0,8)}-${raw.slice(8,12)}-${raw.slice(12,16)}-${raw.slice(16,20)}-${raw.slice(20)}`;
}
export function proposalGrant(proposal:SpawnProposal,header:ExecutionHeader):ChildGrant {
  return validateChildGrant({version:1,id:proposalId(proposal.hash),proposalHash:proposal.hash,previousGraphHash:proposal.graphHash,planHash:proposal.planHash,runManifestHash:proposal.runManifestHash,approvalRevision:proposal.approvalRevision,parentId:proposal.parentId,
    accounts:proposal.agents.map(agent=>({id:agent.id,parentId:agent.parentId,tokenBudget:agent.tokenBudget,costBudgetNanos:Math.floor(agent.costBudgetUsd*1e9),deadline:Date.parse(header.createdAt)+agent.timeBudgetMs,allowedTools:agent.allowedTools,allowedPaths:agent.allowedPaths}))});
}
export function validateSpawnProposal(value:unknown,manifest:RunManifest,header:ExecutionHeader,base:ProjectPlan):SpawnProposal {
  shape(value,['version','parentId','agents','tasks','runId','runManifestHash','approvalRevision','graphHash','planHash','source','hash']);
  if(value.runId!==manifest.id||value.runManifestHash!==manifest.hash||value.approvalRevision!==header.approvalRevision||!hex(value.graphHash)||!hex(value.planHash)||!hex(value.hash))fail('Child proposal belongs to another run, approval or graph.');
  shape(value.source,['path','sha256']);pathName(value.source.path);if(!hex(value.source.sha256))fail('Child proposal source needs its byte hash.');
  const {hash,...body}=value;if(hash!==digest(canonicalJson(body)))fail('Child proposal hash is invalid.');
  const proposal=value as unknown as SpawnProposal,input={version:proposal.version,parentId:proposal.parentId,agents:proposal.agents,tasks:proposal.tasks},next=extendPlan(base,input);
  if(analyzePlan(base).hash!==proposal.graphHash||analyzePlan(next).hash!==proposal.planHash)fail('Child proposal graph revision changed.');
  if(Buffer.byteLength(canonicalJson(value))>MAX_SPAWN_BYTES)fail('Child proposal exceeds 64 KiB.');proposalGrant(proposal,header);return proposal;
}
export function makeSpawnProposal(manifest:RunManifest,header:ExecutionHeader,base:ProjectPlan,input:SpawnInput,source:SpawnProposal['source']):SpawnProposal {
  const next=extendPlan(base,input),body={...structuredClone(input),runId:manifest.id,runManifestHash:manifest.hash,approvalRevision:header.approvalRevision,graphHash:analyzePlan(base).hash,planHash:analyzePlan(next).hash,source};
  return validateSpawnProposal({...body,hash:digest(canonicalJson(body))},manifest,header,base);
}
export function validateSpawnAdmission(value:unknown,manifest:RunManifest,header:ExecutionHeader,base:ProjectPlan):SpawnAdmission {
  shape(value,['version','proposal','grant']);if(value.version!==1)fail('Unsupported spawn admission.');const proposal=validateSpawnProposal(value.proposal,manifest,header,base);
  shape(value.grant,['grant','eventId','eventHash','at']);if(!uuid(value.grant.eventId)||!hex(value.grant.eventHash))fail('Spawn admission requires its budget event.');integer(value.grant.at,Date.parse(header.createdAt),header.deadline);
  if(canonicalJson(validateChildGrant(value.grant.grant))!==canonicalJson(proposalGrant(proposal,header)))fail('Child authority differs from the approved graph.');return value as unknown as SpawnAdmission;
}
