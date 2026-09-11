import { expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { analyzePlan, bindPlan, validateAgentOutput, MAX_PLAN_BYTES } from '../src/orchestration/index.js';
import { toyPlan } from './helpers/orchestration-plan.js';
it('validates the full agent contract, computes deterministic stages and keeps the caller plan separate', () => {
  const plan = toyPlan(), result = analyzePlan(plan);
  expect(result.stages).toEqual([['inspect-a','inspect-b'], ['verify']]); expect(result.conflicts).toEqual([]);
  expect(result.coordinatorId).toBe('coordinator'); expect(result.depths).toEqual({ coordinator: 0, a: 1, b: 1 });
  expect(analyzePlan(JSON.parse(JSON.stringify(plan))).hash).toBe(result.hash);
  plan.goal = 'Changed later'; expect(result.plan.goal).not.toBe(plan.goal);
  result.plan.tasks.reverse(); expect(analyzePlan(result.plan).stages).toEqual(result.stages);
});
it.each([
  ['version', (p: any) => { p.version = 2; }], ['extra fields', (p: any) => { p.agents[1].unbounded = true; }],
  ['missing agent field', (p: any) => { delete p.agents[1].acceptanceCriteria; }], ['invalid token budget', (p: any) => { p.agents[1].tokenBudget = 0; }],
  ['invalid cost', (p: any) => { p.agents[1].costBudgetUsd = -1; }], ['unbounded time', (p: any) => { p.agents[1].timeBudgetMs = Infinity; }],
  ['unknown provider', (p: any) => { p.agents[1].preference.provider = 'unknown-provider'; }], ['raw credential', (p: any) => { p.goal = 'TOKEN=synthetic-secret'; }],
  ['terminal control', (p: any) => { p.goal = '\x1b[2J'; }], ['duplicate agent', (p: any) => { p.agents.push(p.agents[1]); }],
  ['second root', (p: any) => { p.agents[1].parentId = null; }], ['missing parent', (p: any) => { p.agents[1].parentId = 'missing'; }],
  ['hierarchy cycle', (p: any) => { p.agents[1].parentId = 'b'; p.agents[2].parentId = 'a'; }],
  ['count overflow', (p: any) => { p.agents[0].maxChildCount = 1; }], ['depth overflow', (p: any) => { p.limits.maxDepth = 0; }],
  ['child delegation escalation', (p: any) => { p.agents[1].maxChildDepth = 2; }], ['child retry escalation', (p: any) => { p.agents[1].escalationPolicy.maxRetries = 2; }],
  ['child tool escalation', (p: any) => { p.agents[1].allowedTools.push('shell'); }], ['child path escalation', (p: any) => { p.workspace.allowedPaths = [{path:'a',access:'read'}]; }],
  ['aggregate budget overflow', (p: any) => { p.agents[1].tokenBudget = 3000; p.agents[2].tokenBudget = 3000; }],
  ['task cycle', (p: any) => { p.tasks[0].dependencies = ['verify']; }], ['missing task', (p: any) => { p.tasks[0].dependencies = ['missing']; }],
  ['duplicate task', (p: any) => { p.tasks.push(p.tasks[0]); }], ['missing worker', (p: any) => { p.tasks[0].agentId = 'missing'; }],
  ['artifact without dependency', (p: any) => { p.tasks[2].dependencies = []; }], ['duplicate artifact', (p: any) => { p.tasks[1].outputs[0].id = 'report-a'; }],
  ['undeclared artifact', (p: any) => { p.tasks[2].inputs[0].value = 'missing'; }], ['output beyond authority', (p: any) => { p.tasks[0].outputs[0].path = 'b/report.txt'; }],
  ['path traversal', (p: any) => { p.agents[1].allowedPaths[0].path = '../outside'; }], ['glob', (p: any) => { p.agents[1].allowedPaths[0].path = 'a/**'; }],
  ['empty evidence specification', (p: any) => { p.tasks[0].outputs = []; }], ['excessive concurrency', (p: any) => { p.limits.maxConcurrent = 17; }],
] as const)('rejects %s before preparing a run', (_label, mutate) => { const plan = toyPlan(); mutate(plan); expect(() => analyzePlan(plan)).toThrow(); });
it('identifies write/read conflicts and does not claim dependency stages are safe parallel batches', () => {
  const plan = toyPlan(); plan.agents[2]!.allowedPaths = [{ path: 'a', access: 'write' }]; plan.tasks[1]!.outputs[0]!.path = 'a/second.txt';
  const result = analyzePlan(plan); expect(result.stages[0]).toEqual(['inspect-a','inspect-b']);
  expect(result.conflicts).toEqual([{ tasks: ['inspect-a','inspect-b'], paths: ['a'] }]);
  plan.tasks[1]!.dependencies = ['inspect-a']; expect(analyzePlan(plan).conflicts).toEqual([]);
});
it('binds project identity and rejects current symlinks in grants, inputs or artifact paths', () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'calliope-plan-'))), outside = realpathSync(mkdtempSync(join(tmpdir(), 'calliope-plan-out-')));
  try {
    const plan = toyPlan(), first = bindPlan(analyzePlan(plan), root); expect(first.root).toBe(root); expect(first.key).toHaveLength(64);
    symlinkSync(outside, join(root,'a')); expect(() => bindPlan(analyzePlan(plan), root)).toThrow(/alias|outside/);
    rmSync(join(root,'a')); mkdirSync(join(root,'a')); symlinkSync(outside, join(root,'a','data'));
    plan.tasks[0]!.inputs = [{ id: 'source', kind: 'file', value: 'a/data/source.txt' }]; expect(() => bindPlan(analyzePlan(plan), root)).toThrow(/alias|outside/);
  } finally { rmSync(root, {recursive:true,force:true}); rmSync(outside, {recursive:true,force:true}); }
});
it('rejects oversized, deeply nested and non-JSON plans without including their payload in errors', () => {
  const plan = toyPlan(); plan.goal = 'x'.repeat(MAX_PLAN_BYTES + 1); expect(() => analyzePlan(plan)).toThrow(/2 MiB/);
  let deep: unknown = null; for (let i = 0; i < 100; i++) deep = { deep }; expect(() => analyzePlan(deep)).toThrow(/bounded plain JSON/);
  expect(() => analyzePlan(new Date())).toThrow(/plain JSON/); expect(() => analyzePlan(null)).toThrow(/schema/);
});
it('requires declared artifact ownership, provenance and evidence references without treating them as verified files', () => {
  const analysis = analyzePlan(toyPlan()), runId = randomUUID();
  const output = { version: 1, agentId: 'coordinator', taskId: 'verify', status: 'success', summary: 'Checks reported.', changedFiles: ['verification.json'],
    artifacts: [{ id: 'verification', agentId: 'coordinator', taskId: 'verify', kind: 'test_result', path: 'verification.json', sha256: 'a'.repeat(64), createdAt: new Date().toISOString(), source: { runId, eventId: randomUUID() }, confidence: 0.8 }],
    testEvidence: ['verification'], unresolvedRisks: [], recommendedNextAction: 'Independently verify the recorded artifact.' };
  expect(validateAgentOutput(output, analysis, runId)).toEqual(output);
  for (const mutate of [(v: any) => { v.agentId = 'a'; }, (v: any) => { v.artifacts = []; }, (v: any) => { v.artifacts[0].source.runId = randomUUID(); }, (v: any) => { v.artifacts[0].sha256 = 'invalid'; }, (v: any) => { v.testEvidence = ['missing']; }, (v: any) => { v.artifacts[0].confidence = 2; }, (v: any) => { v.changedFiles = ['../outside']; }]) {
    const invalid = structuredClone(output); mutate(invalid); expect(() => validateAgentOutput(invalid, analysis, runId)).toThrow();
  }
});
it('rejects undefined values instead of silently deleting unknown fields from an in-memory plan', () => {
  const plan = {...toyPlan(), ignored:undefined}; expect(()=>analyzePlan(plan)).toThrow(/undefined/);
});
it('validates the documented plan and requires existing regular file inputs', async () => {
  const {readFileSync,writeFileSync} = await import('node:fs');
  const source=readFileSync(new URL('../docs/orchestration.md',import.meta.url),'utf8');
  const plan=JSON.parse(/```json\n([\s\S]*?)\n```/.exec(source)![1]!); const analysis=analyzePlan(plan);
  const root=realpathSync(mkdtempSync(join(tmpdir(),'calliope-doc-plan-')));
  try { expect(()=>bindPlan(analysis,root)).toThrow(/existing regular/); mkdirSync(join(root,'src')); writeFileSync(join(root,'src','index.ts'),'// public toy source'); expect(bindPlan(analysis,root).root).toBe(root); }
  finally {rmSync(root,{recursive:true,force:true});}
});
