/** One durable Git writer for reviewed proposals and unverified task candidates. */
import * as fs from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson,digest} from '../approvals/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {authorizeSessionAction} from '../session-management/index.js';
import {privateDirectory,readArtifactBytes} from '../orchestration/execution-store.js';
import {inspectExecution} from '../orchestration/coordinator-actions.js';
import {OrchestrationError} from '../orchestration/types.js';
import {shape} from '../orchestration/validation.js';
import type {RunActionOptions} from '../orchestration/actions.js';
import {worktreeGit} from '../isolation/worktree.js';

export interface WriterSelection {runId:string;executionRevision:string;taskId:string;artifactHash:string}
export interface WriterReview<S extends WriterSelection> {
  version:1;kind:string;writer:'git';project:{root:string;key:string};source:S;
  manifestHash:string;sourceHash:string;baseCommit:string;author:{name:string;email:string};paths:string[];patchBytes:number;
}
interface Intent<R> {version:1;review:R;hash:string;branch:string;createdAt:string}
interface Candidate {version:1;proposalHash:string;tree:string;commit:string}
function conflict(message:string):never{throw new OrchestrationError('conflict',message);}
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const oid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const git=(project:string,args:string[],options:RunActionOptions,input?:Parameters<typeof worktreeGit>[4],accepted=[0])=>
  worktreeGit(project,['--no-replace-objects',...args],options.signal,accepted,input);

interface WriterSpec<S extends WriterSelection,R extends WriterReview<S>,K extends 'proposed'|'candidate'> {
  directory:'source-proposals'|'source-candidates';kind:R['kind'];status:K;tool:string;operation:string;
  selection:(source:S)=>void;
  branchFor:(source:S,hash:string)=>string;
  commitMessage:(source:S,hash:string)=>string;
  preview:(cwd:string,source:S,options:RunActionOptions,leaseId?:string)=>Promise<{review:R;hash:string;branch:string;patch:string}>;
}
/** Internal adapters supply native evidence inspection, never callbacks from JSON. */
export function sourceWriter<S extends WriterSelection,R extends WriterReview<S>,K extends 'proposed'|'candidate'>(spec:WriterSpec<S,R,K>) {
  function writeRecord(file:string,value:unknown):void {
    const body=canonicalJson(value),encoded=canonicalJson({body:value,sha256:digest(body)}),temp=file+'.'+randomUUID()+'.tmp';
    if(Buffer.byteLength(encoded)>256*1024)throw new OrchestrationError('limit','Source review exceeds its storage bound.');
    const fd=fs.openSync(temp,'wx',0o600);
    try{fs.writeFileSync(fd,encoded);fs.fsyncSync(fd);}finally{fs.closeSync(fd);}
    try{if(fs.existsSync(file))conflict('Source proposal record already exists. Recover its original identity.');fs.renameSync(temp,file);
      if(process.platform!=='win32'){const directory=fs.openSync(dirname(file),'r');try{fs.fsyncSync(directory);}finally{fs.closeSync(directory);}}}
    finally{if(fs.existsSync(temp))fs.unlinkSync(temp);}
  }
  function readRecord<T>(file:string):T {
    let value;try{value=JSON.parse(readArtifactBytes(file,256*1024,true).toString());}catch{conflict('Source proposal record is missing or damaged. Preserve it for inspection.');}
    shape(value,['body','sha256']);if(!hex(value.sha256)||digest(canonicalJson(value.body))!==value.sha256)conflict('Source proposal record changed.');
    return value.body as T;
  }

  async function opened(cwd:string,runId:string,hash:string,options:RunActionOptions) {
    if(!uuid(runId)||!hex(hash))throw new OrchestrationError('invalid','Select the exact source proposal.');
    const current=await inspectExecution(cwd,runId,options),root=join(current.store.root,spec.directory),file=join(root,hash+'.json');
    if(!fs.existsSync(file))return {current,root,file,intent:null,candidate:null};
    privateDirectory(root);const intent=readRecord<Intent<R>>(file);
    shape(intent,['version','review','hash','branch','createdAt']);
    spec.selection(intent.review.source);
    if(intent.review.kind!==spec.kind||intent.version!==1||intent.hash!==hash||digest(canonicalJson(intent.review))!==hash||intent.review.source.runId!==runId||
      intent.review.project.root!==current.view.manifest.project.root||intent.review.project.key!==current.view.manifest.project.key||
      intent.review.manifestHash!==current.view.manifest.hash||intent.branch!==spec.branchFor(intent.review.source,hash)||
      typeof intent.createdAt!=='string'||!Number.isFinite(Date.parse(intent.createdAt)))conflict('Source proposal ownership changed.');
    const candidateFile=join(root,hash+'.candidate.json'),candidate=fs.existsSync(candidateFile)?readRecord<Candidate>(candidateFile):null;
    if(candidate){shape(candidate,['version','proposalHash','tree','commit']);
      if(candidate.version!==1||candidate.proposalHash!==hash||!oid(candidate.tree)||!oid(candidate.commit))conflict('Source candidate identity changed.');}
    return {current,root,file,intent,candidate};
  }

  async function inspectSourceChange(cwd:string,runId:string,hash:string,options:RunActionOptions={}) {
    const {intent,candidate}=await opened(cwd,runId,hash,options);
    if(!intent)throw new OrchestrationError('unavailable','No saved source proposal has this identity.');
    const ref=(await git(intent.review.project.root,['rev-parse','--verify','--quiet',intent.branch],options,undefined,[0,1])).trim();
    if(ref&&(!candidate||ref!==candidate.commit))conflict('The proposal branch changed outside this request. Inspect it in Git.');
    if(candidate){
      const body=await git(intent.review.project.root,['cat-file','commit',candidate.commit],options);
      if(!body.startsWith(`tree ${candidate.tree}\nparent ${intent.review.baseCommit}\n`)||
        body.slice(body.indexOf('\n\n')+2)!==spec.commitMessage(intent.review.source,hash))conflict('Source candidate content differs from its original review.');
    }
    return {version:1 as const,status:ref?spec.status:'prepared' as const,hash,branch:intent.branch,
      review:intent.review,createdAt:intent.createdAt,commit:ref||null,tree:candidate?.tree??null};
  }

  /** Discover original review identities after restart, without consulting current HEAD. */
  async function listSourceChanges(cwd:string,runId:string,options:RunActionOptions={}) {
    if(!uuid(runId))throw new OrchestrationError('invalid','Select the exact source run.');
    const current=await inspectExecution(cwd,runId,options),root=join(current.store.root,spec.directory);
    if(!fs.existsSync(root))return [];
    privateDirectory(root);
    const names=fs.readdirSync(root).filter(name=>/^[a-f0-9]{64}\.json$/.test(name)).sort();
    if(names.length>100)throw new OrchestrationError('limit','Source proposal inventory exceeds its native bound.');
    const result=[];
    for(const name of names)result.push(await inspectSourceChange(cwd,runId,name.slice(0,-5),options));
    return result;
  }

  /** One new local branch; the source checkout/index, installed skills and run journal stay unchanged. */
  async function proposeSourceChange(cwd:string,source:S,reviewedHash:string,options:RunActionOptions={}) {
    spec.selection(source);if(!hex(reviewedHash))throw new OrchestrationError('invalid','Review the exact source proposal hash.');
    let prior=await opened(cwd,source.runId,reviewedHash,options);
    if(prior.intent){
      if(canonicalJson(prior.intent.review.source)!==canonicalJson(source))conflict('Source selection differs from the original request.');
      const existing=await inspectSourceChange(cwd,source.runId,reviewedHash,options);if(existing.status===spec.status)return existing;
    }
    const reviewed=await spec.preview(cwd,source,options);
    if(reviewed.hash!==reviewedHash)conflict('The source preview changed. Review it again before creating a branch.');
    await authorizeSessionAction(cwd,spec.tool,{path:reviewed.review.project.root,runId:source.runId,
      proposalHash:reviewedHash,branch:reviewed.branch,baseCommit:reviewed.review.baseCommit,author:reviewed.review.author,
      paths:reviewed.review.paths,artifactHash:source.artifactHash,operation:spec.operation},{...options,confirmation:'mutating'});
    const lease=prior.current.store.acquire();let scratch:string|undefined;
    try{
      const fresh=await spec.preview(cwd,source,options,lease.id);if(fresh.hash!==reviewedHash)conflict('Source evidence or repository changed during review.');
      lease.check();prior=await opened(cwd,source.runId,reviewedHash,options);
      if(!fs.existsSync(prior.root))fs.mkdirSync(prior.root,{mode:0o700});privateDirectory(prior.root);
      if(!prior.intent){
        if(fs.readdirSync(prior.root).filter(p=>p.endsWith('.json')&&!p.endsWith('.candidate.json')).length>=100)
          throw new OrchestrationError('limit','This run already has 100 source proposal records.');
        writeRecord(prior.file,{version:1,review:fresh.review,hash:reviewedHash,branch:fresh.branch,createdAt:new Date().toISOString()} satisfies Intent<R>);
        prior=await opened(cwd,source.runId,reviewedHash,options);
      }
      const intent=prior.intent!,project=intent.review.project.root;
      scratch=fs.mkdtempSync(join(prior.root,'index-'));const indexFile=join(scratch,'index');
      await git(project,['read-tree',intent.review.baseCommit],options,{indexFile});
      await git(project,['apply','--cached','--binary','--whitespace=nowarn','--'],options,{indexFile,text:fresh.patch});
      const tree=(await git(project,['write-tree'],options,{indexFile})).trim();
      if(!oid(tree))conflict('Git did not return a valid candidate tree.');
      const commit=(await git(project,['-c','commit.gpgSign=false','-c','i18n.commitEncoding=UTF-8','commit-tree',tree,'-p',intent.review.baseCommit],options,
        {text:spec.commitMessage(source,reviewedHash),identity:{...intent.review.author,date:intent.createdAt}})).trim();
      if(!oid(commit))conflict('Git did not return a valid candidate commit.');
      const candidate:Candidate={version:1,proposalHash:reviewedHash,tree,commit};
      if(prior.candidate&&canonicalJson(prior.candidate)!==canonicalJson(candidate))conflict('The original source candidate changed.');
      if(!prior.candidate)writeRecord(join(prior.root,reviewedHash+'.candidate.json'),candidate);
      const last=await spec.preview(cwd,source,options,lease.id);if(last.hash!==reviewedHash)conflict('Source changed before publishing the local proposal branch.');
      lease.check();throwIfCancelled(options.signal);
      const existing=await inspectSourceChange(cwd,source.runId,reviewedHash,options);
      if(existing.status!==spec.status)await git(project,['update-ref','--stdin'],options,
        {text:`start\nverify HEAD ${intent.review.baseCommit}\ncreate ${intent.branch} ${commit}\nprepare\ncommit\n`});
      return await inspectSourceChange(cwd,source.runId,reviewedHash,options);
    }finally{if(scratch)fs.rmSync(scratch,{recursive:true,force:true});lease.release();}
  }

  return {inspect:inspectSourceChange,list:listSourceChanges,write:proposeSourceChange};
}
