/** Generated task patches become immutable candidates, never verified proposals. */
import {canonicalJson,digest} from '../approvals/index.js';
import {sourceWriter,type WriterReview} from '../source-changes/writer.js';
import {readPinnedWorktreeBase,worktreeGit} from '../isolation/worktree.js';
import {inspectExecution} from './coordinator-actions.js';
import {readCollectedArtifact} from './verification.js';
import {OrchestrationError} from './types.js';
import {id,pathName,shape} from './validation.js';
import type {RunActionOptions} from './actions.js';

export interface SourceCandidateSelection {
  runId:string;executionRevision:string;taskId:string;attempt:number;artifactId:string;artifactHash:string;
}
export interface SourceCandidateReview extends WriterReview<SourceCandidateSelection> {
  kind:'source-candidate-review';verification:'required';
}
function conflict(message:string):never{throw new OrchestrationError('conflict',message);}
const hash=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{64}$/.test(v);
const uuid=(v:unknown)=>typeof v==='string'&&/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(v);
const git=(project:string,args:string[],options:RunActionOptions,input?:Parameters<typeof worktreeGit>[4])=>
  worktreeGit(project,['--no-replace-objects','--literal-pathspecs',...args],options.signal,[0],input);
const branchFor=(source:SourceCandidateSelection,review:string)=>`refs/calliope-candidates/${source.runId}/${review}`;
const commitMessage=(source:SourceCandidateSelection,review:string)=>`Stage unverified candidate for ${source.taskId}\n\nCalliope-Source-Candidate: ${review}\nRun: ${source.runId}\nAttempt: ${source.attempt}\nArtifact-SHA256: ${source.artifactHash}\nVerification: required\n`;

export function sourceCandidateCapabilities(){return {version:1,owner:'calliope-cli',writer:'git',
  operations:['preview','create','inspect','list'],semantics:'generated-task-patch-to-unverified-local-candidate',
  verification:'required',installation:false,merge:false,push:false,mayCallModel:false} as const;}

function selection(source:SourceCandidateSelection):void {
  shape(source,['runId','executionRevision','taskId','attempt','artifactId','artifactHash']);
  if(!uuid(source.runId)||!hash(source.executionRevision)||!hash(source.artifactHash)||
      !Number.isSafeInteger(source.attempt)||source.attempt<1)
    throw new OrchestrationError('invalid','Select the exact native task attempt and patch.');
  id(source.taskId);id(source.artifactId);
}

/** Preview creates no Git object/ref and does not turn task checks into migration acceptance. */
export async function previewSourceCandidate(cwd:string,source:SourceCandidateSelection,options:RunActionOptions={}) {
  return preview(cwd,source,options);
}
async function preview(cwd:string,source:SourceCandidateSelection,options:RunActionOptions,leaseId?:string) {
  selection(source);
  const current=await inspectExecution(cwd,source.runId,options),{view,store}=current,state=current.execution?.state;
  if(!state||state.revision!==source.executionRevision||state.ownerId||current.owner?.alive&&current.owner.id!==leaseId)
    conflict('The source execution changed or is still owned. Inspect its current task evidence.');
  store.assertApproval(current.execution!.header);
  const context=store.context(),task=context.plan.tasks.find(t=>t.id===source.taskId),attempt=state.tasks[source.taskId],output=attempt?.output;
  if(!task?.isolation||task.isolation.mode==='read-only-v1'||task.isolation.patchArtifactId!==source.artifactId||
      !attempt||attempt.attempts!==source.attempt||attempt.status!=='completed'||!output||
      !output.checks.length||output.checks.some(check=>!check.passed))
    conflict('Select a completed isolated task attempt and its executor-collected patch. Independent verification is still required.');
  const artifact=output.artifacts.find(a=>a.id===source.artifactId);
  if(!artifact||artifact.sha256!==source.artifactHash||artifact.kind!=='patch'||artifact.location!=='run'||
      artifact.bytes<1||artifact.bytes>1024*1024)conflict('Select the collected nonempty patch, up to 1 MiB.');
  const bytes=await readCollectedArtifact(store,artifact,options);
  let patch:string;try{patch=new TextDecoder('utf-8',{fatal:true}).decode(bytes);}catch{conflict('Native patches must use UTF-8.');}
  const project=view.manifest.project,baseCommit=readPinnedWorktreeBase(store.root,project.root,view.manifest.planHash);
  if((await git(project.root,['rev-parse','--verify','HEAD^{commit}'],options)).trim()!==baseCommit)
    conflict('The owning source advanced beyond the task base. Replan the affected unit before creating a candidate.');
  const author={name:(await git(project.root,['config','--local','--get','user.name'],options)).trim(),
    email:(await git(project.root,['config','--local','--get','user.email'],options)).trim()};
  if(Object.values(author).some(v=>!v||v.length>256||/[\r\n<>\x00]/.test(v)))
    conflict('Configure a valid repository-local Git author before reviewing a candidate.');
  const stats=await git(project.root,['apply','--numstat','-z','--'],options,{text:patch});
  const paths=stats.split('\0').filter(Boolean).map(line=>{
    const match=/^(?:\d+|-)\t(?:\d+|-)\t(.+)$/s.exec(line);if(!match)conflict('Native patch path inventory is unavailable.');
    const value=match![1]!;pathName(value);if(value.split('/').some(p=>p.toLowerCase()==='.git'))conflict('Git metadata cannot be staged.');return value;
  });
  const grants=context.plan.agents.find(a=>a.id===task.agentId)!.allowedPaths.filter(g=>g.access==='write');
  if(!paths.length||paths.length>1000||paths.some(p=>!grants.some(g=>g.path==='.'||p===g.path||p.startsWith(g.path+'/'))))
    conflict('The patch exceeds the selected worker’s original write scope or path bound.');
  // Do not silently hide an overlapping user edit, including an ignored/untracked target.
  if(await git(project.root,['status','--porcelain=v1','-z','--untracked-files=all','--ignored=matching','--',...paths],options))
    conflict('Candidate paths conflict with local staged, unstaged, untracked or ignored changes. Preserve them and replan.');
  const review:SourceCandidateReview={version:1,kind:'source-candidate-review',writer:'git',verification:'required',
    project:{root:project.root,key:project.key},source,manifestHash:view.manifest.hash,
    sourceHash:digest(canonicalJson({task,attempt,artifact})),baseCommit,author,paths,patchBytes:bytes.length};
  const reviewHash=digest(canonicalJson(review));
  store.assertRevision(source.executionRevision);store.assertApproval(current.execution!.header);
  return {review,hash:reviewHash,branch:branchFor(source,reviewHash),patch};
}

const writer=sourceWriter<SourceCandidateSelection,SourceCandidateReview,'candidate'>({
  directory:'source-candidates',kind:'source-candidate-review',status:'candidate',tool:'orchestration_source_candidate',
  operation:'Create one unverified local candidate for independent verification; do not mark verified, merge, install, push or run work.',
  selection,branchFor,commitMessage,preview,
});
export const createSourceCandidate=writer.write;
export const inspectSourceCandidate=writer.inspect;
export const listSourceCandidates=writer.list;
