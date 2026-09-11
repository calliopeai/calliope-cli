import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { mkdtempSync, realpathSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as config from '../src/config.js';
import { clearModelCache } from '../src/model-detection.js';
import { HealthStore, providerTarget } from '../src/health/index.js';
import { providerChoices, readProjectDefaults, saveProjectDefaults } from '../src/preferences/index.js';
import { trustProject } from '../src/trust.js';
import { handleCommand, type CommandContext } from '../src/ui/commands.js';
import { RunLog, readRunLog, resetRunLogs, verifyChain } from '../src/runlog.js';

let root: string;
const models: Record<string, unknown[]> = {};
const json = (data: unknown) => new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
beforeEach(() => {
  config.resetConfig(); clearModelCache(); resetRunLogs();
  root = realpathSync(mkdtempSync(join(tmpdir(), 'calliope-repl-models-')));
  for (const provider of config.getProviderNames()) {
    const vars = config.getProviderEnvVars(provider);
    for (const name of [vars.apiKey, vars.baseUrl]) if (name) vi.stubEnv(name, '');
  }
  for (const provider of ['deepseek', 'xai'] as const) {
    config.setProviderCred(provider, { apiKey: 'fake', baseUrl: `https://${provider}.invalid/v1` });
    models[provider] = [{ id: `${provider}-live`, capabilities: { tools: true, streaming: true }, context_length: 8000 }];
  }
  config.set('defaultProvider', 'deepseek'); config.set('defaultModel', 'deepseek-live');
  config.set('routing', { enabled: true, providerPool: ['deepseek', 'xai'], costSensitivity: 0 });
  vi.stubGlobal('fetch', vi.fn(async input => {
    const url = new URL(String(input)); expect(url.pathname).toBe('/v1/models');
    return json({ data: models[url.hostname.split('.')[0]!] });
  }));
});
afterEach(() => { config.resetConfig(); clearModelCache(); resetRunLogs(); vi.restoreAllMocks(); vi.unstubAllGlobals(); vi.unstubAllEnvs(); rmSync(root, { recursive: true, force: true }); });
function context() {
  const output: string[] = [];
  const ctx = { provider: 'deepseek', actualProvider: 'deepseek', actualModel: 'deepseek-live', model: 'deepseek-live',
    setProvider: vi.fn(), setModel: vi.fn(), setAvailableModels: vi.fn(), setModalMode: vi.fn(),
    sessionRef: { current: { id: 'model-controls', projectPath: root } }, llmMessages: { current: [] },
    addMessage: (_type: string, message: string) => output.push(message),
  } as unknown as CommandContext;
  return { ctx, output };
}

it('validates a provider switch through live discovery without persisting global preferences', async () => {
  const { ctx, output } = context();
  await handleCommand('/provider xai', ctx);
  expect(ctx.setProvider).toHaveBeenCalledWith('xai'); expect(ctx.setModel).toHaveBeenCalledWith(undefined);
  expect(config.get('defaultProvider')).toBe('deepseek'); expect(config.get('defaultModel')).toBe('deepseek-live');
  expect(output.join('\n')).toContain('session only'); expect(fetch).toHaveBeenCalledOnce();
  expect(readRunLog(RunLog.open('model-controls_controls').filePath).some(event => event.type === 'routing_decision')).toBe(true);
});

it('rejects unavailable or incompatible models without changing selection, and permits retry after recovery', async () => {
  const { ctx, output } = context();
  models.deepseek = [{ id: 'bad', capabilities: { tools: false } }, { id: 'good', capabilities: { tools: true } }];
  for (const model of ['bad', 'absent']) await handleCommand(`/model ${model}`, ctx);
  expect(ctx.setModel).not.toHaveBeenCalled(); expect(output.join('\n')).toContain('No eligible');
  await handleCommand('/model good', ctx);
  expect(ctx.setModel).toHaveBeenCalledWith('good'); expect(config.get('defaultModel')).toBe('deepseek-live');
});

it('supports auto selection, shows all registered providers with local health and opens discovered models', async () => {
  const { ctx, output } = context();
  const store = new HealthStore(), target = providerTarget('xai');
  for (let i = 0; i < 3; i++) store.append({ provider: 'xai', target: target.key, type: 'attempt', outcome: 'error', failure: 'server' });
  await handleCommand('/provider list', ctx);
  expect(output.join('\n')).toContain('xai: quarantined'); expect(fetch).not.toHaveBeenCalled();
  const choices = await providerChoices();
  expect(choices.map(choice => choice.id).sort()).toEqual(['auto', ...config.getProviderNames()].sort());
  await handleCommand('/provider auto', ctx); expect(ctx.setProvider).toHaveBeenCalledWith('auto');
  await handleCommand('/model list', ctx); expect(ctx.setModalMode).toHaveBeenCalledWith('model');
  expect(ctx.setAvailableModels).toHaveBeenCalledWith(expect.arrayContaining([expect.objectContaining({ id: 'deepseek-live' })]));
});

it.each(['/provider xai', '/model list'])('cancels %s discovery without changing state', async command => {
  let started!: () => void;
  const ready = new Promise<void>(resolve => { started = resolve; });
  vi.stubGlobal('fetch', vi.fn((_input, init) => new Promise((_resolve, reject) => {
    const signal = init?.signal as AbortSignal; started(); signal.addEventListener('abort', () => reject(signal.reason), { once: true });
  })));
  const { ctx } = context(), controller = new AbortController(); ctx.signal = controller.signal;
  const pending = handleCommand(command, ctx); await ready; controller.abort();
  await expect(pending).rejects.toThrow();
  expect(ctx.setProvider).not.toHaveBeenCalled(); expect(ctx.setModel).not.toHaveBeenCalled(); expect(ctx.setModalMode).not.toHaveBeenCalled();
});

it('saves and resets trusted project defaults and audits the exact mutation scope', async () => {
  const { ctx, output } = context(); trustProject(root);
  await handleCommand('/defaults save', ctx); resetRunLogs();
  expect(readProjectDefaults(root).selection).toEqual({ provider: 'deepseek', model: 'deepseek-live' });
  await handleCommand('/defaults reset', ctx); expect(readProjectDefaults(root).selection).toEqual({});
  expect(config.get('defaultModel')).toBe('deepseek-live');
  const log = RunLog.open('model-controls_controls'), events = readRunLog(log.filePath);
  expect(verifyChain(events).ok).toBe(true);
  expect(events.find(event => event.type === 'tool_call')).toMatchObject({ args: { path: join(root, '.calliope-models.json') } });
  expect(output.join('\n')).toContain('New session:');
});

it('does not bypass project policy for an explicitly requested defaults save', async () => {
  trustProject(root); await saveProjectDefaults(root, { provider: 'xai' });
  const file = join(root, '.calliope-models.json'), original = readFileSync(file, 'utf8');
  const policy = join(root, 'deny-policy.mjs');
  writeFileSync(policy, 'process.stdin.resume(); process.stdin.on("end", () => { console.error("defaults locked"); process.exitCode = 1; });');
  config.set('policy', { command: `${process.execPath} ${policy}`, timeoutMs: 2000 });
  const { ctx, output } = context(); await handleCommand('/defaults save', ctx);
  expect(readFileSync(file, 'utf8')).toBe(original); expect(output.join('\n')).toContain('defaults locked');
});
