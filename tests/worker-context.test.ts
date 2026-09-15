import {afterEach,it,expect} from 'vitest';
import * as fs from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID} from 'node:crypto';
import {workerAttemptContext} from '../src/orchestration/index.js';
import {coordinatorRun} from './helpers/coordinator-run.js';

const roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))fs.rmSync(root,{recursive:true,force:true});});

it('binds fresh worker attempt context to the current journal start and rejects projected drift',async()=>{
  const root=fs.realpathSync(fs.mkdtempSync(join(tmpdir(),'calliope-worker-attempt-')));roots.push(root);
  const {store,view}=await coordinatorRun(root),task=view.manifest.plan.tasks[0]!;
  await store.append({type:'started',ownerId:randomUUID()});const started=await store.append({type:'task_started',taskId:task.id,attempt:1,sessionId:'session-1'});
  const first=workerAttemptContext(view.manifest.plan,task,store.read());
  expect(first).toEqual({attempt:{version:1,number:1,phase:'initial',maxAttempts:2,startedEventId:started.id,previous:[]},previousAttempts:[]});
  first.attempt.previous.push({number:9,startedEventId:'not-an-event',outcomeEventId:null,status:'unknown'});expect(workerAttemptContext(view.manifest.plan,task,store.read()).attempt.previous).toEqual([]);
  const drift=structuredClone(store.read());drift.state.tasks[task.id]!.sessionId='different-session';
  expect(()=>workerAttemptContext(view.manifest.plan,task,drift)).toThrow('differs from the current task-start event');
  const inactive=structuredClone(store.read());inactive.state.tasks[task.id]!.status='pending';expect(()=>workerAttemptContext(view.manifest.plan,task,inactive)).toThrow('current running task');
  const sequence=structuredClone(store.read()),firstStart=sequence.events.find(event=>event.change.type==='task_started')! as any;
  firstStart.change.attempt=2;sequence.events.push({...structuredClone(firstStart),id:randomUUID(),sequence:firstStart.sequence+1,change:{...firstStart.change,attempt:2,sessionId:'session-2'}});sequence.state.tasks[task.id]!.attempts=2;sequence.state.tasks[task.id]!.sessionId='session-2';
  expect(()=>workerAttemptContext(view.manifest.plan,task,sequence)).toThrow('history differs');
  const excessive=structuredClone(store.read()),start=excessive.events.find(event=>event.change.type==='task_started')! as any;
  excessive.events.push({...structuredClone(start),id:randomUUID(),sequence:start.sequence+1,change:{...start.change,attempt:2,sessionId:'session-2'}},{...structuredClone(start),id:randomUUID(),sequence:start.sequence+2,change:{...start.change,attempt:3,sessionId:'session-3'}});excessive.state.tasks[task.id]!.attempts=3;excessive.state.tasks[task.id]!.sessionId='session-3';
  expect(()=>workerAttemptContext(view.manifest.plan,task,excessive)).toThrow('exceeds the reviewed retry limit');
});
