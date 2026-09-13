import {hex,identifier,integer,invalid,shape,uuid} from './authority.js';

/** Immutable execution provenance supplied by the coordinator, never by model output. */
export type RequestAttribution = {
  version:1;eventId:string;eventHash:string;sessionId:string;
} & ({kind:'task';taskId:string;attempt:number}|{kind:'supervision';role:'controller'|'reviewer';round:number});

export function validateRequestAttribution(value:unknown):RequestAttribution {
  shape(value,['version','kind','eventId','eventHash','sessionId'],['taskId','attempt','role','round']);
  if(value.version!==1||!uuid(value.eventId)||!hex(value.eventHash)||typeof value.sessionId!=='string'||value.sessionId.length>128||!/^[a-zA-Z0-9_-]+$/.test(value.sessionId))invalid();
  if(value.kind==='task'){
    shape(value,['version','kind','eventId','eventHash','sessionId','taskId','attempt']);identifier(value.taskId);integer(value.attempt,1,4);
  }else if(value.kind==='supervision'){
    shape(value,['version','kind','eventId','eventHash','sessionId','role','round']);integer(value.round,1,64);if(value.role!=='controller'&&value.role!=='reviewer')invalid();
  }else invalid();
  return structuredClone(value) as RequestAttribution;
}
