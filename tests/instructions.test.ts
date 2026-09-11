import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { loadRepositoryInstructions, formatRepositoryInstructions, MAX_INSTRUCTION_BYTES } from '../src/instructions.js';
import { trustProject, untrustProject } from '../src/trust.js';
import { buildMemoryContext } from '../src/memory.js';

let root: string;
beforeEach(() => {
  root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-instructions-')));
  fs.mkdirSync(path.join(root, '.git'));
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));
function write(relative: string, content: string): string {
  const file = path.join(root, relative);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
  return file;
}

describe('repository instructions', () => {
  it('loads trusted ancestors in scope order with full contents and provenance', () => {
    const full = Array.from({ length: 120 }, (_, i) => `Rule ${i}`).join('\n');
    write('AGENTS.md', full);
    write('packages/AGENTS.md', 'Package rules');
    write('packages/app/AGENTS.md', 'App overrides');
    write('packages/other/AGENTS.md', 'Sibling rules');
    trustProject(root);
    const cwd = path.join(root, 'packages/app');
    const loaded = loadRepositoryInstructions(cwd);
    expect(loaded.map(i => i.content)).toEqual([full, 'Package rules', 'App overrides']);
    expect(loaded[2]).toMatchObject({ path: path.join(cwd, 'AGENTS.md'), scope: cwd });
    expect(buildMemoryContext(cwd)).toContain('Rule 119');
    expect(buildMemoryContext(cwd)).toContain('More specific directory instructions take precedence');
    expect(buildMemoryContext(cwd)).not.toContain('Sibling rules');
  });

  it('does not load unknown or explicitly untrusted instructions', () => {
    write('AGENTS.md', 'Do not load');
    expect(loadRepositoryInstructions(root)).toEqual([]);
    trustProject(root);
    write('child/AGENTS.md', 'Also do not load');
    untrustProject(path.join(root, 'child'));
    expect(loadRepositoryInstructions(path.join(root, 'child'))).toEqual([]);
  });

  it('trusting a child does not grant access to parent instructions', () => {
    write('AGENTS.md', 'Untrusted parent');
    write('child/AGENTS.md', 'Trusted child');
    trustProject(path.join(root, 'child'));
    expect(loadRepositoryInstructions(path.join(root, 'child')).map(i => i.content)).toEqual(['Trusted child']);
  });

  it('stops at independent clones and worktree git markers', () => {
    write('AGENTS.md', 'Parent repo');
    write('child/.git', 'gitdir: /some/worktree');
    write('child/AGENTS.md', 'Child repo');
    trustProject(root);
    expect(loadRepositoryInstructions(path.join(root, 'child'))).toEqual([]);
    trustProject(path.join(root, 'child'));
    expect(loadRepositoryInstructions(path.join(root, 'child')).map(i => i.content)).toEqual(['Child repo']);
  });

  it('limits non-git workspaces to the selected directory', () => {
    fs.rmSync(path.join(root, '.git'), { recursive: true });
    write('AGENTS.md', 'Parent');
    write('child/AGENTS.md', 'Child');
    trustProject(root);
    trustProject(path.join(root, 'child'));
    expect(loadRepositoryInstructions(path.join(root, 'child')).map(i => i.content)).toEqual(['Child']);
  });

  it('preserves CALLIOPE.md preferences and appends controlling instructions last', () => {
    write('CALLIOPE.md', '# Memory\n## Preferences\n- Use tests\n');
    write('CLAUDE.md', 'Legacy context');
    write('AGENTS.md', 'Portable rules');
    trustProject(root);
    const prompt = buildMemoryContext(root);
    expect(prompt).toContain('Use tests');
    expect(prompt.indexOf('Portable rules')).toBeGreaterThan(prompt.indexOf('Legacy context'));
  });

  it('fails explicitly rather than truncating oversized instruction chains', () => {
    write('AGENTS.md', 'a'.repeat(MAX_INSTRUCTION_BYTES));
    write('child/AGENTS.md', 'b');
    trustProject(root);
    expect(loadRepositoryInstructions(root)[0]!.content).toHaveLength(MAX_INSTRUCTION_BYTES);
    expect(() => loadRepositoryInstructions(path.join(root, 'child'))).toThrow('instructions were not truncated');
  });

  it('allows in-scope instruction symlinks but refuses an escape', () => {
    write('rules.md', 'Shared rules');
    fs.symlinkSync('rules.md', path.join(root, 'AGENTS.md'));
    trustProject(root);
    expect(loadRepositoryInstructions(root)[0]!.content).toBe('Shared rules');
    write('child/placeholder', '');
    fs.symlinkSync('../rules.md', path.join(root, 'child/AGENTS.md'));
    untrustProject(root);
    trustProject(path.join(root, 'child'));
    // Parent explicitly untrusted blocks all inheritance.
    expect(loadRepositoryInstructions(path.join(root, 'child'))).toEqual([]);
    fs.writeFileSync(path.join(root, 'child/.git'), 'gitdir: example');
    expect(() => loadRepositoryInstructions(path.join(root, 'child'))).toThrow('outside the trusted scope');
  });

  it('rejects non-file instructions and handles missing workspaces', () => {
    fs.mkdirSync(path.join(root, 'AGENTS.md'));
    trustProject(root);
    expect(() => loadRepositoryInstructions(root)).toThrow('regular file');
    expect(loadRepositoryInstructions(path.join(root, 'missing'))).toEqual([]);
    expect(formatRepositoryInstructions([])).toBe('');
  });
});


it('does not import instructions through a symlink into an explicitly untrusted subtree', () => {
  write('excluded/rules.md', 'Untrusted rules');
  fs.symlinkSync(path.join(root, 'excluded/rules.md'), path.join(root, 'AGENTS.md'));
  trustProject(root);
  untrustProject(path.join(root, 'excluded'));
  expect(() => loadRepositoryInstructions(root)).toThrow('explicitly untrusted directory');
});
