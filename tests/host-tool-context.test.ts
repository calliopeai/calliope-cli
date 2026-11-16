import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';

const chat = vi.fn();
vi.mock('../src/providers/index.js', () => ({ chat: (...args: unknown[]) => chat(...args), selectProvider: () => 'anthropic' }));
vi.mock('../src/routing/index.js', async original => ({
  ...await original<typeof import('../src/routing/index.js')>(),
  selectRoute: (await import('./helpers/route-fixture.js')).fixtureRoute,
}));

import { runHeadless } from '../src/headless.js';
import { trustProject } from '../src/trust.js';

const roots: string[] = [];
afterEach(() => { vi.restoreAllMocks(); chat.mockReset(); for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('does not load host filesystem context through a project alias when a host runtime owns tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-host-context-')); roots.push(root);
  const cwd = path.join(root, 'project'); fs.mkdirSync(cwd);
  const canary = 'synthetic-private-host-context';
  fs.writeFileSync(path.join(root, 'private.txt'), canary);
  fs.symlinkSync(path.join(root, 'private.txt'), path.join(cwd, 'CLAUDE.md'));
  trustProject(cwd);
  chat.mockResolvedValue({ content: 'done', finishReason: 'stop', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  const execute = vi.fn();
  expect(await runHeadless({ cwd, prompt: 'Inspect the assigned workspace.', provider: 'anthropic', model: 'context-fixture', outputMode: 'json', toolRuntime: { version: 1, tools: [], execute } })).toBe(0);
  expect(chat).toHaveBeenCalledOnce();
  expect(JSON.stringify(chat.mock.calls[0])).not.toContain(canary);
  expect(execute).not.toHaveBeenCalled();
});

it('keeps ordinary local project context loading', async () => {
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-local-context-')); roots.push(cwd);
  fs.writeFileSync(path.join(cwd, 'CLAUDE.md'), 'Visible local project instructions.');
  trustProject(cwd);
  chat.mockResolvedValue({ content: 'done', finishReason: 'stop', toolCalls: [], usage: { inputTokens: 1, outputTokens: 1 } });
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  expect(await runHeadless({ cwd, prompt: 'Inspect this local project.', provider: 'anthropic', model: 'context-fixture', outputMode: 'json' })).toBe(0);
  expect(JSON.stringify(chat.mock.calls[0])).toContain('Visible local project instructions.');
});
