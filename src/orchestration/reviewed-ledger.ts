/** Host an existing reviewed allowance; native graph admission remains the only writer of children. */
import {dirname,join} from 'node:path';
import {canonicalJson,digest} from '../approvals/index.js';
import {throwIfCancelled} from '../cancellation.js';
import {accountLineage} from '../execution/authority.js';
import {effectiveExecutionManifest} from '../execution/child-grants.js';
import {createLedgerServer} from '../execution/ledger-server.js';
import {LedgerServerState,mintLedgerToken} from '../execution/ledger-protocol.js';
import {ExecutionLimitError,type ChildGrant} from '../execution/types.js';
import type {ReservationLedger} from '../execution/ledger.js';
import {inspectSpawnAuthority} from '../spawning/authority.js';
import {RunStore} from './store.js';
import {ExecutionStore} from './execution-store.js';
import {agentStopped} from './execution-journal.js';
import {prepareAgentExecution} from './execution.js';
import type {RunActionOptions} from './actions.js';
import {matchesAgentPreference} from './routing.js';

export const REVIEWED_LEDGER_CAPABILITY={version:1,ownerScope:1,tokenVersion:2,reviewedAuthority:1,grants:'native-admissions-only'} as const;

/** Returns an unbound server and a private owner token. Only the trusted host listens or delivers credentials. */
export async function prepareReviewedLedger(cwd:string,runId:string,agentId:string,maxOutputTokens:number,options:RunActionOptions={}) {
  const runs=options.store??new RunStore(),execution=await prepareAgentExecution(cwd,runId,agentId,maxOutputTokens,{...options,store:runs});
  const ledger=execution.ledger as ReservationLedger,view=await runs.read(runId,cwd,options.signal),history=new ExecutionStore(join(runs.root,runId),view.manifest);
  const assertOwner=()=>{throwIfCancelled(options.signal);execution.assertAuthority!();};
  const assertAccount=(id:string)=>{
    assertOwner();
    const current=history.exists()?inspectSpawnAuthority(history,ledger):undefined,context=current?.context??view.manifest;
    const agent=context.plan.agents.find(agent=>agent.id===id);
    if(!agent||current&&agentStopped(current.view.state,context,id))throw new ExecutionLimitError('authority','Account is not active in the reviewed native graph.');
    return agent;
  };
  const assertGrant=(grant:ChildGrant)=>{
    assertOwner();
    const admitted=history.exists()?inspectSpawnAuthority(history,ledger).view.state.graph?.admissions.find(entry=>entry.grant.grant.id===grant.id):undefined;
    if(!admitted||canonicalJson(admitted.grant.grant)!==canonicalJson(grant))throw new ExecutionLimitError('authority','Child grant requires its existing native reviewed admission.');
    for(const account of grant.accounts)assertAccount(account.id);
  };
  assertAccount(agentId);
  const saved=ledger.read(cwd),effective=effectiveExecutionManifest(saved.manifest,saved.projection),deadline=Math.min(...accountLineage(effective,agentId).map(account=>account.deadline));
  if(Date.now()>=deadline)throw new ExecutionLimitError('deadline','Original owner allowance expired.');
  history.create({version:1,runId,manifestHash:view.manifest.hash,approvalRevision:view.run.revision,createdAt:new Date(saved.manifest.createdAt).toISOString(),deadline:saved.manifest.deadline});
  assertAccount(agentId);
  const authority=digest(canonicalJson({version:1,runId,manifestHash:view.manifest.hash,approvalRevision:view.run.revision}));
  const state=new LedgerServerState(join(dirname(ledger.root),`${runId}.ledger-server`));
  const server=createLedgerServer({ledger,cwd,state,ownerAgentId:agentId,authority,assertAuthority:assertOwner,assertAccountAuthority:assertAccount,assertGrantAuthority:assertGrant,
    assertReservationAuthority:reservation=>{
      const agent=assertAccount(reservation.agentId);
      if(!matchesAgentPreference(agent.preference,reservation.provider,reservation.model))throw new ExecutionLimitError('authority','Request changes an explicit reviewed provider or model.');
      if(reservation.outputTokens>maxOutputTokens)throw new ExecutionLimitError('budget','Request exceeds the reviewed host output limit.');
    }});
  const ownerToken=mintLedgerToken(state.secret(),{v:2,authority,run:runId,role:'parent',owner:agentId,exp:deadline});
  return {server,ownerToken,execution,deadline,capability:REVIEWED_LEDGER_CAPABILITY};
}
