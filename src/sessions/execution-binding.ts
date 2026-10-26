import type {TaskRequestAttribution} from '../execution/attribution.js';
/** A retained session restriction; it never grants execution authority. */
export type SessionExecutionBinding = {
  manifestHash: string;
  agentId: string;
} & ({version:1}|{version:2;attribution:TaskRequestAttribution});

export function validSessionExecutionBinding(value: unknown): value is SessionExecutionBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  if(typeof v.manifestHash!=='string'||!/^[a-f0-9]{64}$/.test(v.manifestHash)||typeof v.agentId!=='string'||!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v.agentId))return false;
  if(v.version===1)return Object.keys(v).sort().join()==='agentId,manifestHash,version';
  if(v.version!==2||Object.keys(v).sort().join()!=='agentId,attribution,manifestHash,version'||!v.attribution||typeof v.attribution!=='object'||Array.isArray(v.attribution))return false;
  const a=v.attribution as Record<string,unknown>;
  return Object.keys(a).sort().join()==='attempt,eventHash,eventId,kind,sessionId,taskId,version'&&a.version===1&&a.kind==='task'
    &&typeof a.eventId==='string'&&/^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(a.eventId)
    &&typeof a.eventHash==='string'&&/^[a-f0-9]{64}$/.test(a.eventHash)
    &&typeof a.sessionId==='string'&&/^[a-zA-Z0-9_-]{1,128}$/.test(a.sessionId)
    &&typeof a.taskId==='string'&&/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(a.taskId)
    &&Number.isSafeInteger(a.attempt)&&Number(a.attempt)>=1&&Number(a.attempt)<=4;
}
