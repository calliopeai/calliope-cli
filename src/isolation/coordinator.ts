import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { canonicalJson, canonicalPath } from '../approvals/index.js';
import { authorizeSessionAction } from '../session-management/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { readCollectedArtifact, recordExecutorArtifact } from '../orchestration/verification.js';
import { OrchestrationError, type ProjectTask } from '../orchestration/types.js';
import type { RunActionOptions } from '../orchestration/actions.js';
import type { ExecutionStore } from '../orchestration/execution-store.js';
import type { ExecutionGuard } from '../execution/guard.js';
import { createWorkerWorktree, pinWorktreeBase, type WorkerWorktree } from './worktree.js';
import { runIsolatedCommand } from './process.js';

export async function taskWorktree(store: ExecutionStore, task: ProjectTask, options: RunActionOptions): Promise<WorkerWorktree | undefined> {
  const context = store.context(); if (!context.plan.workspace.isolation) return undefined;
  const project = store.manifest.project.root;
  await authorizeSessionAction(project, 'orchestration_workspace', { path: project, runId: store.manifest.id, taskId: task.id, planHash: store.manifest.planHash, storage: store.root }, options);
  const base = await pinWorktreeBase(store.root, project, store.manifest.source.path, store.manifest.planHash, options.signal);
  const state = store.read().state, root = join(store.root, `worker-${task.id}-${state.tasks[task.id]!.attempts}`);
  const workspace = await createWorkerWorktree(root, project, base, options.signal);
  const agent = context.plan.agents.find(a => a.id === task.agentId)!, copied = new Map<string, string>();
  for (const input of [...agent.inputs, ...task.inputs]) if (input.kind === 'artifact') {
    const artifact = state.artifacts[input.value]; if (!artifact) throw new OrchestrationError('unavailable', 'Dependency artifact is missing.');
    const path = context.plan.tasks.find(t => t.id === artifact.taskId)!.outputs.find(o => o.id === artifact.id)!.path;
    if (!path) continue;
    if (copied.has(path) && copied.get(path) !== artifact.sha256) throw new OrchestrationError('conflict', 'Dependency artifacts disagree on the same workspace path.');
    const content = await readCollectedArtifact(store, artifact, options); throwIfCancelled(options.signal); workspace.assertIdentity();
    const file = resolve(workspace.filesRoot, path);
    if (path.split('/').some(p=>p.toLowerCase()==='.git') || canonicalPath(file) !== file) throw new OrchestrationError('conflict', 'Dependency path aliases workspace metadata.');
    fs.mkdirSync(dirname(file), { recursive: true, mode: 0o700 }); fs.writeFileSync(file, content, { mode: 0o600 }); copied.set(path, artifact.sha256);
  }
  options.runlog?.policyEvent({ tool: 'orchestration_workspace', source: 'isolation', decision: 'allow', reason: canonicalJson({ taskId: task.id, base, root, inputs: [...copied] }), durationMs: 0 });
  return workspace;
}
export async function verifyInWorktree(store: ExecutionStore, task: ProjectTask, workspace: WorkerWorktree, guard: ExecutionGuard, options: RunActionOptions): Promise<Map<string, string>> {
  const context = store.context(), image = context.plan.workspace.isolation!.image;
  const agent = context.plan.agents.find(a => a.id === task.agentId)!, outputs = new Map<string, string>();
  for (const command of task.isolation!.commands) {
    guard.assertActive(options.signal);
    const rendered = command.argv.map(arg => "'" + arg.replace(/'/g, "'\\''") + "'").join(' ');
    const operation=`Verify in worktree ${workspace.filesRoot}\nImage: ${image}\nRead-only paths: ${agent.allowedPaths.map(p=>p.path).join(', ')}\nNetwork: disabled; timeout: ${command.timeoutMs} ms`;
    await authorizeSessionAction(store.manifest.project.root, 'shell', { command: rendered, operation, argv: command.argv, runId: store.manifest.id, taskId: task.id, image, network: 'none', mounts: agent.allowedPaths.map(p => ({ ...p, access: 'read' })), timeoutMs: command.timeoutMs }, { ...options, confirmation: 'mutating' });
    guard.assertActive(options.signal); const mounts = workspace.mounts(agent.allowedPaths, options.signal), before=workspace.snapshot(agent.allowedPaths,options.signal), callId = randomUUID();
    await store.append({ type: 'tool', taskId: task.id, callId, name: 'shell', path: null, stage: 'started', mutating: true, success: false }, options.signal);
    const receipt = await runIsolatedCommand(image, { ...command, timeoutMs: Math.min(command.timeoutMs, Math.max(1, guard.deadline - Date.now())) }, mounts, options.signal);
    let after:string|null=null;try{after=workspace.snapshot(agent.allowedPaths);}catch{/* Preserve the process result even if its input workspace was replaced. */}
    const result={...receipt,workspace:{before,after},outcome:receipt.outcome==='passed'&&before!==after?'failed' as const:receipt.outcome};
    await store.append({ type: 'tool', taskId: task.id, callId, name: 'shell', path: null, stage: 'finished', mutating: true, success: result.outcome === 'passed' });
    await recordExecutorArtifact(store, task, command.artifactId, canonicalJson(result));
    options.runlog?.policyEvent({ tool: 'shell', source: 'isolated-command', decision: result.outcome === 'passed' ? 'allow' : 'deny', reason: canonicalJson({ artifactId: command.artifactId, outcome: result.outcome, exitCode: result.exitCode, container: result.container, cleanupConfirmed: result.cleanupConfirmed }), durationMs: result.durationMs });
    guard.assertActive(options.signal);
    if (!result.cleanupConfirmed || result.outcome === 'unavailable') throw new OrchestrationError('unavailable', 'Required container execution or cleanup failed; inspect the recorded container before retrying.');
    if (result.outcome !== 'passed') break;
    workspace.rememberVerification(agent.allowedPaths,before);
  }
  guard.assertActive(options.signal); const patch = await workspace.patch(options.signal);
  outputs.set(task.isolation!.patchArtifactId, patch); return outputs;
}
