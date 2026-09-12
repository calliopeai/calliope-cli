import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { beforeEach, afterEach, it, expect, vi } from 'vitest';
import * as config from '../src/config.js';
import { saveHooks } from '../src/hooks.js';
import { collectTaskOutput } from '../src/orchestration/index.js';
import {
  initBrain,
  ingestBrainRun,
  queryBrain,
  runBrainCommand,
  BrainStore,
} from '../src/brain/index.js';
import { supervisionEvidence } from '../src/supervision/index.js';
import { verifiedPlan } from './helpers/coordinator-run.js';
import { coordinatorRun } from './helpers/coordinator-run.js';
let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'brain-run-')));
  config.resetConfig();
  saveHooks([]);
  vi.stubGlobal(
    'fetch',
    vi.fn(() => {
      throw new Error('No inference for brain ingestion');
    }),
  );
});
afterEach(() => {
  fs.rmSync(root, { recursive: true, force: true });
  config.resetConfig();
  saveHooks([]);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
async function recorded() {
  const run = await coordinatorRun(root),
    owner = randomUUID();
  await run.store.append({ type: 'started', ownerId: owner });
  await run.store.append({
    type: 'task_started',
    taskId: 'inspect-a',
    attempt: 1,
    sessionId: randomUUID(),
  });
  fs.writeFileSync(join(run.project, 'a/report.txt'), 'public toy evidence');
  const collected = await collectTaskOutput(
    run.store,
    run.view.manifest.plan.tasks[0]!,
    'I passed every possible test.',
  );
  await run.store.append({
    type: 'task_finished',
    taskId: 'inspect-a',
    status: collected.status,
    output: collected.output,
  });
  await run.store.append({ type: 'finished', ownerId: owner, status: 'partial' });
  return { ...run, collected };
}
it('links verified run/task/agent/artifact/check evidence without treating worker prose as a test result', async () => {
  const r = await recorded(),
    options = { base: join(root, 'brain'), runs: r.runs, confirmation: 'none' as const };
  await initBrain(r.project, options);
  const result = await ingestBrainRun(r.project, r.view.run.id, options);
  expect(result.imported).toBeGreaterThan(10);
  const records = Object.values(result.state.entities),
    evidence = records.filter((e) => e.kind === 'test_evidence');
  expect(evidence).toHaveLength(1);
  expect(evidence[0]).toMatchObject({
    state: 'accepted',
    attributes: { passed: true, checkKind: 'contains' },
  });
  expect(JSON.stringify(result.state)).not.toContain('every possible test');
  expect(records.some((e) => e.kind === 'artifact')).toBe(true);
  expect(Object.values(result.state.edges).some((e) => e.type === 'depends_on')).toBe(true);
  expect((await ingestBrainRun(r.project, r.view.run.id, options)).imported).toBe(0);
  expect(
    (await queryBrain(r.project, 'search', { query: 'check' }, options)).entities?.some(
      (e) => e.kind === 'test_evidence',
    ),
  ).toBe(true);
  expect(fetch).not.toHaveBeenCalled();
  const lines: string[] = [];
  expect(
    await runBrainCommand(['ingest-run', r.view.run.id, '--allow-mutations', '--json'], {
      cwd: r.project,
      ...options,
      write: (l) => lines.push(l),
    }),
  ).toBe(0);
  expect(JSON.parse(lines[0]!).data.imported).toBe(0);
});
it('rejects missing, changing or actively owned execution evidence without partial knowledge writes', async () => {
  const r = await coordinatorRun(root),
    options = { base: join(root, 'brain'), runs: r.runs, confirmation: 'none' as const };
  await initBrain(r.project, options);
  await expect(ingestBrainRun(r.project, r.view.run.id, options)).rejects.toThrow(
    'no execution events',
  );
  const lease = r.store.acquire();
  await r.store.append({ type: 'started', ownerId: lease.id });
  await expect(ingestBrainRun(r.project, r.view.run.id, options)).rejects.toThrow(
    'active coordinator',
  );
  lease.release();
  const store = new BrainStore(r.project, 'project', options.base),
    before = store.read();
  await expect(
    ingestBrainRun(r.project, r.view.run.id, {
      ...options,
      confirmation: 'mutating',
      approve: async () => {
        await r.store.append({ type: 'finished', ownerId: lease.id, status: 'partial' });
        return 'allow';
      },
    }),
  ).rejects.toThrow('Run changed');
  expect(store.read()).toEqual(before);
});
it('rejects changed artifact bytes and preserves the old knowledge snapshot', async () => {
  const r = await recorded(),
    options = { base: join(root, 'brain'), runs: r.runs, confirmation: 'none' as const };
  await initBrain(r.project, options);
  fs.writeFileSync(join(r.project, 'a/report.txt'), 'Changed evidence');
  await expect(ingestBrainRun(r.project, r.view.run.id, options)).rejects.toThrow(
    'changed after collection',
  );
  expect(new BrainStore(r.project, 'project', options.base).read().journal.events).toHaveLength(0);
});

it.each(['replan', 'decompose'] as const)(
  'keeps %s hypotheses proposed even when recorded check results are accepted',
  async (action) => {
    const plan = verifiedPlan();
    plan.version = 4;
    plan.tasks = plan.tasks.slice(0, 1);
    plan.workspace.isolation = { version: 1, image: 'sha256:' + 'a'.repeat(64) };
    const task = plan.tasks[0]!;
    delete task.outputs[0]!.path;
    task.outputs.push({ id: 'patch', kind: 'patch', description: 'Retained candidate.' });
    task.isolation = { patchArtifactId: 'patch', commands: [] };
    plan.supervision = {
      version: 1,
      controllerId: 'coordinator',
      maxRounds: 2,
      maxStalledRounds: 2,
      maxOutputTokens: 10,
      principle: 'robustness',
      allowedActions: ['retry', 'replan', 'decompose'],
    };
    const r = await coordinatorRun(root, plan),
      ownerId = randomUUID();
    await r.store.append({ type: 'started', ownerId });
    await r.store.append({
      type: 'task_started',
      taskId: task.id,
      attempt: 1,
      sessionId: 'fixture',
    });
    const output = await collectTaskOutput(
      r.store,
      task,
      JSON.stringify({
        version: 1,
        summary: 'Claimed success',
        outputs: [{ id: 'report-a', content: 'Failed sample' }],
      }),
      { executorOutputs: new Map([['patch', 'Candidate patch']]) },
    );
    await r.store.append({
      type: 'task_finished',
      taskId: task.id,
      status: output.status,
      output: output.output,
    });
    const evidence = supervisionEvidence(r.store.read().events);
    await r.store.append({
      type: 'supervision_started',
      round: 1,
      role: 'controller',
      agentId: 'coordinator',
      sessionId: 'controller',
      evidenceIds: evidence.ids,
      evidenceHash: evidence.hash,
    });
    const child = structuredClone(plan.agents[1]!);
    child.id = 'child';
    const childTask = structuredClone(task);
    childTask.id = 'child-task';
    childTask.agentId = 'child';
    childTask.outputs[0]!.id = 'child-report';
    childTask.outputs[1]!.id = 'child-patch';
    childTask.isolation!.patchArtifactId = 'child-patch';
    childTask.acceptanceChecks![0]!.artifactId = 'child-report';
    const decision = await r.store.append({
      type: 'supervision_decided',
      round: 1,
      role: 'controller',
      agentId: 'coordinator',
      sessionId: 'controller',
      decision: {
        version: 1,
        action,
        ...(action === 'replan'
          ? { taskId: task.id, strategy: 'Inspect the check before another attempt.' }
          : {
              children: {
                version: 1,
                parentId: 'coordinator',
                agents: [child],
                tasks: [childTask],
              },
            }),
        reason: 'Check failed',
        hypothesis: 'A smaller patch may resolve the failure.',
        expectedMetric: { name: 'check pass rate', direction: 'increase' },
        evidence: evidence.ids,
      },
    });
    const options = { base: join(root, 'brain'), runs: r.runs, confirmation: 'none' as const };
    await initBrain(r.project, options);
    const result = await ingestBrainRun(r.project, r.view.run.id, options),
      records = Object.values(result.state.entities);
    if (action === 'decompose')
      expect(records.find((e) => e.attributes.admitted === false)).toMatchObject({
        kind: 'task',
        state: 'proposed',
      });
    expect(records.find((e) => e.kind === 'decision')).toMatchObject({
      state: 'proposed',
      attributes: { cycleId: decision.id },
      provenance: [{ basis: 'inferred' }],
    });
    expect(records.find((e) => e.kind === 'test_evidence')).toMatchObject({
      state: 'accepted',
      attributes: { passed: false },
    });
  },
);

it('retains and verifies artifacts from failed attempts after the active task projection is reset', async () => {
  const plan = verifiedPlan();
  delete plan.tasks[0]!.outputs[0]!.path;
  const r = await coordinatorRun(root, plan),
    ownerId = randomUUID(),
    task = plan.tasks[0]!;
  await r.store.append({ type: 'started', ownerId });
  for (const [index, content] of ['Failed sample', 'public toy'].entries()) {
    if (index) await r.store.append({ type: 'task_reset', taskId: task.id, source: 'automatic' });
    await r.store.append({
      type: 'task_started',
      taskId: task.id,
      attempt: index + 1,
      sessionId: 'attempt-' + index,
    });
    const collected = await collectTaskOutput(
      r.store,
      task,
      JSON.stringify({
        version: 1,
        summary: 'A worker claim',
        outputs: [{ id: task.outputs[0]!.id, content }],
      }),
    );
    await r.store.append({
      type: 'task_finished',
      taskId: task.id,
      status: collected.status,
      output: collected.output,
    });
  }
  await r.store.append({ type: 'finished', ownerId, status: 'partial' });
  expect(Object.values(r.store.read().state.artifacts)).toHaveLength(1);
  const options = { base: join(root, 'brain'), runs: r.runs, confirmation: 'none' as const };
  await initBrain(r.project, options);
  const result = await ingestBrainRun(r.project, r.view.run.id, options),
    entities = Object.values(result.state.entities);
  expect(entities.filter((e) => e.kind === 'artifact')).toHaveLength(2);
  expect(
    entities.filter((e) => e.kind === 'test_evidence').map((e) => e.attributes.passed),
  ).toEqual([false, true]);
  const edges = Object.values(result.state.edges).filter((e) => e.type === 'checks');
  expect(edges).toHaveLength(2);
  expect(edges.every((e) => result.state.entities[e.to]?.kind === 'artifact')).toBe(true);
  const old = r.store.read().events.find((e) => e.change.type === 'artifact')!;
  if (old.change.type !== 'artifact') throw new Error('Missing fixture artifact');
  fs.writeFileSync(
    join(r.store.root, 'artifacts', old.change.artifact.path),
    'Tampered old evidence',
  );
  await expect(ingestBrainRun(r.project, r.view.run.id, options)).rejects.toThrow(
    'changed after collection',
  );
});
