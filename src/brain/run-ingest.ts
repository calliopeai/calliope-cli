import { canonicalJson, digest } from '../approvals/index.js';
import { authorizeSessionAction } from '../session-management/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { inspectExecution } from '../orchestration/coordinator-actions.js';
import { readCollectedArtifact, checkArtifactSnapshot } from '../orchestration/verification.js';
import type { RunStore } from '../orchestration/store.js';
import { projectImprovementHistory } from '../improvement/projection.js';
import { brainStore, sanitizeBrainText, type BrainOptions } from './access.js';
import { commitBrain } from './actions.js';
import { recordInput } from './journal.js';
import {
  BrainError,
  BRAIN_LIMITS,
  type BrainChange,
  type EntityInput,
  type EdgeInput,
  type SourceInput,
} from './types.js';
export interface BrainRunOptions extends BrainOptions {
  runs?: RunStore;
}
/** Ingest verified metadata and executor checks. Worker prose never establishes a passed test. */
export async function ingestBrainRun(cwd: string, runId: string, options: BrainRunOptions = {}) {
  await authorizeSessionAction(
    cwd,
    'read_file',
    { path: cwd, operation: 'brain-ingest-run', runId },
    options,
  );
  const current = await inspectExecution(cwd, runId, { ...options, store: options.runs });
  if (!current.execution?.events.length)
    throw new BrainError('unavailable', 'Run has no execution events to cite.');
  if (current.owner?.alive)
    throw new BrainError(
      'conflict',
      'Stop the active coordinator before ingesting a stable run snapshot.',
    );
  const execution = current.execution,
    context = current.store.context(execution),
    prior = brainStore(cwd, options).read(options.signal),
    changes: BrainChange[] = [],
    entities = new Map<string, EntityInput>(),
    edges: EdgeInput[] = [],
    sources = new Map<string, SourceInput>();
  let total = 0;
  const key = (kind: string, id: string) =>
      'run:' + digest(runId + ':' + execution.state.revision + ':' + kind + ':' + id),
    event = execution.events.at(-1)!,
    root = key('run', runId);
  const evidence = (id: string, data: unknown, eventId = event.id, path?: string) => {
    const original = canonicalJson(data),
      content = sanitizeBrainText(original),
      sourceId = key('source', id);
    if (Buffer.byteLength(content) > BRAIN_LIMITS.contentBytes)
      throw new BrainError('limit', 'Run metadata exceeds one knowledge source.');
    sources.set(sourceId, {
      id: sourceId,
      kind: 'run',
      name: sanitizeBrainText('Run evidence ' + id),
      content,
      originalHash: digest(original),
      contentHash: digest(content),
      redacted: original !== content,
      locator: {
        runId,
        eventId,
        projectKey: current.view.manifest.project.key,
        ...(path ? { path } : {}),
      },
    });
    return [{ sourceId, basis: 'observed' as const }];
  };
  const add = (
    id: string,
    kind: EntityInput['kind'],
    name: string,
    summary: string,
    provenance: EntityInput['provenance'],
    attributes: EntityInput['attributes'] = {},
    proposed = false,
  ) => {
    entities.set(id, {
      id,
      kind,
      name: sanitizeBrainText(name),
      summary: sanitizeBrainText(summary),
      provenance,
      attributes,
      state: proposed ? 'proposed' : 'accepted',
      confidence: proposed ? 0.5 : 1,
    });
  };
  const link = (from: string, to: string, type: string, p: EntityInput['provenance']) =>
    edges.push({
      id: key('edge', from + ':' + type + ':' + to),
      from,
      to,
      type,
      state: p.some((p) => p.basis === 'inferred') ? 'proposed' : 'accepted',
      confidence: 1,
      provenance: p,
    });
  const runEvidence = evidence('run', {
    runId,
    manifestHash: current.view.manifest.hash,
    executionRevision: execution.state.revision,
    status: execution.state.status,
  });
  add(
    root,
    'run',
    runId + '@' + execution.state.revision.slice(0, 12),
    'Recorded execution snapshot; status is an executor observation.',
    runEvidence,
    { status: execution.state.status, runId, revision: execution.state.revision },
  );
  for (const agent of context.plan.agents) {
    throwIfCancelled(options.signal);
    const id = key('agent', agent.id),
      p = evidence('agent:' + agent.id, {
        id: agent.id,
        role: agent.role,
        parentId: agent.parentId,
        preference: agent.preference,
      });
    add(id, 'agent', agent.id, agent.role, p, { runId, agentId: agent.id });
    link(root, id, 'includes_agent', p);
    if (agent.parentId) link(id, key('agent', agent.parentId), 'reports_to', p);
  }
  for (const task of context.plan.tasks) {
    const id = key('task', task.id),
      p = evidence('task:' + task.id, {
        id: task.id,
        agentId: task.agentId,
        dependencies: task.dependencies,
        status: execution.state.tasks[task.id]!.status,
      });
    add(id, 'task', task.id, 'Recorded task assignment and executor status.', p, {
      runId,
      taskId: task.id,
      status: execution.state.tasks[task.id]!.status,
    });
    link(root, id, 'includes_task', p);
    link(id, key('agent', task.agentId), 'assigned_to', p);
    for (const dependency of task.dependencies) link(id, key('task', dependency), 'depends_on', p);
  }
  for (const artifact of Object.values(execution.state.artifacts)) {
    throwIfCancelled(options.signal);
    total += artifact.bytes;
    if (total > 64 * 1024 * 1024)
      throw new BrainError('limit', 'Run evidence exceeds the 64 MiB ingestion bound.');
    await readCollectedArtifact(current.store, artifact, { ...options, store: options.runs });
    const path = context.plan.tasks
        .find((t) => t.id === artifact.taskId)!
        .outputs.find((o) => o.id === artifact.id)!.path,
      id = key('artifact', artifact.source.eventId),
      p = evidence('artifact:' + artifact.source.eventId, artifact, artifact.source.eventId, path);
    add(
      id,
      'artifact',
      artifact.id,
      'Artifact hash and size verified against retained bytes; its prose is not a test result.',
      p,
      { runId, sha256: artifact.sha256, bytes: artifact.bytes },
    );
    link(key('task', artifact.taskId), id, 'produced', p);
  }
  for (const entry of execution.events)
    if (entry.change.type === 'task_finished') {
      const c = entry.change;
      for (const check of c.output.checks) {
        const artifact = c.output.artifacts.find((a) => a.id === check.artifactId);
        if (artifact)
          await readCollectedArtifact(current.store, artifact, { ...options, store: options.runs });
        const path = context.plan.tasks
            .find((t) => t.id === c.taskId)!
            .outputs.find((o) => o.id === check.artifactId)?.path,
          p = evidence(
            'check:' + entry.id + ':' + check.id,
            { taskId: c.taskId, check, eventHash: entry.hash },
            entry.id,
            path,
          ),
          id = key('check', entry.id + ':' + check.id);
        add(
          id,
          'test_evidence',
          c.taskId + ':' + check.id,
          `Recorded ${check.kind} check ${check.passed ? 'passed' : 'failed'}.`,
          p,
          {
            runId,
            passed: check.passed,
            checkKind: check.kind,
            observedHash: check.observedHash,
            eventId: entry.id,
          },
        );
        link(key('task', c.taskId), id, 'checked_by', p);
        if (artifact) link(id, key('artifact', artifact.source.eventId), 'checks', p);
      }
    }
  // Reuse the supervisor's evidence projection, which excludes unreviewed controller drafts.
  const improvement = projectImprovementHistory(current.view.manifest, execution, context);
  for (const cycle of improvement.cycles) {
    const id = key('decision', cycle.id),
      p = evidence(
        'decision:' + cycle.id,
        {
          decision: cycle.proposedChange,
          status: cycle.status,
          metrics: cycle.metrics,
          source: cycle.source,
        },
        cycle.id,
      ).map((p) => ({ ...p, basis: 'inferred' as const }));
    add(
      id,
      'decision',
      'Improvement ' + cycle.id,
      cycle.hypothesis.text,
      p,
      { runId, cycleId: cycle.id, observedCycleStatus: cycle.status },
      true,
    );
    link(root, id, 'proposes', p);
    for (const taskId of cycle.targetTaskIds) {
      const taskKey = key('task', taskId);
      if (!entities.has(taskKey))
        add(
          taskKey,
          'task',
          taskId,
          'Proposed child task; it has not been admitted to execution.',
          p,
          { runId, taskId, admitted: false },
          true,
        );
      link(id, taskKey, 'targets', p);
    }
    if (cycle.parentCycleId) link(id, key('decision', cycle.parentCycleId), 'refines', p);
  }
  for (const value of sources.values()) {
    const old = prior.state.sources[value.id];
    if (old && canonicalJson(recordInput(old)) !== canonicalJson(value))
      throw new BrainError('conflict', 'Run source conflicts with retained evidence.');
    if (!old) changes.push({ kind: 'source', value });
  }
  for (const [kind, values] of [
    ['entity', [...entities.values()]],
    ['edge', edges],
  ] as const)
    for (const value of values) {
      const old = kind === 'entity' ? prior.state.entities[value.id] : prior.state.edges[value.id];
      if (old) {
        if (canonicalJson(recordInput(old)) !== canonicalJson(value))
          throw new BrainError(
            'conflict',
            'Run snapshot conflicts with a local knowledge correction.',
          );
      } else
        changes.push({
          kind,
          id: value.id,
          expected: prior.state.revisions[kind + ':' + value.id] ?? null,
          value,
        } as BrainChange);
    }
  if (!changes.length)
    return { ...prior, index: 'unchanged' as const, runId, entityId: root, imported: 0 };
  const check = () => {
    if (current.store.read().state.revision !== execution.state.revision)
      throw new BrainError(
        'conflict',
        'Run changed during brain review; ingest its current snapshot.',
      );
    for (const artifact of Object.values(execution.state.artifacts))
      checkArtifactSnapshot(current.store, artifact);
  };
  return {
    ...(await commitBrain(
      cwd,
      changes,
      'run',
      'Recorded run metadata and executor evidence; improvement hypotheses remain proposals.',
      prior,
      options,
      check,
    )),
    runId,
    entityId: root,
    imported: changes.length,
  };
}
