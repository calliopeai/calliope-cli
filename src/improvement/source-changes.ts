/** Verified source changes become review branches in their owning repository. */
import * as fs from 'node:fs';
import {join,dirname} from 'node:path';
import {randomUUID} from 'node:crypto';
import {canonicalJson,digest} from '../approvals/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {authorizeSessionAction} from '../session-management/index.js';
import {privateDirectory,readArtifactBytes} from '../orchestration/execution-store.js';
import {inspectExecution} from '../orchestration/coordinator-actions.js';
import {readCollectedArtifact} from '../orchestration/verification.js';
import {OrchestrationError} from '../orchestration/types.js';
import {id,pathName,shape} from '../orchestration/validation.js';
import type {RunActionOptions} from '../orchestration/actions.js';
import {readPinnedWorktreeBase,worktreeGit} from '../isolation/worktree.js';
import {inspectImprovements,improvementProposalHash} from './actions.js';

export interface SourceChangeSelection {
  runId:string;cycleId:string;executionRevision:string;proposalHash:string;
  taskId:string;artifactId:string;artifactHash:string;
}
export interface SourceChangeReview {
  version:1;kind:'source-change-review';writer:'git';project:{root:string;key:string};
  source:SourceChangeSelection;manifestHash:string;sourceHash:string;baseCommit:string;
  author:{name:string;email:string};paths:string[];patchBytes:number;
}
interface Intent {version:1;review:SourceChangeReview;hash:string;branch:string;createdAt:string}
interface Candidate {version:1;proposalHash:string;tree:string;commit:string}
function conflict(message:string):never{throw new OrchestrationError('conflict',message);}
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const oid=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/.test(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const branchFor=(source:SourceChangeSelection,hash:string)=>`refs/heads/calliope-proposals/${source.runId}/${hash}`;
const commitMessage=(source:SourceChangeSelection,hash:string)=>`Propose source change for ${source.taskId}\n\nCalliope-Source-Proposal: ${hash}\nRun: ${source.runId}\nArtifact-SHA256: ${source.artifactHash}\n`;
const git=(project:string,args:string[],options:RunActionOptions,input?:Parameters<typeof worktreeGit>[4],accepted=[0])=>
  worktreeGit(project,['--no-replace-objects',...args],options.signal,accepted,input);

export function sourceChangeCapabilities(){return {version:1,owner:'calliope-cli',writer:'git',
  operations:['preview','propose','inspect'],semantics:'verified-patch-to-local-review-branch',
  installation:false,merge:false,push:false,mayCallModel:false} as const;}

function selection(value:SourceChangeSelection):void {
  shape(value,['runId','cycleId','executionRevision','proposalHash','taskId','artifactId','artifactHash']);
  if(!uuid(value.runId)||!uuid(value.cycleId)||![value.executionRevision,value.proposalHash,value.artifactHash].every(hex))
    throw new OrchestrationError('invalid','Select exact native improvement and artifact identities.');
  id(value.taskId);id(value.artifactId);
}

/** Preview reads verified evidence and Git metadata; it creates no Git object or ref. */
export async function previewSourceChange(cwd:string,source:SourceChangeSelection,options:RunActionOptions={}) {
  return preview(cwd,source,options);
}
async function preview(cwd:string,source:SourceChangeSelection,options:RunActionOptions,leaseId?:string) {
  selection(source);
  const current=await inspectImprovements(cwd,source.runId,options),{store,view}=current,state=current.execution!.state;
  if(state.revision!==source.executionRevision||state.ownerId||current.owner?.alive&&current.owner.id!==leaseId)
    conflict('The source execution changed or is still owned. Refresh its verified results.');
  store.assertApproval(current.execution!.header);
  const cycle=current.history.cycles.find(c=>c.id===source.cycleId);
  if(!cycle||cycle.status!=='verified'||cycle.withdrawal||improvementProposalHash(cycle)!==source.proposalHash)
    conflict('Select an exact verified improvement that has not been withdrawn.');
  const task=store.context().plan.tasks.find(t=>t.id===source.taskId),result=cycle.results.find(r=>r.taskId===source.taskId);
  if(!task?.isolation||task.isolation.mode==='read-only-v1'||task.isolation.patchArtifactId!==source.artifactId||
     !result||result.status!=='completed'||!result.checks.length||result.checks.some(c=>!c.passed))
    conflict('Source proposals require a completed isolated task and its executor-collected patch.');
  const artifact=result.artifacts.find(a=>a.id===source.artifactId);
  if(!artifact||artifact.sha256!==source.artifactHash||artifact.kind!=='patch'||artifact.bytes<1||artifact.bytes>1024*1024)
    conflict('Select the verified nonempty native patch, up to 1 MiB.');
  const bytes=await readCollectedArtifact(store,artifact,options);
  let patch:string;try{patch=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{conflict('Native patches must use UTF-8.');}
  const project=view.manifest.project,baseCommit=readPinnedWorktreeBase(store.root,project.root,view.manifest.planHash);
  const head=(await git(project.root,['rev-parse','--verify','HEAD^{commit}'],options)).trim();
  if(head!==baseCommit)conflict('The owning repository advanced beyond the verified base. Prepare and verify a new change.');
  const author={name:(await git(project.root,['config','--local','--get','user.name'],options)).trim(),
    email:(await git(project.root,['config','--local','--get','user.email'],options)).trim()};
  if(Object.values(author).some(v=>!v||v.length>256||/[\r\n<>\x00]/.test(v)))
    conflict('Configure a valid repository-local Git author before reviewing a source proposal.');
  const stats=await git(project.root,['apply','--numstat','-z','--'],options,{text:patch});
  const paths=stats.split('\0').filter(Boolean).map(line=>{
    const match=/^(?:\d+|-)\t(?:\d+|-)\t(.+)$/s.exec(line);if(!match)conflict('Native patch path inventory is unavailable.');
    const value=match![1]!;pathName(value);if(value.split('/').some(p=>p.toLowerCase()==='.git'))conflict('Git metadata cannot be proposed.');return value;
  });
  const grants=store.context().plan.agents.find(a=>a.id===task.agentId)!.allowedPaths.filter(g=>g.access==='write');
  if(!paths.length||paths.length>10000||paths.some(p=>!grants.some(g=>g.path==='.'||p===g.path||p.startsWith(g.path+'/'))))
    conflict('The patch includes paths outside the selected worker’s original write scope.');
  const review:SourceChangeReview={version:1,kind:'source-change-review',writer:'git',project:{root:project.root,key:project.key},
    source,manifestHash:view.manifest.hash,sourceHash:digest(canonicalJson({cycle,artifact})),baseCommit,author,paths,patchBytes:bytes.length};
  const hash=digest(canonicalJson(review));
  store.assertRevision(source.executionRevision);store.assertApproval(current.execution!.header);
  return {review,hash,branch:branchFor(source,hash),patch};
}

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
  const current=await inspectExecution(cwd,runId,options),root=join(current.store.root,'source-proposals'),file=join(root,hash+'.json');
  if(!fs.existsSync(file))return {current,root,file,intent:null,candidate:null};
  privateDirectory(root);const intent=readRecord<Intent>(file);
  shape(intent,['version','review','hash','branch','createdAt']);
  if(intent.version!==1||intent.hash!==hash||digest(canonicalJson(intent.review))!==hash||intent.review.source.runId!==runId||
    intent.review.project.root!==current.view.manifest.project.root||intent.review.project.key!==current.view.manifest.project.key||
    intent.review.manifestHash!==current.view.manifest.hash||intent.branch!==branchFor(intent.review.source,hash)||
    typeof intent.createdAt!=='string'||!Number.isFinite(Date.parse(intent.createdAt)))conflict('Source proposal ownership changed.');
  const candidateFile=join(root,hash+'.candidate.json'),candidate=fs.existsSync(candidateFile)?readRecord<Candidate>(candidateFile):null;
  if(candidate){shape(candidate,['version','proposalHash','tree','commit']);
    if(candidate.version!==1||candidate.proposalHash!==hash||!oid(candidate.tree)||!oid(candidate.commit))conflict('Source candidate identity changed.');}
  return {current,root,file,intent,candidate};
}

export async function inspectSourceChange(cwd:string,runId:string,hash:string,options:RunActionOptions={}) {
  const {intent,candidate}=await opened(cwd,runId,hash,options);
  if(!intent)throw new OrchestrationError('unavailable','No saved source proposal has this identity.');
  const ref=(await git(intent.review.project.root,['rev-parse','--verify','--quiet',intent.branch],options,undefined,[0,1])).trim();
  if(ref&&(!candidate||ref!==candidate.commit))conflict('The proposal branch changed outside this request. Inspect it in Git.');
  if(candidate){
    const body=await git(intent.review.project.root,['cat-file','commit',candidate.commit],options);
    if(!body.startsWith(`tree ${candidate.tree}\nparent ${intent.review.baseCommit}\n`)||
      body.slice(body.indexOf('\n\n')+2)!==commitMessage(intent.review.source,hash))conflict('Source candidate content differs from its original review.');
  }
  return {version:1 as const,status:ref?'proposed' as const:'prepared' as const,hash,branch:intent.branch,
    review:intent.review,createdAt:intent.createdAt,commit:ref||null,tree:candidate?.tree??null};
}

/** One new local branch; the source checkout/index, installed skills and run journal stay unchanged. */
export async function proposeSourceChange(cwd:string,source:SourceChangeSelection,reviewedHash:string,options:RunActionOptions={}) {
  selection(source);if(!hex(reviewedHash))throw new OrchestrationError('invalid','Review the exact source proposal hash.');
  let prior=await opened(cwd,source.runId,reviewedHash,options);
  if(prior.intent){
    if(canonicalJson(prior.intent.review.source)!==canonicalJson(source))conflict('Source selection differs from the original request.');
    const existing=await inspectSourceChange(cwd,source.runId,reviewedHash,options);if(existing.status==='proposed')return existing;
  }
  const reviewed=await previewSourceChange(cwd,source,options);
  if(reviewed.hash!==reviewedHash)conflict('The source preview changed. Review it again before creating a branch.');
  await authorizeSessionAction(cwd,'orchestration_source_proposal',{path:reviewed.review.project.root,runId:source.runId,
    proposalHash:reviewedHash,branch:reviewed.branch,baseCommit:reviewed.review.baseCommit,author:reviewed.review.author,
    paths:reviewed.review.paths,artifactHash:source.artifactHash,operation:'Create one local review branch; do not merge, install, push or run work.'},{...options,confirmation:'mutating'});
  const lease=prior.current.store.acquire();let scratch:string|undefined;
  try{
    const fresh=await preview(cwd,source,options,lease.id);if(fresh.hash!==reviewedHash)conflict('Source evidence or repository changed during review.');
    lease.check();prior=await opened(cwd,source.runId,reviewedHash,options);
    if(!fs.existsSync(prior.root))fs.mkdirSync(prior.root,{mode:0o700});privateDirectory(prior.root);
    if(!prior.intent){
      if(fs.readdirSync(prior.root).filter(p=>p.endsWith('.json')&&!p.endsWith('.candidate.json')).length>=100)
        throw new OrchestrationError('limit','This run already has 100 source proposal records.');
      writeRecord(prior.file,{version:1,review:fresh.review,hash:reviewedHash,branch:fresh.branch,createdAt:new Date().toISOString()} satisfies Intent);
      prior=await opened(cwd,source.runId,reviewedHash,options);
    }
    const intent=prior.intent!,project=intent.review.project.root;
    scratch=fs.mkdtempSync(join(prior.root,'index-'));const indexFile=join(scratch,'index');
    await git(project,['read-tree',intent.review.baseCommit],options,{indexFile});
    await git(project,['apply','--cached','--binary','--whitespace=nowarn','--'],options,{indexFile,text:fresh.patch});
    const tree=(await git(project,['write-tree'],options,{indexFile})).trim();
    if(!oid(tree))conflict('Git did not return a valid candidate tree.');
    const commit=(await git(project,['-c','commit.gpgSign=false','-c','i18n.commitEncoding=UTF-8','commit-tree',tree,'-p',intent.review.baseCommit],options,
      {text:commitMessage(source,reviewedHash),identity:{...intent.review.author,date:intent.createdAt}})).trim();
    if(!oid(commit))conflict('Git did not return a valid candidate commit.');
    const candidate:Candidate={version:1,proposalHash:reviewedHash,tree,commit};
    if(prior.candidate&&canonicalJson(prior.candidate)!==canonicalJson(candidate))conflict('The original source candidate changed.');
    if(!prior.candidate)writeRecord(join(prior.root,reviewedHash+'.candidate.json'),candidate);
    const last=await preview(cwd,source,options,lease.id);if(last.hash!==reviewedHash)conflict('Source changed before publishing the local proposal branch.');
    lease.check();throwIfCancelled(options.signal);
    const existing=await inspectSourceChange(cwd,source.runId,reviewedHash,options);
    if(existing.status!=='proposed')await git(project,['update-ref','--stdin'],options,
      {text:`start\nverify HEAD ${intent.review.baseCommit}\ncreate ${intent.branch} ${commit}\nprepare\ncommit\n`});
    return await inspectSourceChange(cwd,source.runId,reviewedHash,options);
  }finally{if(scratch)fs.rmSync(scratch,{recursive:true,force:true});lease.release();}
}
