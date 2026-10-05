/** Native AWS identity resolution shared by inference and model discovery. */
import {spawn,execFile} from 'node:child_process';
import {join} from 'node:path';
import * as config from '../config.js';
import {cancellable,isCancellation,throwIfCancelled} from '../cancellation.js';
import {bindProcessCancellation,detachedProcess} from '../process-cancellation.js';

interface Credentials {accessKeyId:string;secretAccessKey:string;sessionToken?:string;expiration?:Date}
const credentialError=()=>new Error('AWS credentials not found or expired for the selected Bedrock identity. Renew the selected profile or check workload identity configuration.');

export async function resolveBedrockCredentials(signal?:AbortSignal):Promise<Credentials> {
  throwIfCancelled(signal);
  const {profile,region}=config.getProviderCred('bedrock');
  const binary=(globalThis as {__CALLIOPE_BINARY_VERSION__?:string}).__CALLIOPE_BINARY_VERSION__;
  // Node >=24 can run the source worker during tests; installed packages use JS.
  const worker=new URL(import.meta.url.endsWith('.ts')?'./bedrock-credential-worker.ts':'./bedrock-credential-worker.js',import.meta.url);
  const argv=binary?['--internal-aws-credentials']:[...(process.versions.bun?['--no-env-file']:[]),'--input-type=module','-e',
    `import(${JSON.stringify(worker.href)}).then(m=>m.runBedrockCredentialWorker())`];
  // Resolve afresh with a snapshot of this caller's environment. Credentials are
  // sent over private IPC, never command arguments, stdout, logs or temp files.
  let child:ReturnType<typeof spawn>;
  try {
    child=spawn(process.execPath,argv,{env:{...process.env},detached:detachedProcess,
      windowsHide:true,stdio:['ignore','ignore','ignore','ipc'],serialization:'json'});
  } catch {throw credentialError();}
  const controller=new AbortController();
  const stopped=detachedProcess?bindProcessCancellation(child,controller.signal):undefined;
  let timer:ReturnType<typeof setTimeout>|undefined;
  let credentials:Credentials;
  try {
    credentials=await cancellable(new Promise<Credentials>((resolve,reject)=>{
      timer=setTimeout(()=>reject(credentialError()),10000);
      child.once('error',()=>reject(credentialError()));
      child.once('exit',()=>reject(credentialError()));
      child.once('message',(message:unknown)=>{
        if(!message||typeof message!=='object'){reject(credentialError());return;}
        const value=message as Record<string,unknown>;
        const valid=(field:unknown)=>typeof field==='string'&&field.length>0&&field.length<=32768;
        if(!valid(value.accessKeyId)||!valid(value.secretAccessKey)||
          value.sessionToken!==undefined&&!valid(value.sessionToken)||
          value.expiration!==undefined&&(typeof value.expiration!=='string'||!Number.isFinite(Date.parse(value.expiration))||Date.parse(value.expiration)<=Date.now())){
          reject(credentialError());return;
        }
        resolve({accessKeyId:value.accessKeyId as string,secretAccessKey:value.secretAccessKey as string,
          ...(value.sessionToken?{sessionToken:value.sessionToken as string}:{}),
          ...(value.expiration?{expiration:new Date(value.expiration as string)}:{})});
      });
      child.send({profile,region:region||'us-east-1'},error=>{if(error)reject(credentialError());});
    }),signal);
    throwIfCancelled(signal);
  } catch(error) {
    if(isCancellation(error))throw error;
    throw credentialError();
  } finally {
    if(timer)clearTimeout(timer);
    if(detachedProcess){controller.abort();await stopped;}
    else if(child.pid&&child.exitCode===null) {
      // Windows has no POSIX groups; terminate descendants before their owner.
      await new Promise<void>((resolve,reject)=>execFile(
        join(process.env.SystemRoot||'C:\\Windows','System32','taskkill.exe'),
        ['/pid',String(child.pid),'/T','/F'],{windowsHide:true,timeout:1000},error=>{
          if(error&&child.exitCode===null){child.kill();reject(credentialError());}else resolve();
        }));
    }
  }
  throwIfCancelled(signal);
  return credentials;
}
