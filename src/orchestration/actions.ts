import { resolve, relative, dirname } from 'node:path';
import { realpathSync } from 'node:fs';
import { digest, canonicalPath, projectIdentity } from '../approvals/index.js';
import { withScope, validatePath } from '../scope.js';
import { readPrivateSessionFile } from '../sessions/index.js';
import { authorizeSessionAction, type SessionActionOptions } from '../session-management/index.js';
import { getHooksForEvent } from '../hooks.js';
import { isPolicyEnabled } from '../policy.js';
import { throwIfCancelled } from '../cancellation.js';
import { RunStore } from './store.js';
import { analyzePlan, bindPlan, MAX_PLAN_BYTES, pathName } from './validation.js';
import { OrchestrationError, type RunInspection } from './types.js';
export interface RunActionOptions extends SessionActionOptions { store?: RunStore; source?: 'cli' | 'repl' }

/** Dry validation cannot execute arbitrary hook/policy programs as a side effect. */
export async function loadRunPlan(cwd: string, path: string, dryRun: boolean, options: RunActionOptions = {}) {
  throwIfCancelled(options.signal);
  const { project: root } = projectIdentity(cwd), file = resolve(root,path), sourcePath = relative(root,file); pathName(sourcePath);
  if (canonicalPath(file) !== file || realpathSync(dirname(file)) !== dirname(file)) throw new OrchestrationError('invalid','Plan file must be inside the canonical project without symlink aliases.');
  withScope(root, () => validatePath(file,root));
  if (dryRun) {
    if (isPolicyEnabled() || getHooksForEvent('pre-tool').length) throw new OrchestrationError('policy-denied','Dry-run cannot evaluate executable policy/hooks without running them. Use explicit preparation to authorize the read through the shared gates.');
  } else await authorizeSessionAction(root,'read_file',{path:file,operation:'orchestration-plan'},options);
  throwIfCancelled(options.signal);
  if (canonicalPath(file) !== file) throw new OrchestrationError('conflict','Plan path changed during permission checks.');
  const raw = readPrivateSessionFile(file,MAX_PLAN_BYTES); if (raw === null) throw new OrchestrationError('unavailable','Plan file was not found.');
  let value: unknown; try { value = JSON.parse(raw); } catch { throw new OrchestrationError('invalid','Plan is not valid JSON.'); }
  const analysis = analyzePlan(value), project = bindPlan(analysis,root);
  return { analysis, project, source:{path:sourcePath,sha256:digest(raw)} };
}
export async function prepareRun(cwd: string, path: string, options: RunActionOptions = {}): Promise<RunInspection> {
  const loaded = await loadRunPlan(cwd,path,false,options), { project, analysis, source } = loaded;
  await authorizeSessionAction(project.root,'orchestration_prepare',{path:project.root,planHash:analysis.hash,source:source.path,agents:analysis.plan.agents.length,tasks:analysis.plan.tasks.length},options);
  throwIfCancelled(options.signal);
  const current = projectIdentity(cwd); if (current.projectKey !== project.key) throw new OrchestrationError('conflict','Project identity changed during authorization.');
  return (options.store ?? new RunStore()).prepare(analysis,project.root,source,options.signal);
}
export async function changePreparedRun(cwd: string, id: string, type: 'approved' | 'cancelled', options: RunActionOptions = {}): Promise<RunInspection> {
  const store = options.store ?? new RunStore(), prior = await store.read(id,cwd,options.signal);
  await authorizeSessionAction(prior.run.project.root,type === 'approved' ? 'orchestration_approve' : 'orchestration_cancel',
    {path:prior.run.project.root,runId:id,planHash:prior.run.planHash,revision:prior.run.revision},options);
  return store.transition(id,cwd,prior.run.revision,{type,source:options.source ?? 'cli'},options.signal);
}
export async function inspectRun(cwd: string, id?: string, options: RunActionOptions = {}): Promise<RunInspection> {
  const store = options.store ?? new RunStore();
  if (!id) id = (await store.list(cwd,options.signal)).runs.at(-1)?.id;
  if (!id) throw new OrchestrationError('unavailable','No prepared run in this project. Use calliope run prepare <plan>.');
  return store.read(id,cwd,options.signal);
}
