import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import * as config from '../src/config.js';
import { trustProject, untrustProject } from '../src/trust.js';
import { mergePreferences, resolvePreferences, validatePreference, readProjectDefaults, saveProjectDefaults, PROJECT_MODEL_DEFAULTS, parseOnce, formatModelDetails, parseModelFlags, createSubmission, drainSubmissions } from '../src/preferences/index.js';
import { RunLog, readRunLog, verifyChain, resetRunLogs } from '../src/runlog.js';
vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));
let root: string;
beforeEach(() => { config.resetConfig(); resetRunLogs(); root = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-preferences-'))); });
afterEach(() => { config.resetConfig(); resetRunLogs(); vi.restoreAllMocks(); fs.rmSync(root, { recursive: true, force: true }); });
const defaults = () => join(root, PROJECT_MODEL_DEFAULTS);

it('resolves precedence and never carries a foreign provider model through a switch', () => {
  expect(mergePreferences([
    { source: 'global', value: { provider: 'anthropic', model: 'global-model' } },
    { source: 'project', value: { provider: 'deepseek', model: 'project-model' } },
    { source: 'environment', value: { model: 'env-model' } },
    { source: 'session', value: { model: 'session-model' } },
    { source: 'turn', value: { provider: 'xai' } },
  ])).toMatchObject({ provider: 'xai', sources: { provider: 'turn', model: null } });
  const preference = mergePreferences([{ source: 'global', value: { provider: 'xai', model: 'global' } }, { source: 'turn', value: { model: 'temporary' } }]);
  expect(preference).toMatchObject({ model: 'temporary', sources: { provider: 'global', model: 'turn' } });
  expect(mergePreferences([{ source: 'global', value: { provider: 'xai', model: 'global' } }, { source: 'session', value: { model: null } }]).model).toBeUndefined();
});

it('persists trusted project defaults across restart without changing global preferences', async () => {
  config.set('defaultProvider', 'anthropic'); config.set('defaultModel', 'global');
  trustProject(root);
  await saveProjectDefaults(root, { provider: 'deepseek', model: 'project' });
  resetRunLogs();
  expect(resolvePreferences(root, { env: {} })).toMatchObject({ provider: 'deepseek', model: 'project', sources: { provider: 'project', model: 'project' } });
  expect(config.get('defaultProvider')).toBe('anthropic'); expect(config.get('defaultModel')).toBe('global');
  expect(resolvePreferences(root, { env: { CALLIOPE_PROVIDER: 'xai' } }).model).toBeUndefined();
  expect(resolvePreferences(root, { env: {}, session: { provider: 'google' }, turn: { model: 'temporary' } })).toMatchObject({ provider: 'google', model: 'temporary' });
  if (process.platform !== 'win32') expect(fs.statSync(defaults()).mode & 0o777).toBe(0o600);
});

it('ignores untrusted project defaults and never reads parent settings or executes legacy commands', async () => {
  await saveProjectDefaults(root, { provider: 'xai', model: 'project' });
  expect(readProjectDefaults(root)).toMatchObject({ warning: expect.stringContaining('not trusted') });
  trustProject(root); const nested = join(root, 'nested'); fs.mkdirSync(nested); trustProject(nested);
  expect(readProjectDefaults(nested).selection).toBeUndefined();
  fs.rmSync(defaults());
  fs.writeFileSync(join(root, '.calliope'), 'provider: deepseek\nmodel: legacy\n[commands]\nbuild: touch should-not-exist\n');
  expect(readProjectDefaults(root)).toMatchObject({ legacy: true, selection: { provider: 'deepseek', model: 'legacy' } });
  expect(fs.existsSync(join(root, 'should-not-exist'))).toBe(false);
  untrustProject(root); expect(readProjectDefaults(root).selection).toBeUndefined();
});

it('preserves unrelated fields and legacy files when saving or resetting', async () => {
  trustProject(root); fs.writeFileSync(join(root, '.calliope'), 'provider: google\n');
  fs.writeFileSync(defaults(), JSON.stringify({ version: 1, updatedAt: new Date().toISOString(), selection: { provider: 'xai' }, extension: { note: 'keep' } }));
  await saveProjectDefaults(root, {});
  expect(JSON.parse(fs.readFileSync(defaults(), 'utf8'))).toMatchObject({ selection: {}, extension: { note: 'keep' } });
  expect(readProjectDefaults(root).selection).toEqual({});
  expect(fs.readFileSync(join(root, '.calliope'), 'utf8')).toBe('provider: google\n');
});

it('starts with a project state directory and still discovers later legacy config files', () => {
  trustProject(root);
  const state = join(root, '.calliope'); fs.mkdirSync(state);
  fs.writeFileSync(join(state, 'state.json'), '{"keep":true}');
  config.set('defaultProvider', 'google');
  expect(resolvePreferences(root, { env: {} })).toMatchObject({ provider: 'google', sources: { provider: 'global' }, warnings: [] });
  fs.mkdirSync(join(root, '.calliope.conf'));
  fs.writeFileSync(join(root, 'calliope.conf'), 'provider: deepseek\nmodel: legacy\n');
  expect(readProjectDefaults(root)).toMatchObject({ legacy: true, selection: { provider: 'deepseek', model: 'legacy' } });
  fs.writeFileSync(join(state, 'state.json'), '{"keep":"updated"}');
  expect(resolvePreferences(root, { env: {} })).toMatchObject({ provider: 'deepseek', model: 'legacy' });
  expect(fs.readFileSync(join(state, 'state.json'), 'utf8')).toBe('{"keep":"updated"}');
});

it('rejects an explicit defaults directory and legacy symlinks instead of silently ignoring them', () => {
  trustProject(root);
  fs.mkdirSync(defaults());
  expect(() => readProjectDefaults(root)).toThrow('type limit');
  fs.rmdirSync(defaults());
  const target = join(root, 'target'); fs.mkdirSync(target);
  fs.symlinkSync(target, join(root, '.calliope'));
  expect(() => readProjectDefaults(root)).toThrow('symlink');
  expect(fs.statSync(target).isDirectory()).toBe(true);
});

it('audits successful and denied writes without including unrelated file content', async () => {
  const log = RunLog.open('preferences', { dir: join(root, 'runs') });
  await saveProjectDefaults(root, { provider: 'xai' }, { runlog: log });
  const before = fs.readFileSync(defaults(), 'utf8');
  await expect(saveProjectDefaults(root, { provider: 'google' }, { runlog: log, confirmation: 'mutating' })).rejects.toThrow('confirmation');
  expect(fs.readFileSync(defaults(), 'utf8')).toBe(before);
  const events = readRunLog(log.filePath); expect(verifyChain(events).ok).toBe(true);
  expect(events.filter(event => event.type === 'tool_result')).toHaveLength(2);
  expect(events.some(event => event.type === 'policy_event' && event.decision === 'confirm')).toBe(true);
  expect(events.filter(event => event.type === 'tool_call').every(event => !('content' in (event.args as object)))).toBe(true);
});

it('cancels during approval before creating a file or leaving a writer lock', async () => {
  const controller = new AbortController();
  await expect(saveProjectDefaults(root, { provider: 'xai' }, { signal: controller.signal, confirmation: 'mutating', approve: async () => { controller.abort(); return 'allow'; } })).rejects.toThrow();
  expect(fs.existsSync(defaults())).toBe(false); expect(fs.existsSync(defaults() + '.lock')).toBe(false);
});

it('rejects malformed, oversized, symlinked and unknown-version defaults without overwriting them', async () => {
  trustProject(root);
  for (const text of ['{', '{}', JSON.stringify({ version: 2, selection: {} }), 'x'.repeat(65537)]) {
    fs.writeFileSync(defaults(), text);
    expect(() => readProjectDefaults(root)).toThrow();
    await expect(saveProjectDefaults(root, {})).rejects.toThrow();
    expect(fs.readFileSync(defaults(), 'utf8')).toBe(text);
  }
  const other = join(root, 'other'); fs.writeFileSync(other, '{}'); fs.rmSync(defaults()); fs.symlinkSync(other, defaults());
  expect(() => readProjectDefaults(root)).toThrow('symlink');
  await expect(saveProjectDefaults(root, {})).rejects.toThrow('symlink');
  expect(fs.readFileSync(other, 'utf8')).toBe('{}');
  fs.rmSync(other);
  expect(() => readProjectDefaults(root)).toThrow('symlink');
  await expect(saveProjectDefaults(root, {})).rejects.toThrow('symlink');
});

it('detects concurrent edits during approval and preserves the later writer', async () => {
  await saveProjectDefaults(root, { provider: 'deepseek' });
  await expect(saveProjectDefaults(root, { provider: 'xai' }, { confirmation: 'mutating', approve: async () => {
    await saveProjectDefaults(root, { provider: 'google' }); return 'allow';
  } })).rejects.toThrow('changed during approval');
  trustProject(root); expect(readProjectDefaults(root).selection?.provider).toBe('google');
});

it('rejects directory replacement during asynchronous approval before writing into the replacement', async () => {
  const moved = root + '-moved';
  try {
    await expect(saveProjectDefaults(root, { provider: 'xai' }, { confirmation: 'mutating', approve: async () => {
      fs.renameSync(root, moved); fs.mkdirSync(root); return 'allow';
    } })).rejects.toThrow(/changed during approval/);
    expect(fs.readdirSync(root)).toEqual([]);
    expect(fs.existsSync(join(moved, PROJECT_MODEL_DEFAULTS))).toBe(false);
  } finally { fs.rmSync(moved, { recursive: true, force: true }); }
});

it.skipIf(process.platform === 'win32')('rejects named pipes without waiting for a writer', async () => {
  trustProject(root); execFileSync('mkfifo', [defaults()], { timeout: 1000 });
  expect(() => readProjectDefaults(root)).toThrow('type limit');
  await expect(saveProjectDefaults(root, {})).rejects.toThrow('type limit');
});

it('rejects an existing writer lock and cleans up its own failed temporary write', async () => {
  fs.writeFileSync(defaults() + '.lock', 'another writer');
  await expect(saveProjectDefaults(root, {})).rejects.toThrow('writer lock');
  expect(fs.readFileSync(defaults() + '.lock', 'utf8')).toBe('another writer'); fs.rmSync(defaults() + '.lock');
  vi.spyOn(fs, 'renameSync').mockImplementationOnce(() => { throw new Error('disk rejected rename'); });
  await expect(saveProjectDefaults(root, {})).rejects.toThrow('disk rejected');
  expect(fs.readdirSync(root).filter(file => file.includes('.tmp') || file.includes('.lock'))).toEqual([]);
});

it.each([{ provider: 'ai21' }, { provider: 'wrong' }, { model: '\nsecret' }, { model: '' }, { apiKey: 'fake' }, [], null])('rejects malformed preferences %j', value => {
  expect(() => validatePreference(value)).toThrow();
});

it('parses bounded one-turn flags without interpreting prompt text or changing preferences', () => {
  expect(parseOnce('/once --provider xai --model custom -- Explain -- this $(literal)')).toEqual({ preference: { provider: 'xai', model: 'custom' }, prompt: 'Explain -- this $(literal)' });
  expect(parseOnce('ordinary input')).toBeUndefined();
  for (const input of ['/once', '/once --provider xai', '/once --provider xai --', '/once --provider xai --provider google -- task', '/once --unknown value -- task', '/once -- task']) expect(() => parseOnce(input)).toThrow('Usage');
});

it('shows discovered capacity and cost while keeping unknown and zero distinct', () => {
  expect(formatModelDetails({ id: 'unknown' })).toContain('cost unknown');
  expect(formatModelDetails({ id: 'free', contextLength: 8000, pricing: { input: 0, output: 0 }, capabilities: { tools: true } })).toContain('context 8,000 · output unknown · $0.000000');
});

it('parses invocation flags without leaking their values into prompts or interpreting arguments after --', () => {
  expect(parseModelFlags(['--headless', '--model=live', '--provider', 'xai', 'hello', '--', '--provider', 'literal'])).toEqual({
    preference: { provider: 'xai', model: 'live' }, args: ['--headless', 'hello'], literal: ['--provider', 'literal'],
  });
  for (const args of [['--model'], ['--provider', '--model'], ['--provider='], ['--provider=ai21'], ['--model=a', '--model=b']]) expect(() => parseModelFlags(args)).toThrow();
});

it('snapshots each queued preference and keeps temporary provider/model choices out of subsequent turns', async () => {
  const base = resolvePreferences(root, { env: {}, session: { provider: 'deepseek', model: 'saved' } });
  const first = createSubmission('/once --provider xai --model one -- first', base), second = createSubmission('second', base);
  base.model = 'later'; base.sources.model = 'global';
  expect(first).toMatchObject({ prompt: 'first', selection: { provider: 'xai', model: 'one', sources: { model: 'turn' } } });
  expect(second.selection).toMatchObject({ provider: 'deepseek', model: 'saved', sources: { model: 'session' } });
  const pending = [second], seen: string[] = [];
  expect(await drainSubmissions(first, { run: async item => { seen.push(item.prompt); return true; }, next: () => pending.shift() })).toBe('empty');
  expect(seen).toEqual(['first', 'second']);
  expect(() => createSubmission('/defaults save', base)).toThrow('other commands');
  expect(() => createSubmission('', base)).toThrow();
});

it('preserves queued work when the active turn fails or cancels and bounds continued draining', async () => {
  const first = createSubmission('first', resolvePreferences(root, { env: {} }));
  const next = vi.fn(() => first);
  expect(await drainSubmissions(first, { run: async () => false, next })).toBe('stopped');
  expect(next).not.toHaveBeenCalled();
  const controller = new AbortController();
  await expect(drainSubmissions(first, { signal: controller.signal, run: async () => { controller.abort(); return true; }, next })).rejects.toThrow();
  expect(next).not.toHaveBeenCalled();
  const run = vi.fn(async () => true);
  expect(await drainSubmissions(first, { run, next })).toBe('limit');
  expect(run).toHaveBeenCalledTimes(100); expect(next).toHaveBeenCalledTimes(99);
});
