import { resolve, relative, isAbsolute } from 'node:path';
import { statSync } from 'node:fs';
import { getProviderNames } from '../config.js';
import { canonicalJson, canonicalPath, digest, approvalDisplayText, projectIdentity } from '../approvals/index.js';
import { OrchestrationError, type AgentContract, type AgentInput, type AgentOutput, type ArtifactSpec, type PathGrant, type PlanAnalysis, type ProjectPlan } from './types.js';
import {validateIsolation,validateTaskIsolation} from '../isolation/contracts.js';

export const MAX_PLAN_BYTES = 2 * 1024 * 1024;
export const MAX_AGENTS = 256, MAX_TASKS = 1024, MAX_DEPTH = 8;
export function fail(message: string): never { throw new OrchestrationError('invalid', message); }
export const obj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const uuid = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/.test(v);
export const hex = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{64}$/.test(v);
export const iso = (v: unknown): v is string => typeof v === 'string' && v.length === 24 && Number.isFinite(Date.parse(v)) && new Date(v).toISOString() === v;
export function shape(v: unknown, required: string[], optional: string[] = []): asserts v is Record<string, unknown> {
  if (!obj(v) || required.some(key => !Object.hasOwn(v, key)) || Object.keys(v).some(key => !required.includes(key) && !optional.includes(key))) fail('Invalid orchestration fields or schema version.');
}
export function text(v: unknown, max = 8192): asserts v is string {
  if (typeof v !== 'string' || !v.trim() || v.length > max || approvalDisplayText(v) !== v) fail('Invalid text: use bounded text without credentials or terminal controls.');
}
export function id(v: unknown): asserts v is string { if (typeof v !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v)) fail('IDs use 1–64 letters, numbers, underscores or hyphens.'); }
export function integer(v: unknown, min: number, max: number): asserts v is number { if (!Number.isSafeInteger(v) || Number(v) < min || Number(v) > max) fail('Invalid orchestration limit or budget.'); }
export function cost(v: unknown): asserts v is number { if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 10000) fail('Invalid dollar budget.'); }
export function array(v: unknown, max = 1024, min = 0): asserts v is unknown[] { if (!Array.isArray(v) || v.length < min || v.length > max) fail('Invalid orchestration collection size.'); }
export function strings(v: unknown, max = 100, min = 0): asserts v is string[] { array(v, max, min); v.forEach(item => text(item)); if (new Set(v).size !== v.length) fail('Duplicate collection entries.'); }
export function planJson(v: unknown): string {
  let raw: string; try { raw = canonicalJson(v); } catch { return fail('Plan must contain bounded plain JSON.'); }
  const pending = [v]; let nodes = 0;
  while (pending.length) { const item = pending.pop(); if (++nodes > 100000 || item === undefined) fail('Plan must contain bounded plain JSON without undefined values.'); if (Array.isArray(item)) pending.push(...item); else if (obj(item)) pending.push(...Object.values(item)); }
  if (Buffer.byteLength(raw) > MAX_PLAN_BYTES) throw new OrchestrationError('limit', 'Plan exceeds 2 MiB.');
  return raw;
}
export function pathName(v: unknown): asserts v is string {
  text(v, 1024);
  if (isAbsolute(v) || v.includes('\\') || /[\x00-\x1f\x7f:*?\[\]{}]/.test(v) || v !== '.' && v.split('/').some(part => !part || part === '.' || part === '..')) fail('Use normalized project-relative paths without traversal, aliases or globs.');
}
export const covers = (parent: string, child: string) => parent === '.' || parent === child || child.startsWith(parent + '/');
export const permits = (grants: PathGrant[], path: string, access: 'read' | 'write') => grants.some(grant => covers(grant.path, path) && (access === 'read' || grant.access === 'write'));
function paths(v: unknown): asserts v is PathGrant[] {
  array(v, 256); const seen = new Set<string>();
  for (const value of v) { shape(value, ['path', 'access']); pathName(value.path); if (!['read','write'].includes(String(value.access)) || seen.has(value.path)) fail('Invalid or duplicate path grant.'); seen.add(value.path); }
}
function tools(v: unknown): asserts v is string[] { strings(v, 256); if (v.some(name => !/^[a-zA-Z0-9_.:-]{1,128}$/.test(name))) fail('Invalid tool name.'); }
function inputs(v: unknown): asserts v is AgentInput[] {
  array(v, 100); const seen = new Set<string>();
  for (const input of v) { shape(input, ['id', 'kind', 'value']); id(input.id); text(input.value); if (!['text','file','artifact'].includes(String(input.kind)) || seen.has(input.id)) fail('Invalid or duplicate input.'); seen.add(input.id); if (input.kind === 'file') pathName(input.value); if (input.kind === 'artifact') id(input.value); }
}
function artifact(v: unknown): asserts v is ArtifactSpec {
  shape(v, ['id','kind','description'], ['path']); id(v.id); text(v.description);
  if (!['file','patch','report','test_result','decision','evidence'].includes(String(v.kind))) fail('Invalid artifact kind.');
  if (v.path !== undefined) pathName(v.path);
  if (v.kind === 'file' && v.path === undefined) fail('File artifacts require a project-relative path.');
}
function agent(v: unknown): asserts v is AgentContract {
  shape(v, ['id','parentId','role','objective','inputs','allowedTools','allowedPaths','preference','tokenBudget','costBudgetUsd','timeBudgetMs','maxChildDepth','maxChildCount','acceptanceCriteria','escalationPolicy']);
  id(v.id); if (v.parentId !== null) id(v.parentId); text(v.role, 128); text(v.objective); inputs(v.inputs); tools(v.allowedTools); paths(v.allowedPaths);
  shape(v.preference, ['provider'], ['model']); if (v.preference.provider !== 'auto' && !getProviderNames().includes(v.preference.provider as never)) fail('Unknown provider preference.');
  if (v.preference.model !== undefined) text(v.preference.model, 256);
  integer(v.tokenBudget, 1, 100000000); cost(v.costBudgetUsd); integer(v.timeBudgetMs, 1, 86400000);
  integer(v.maxChildDepth, 0, MAX_DEPTH); integer(v.maxChildCount, 0, MAX_AGENTS - 1); strings(v.acceptanceCriteria, 100, 1);
  shape(v.escalationPolicy, ['onFailure','maxRetries']); if (!['stop','parent','human'].includes(String(v.escalationPolicy.onFailure))) fail('Invalid escalation policy.'); integer(v.escalationPolicy.maxRetries, 0, 3);
  if (v.parentId === null && v.escalationPolicy.onFailure === 'parent') fail('The coordinator has no parent for escalation.');
}

/** Pure validation: no model lookup, process creation, file writes or execution. */
export function analyzePlan(value: unknown): PlanAnalysis {
  const raw = planJson(value); const v: unknown = JSON.parse(raw);
  shape(v, ['version','id','goal','workspace','limits','agents','tasks']); if (![1,2,3].includes(v.version as number)) fail('Unsupported plan version.'); id(v.id); text(v.goal);
  shape(v.workspace, ['id','root','allowedTools','allowedPaths',...(v.version===3?['isolation']:[])]); id(v.workspace.id); if (v.workspace.root !== '.') fail('Workspace root must be the current project (.).'); tools(v.workspace.allowedTools); paths(v.workspace.allowedPaths);
  if(v.version===3)validateIsolation(v.workspace.isolation);
  shape(v.limits, ['maxAgents','maxTasks','maxDepth','maxConcurrent','tokenBudget','costBudgetUsd','timeBudgetMs']);
  integer(v.limits.maxAgents, 1, MAX_AGENTS); integer(v.limits.maxTasks, 1, MAX_TASKS); integer(v.limits.maxDepth, 0, MAX_DEPTH); integer(v.limits.maxConcurrent, 1, 16);
  integer(v.limits.tokenBudget, 1, 100000000); cost(v.limits.costBudgetUsd); integer(v.limits.timeBudgetMs, 1, 86400000);
  array(v.agents, v.limits.maxAgents, 1); array(v.tasks, v.limits.maxTasks, 1);
  const agents = new Map<string, AgentContract>();
  for (const item of v.agents) { agent(item); if (agents.has(item.id)) fail('Duplicate agent ID.'); agents.set(item.id, item); }
  const plan = v as unknown as ProjectPlan, roots = plan.agents.filter(item => item.parentId === null);
  if (roots.length !== 1) fail('A plan requires exactly one root coordinator.');
  const depths: Record<string, number> = Object.create(null);
  for (const item of plan.agents) {
    let current = item, depth = 0; const visited = new Set<string>();
    while (current.parentId !== null) {
      if (visited.has(current.id) || ++depth > plan.limits.maxDepth) fail('Agent hierarchy contains a cycle or exceeds depth limits.'); visited.add(current.id);
      const parent = agents.get(current.parentId); if (!parent) fail('Agent parent does not exist.'); current = parent;
    }
    depths[item.id] = depth;
    const parent = item.parentId ? agents.get(item.parentId)! : undefined;
    const authority = parent ?? plan.workspace;
    if (item.allowedTools.some(name => !authority.allowedTools.includes(name)) || item.allowedPaths.some(grant => !permits(authority.allowedPaths, grant.path, grant.access))) fail('Agent tools or paths exceed parent/workspace authority.');
    if (item.tokenBudget > (parent?.tokenBudget ?? plan.limits.tokenBudget) || item.costBudgetUsd > (parent?.costBudgetUsd ?? plan.limits.costBudgetUsd) || item.timeBudgetMs > (parent?.timeBudgetMs ?? plan.limits.timeBudgetMs)) fail('Agent budget exceeds its parent or run.');
    if (item.maxChildDepth > (parent ? parent.maxChildDepth - 1 : plan.limits.maxDepth) || parent && (item.maxChildCount > parent.maxChildCount || item.escalationPolicy.maxRetries > parent.escalationPolicy.maxRetries)) fail('Child delegation limits exceed parent authority.');
    const children = plan.agents.filter(child => child.parentId === item.id);
    if (children.length > item.maxChildCount || children.reduce((sum, child) => sum + child.tokenBudget, 0) > item.tokenBudget || children.reduce((sum, child) => sum + Math.round(child.costBudgetUsd * 1e9), 0) > Math.round(item.costBudgetUsd * 1e9)) fail('Direct children exceed the parent count or aggregate budget.');
    for (const input of item.inputs) if (input.kind === 'file' && !permits(item.allowedPaths, input.value, 'read')) fail('Agent input exceeds allowed paths.');
  }
  const tasks = new Map<string, ProjectPlan['tasks'][number]>(), producers = new Map<string, string>();
  for (const item of v.tasks) {
    shape(item, ['id','agentId','objective','inputs','outputs','dependencies','acceptanceCriteria',...(v.version!==1?['acceptanceChecks']:[]),...(v.version===3?['isolation']:[])]); id(item.id); id(item.agentId); text(item.objective); inputs(item.inputs); strings(item.dependencies, MAX_TASKS); item.dependencies.forEach(id); strings(item.acceptanceCriteria, 100, 1); array(item.outputs, 100, 1);
    if (tasks.has(item.id) || !agents.has(item.agentId)) fail('Duplicate task ID or missing assigned agent.');
    const owner = agents.get(item.agentId)!;
    for (const output of item.outputs) { artifact(output); if (producers.has(output.id)) fail('Artifact IDs must be unique across tasks.'); producers.set(output.id, item.id); if (output.path && !permits(owner.allowedPaths, output.path, 'write')) fail('Artifact output exceeds the agent write scope.'); }
    for (const input of item.inputs) if (input.kind === 'file' && !permits(owner.allowedPaths, input.value, 'read')) fail('Task input exceeds its agent scope.');
    if(v.version===3)validateTaskIsolation(item.isolation,item as unknown as ProjectPlan['tasks'][number],plan);
    if(v.version!==1) {
      array(item.acceptanceChecks,200);const checks=new Set<string>();
      for(const check of item.acceptanceChecks){
        shape(check,['id','artifactId','kind','criteria'],['expected']);id(check.id);id(check.artifactId);strings(check.criteria,200,1);
        if(checks.has(check.id)||!item.outputs.some(output=>obj(output)&&output.id===check.artifactId)||!['exists','contains','sha256','json',...(v.version===3?['command']:[])].includes(String(check.kind)))fail('Invalid acceptance check or artifact reference.');checks.add(check.id);
        for(const criterion of check.criteria){const match=/^(task|agent):(0|[1-9][0-9]?)$/.exec(criterion);if(!match||Number(match[2])>=(match[1]==='task'?item.acceptanceCriteria.length:owner.acceptanceCriteria.length))fail('Acceptance checks must reference declared task/agent criteria.');}
        if(check.kind==='exists'||check.kind==='command'){if(check.expected!==undefined)fail('Existence/command checks have no expected value.');if(check.kind==='command'&&!(item.isolation as ProjectPlan['tasks'][number]['isolation'])?.commands.some(c=>c.artifactId===check.artifactId))fail('Command checks require a declared executor result.');}
        else {text(check.expected);if(check.kind==='sha256'&&!hex(check.expected))fail('Expected SHA-256 is invalid.');if(check.kind==='json'){try{planJson(JSON.parse(check.expected));}catch{fail('Expected JSON must be bounded valid JSON.');}}}
      }
    }
    tasks.set(item.id, item as unknown as ProjectPlan['tasks'][number]);
    if(v.version===3){const task=item as unknown as ProjectPlan['tasks'][number];for(const command of task.isolation!.commands)if(!task.acceptanceChecks!.some(c=>c.kind==='command'&&c.artifactId===command.artifactId))fail('Every verification command requires an explicit command acceptance check.');}
  }
  for (const task of tasks.values()) if (task.dependencies.some(dep => !tasks.has(dep) || dep === task.id)) fail('Missing or self-referencing task dependency.');
  const remaining = new Set(tasks.keys()), completed = new Set<string>(), stages: string[][] = [];
  while (remaining.size) {
    const ready = [...remaining].filter(key => tasks.get(key)!.dependencies.every(dep => completed.has(dep))).sort();
    if (!ready.length) fail('Task dependency graph contains a cycle.');
    stages.push(ready); for (const key of ready) { remaining.delete(key); completed.add(key); }
  }
  const ancestry = new Map<string, Set<string>>();
  const ancestors = (taskId: string) => {
    const cached = ancestry.get(taskId); if (cached) return cached;
    const found = new Set<string>(), pending = [...tasks.get(taskId)!.dependencies];
    while (pending.length) { const next = pending.pop()!; if (found.has(next)) continue; found.add(next); pending.push(...tasks.get(next)!.dependencies); }
    ancestry.set(taskId, found); return found;
  };
  for (const task of tasks.values()) {
    const deps = ancestors(task.id);
    for (const input of [...task.inputs, ...agents.get(task.agentId)!.inputs]) if (input.kind === 'artifact' && (!producers.has(input.value) || !deps.has(producers.get(input.value)!))) fail('Artifact inputs require a producing dependency; summaries alone are not evidence.');
    for(const input of [...task.inputs,...agents.get(task.agentId)!.inputs])if(input.kind==='artifact'){
      const source=tasks.get(producers.get(input.value)!)!.outputs.find(o=>o.id===input.value)!;
      if(source.path&&!permits(agents.get(task.agentId)!.allowedPaths,source.path,'read'))fail('Artifact input exceeds the consuming agent read scope.');
    }
  }
  for (const item of plan.agents) if (item.inputs.some(input => input.kind === 'artifact' && (!producers.has(input.value) || !plan.tasks.some(task => task.agentId === item.id)))) fail('Agent artifact inputs require a declared producer and an assigned consuming task.');
  let comparisons = 0;
  const conflicts: PlanAnalysis['conflicts'] = [], sorted = [...tasks.values()].sort((a,b) => a.id.localeCompare(b.id));
  for (let i = 0; i < sorted.length; i++) for (let j = i + 1; j < sorted.length; j++) {
    const a = sorted[i]!, b = sorted[j]!; if (ancestors(a.id).has(b.id) || ancestors(b.id).has(a.id)) continue;
    const overlap = new Set<string>();
    for (const left of agents.get(a.agentId)!.allowedPaths) for (const right of agents.get(b.agentId)!.allowedPaths) {
      if (++comparisons > 2000000) throw new OrchestrationError('limit', 'Plan scope analysis exceeds two million comparisons; reduce scope entries or split the plan.');
      if ((left.access === 'write' || right.access === 'write') && (covers(left.path, right.path) || covers(right.path, left.path))) overlap.add(covers(left.path, right.path) ? right.path : left.path);
    }
    if (conflicts.length >= 10000) throw new OrchestrationError('limit', 'Plan exceeds 10,000 scope conflicts; narrow task authority or add dependencies.');
    if (overlap.size) conflicts.push({ tasks: [a.id,b.id], paths: [...overlap].sort() });
  }
  return { plan, hash: digest(raw), coordinatorId: roots[0]!.id, depths: { ...depths }, stages, conflicts };
}

/** Bind declared paths to today's filesystem; execution must recheck every access. */
export function bindPlan(analysis: PlanAnalysis, cwd: string): { root: string; key: string } {
  const { project: root, projectKey: key } = projectIdentity(cwd);
  const all = [...analysis.plan.workspace.allowedPaths.map(grant => grant.path), ...analysis.plan.agents.flatMap(agent => agent.allowedPaths.map(grant => grant.path))];
  all.push(...analysis.plan.agents.flatMap(agent => agent.inputs.filter(input => input.kind === 'file').map(input => input.value)), ...analysis.plan.tasks.flatMap(task => [...task.inputs.filter(input => input.kind === 'file').map(input => input.value), ...task.outputs.flatMap(output => output.path ? [output.path] : [])]));
  for (const path of new Set(all)) {
    const absolute = resolve(root, path), canonical = canonicalPath(absolute), rel = relative(root, canonical);
    if (canonical !== absolute || rel === '..' || rel.startsWith('../') || isAbsolute(rel)) fail('A declared path resolves through an alias or outside the canonical project.');
  }
  for (const input of [...analysis.plan.agents.flatMap(agent => agent.inputs), ...analysis.plan.tasks.flatMap(task => task.inputs)]) if (input.kind === 'file') {
    try { if (!statSync(resolve(root,input.value)).isFile()) fail('File inputs must be existing regular files; use artifact inputs for dependency outputs.'); }
    catch { fail('File inputs must be existing regular files; use artifact inputs for dependency outputs.'); }
  }
  return { root, key };
}

/** Validate declared evidence associations. Verifying file content is a separate execution gate. */
export function validateAgentOutput(value: unknown, analysis: PlanAnalysis, runId: string): AgentOutput {
  planJson(value); shape(value, ['version','agentId','taskId','status','summary','changedFiles','artifacts','testEvidence','unresolvedRisks','recommendedNextAction']);
  if (value.version !== 1 || !['success','partial','failed','cancelled','denied'].includes(String(value.status))) fail('Invalid agent output status or version.');
  const task = analysis.plan.tasks.find(task => task.id === value.taskId && task.agentId === value.agentId); if (!task) fail('Output does not belong to an assigned task.');
  const owner = analysis.plan.agents.find(agent => agent.id === task.agentId)!;
  text(value.summary); text(value.recommendedNextAction); strings(value.changedFiles, 256); strings(value.testEvidence, 100); strings(value.unresolvedRisks, 100); array(value.artifacts, 100);
  for (const path of value.changedFiles) { pathName(path); if (!permits(owner.allowedPaths, path, 'write')) fail('Changed file exceeds agent scope.'); }
  const ids = new Set<string>();
  for (const evidence of value.artifacts) {
    shape(evidence, ['id','taskId','agentId','kind','path','sha256','createdAt','source','confidence']);
    const spec = task.outputs.find(spec => spec.id === evidence.id); if (!spec || ids.has(spec.id) || spec.kind !== evidence.kind || evidence.taskId !== task.id || evidence.agentId !== owner.id) fail('Artifact provenance does not match the declared output.');
    ids.add(spec.id); pathName(evidence.path); if (spec.path && spec.path !== evidence.path || !permits(owner.allowedPaths, evidence.path, 'write')) fail('Artifact evidence path is outside its declaration.');
    shape(evidence.source, ['runId','eventId']); if (evidence.source.runId !== runId || !uuid(evidence.source.eventId) || !hex(evidence.sha256) || !iso(evidence.createdAt) || typeof evidence.confidence !== 'number' || !Number.isFinite(evidence.confidence) || evidence.confidence < 0 || evidence.confidence > 1) fail('Artifact requires source event, digest, timestamp and confidence.');
  }
  const artifacts = value.artifacts;
  if (value.testEvidence.some(ref => !ids.has(ref) || !artifacts.some(e => obj(e) && e.id === ref && ['test_result','evidence'].includes(String(e.kind))))) fail('Test evidence must reference a supplied evidence artifact.');
  if (value.status === 'success' && task.outputs.some(spec => !ids.has(spec.id))) fail('Successful output requires all declared artifacts; it still requires independent verification.');
  return JSON.parse(planJson(value)) as AgentOutput;
}
