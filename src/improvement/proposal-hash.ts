import {canonicalJson,digest} from '../approvals/index.js';
import type {ImprovementCycle} from './types.js';

export function improvementProposalHash(cycle:ImprovementCycle):string {
  return digest(canonicalJson({version:1,runId:cycle.runId,manifestHash:cycle.source.manifestHash,decision:cycle.source.decision,proposal:cycle.proposedChange,deadline:cycle.budget.deadline}));
}
