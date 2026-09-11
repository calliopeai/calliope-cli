/** Bounded session-owned data; importing these files never runs their contents. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { throwIfCancelled } from '../cancellation.js';
import { validateToolOutputSnapshot } from './output.js';
import { readPrivateSessionFile, assertSessionDirectory, invalid, object, hash, validateMessages } from './format.js';

export interface ToolStateFile { path: string; content: string }
export const MAX_TOOL_STATE_BYTES = 16 * 1024 * 1024;
const allowed = /^(?:todos\.txt|active-todo\.json|tool-output\.json|ledger\.json|plans\/[a-zA-Z0-9_-]{1,150}\.json)$/;
const strings = (value: unknown) => Array.isArray(value) && value.every(item => typeof item === 'string');
const number = (value: unknown) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value));
function validateJsonFile(path: string, data: unknown): void {
  if (!object(data)) throw invalid();
  validateMessages([{ role: 'assistant', content: '', providerMetadata: data }]);
  if (path === 'tool-output.json') { validateToolOutputSnapshot(data);
  } else if (path === 'active-todo.json') {
    if (typeof data.todoId !== 'string' || !data.todoId || !date(data.setAt)) throw invalid();
  } else if (path.startsWith('plans/')) {
    if (typeof data.id !== 'string' || !/^[a-zA-Z0-9_-]{1,150}$/.test(data.id) || typeof data.title !== 'string' ||
      !date(data.createdAt) || !['draft', 'approved', 'in_progress', 'completed', 'cancelled'].includes(String(data.status)) ||
      !Array.isArray(data.phases) || data.phases.length > 10000 || !data.phases.every(phase => object(phase) &&
        typeof phase.name === 'string' && strings(phase.steps))) throw invalid();
  } else {
    const action = (value: unknown) => object(value) && typeof value.tool === 'string' && typeof value.args === 'string' &&
      ['ok', 'error', 'blocked'].includes(String(value.result)) && (value.errorSummary === undefined || typeof value.errorSummary === 'string');
    const entry = (value: unknown, partial = false) => object(value) &&
      ['iteration', 'timestamp', 'durationMs', 'cost'].every(key => partial && value[key] === undefined || number(value[key])) &&
      (partial && value.actions === undefined || Array.isArray(value.actions) && value.actions.every(action)) &&
      (partial && value.tokens === undefined || object(value.tokens) && number(value.tokens.input) && number(value.tokens.output)) &&
      (partial && value.outcome === undefined || ['success', 'error', 'partial', 'blocked', 'skipped'].includes(String(value.outcome)));
    if (data.version !== 1 || !number(data.iterationStart) || !Array.isArray(data.entries) || data.entries.length > 10000 ||
      !data.entries.every(value => entry(value)) || data.currentEntry !== null && !entry(data.currentEntry, true) ||
      !Array.isArray(data.failedApproaches) || data.failedApproaches.length > 10000 || !data.failedApproaches.every(value =>
        object(value) && typeof value.description === 'string' && typeof value.reason === 'string' && number(value.iteration) && strings(value.tools)) ||
      !Array.isArray(data.runs) || data.runs.length > 10000 || !data.runs.every(value => object(value) && typeof value.id === 'string' &&
        typeof value.prompt === 'string' && ['agent', 'loop', 'swarm', 'council', 'workflow'].includes(String(value.kind)) &&
        ['running', 'completed', 'cancelled', 'failed', 'interrupted', 'stopped'].includes(String(value.status)) &&
        number(value.startedAt) && number(value.updatedAt) && number(value.entryCountAtStart)) ||
      ['nextIterationNumber', 'totalEntryCount', 'totalTokenCount', 'totalCostUsd', 'totalDurationMs', 'totalFailureCount', 'totalFailedApproachCount']
        .some(key => data[key] !== undefined && !number(data[key]))) throw invalid();
  }
}
export function validateToolState(value: unknown): ToolStateFile[] {
  if (!Array.isArray(value) || value.length > 1000) throw invalid();
  const seen = new Set<string>(); let bytes = 0;
  for (const file of value) {
    if (!object(file) || Object.keys(file).length !== 2 || typeof file.path !== 'string' || !allowed.test(file.path) ||
      seen.has(file.path) || typeof file.content !== 'string') throw invalid();
    seen.add(file.path); bytes += Buffer.byteLength(file.content); if (bytes > MAX_TOOL_STATE_BYTES) throw invalid();
    if (file.path.endsWith('.json')) {
      try { validateJsonFile(file.path, JSON.parse(file.content)); } catch { throw invalid(); }
    }
  }
  return value as ToolStateFile[];
}

export function readToolState(dir: string): ToolStateFile[] {
  assertSessionDirectory(dir);
  const names = ['todos.txt', 'active-todo.json', 'ledger.json', 'tool-output.json'];
  const plans = join(dir, 'plans');
  if (fs.existsSync(plans)) {
    const stat = fs.lstatSync(plans); if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    const listing = fs.opendirSync(plans);
    try {
      let entry: fs.Dirent | null;
      while ((entry = listing.readSync())) {
        if (!entry.isFile() || !allowed.test(`plans/${entry.name}`) || names.length >= 1000) throw invalid();
        names.push(`plans/${entry.name}`);
      }
    } finally { listing.closeSync(); }
  }
  const files: ToolStateFile[] = []; let bytes = 0;
  for (const name of names.sort()) {
    const content = readPrivateSessionFile(join(dir, ...name.split('/')), MAX_TOOL_STATE_BYTES - bytes);
    if (content !== null) { bytes += Buffer.byteLength(content); files.push({ path: name, content }); }
  }
  return validateToolState(files);
}

/** Only used for a fresh, inactive destination; initial empty files may be replaced. */
export function installToolState(dir: string, files: ToolStateFile[], signal?: AbortSignal): void {
  assertSessionDirectory(dir); validateToolState(files);
  const identity = fs.statSync(dir);
  for (const file of files) {
    throwIfCancelled(signal);
    const target = join(dir, ...file.path.split('/'));
    const parent = file.path.startsWith('plans/') ? join(dir, 'plans') : dir;
    const stat = fs.lstatSync(parent);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw invalid();
    const before = readPrivateSessionFile(target, MAX_TOOL_STATE_BYTES);
    if (before !== null && before !== '') throw invalid();
    const temp = join(parent, `.state-${randomUUID()}.tmp`);
    try {
      const fd = fs.openSync(temp, 'wx', 0o600);
      try { fs.writeFileSync(fd, file.content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      throwIfCancelled(signal);
      const current = fs.lstatSync(dir), currentParent = fs.lstatSync(parent);
      if (current.isSymbolicLink() || current.dev !== identity.dev || current.ino !== identity.ino ||
        currentParent.isSymbolicLink() || currentParent.dev !== stat.dev || currentParent.ino !== stat.ino ||
        readPrivateSessionFile(target, MAX_TOOL_STATE_BYTES) !== before) throw invalid();
      fs.renameSync(temp, target);
    } finally {
      try {
        const current = fs.lstatSync(dir), currentParent = fs.lstatSync(parent);
        if (!current.isSymbolicLink() && current.dev === identity.dev && current.ino === identity.ino &&
          !currentParent.isSymbolicLink() && currentParent.dev === stat.dev && currentParent.ino === stat.ino) fs.unlinkSync(temp);
      } catch { /* Own temporary file was committed, or parent was replaced. */ }
    }
  }
}

export const toolStateHash = (files: ToolStateFile[]): string => hash(JSON.stringify(validateToolState(files)));
