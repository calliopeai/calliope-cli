import type {ImprovementHistory} from './types.js';
/** Bounded model feedback: raw prompts/logs and duplicate artifacts stay out of the review. */
export function improvementFeedback(history:ImprovementHistory) {
  return{version:history.version,...(history.accounting?{accounting:history.accounting}:{}),total:history.cycles.length,cycles:history.cycles.slice(-4).map(c=>({id:c.id,parentCycleId:c.parentCycleId,previousCycleId:c.previousCycleId,status:c.status,action:c.proposedChange.action,targets:c.targetTaskIds,
    expectedMetric:c.expectedMetric,measurements:c.metrics,withdrawn:!!c.withdrawal})),
    limits:history.version===2?'Measurements describe recorded attempts, not causal proof or a security/performance guarantee. Provider-accounted cost covers worker attempts only, excludes planning and controller/reviewer overhead, and is not an invoice. Incomplete attribution or usage prevents cost comparisons. Requested metrics remain proposed; all cycles share the original run allowance.':'Measurements describe recorded attempts, not causal proof or a security/performance guarantee. Requested metrics without matching observations remain proposed. Per-cycle provider cost is unavailable without request attribution; all cycles share the original run allowance.'};
}
