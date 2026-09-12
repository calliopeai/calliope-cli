import {canonicalJson} from '../approvals/index.js';
import {OrchestrationError} from '../orchestration/types.js';
import type {VerificationCommand} from '../isolation/contracts.js';

/** Only called for executor-owned command artifacts, after scope and integrity checks. */
export function compactCommandReceipt(bytes:Buffer,command:Pick<VerificationCommand,'argv'>,image:string):string {
  try {
    const v=JSON.parse(bytes.toString('utf8'));
    if(v.version!==1||v.kind!=='isolated-command'||canonicalJson(v.argv)!==canonicalJson(command.argv)||v.image!==image||
      !Number.isSafeInteger(v.exitCode)||v.exitCode<0||!['passed','failed','cancelled','timeout','unavailable'].includes(v.outcome)||
      typeof v.cleanupConfirmed!=='boolean'||typeof v.truncated!=='boolean'||typeof v.stdout!=='string'||typeof v.stderr!=='string'||
      !Number.isFinite(v.durationMs)||v.durationMs<0||typeof v.container!=='string'||
      !/^[a-f0-9]{64}$/.test(v.workspace?.before)||!(v.workspace.after===null||/^[a-f0-9]{64}$/.test(v.workspace.after)))throw new Error();
    return JSON.stringify({version:1,kind:v.kind,argv:v.argv,image:v.image,exitCode:v.exitCode,outcome:v.outcome,
      cleanupConfirmed:v.cleanupConfirmed,workspace:{before:v.workspace.before,after:v.workspace.after},durationMs:v.durationMs,truncated:v.truncated,
      logsOmitted:true});
  }catch{throw new OrchestrationError('invalid','Executor verification receipt is malformed or does not match the reviewed command.');}
}
