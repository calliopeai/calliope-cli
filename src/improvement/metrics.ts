import {canonicalJson} from '../approvals/index.js';
import type {CycleMetric,CycleOutcome} from './types.js';

function rate(values:CycleOutcome[],kind:'checks'|'tools'):number|null {
  const total=values.reduce((n,v)=>n+(kind==='checks'?v.checks.length:v.toolCalls),0);
  if(!total)return null;
  return values.reduce((n,v)=>n+(kind==='checks'?v.checks.filter(c=>c.passed).length:v.toolFailures),0)/total;
}
function duration(values:CycleOutcome[]):number|null {
  return !values.length||values.some(v=>v.durationMs===null)?null:values.reduce((n,v)=>n+v.durationMs!,0);
}
/** A decomposition changes the measurement population; it cannot claim a like-for-like gain. */
export function cycleMetrics(before:CycleOutcome[],after:CycleOutcome[],targets:string[]):CycleMetric[] {
  const population=(values:CycleOutcome[])=>values.map(v=>v.taskId).sort();
  const same=before.length>0&&canonicalJson(population(before))===canonicalJson(population(after))&&canonicalJson(population(after))===canonicalJson([...targets].sort());
  const checks=(values:CycleOutcome[])=>values.flatMap(v=>v.checks.map(c=>({taskId:v.taskId,id:c.id,artifactId:c.artifactId,kind:c.kind,criteria:c.criteria}))).sort((a,b)=>canonicalJson(a).localeCompare(canonicalJson(b)));
  const sameChecks=same&&canonicalJson(checks(before))===canonicalJson(checks(after));
  const metric=(name:CycleMetric['name'],unit:CycleMetric['unit'],b:number|null,a:number|null,matching:boolean,direction:CycleMetric['direction']):CycleMetric=>{
    const comparable=matching&&b!==null&&a!==null;
    return{name,unit,before:b,after:a,delta:comparable?a!-b!:null,comparable,direction,
      reason:comparable?'Recorded observations for the same tasks; this alone does not establish causal improvement.':!matching?'Task population or check definitions differ, or the next attempt is incomplete.':'The required measurement was not recorded.'};
  };
  return[metric('acceptance-check-pass-rate','ratio',rate(before,'checks'),rate(after,'checks'),sameChecks,'increase'),
    metric('attempt-duration','ms',duration(before),duration(after),same,'decrease'),
    metric('tool-failure-rate','ratio',rate(before,'tools'),rate(after,'tools'),same,'decrease')];
}
