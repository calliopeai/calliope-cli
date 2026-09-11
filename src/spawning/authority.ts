import {canonicalJson} from '../approvals/index.js';
import {ReservationLedger} from '../execution/ledger.js';
import {ExecutionLimitError} from '../execution/types.js';
import type {ExecutionStore} from '../orchestration/execution-store.js';
import type {ExecutionInspection} from '../orchestration/coordinator-types.js';

/** Graph events may consume only grants recorded in this run's original ledger. */
export function inspectSpawnAuthority(store:ExecutionStore,ledger:ReservationLedger,view:ExecutionInspection=store.read()) {
  const saved=ledger.read(store.manifest.project.root),grants=saved.projection.childGrants??[],admissions=view.state.graph?.admissions??[];
  if(saved.manifest.runId!==store.manifest.id||saved.manifest.planHash!==store.manifest.planHash||admissions.length>grants.length)throw new ExecutionLimitError('authority','Child graph has no matching original run budget.');
  for(const record of grants)if(record.grant.runManifestHash!==store.manifest.hash||record.grant.approvalRevision!==view.header.approvalRevision)throw new ExecutionLimitError('authority','Child grant belongs to another run or approval.');
  for(let n=0;n<admissions.length;n++)if(canonicalJson(admissions[n]!.grant)!==canonicalJson(grants[n]))throw new ExecutionLimitError('authority','Child graph and budget grant histories disagree.');
  return{view,context:store.context(view),budget:saved,pending:grants.slice(admissions.length)};
}
