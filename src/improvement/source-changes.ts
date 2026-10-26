/** Verified source changes become review branches in their owning repository. */
import {sourceWriter} from '../source-changes/writer.js';
import {canonicalJson,digest} from '../approvals/index.js';
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
function conflict(message:string):never{throw new OrchestrationError('conflict',message);}
const hex=(v:unknown):v is string=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const branchFor=(source:SourceChangeSelection,hash:string)=>`refs/heads/calliope-proposals/${source.runId}/${hash}`;
const commitMessage=(source:SourceChangeSelection,hash:string)=>`Propose source change for ${source.taskId}\n\nCalliope-Source-Proposal: ${hash}\nRun: ${source.runId}\nArtifact-SHA256: ${source.artifactHash}\n`;
const git=(project:string,args:string[],options:RunActionOptions,input?:Parameters<typeof worktreeGit>[4],accepted=[0])=>
  worktreeGit(project,['--no-replace-objects',...args],options.signal,accepted,input);

export function sourceChangeCapabilities(){return {version:1,owner:'calliope-cli',writer:'git',
  operations:['preview','propose','inspect','list'],semantics:'verified-patch-to-local-review-branch',
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

const writer=sourceWriter<SourceChangeSelection,SourceChangeReview,'proposed'>({
  directory:'source-proposals',kind:'source-change-review',status:'proposed',tool:'orchestration_source_proposal',
  operation:'Create one local review branch; do not merge, install, push or run work.',selection,branchFor,commitMessage,preview,
});
export const proposeSourceChange=writer.write;
export const inspectSourceChange=writer.inspect;
export const listSourceChanges=writer.list;
