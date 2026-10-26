import {array,fail,integer,shape,text,uuid} from './validation.js';

/** A question is input to one tool call, never an expansion of its authority. */
export interface ExecutionQuestionRequest {
  id:string;ownerId:string;attempt:number;sessionId:string;callId:string;
  text:string;options:string[];context:string|null;
}
export interface ExecutionQuestion extends ExecutionQuestionRequest {
  taskId:string;status:'pending'|'answered'|'closed';answer:string|null;
}
export function validateQuestionRequest(value:unknown):asserts value is ExecutionQuestionRequest {
  shape(value,['id','ownerId','attempt','sessionId','callId','text','options','context']);
  if(!uuid(value.id)||!uuid(value.ownerId))fail('Invalid question request identity.');
  integer(value.attempt,1,4);text(value.sessionId,128);text(value.callId,256);
  if(!/^[a-zA-Z0-9_-]+$/.test(value.sessionId))fail('Invalid question session.');
  text(value.text,8192);array(value.options,8);for(const option of value.options)text(option,256);
  if(new Set(value.options).size!==value.options.length)fail('Question options must be distinct.');
  if(value.context!==null)text(value.context,8192);
}
export function validateQuestionAnswer(value:unknown):asserts value is string {text(value,8192);}
