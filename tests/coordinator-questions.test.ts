import {beforeEach,afterEach,it,expect,vi} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import * as config from '../src/config.js';
import {saveHooks} from '../src/hooks.js';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {answerExecutionQuestion,ExecutionStore,changePreparedRun,runOrchestrationCommand,formatExecutionData,validateQuestionRequest,validateQuestionAnswer,type ExecutionLease,type ExecutionQuestionRequest} from '../src/orchestration/index.js';

let root:string,leases:ExecutionLease[];
beforeEach(()=>{config.resetConfig();saveHooks([]);root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-questions-')));fs.chmodSync(root,0o700);leases=[];vi.stubGlobal('fetch',vi.fn(()=>{throw new Error('Question control must not call a provider.');}));});
afterEach(()=>{for(const lease of leases)lease.release();config.resetConfig();saveHooks([]);vi.restoreAllMocks();vi.unstubAllGlobals();fs.rmSync(root,{recursive:true,force:true});});
async function question() {
  const p=verifiedPlan();p.workspace.allowedTools.push('ask_question');for(const a of p.agents)a.allowedTools.push('ask_question');
  const r=await coordinatorRun(root,p),lease=r.store.acquire();leases.push(lease);
  await r.store.append({type:'started',ownerId:lease.id});
  await r.store.append({type:'task_started',taskId:'inspect-a',sessionId:'question-session',attempt:1});
  await r.store.append({type:'tool',taskId:'inspect-a',callId:'question-call',name:'ask_question',path:null,stage:'started',mutating:false,success:false});
  const request:ExecutionQuestionRequest={id:randomUUID(),ownerId:lease.id,attempt:1,sessionId:'question-session',callId:'question-call',text:'Which audience?',options:['Engineers','Operators'],context:'Choose the report audience.'};
  await r.store.append({type:'question_asked',taskId:'inspect-a',request});
  return {...r,lease,request};
}
it('recovers an exact pending request from disk and records one answer without changing attempt, session, clock or allowance',async()=>{
  const r=await question(),before=r.store.read(),budget=r.authority.ledger.read(r.project);
  const reopened=new ExecutionStore(join(r.runs.root,r.view.run.id),r.view.manifest);
  expect(reopened.read()).toEqual(before);expect(before.state.version).toBe(7);expect(before.events.at(-1)!.version).toBe(8);
  const answer=await answerExecutionQuestion(r.project,r.view.run.id,r.request.id,before.state.revision,'Operators',{store:r.runs,approve:async()=> 'allow'});
  expect(answer.state.questions![r.request.id]).toMatchObject({...r.request,taskId:'inspect-a',status:'answered',answer:'Operators'});
  expect(answer.header).toEqual(before.header);expect(answer.state.tasks).toEqual(before.state.tasks);expect(r.authority.ledger.read(r.project)).toEqual(budget);
  expect(answer.state.ownerId).toBe(r.lease.id);expect(answer.events).toHaveLength(before.events.length+1);
  await expect(answerExecutionQuestion(r.project,r.view.run.id,r.request.id,answer.state.revision,'Different',{store:r.runs,approve:async()=> 'allow'})).rejects.toThrow(/waiting/);
});
it('rejects policy denial, stale revision and an unknown request without appending an answer',async()=>{
  const r=await question(),before=r.store.read(),base={store:r.runs};
  await expect(answerExecutionQuestion(r.project,r.view.run.id,r.request.id,before.state.revision,'Operators',base)).rejects.toThrow(/denied/);
  await expect(answerExecutionQuestion(r.project,r.view.run.id,r.request.id,before.state.revision,'Operators',{...base,approve:async()=> 'deny'})).rejects.toThrow(/denied/);
  await expect(answerExecutionQuestion(r.project,r.view.run.id,r.request.id,'0'.repeat(64),'Operators',base)).rejects.toThrow(/changed/);
  await expect(answerExecutionQuestion(r.project,r.view.run.id,randomUUID(),before.state.revision,'Operators',base)).rejects.toThrow(/waiting/);
  await expect(answerExecutionQuestion(r.project,r.view.run.id,'invalid',before.state.revision,'Operators',base)).rejects.toThrow(/exact question/);
  const other=join(root,'other-project');fs.mkdirSync(other);
  await expect(answerExecutionQuestion(other,r.view.run.id,r.request.id,before.state.revision,'Operators',base)).rejects.toThrow();
  expect(r.store.read()).toEqual(before);
});
it('serializes concurrent answers under the native writer lock',async()=>{
  const r=await question(),revision=r.store.read().state.revision;
  const answers=await Promise.allSettled(['Operators','Engineers'].map(answer=>answerExecutionQuestion(r.project,r.view.run.id,r.request.id,revision,answer,{store:r.runs,approve:async()=> 'allow'})));
  expect(answers.filter(a=>a.status==='fulfilled')).toHaveLength(1);
  expect(r.store.read().events.filter(e=>e.change.type==='question_answered')).toHaveLength(1);
});
it('keeps consecutive questions distinct and refuses a second pending question in the same task',async()=>{
  const r=await question(),second={...r.request,id:randomUUID(),callId:'second-question',text:'Which format?',options:['Markdown','Plain text']};
  await r.store.append({type:'tool',taskId:'inspect-a',callId:second.callId,name:'ask_question',path:null,stage:'started',mutating:false,success:false});
  await expect(r.store.append({type:'question_asked',taskId:'inspect-a',request:second})).rejects.toThrow(/already recorded/);
  await answerExecutionQuestion(r.project,r.view.run.id,r.request.id,r.store.read().state.revision,'Operators',{store:r.runs,approve:async()=> 'allow'});
  await r.store.append({type:'tool',taskId:'inspect-a',callId:r.request.callId,name:'ask_question',path:null,stage:'finished',mutating:false,success:true});
  await r.store.append({type:'question_asked',taskId:'inspect-a',request:second});
  const before=r.store.read();
  await expect(answerExecutionQuestion(r.project,r.view.run.id,r.request.id,before.state.revision,'Markdown',{store:r.runs,approve:async()=> 'allow'})).rejects.toThrow(/waiting/);
  expect(r.store.read()).toEqual(before);
  await answerExecutionQuestion(r.project,r.view.run.id,second.id,before.state.revision,'Markdown',{store:r.runs,approve:async()=> 'allow'});
  const questions=r.store.read().state.questions!;
  expect(questions[r.request.id]).toMatchObject({status:'answered',answer:'Operators'});
  expect(questions[second.id]).toMatchObject({status:'answered',answer:'Markdown'});
});
it.each(['stop','owner','finish','revoke','deadline','orphan'])('refuses an answer after %s changes the waiting authority',async kind=>{
  const r=await question();
  if(kind==='stop')await r.store.append({type:'agent_stop',agentId:'coordinator'});
  if(kind==='owner')await r.store.append({type:'started',ownerId:randomUUID()});
  if(kind==='finish')await r.store.append({type:'tool',taskId:'inspect-a',callId:'question-call',name:'ask_question',path:null,stage:'finished',mutating:false,success:false});
  if(kind==='revoke')await changePreparedRun(r.project,r.view.run.id,'cancelled',{store:r.runs});
  if(kind==='deadline')vi.spyOn(Date,'now').mockReturnValue(r.store.read().header.deadline);
  if(kind==='orphan'){r.lease.release();leases=leases.filter(lease=>lease!==r.lease);}
  const before=r.store.read();
  if(['stop','owner','finish'].includes(kind))expect(before.state.questions![r.request.id]!.status).toBe('closed');
  await expect(answerExecutionQuestion(r.project,r.view.run.id,r.request.id,before.state.revision,'Operators',{store:r.runs,approve:async()=> 'allow'})).rejects.toThrow();
  expect(r.store.read()).toEqual(before);
});
it.each(['stop','revoke'])('rechecks %s after an asynchronous permission decision',async kind=>{
  const r=await question(),before=r.store.read();
  await expect(answerExecutionQuestion(r.project,r.view.run.id,r.request.id,before.state.revision,'Operators',{store:r.runs,approve:async()=>{
    if(kind==='stop')await r.store.append({type:'agent_stop',agentId:'a'});
    else await changePreparedRun(r.project,r.view.run.id,'cancelled',{store:r.runs});
    return 'allow';
  }})).rejects.toThrow(/changed|active task|approval/);
  expect(r.store.read().events.some(e=>e.change.type==='question_answered')).toBe(false);
});
it('rejects a policy configuration change between permission resolution and the journal commit',async()=>{
  const r=await question(),before=r.store.read(),append=ExecutionStore.prototype.append;
  vi.spyOn(ExecutionStore.prototype,'append').mockImplementation(function(change,...args){
    if(change.type==='question_answered')config.set('policy',{enabled:true,command:'false'});
    return append.call(this,change,...args);
  });
  await expect(answerExecutionQuestion(r.project,r.view.run.id,r.request.id,before.state.revision,'Operators',{store:r.runs,approve:async()=> 'allow'})).rejects.toThrow(/policy changed/);
  expect(r.store.read()).toEqual(before);
});
it('rejects malformed, foreign and duplicate question requests during native replay',async()=>{
  const r=await question(),before=r.store.read();
  for(const patch of [{id:randomUUID(),sessionId:'foreign'},{id:randomUUID(),ownerId:randomUUID()},{id:randomUUID(),attempt:2},{id:randomUUID(),callId:'foreign'},{}]){
    await expect(r.store.append({type:'question_asked',taskId:'inspect-a',request:{...r.request,...patch}})).rejects.toThrow();
  }
  expect(r.store.read()).toEqual(before);
  for(const patch of [{options:['duplicate','duplicate']},{options:Array(9).fill('x')},{text:''},{context:13},{text:'\u001b[2J'},{extra:true}])expect(()=>validateQuestionRequest({...r.request,...patch})).toThrow();
  for(const answer of ['',null,{},'x'.repeat(8193),'\u001b[2J'])expect(()=>validateQuestionAnswer(answer)).toThrow();
});
it('exposes the pending question and exact answer command through the native CLI',async()=>{
  const r=await question(),lines:string[]=[],options={cwd:r.project,store:r.runs,write:(line:string)=>lines.push(line)};
  expect(await runOrchestrationCommand('run',['status',r.view.run.id],options)).toBe(0);
  expect(lines.join('')).toContain('Which audience?');expect(lines.join('')).toContain(r.request.id);
  const interrupted=formatExecutionData('status',{runId:r.view.run.id,execution:r.store.read(),interrupted:true});
  expect(interrupted).toContain('cannot resume');expect(interrupted).not.toContain('Answer with:');
  const revision=r.store.read().state.revision,args=['answer',r.view.run.id,r.request.id,'--revision',revision,'--answer','Operators','--json'];
  lines.length=0;expect(await runOrchestrationCommand('run',args,options)).toBe(3);
  lines.length=0;expect(await runOrchestrationCommand('run',[...args,'--allow-mutations'],options)).toBe(0);
  expect(JSON.parse(lines.at(-1)!).data.execution.state.questions[r.request.id].answer).toBe('Operators');
  lines.length=0;expect(await runOrchestrationCommand('run',['status',r.view.run.id,'--answer','bad','--json'],options)).not.toBe(0);
});
