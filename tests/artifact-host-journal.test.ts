import {it,expect} from 'vitest';
import {mkdtempSync,realpathSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {coordinatorRun,verifiedPlan} from './helpers/coordinator-run.js';
import {ExecutionStore} from '../src/orchestration/index.js';
import {projectBudgetPath} from '../src/budget.js';

it('replays legacy refused artifact calls and new mutation receipts without reinterpreting history',async()=>{
  const root=realpathSync(mkdtempSync(join(tmpdir(),'artifact-journal-')));
  let release:(()=>void)|undefined,project:string|undefined;
  try {
    const p=verifiedPlan();p.workspace.allowedTools.push('artifact');for(const a of p.agents)a.allowedTools.push('artifact');
    const r=await coordinatorRun(root,p);project=r.project;const lease=r.store.acquire();release=()=>lease.release();
    await r.store.append({type:'started',ownerId:lease.id});
    await r.store.append({type:'task_started',taskId:'inspect-a',sessionId:'recorded-session',attempt:1});
    const change={type:'tool' as const,taskId:'inspect-a',callId:'legacy-refused',name:'artifact',path:null,mutating:false,success:false};
    await r.store.append({...change,stage:'started'});await r.store.append({...change,stage:'finished'});
    const legacy=r.store.read();expect(legacy.events.at(-1)!.version).toBe(1);expect(legacy.state.tasks['inspect-a']!.mutations).toBe(false);
    await r.store.append({...change,callId:'native-host',mutating:true,stage:'started'});
    await r.store.append({...change,callId:'native-host',mutating:true,stage:'finished',success:true});
    const current=r.store.read();expect(current.events.slice(0,legacy.events.length)).toEqual(legacy.events);
    expect(current.events.slice(-2).map(e=>e.version)).toEqual([11,11]);expect(current.state.tasks['inspect-a']!.mutations).toBe(true);
    expect(new ExecutionStore(join(r.runs.root,r.view.run.id),r.view.manifest).read()).toEqual(current);
  }finally{release?.();if(project)rmSync(join(projectBudgetPath(project),'..'),{recursive:true,force:true});rmSync(root,{recursive:true,force:true});}
});
