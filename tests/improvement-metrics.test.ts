import {it,expect} from 'vitest';
import {cycleMetrics,improvementFeedback,type CycleOutcome,type ImprovementHistory} from '../src/improvement/index.js';
const outcome=(taskId='task'):CycleOutcome=>({taskId,attempt:1,status:'failed',event:{id:'event',hash:'hash',sequence:1,at:'2026-01-01T00:00:00Z'},checks:[{id:'test',artifactId:'tests',kind:'command',criteria:['task:0'],passed:false,detail:'process failed'}],artifacts:[],risks:[],durationMs:20,toolCalls:2,toolFailures:1});
it('measures comparable attempts without promoting the hypothesis or assuming causal improvement',()=>{
  const before=outcome(),after=structuredClone(before);after.attempt=2;after.status='completed';after.checks[0]!.passed=true;after.durationMs=10;after.toolFailures=0;
  const metrics=cycleMetrics([before],[after],['task']);expect(metrics.map(m=>[m.name,m.before,m.after,m.delta,m.comparable])).toEqual([['acceptance-check-pass-rate',0,1,1,true],['attempt-duration',20,10,-10,true],['tool-failure-rate',0.5,0,-0.5,true]]);
  expect(metrics.every(m=>m.reason.includes('does not establish causal'))).toBe(true);expect(before.status).toBe('failed');
});
it('keeps missing measurements null and refuses comparisons across changed tasks or checks',()=>{
  const before=outcome(),after=outcome();before.checks=[];before.durationMs=null;before.toolCalls=0;
  expect(cycleMetrics([before],[before],['task']).every(m=>m.before===null&&m.after===null&&m.delta===null&&!m.comparable)).toBe(true);
  expect(cycleMetrics([after],[],['task']).every(m=>!m.comparable&&m.delta===null)).toBe(true);
  expect(cycleMetrics([after],[outcome('child')],['child']).every(m=>!m.comparable)).toBe(true);
  const changed=structuredClone(after);changed.checks[0]!.criteria=['agent:0'];expect(cycleMetrics([after],[changed],['task'])[0]!.comparable).toBe(false);
  expect(cycleMetrics([],[],[]).every(m=>m.before===null&&m.after===null&&!m.comparable)).toBe(true);
});
it('bounds recursive feedback and labels unavailable cost attribution',()=>{
  const cycles=Array.from({length:8},(_,n)=>({id:String(n),parentCycleId:n?'0':null,previousCycleId:null,status:'verified',proposedChange:{action:'retry'},targetTaskIds:['task'],expectedMetric:{name:'security',direction:'increase',state:'proposed'},metrics:[],withdrawal:n===7?{}:null}));
  const feedback=improvementFeedback({version:1,kind:'improvement.history',runId:'run',revision:'revision',cycles} as ImprovementHistory);
  expect(feedback.total).toBe(8);expect(feedback.cycles.map(c=>c.id)).toEqual(['4','5','6','7']);expect(feedback.cycles.at(-1)!.withdrawn).toBe(true);expect(feedback.limits).toContain('cost is unavailable');expect(feedback.cycles[0]!.expectedMetric.state).toBe('proposed');
});

function priced(costNanos:number,attempt=1):CycleOutcome {
  const v=outcome();v.attempt=attempt;v.accounting={status:'available',source:{version:1,kind:'task',taskId:v.taskId,attempt,eventId:'start',eventHash:'hash',sessionId:'session'},agentId:'worker',accounted:{tokens:10,costNanos},requestIds:['request'],requests:{settled:1,pending:0,unknown:0,exceeded:0},closed:true,usageComplete:true};return v;
}
it('compares attributed worker charges without claiming whole-goal cost or invoices',()=>{
  const before=priced(100000),after=priced(150000,2),cost=cycleMetrics([before],[after],['task']).at(-1)!;
  expect(cost).toMatchObject({name:'provider-accounted-cost',unit:'nano-usd',before:100000,after:150000,delta:50000,comparable:true});expect(cost.reason).toContain('excludes planning');expect(cost.reason).toContain('not an invoice');
  const history={version:2,kind:'improvement.history',runId:'run',revision:'revision',cycles:[],accounting:{version:1,status:'available',revision:'budget',scope:'worker-attempts',basis:'reservations-and-settlements'}} as ImprovementHistory;
  const feedback=improvementFeedback(history);expect(feedback.version).toBe(2);expect(feedback.accounting).toEqual(history.accounting);expect(feedback.limits).toContain('excludes planning');
});
it('keeps incomplete charges visible but not comparable and leaves legacy costs unavailable',()=>{
  const before=priced(100000),after=priced(150000,2);if(after.accounting?.status!=='available')throw Error('Fixture');after.accounting.usageComplete=false;
  expect(cycleMetrics([before],[after],['task']).at(-1)).toMatchObject({before:100000,after:150000,comparable:false,delta:null,reason:expect.stringContaining('incomplete')});
  after.accounting=null;expect(cycleMetrics([before],[after],['task']).at(-1)).toMatchObject({before:100000,after:null,comparable:false});
  expect(cycleMetrics([before],[],['task']).at(-1)).toMatchObject({after:null,comparable:false});
  expect(cycleMetrics([outcome()],[outcome()],['task'])).toHaveLength(3);
  const zero=priced(0);if(zero.accounting?.status==='available'){zero.accounting.requestIds=[];zero.accounting.requests.settled=0;}expect(cycleMetrics([zero],[zero],['task']).at(-1)).toMatchObject({before:0,after:0,delta:0,comparable:true});
});
it('refuses costs for changed populations, foreign attempts or review scopes',()=>{
  const before=priced(100000),after=priced(150000,2);
  expect(cycleMetrics([before],[after],['child']).at(-1)?.comparable).toBe(false);
  if(after.accounting?.status!=='available')throw Error('Fixture');after.accounting.source={...after.accounting.source,kind:'task',taskId:'task',attempt:1};expect(cycleMetrics([before],[after],['task']).at(-1)).toMatchObject({after:null,comparable:false});
  after.accounting.source={version:1,kind:'supervision',eventId:'start',eventHash:'hash',sessionId:'session',role:'controller',round:1};expect(cycleMetrics([before],[after],['task']).at(-1)).toMatchObject({after:null,comparable:false});
});
