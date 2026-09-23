import * as fs from 'node:fs';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson,canonicalPath} from '../approvals/index.js';
import {ExecutionStore,privateDirectory,readArtifactBytes} from '../orchestration/execution-store.js';
import {OrchestrationError} from '../orchestration/types.js';
import {hex} from '../orchestration/validation.js';
import {MAX_SPAWN_BYTES,MAX_SPAWN_PROPOSALS,validateSpawnProposal} from './validation.js';
import type {SpawnProposal} from './types.js';

/** Immutable human-reviewed proposals live outside the worker's project scope. */
export class SpawnProposalStore {
  readonly root:string;
  constructor(readonly execution:ExecutionStore){this.root=join(execution.root,'spawn-proposals');}
  read(hash:string):SpawnProposal {
    if(!hex(hash))throw new OrchestrationError('invalid','Invalid child proposal hash.');
    privateDirectory(this.root);
    const value:unknown=JSON.parse(readArtifactBytes(join(this.root,hash+'.json'),MAX_SPAWN_BYTES,true).toString());
    if(!value||typeof value!=='object'||!('hash'in value)||value.hash!==hash)throw new OrchestrationError('conflict','Saved child proposal does not match its requested hash.');
    const view=this.execution.read(),admission=view.state.graph?.admissions.find(a=>a.proposal.hash===hash);
    if(admission){if(canonicalJson(value)!==canonicalJson(admission.proposal))throw new OrchestrationError('conflict','Saved child proposal differs from its admission.');return admission.proposal;}
    return validateSpawnProposal(value,this.execution.manifest,view.header,this.execution.context(view).plan);
  }
  /** Caller holds the execution writer lock, including the retention check. */
  save(proposal:SpawnProposal):void {
    privateDirectory(this.execution.root);
    if(canonicalPath(this.root)!==this.root)throw new OrchestrationError('invalid','Child proposal store cannot use a symlink alias.');
    try{fs.mkdirSync(this.root,{mode:0o700});}catch(error){if((error as NodeJS.ErrnoException).code!=='EEXIST')throw error;}
    privateDirectory(this.root);const file=join(this.root,proposal.hash+'.json');
    if(fs.existsSync(file)){if(canonicalJson(this.read(proposal.hash))!==canonicalJson(proposal))throw new OrchestrationError('conflict','Child proposal identity changed.');return;}
    let count=0;const dir=fs.opendirSync(this.root);
    try{let entry:fs.Dirent|null;while((entry=dir.readSync())){if(++count>=MAX_SPAWN_PROPOSALS)throw new OrchestrationError('limit','Child proposal retention reached; preserve existing evidence.');if(!entry.isFile()||!/^([a-f0-9]{64}\.json|[a-f0-9-]{36}\.tmp)$/.test(entry.name))throw new OrchestrationError('unavailable','Child proposal store contains unrecognized files.');}}finally{dir.closeSync();}
    const raw=canonicalJson(proposal);if(Buffer.byteLength(raw)>MAX_SPAWN_BYTES)throw new OrchestrationError('limit','Child proposal exceeds its byte limit.');
    const temp=join(this.root,randomUUID()+'.tmp'),fd=fs.openSync(temp,'wx',0o600);
    try{fs.writeFileSync(fd,raw);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try{fs.linkSync(temp,file);}finally{fs.unlinkSync(temp);}
    // POSIX-only: Windows denies FlushFileBuffers on a directory handle opened via 'r' (#382, #384, #388).
    if(process.platform!=='win32')for(const path of [this.root,this.execution.root]){const directory=fs.openSync(path,'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}
  }
}
