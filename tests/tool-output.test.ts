import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.js';
import * as storage from '../src/storage.js';
import { makeToolOutput, saveToolOutput, readToolOutputs, validateToolOutputSnapshot, MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUT_CHARS, MAX_TOOL_OUTPUTS, hash } from '../src/sessions/index.js';
import { branchSession, exportSession, importSession, sessionCommand } from '../src/session-management/index.js';
import { scopeManager } from '../src/scope.js';
import { ToolProgress } from '../src/ui/tool-progress.js';
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));
let root: string, dir: string, session: storage.Session;
beforeEach(() => {
  config.resetConfig(); root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-output-'))); scopeManager.reset(root);
  session = storage.createSession(root, { activate: false }); dir = storage.getSessionDirById(session.id)!;
  storage.saveSessionConversation(session.id, [{ role: 'user', content: 'toy' }], { expectedRevision: null, status: 'completed' });
});
afterEach(() => { config.resetConfig(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const record = (content = 'one\ntwo\nthree\nfour\nfive\nsix\nSEVENTH') => makeToolOutput('call', 'read_file', content, false);
it('retains inspectable output after restart with private files and redacted content', () => {
  const output = record('TOKEN=opaque-secret\n\x1b[2J\nSEVENTH'); saveToolOutput(dir, output);
  expect(readToolOutputs(dir).records).toEqual([output]); expect(output.content).not.toContain('opaque-secret'); expect(output.content).toContain('\\u001b[2J');
  expect(fs.statSync(join(dir, 'tool-output.json')).mode & 0o777).toBe(0o600);
  expect(() => saveToolOutput(dir, output)).toThrow(/already exists/); expect(readToolOutputs(dir).records).toEqual([output]);
});
it('bounds individual and aggregate output while keeping explicit truncation and eviction evidence', () => {
  const huge = record('x'.repeat(MAX_TOOL_OUTPUT_CHARS + 1)); expect(huge.truncated).toBe(true); expect(huge.content.length).toBe(MAX_TOOL_OUTPUT_CHARS);
  expect(huge.sourceChars).toBe(MAX_TOOL_OUTPUT_CHARS + 1);
  for (let index = 0; index <= MAX_TOOL_OUTPUTS; index++) saveToolOutput(dir, record(String(index)));
  const saved = readToolOutputs(dir); expect(saved.records).toHaveLength(MAX_TOOL_OUTPUTS); expect(saved.dropped).toBe(1); expect(saved.records[0]!.content).toBe('1');
  for (let index = 0; index < 65; index++) saveToolOutput(dir, record('x'.repeat(MAX_TOOL_OUTPUT_CHARS)));
  expect(fs.statSync(join(dir, 'tool-output.json')).size).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_BYTES); expect(readToolOutputs(dir).dropped).toBeGreaterThan(1);
});
it('preserves old records on cancellation, busy writers and interrupted commits', () => {
  saveToolOutput(dir, record()); const file = join(dir, 'tool-output.json'), before = fs.readFileSync(file, 'utf8');
  expect(() => saveToolOutput(dir, record(), AbortSignal.abort())).toThrow(/cancelled/);
  fs.writeFileSync(file + '.lock', 'another process'); expect(() => saveToolOutput(dir, record())).toThrow(/busy/); expect(fs.readFileSync(file + '.lock', 'utf8')).toBe('another process'); fs.unlinkSync(file + '.lock');
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk failure'); });
  expect(() => saveToolOutput(dir, record())).toThrow('disk failure'); expect(fs.readFileSync(file, 'utf8')).toBe(before);
  expect(fs.readdirSync(dir).some(name => name.endsWith('.tmp') || name.endsWith('.lock'))).toBe(false);
});
it('rejects malformed, forged, oversized or symlinked records without overwriting them', () => {
  saveToolOutput(dir, record()); const file = join(dir, 'tool-output.json'), original = readToolOutputs(dir);
  for (const raw of ['{', 'null', '{}', JSON.stringify({ ...original, checksum: 'bad' })]) {
    fs.writeFileSync(file, raw); expect(() => readToolOutputs(dir)).toThrow(); expect(() => saveToolOutput(dir, record())).toThrow(); expect(fs.readFileSync(file, 'utf8')).toBe(raw);
  }
  for (const mutate of [(r: any) => { r.tool = '../escape'; }, (r: any) => { r.content = 'changed'; }, (r: any) => { r.channel = 'thinking'; }, (r: any) => { r.extra = true; }]) {
    const value = structuredClone(original); mutate(value.records[0]); const { checksum: _, ...body } = value; value.checksum = hash(JSON.stringify(body)); expect(() => validateToolOutputSnapshot(value)).toThrow();
  }
  fs.unlinkSync(file); const outside = join(root, 'outside'); fs.writeFileSync(outside, 'outside'); fs.symlinkSync(outside, file);
  expect(() => saveToolOutput(dir, record())).toThrow(); expect(fs.readFileSync(outside, 'utf8')).toBe('outside');
  fs.unlinkSync(file); const fd = fs.openSync(file, 'w'); fs.ftruncateSync(fd, MAX_TOOL_OUTPUT_BYTES + 1); fs.closeSync(fd); expect(() => readToolOutputs(dir)).toThrow();
});
it('preserves tool evidence through branch/export/import and exposes read-only headless JSON', async () => {
  const output = record(); saveToolOutput(dir, output);
  const branch = await branchSession(session.id); expect(readToolOutputs(storage.getSessionDirById(branch.session.id)!).records).toEqual([output]);
  await exportSession(root, session.id, 'portable.json'); const imported = await importSession(root, 'portable.json');
  expect(readToolOutputs(storage.getSessionDirById(imported.session.id)!).records).toEqual([output]);
  const listed = await sessionCommand(['outputs', imported.session.id, '--json'], { cwd: root }); expect(listed).toMatchObject({ exitCode: 0, report: { version: 1, type: 'session', action: 'outputs', localOnly: true } });
  expect(JSON.stringify(listed)).not.toContain('SEVENTH');
  expect(await sessionCommand(['outputs', imported.session.id, output.id, '--json'], { cwd: root })).toMatchObject({ exitCode: 0, report: { data: { record: output } } });
  expect(await sessionCommand(['outputs', imported.session.id, 'missing'], { cwd: root })).toMatchObject({ exitCode: 1 });
  expect(await sessionCommand(['outputs'], { cwd: root })).toMatchObject({ exitCode: 2 });
  expect(await sessionCommand(['outputs', session.id], { cwd: root, signal: AbortSignal.abort() })).toMatchObject({ exitCode: 130 });
});
it('keeps parallel tool timing independent, ignores late chunks and bounds active display state', () => {
  let now = 1000; const progress = new ToolProgress(() => now);
  progress.start('a', 'shell'); progress.start('b', 'read_file'); progress.running('a'); now += 1000; progress.running('b'); now += 1000; progress.output('a', 'TOKEN=opaque-secret');
  expect(progress.snapshot()).toMatchObject({ action: '2 active tools', startTime: 1000, tools: [{ id: 'a', startTime: 1000, detail: 'TOKEN=[REDACTED]' }, { id: 'b', startTime: 2000 }] });
  progress.finish('a'); progress.output('a', 'late'); progress.retry('b'); expect(progress.snapshot()!.tools).toHaveLength(1); expect(progress.snapshot()!.tools![0]!.phase).toBe('retrying');
  progress.clear(); expect(progress.snapshot()).toBeNull(); progress.output('b', 'late'); expect(progress.snapshot()).toBeNull();
  for (let i = 0; i < 300; i++) progress.start(String(i), 'read_file');
  expect(progress.snapshot()).toMatchObject({ action: '300 active tools', omittedTools: 292 }); expect(progress.snapshot()!.tools).toHaveLength(8);
  for (let i = 0; i < 300; i++) progress.finish(String(i)); expect(progress.snapshot()).toBeNull();
});
