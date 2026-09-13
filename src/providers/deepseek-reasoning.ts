/** Opaque protocol state; never merge this with the assistant's displayed answer. */
import type {Message} from '../types.js';
import {toOpenAIMessages} from './openai.js';
import {ProviderProtocolError} from '../errors.js';

export const MAX_DEEPSEEK_REASONING_BYTES=1024*1024;

export function deepSeekReasoning(value:unknown,previous?:string):string|undefined {
  if(value===undefined||value===null)return previous;
  if(typeof value!=='string')throw new ProviderProtocolError('DeepSeek returned malformed reasoning metadata.');
  const text=(previous??'')+value;
  if(Buffer.byteLength(text,'utf8')>MAX_DEEPSEEK_REASONING_BYTES)throw new ProviderProtocolError('DeepSeek reasoning metadata exceeds the 1 MiB protocol limit.');
  return text;
}

export function toDeepSeekMessages(messages:Message[]) {
  return toOpenAIMessages(messages).map((converted,index)=>{
    const original=messages[index]!,metadata=original.providerMetadata?.deepseek;
    if(original.role!=='assistant'||metadata===undefined)return converted;
    if(!metadata||typeof metadata!=='object'||Array.isArray(metadata)||(metadata as {version?:unknown}).version!==1||Object.keys(metadata).some(key=>!['version','reasoningContent'].includes(key)))throw new ProviderProtocolError('Stored DeepSeek reasoning metadata is malformed.');
    const value=(metadata as {reasoningContent?:unknown}).reasoningContent;if(typeof value!=='string')throw new ProviderProtocolError('Stored DeepSeek reasoning metadata is malformed.');
    const reasoning=deepSeekReasoning(value);
    return reasoning===undefined?converted:{...converted,reasoning_content:reasoning};
  });
}
