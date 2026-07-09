import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// The loader in bin.ts is module-scoped; replicate its contract here by
// importing bin with a controlled cwd/HOME. bin.ts runs main() at load, so
// we exercise the parsing/precedence contract through a focused re-import
// with CALLIOPE_NO_AUTORUN (same pattern as signals.test.ts).

let tmpBase: string;
let cwdDir: string;
let homeDir: string;
const TEST_KEYS = ['CALLIOPE_T219_A', 'CALLIOPE_T219_B', 'CALLIOPE_T219_C', 'CALLIOPE_T219_M'] as const;

beforeEach(() => {
  tmpBase = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-envfiles-'));
  cwdDir = path.join(tmpBase, 'proj');
  homeDir = path.join(tmpBase, 'home');
  fs.mkdirSync(path.join(homeDir, '.config', 'calliope'), { recursive: true });
  fs.mkdirSync(cwdDir, { recursive: true });
  for (const k of TEST_KEYS) delete process.env[k];
});

afterEach(() => {
  for (const k of TEST_KEYS) delete process.env[k];
  fs.rmSync(tmpBase, { recursive: true, force: true });
});

async function loadBinWith(env: Record<string, string | undefined>): Promise<void> {
  const { vi } = await import('vitest');
  vi.resetModules();
  const prevCwd = process.cwd();
  const prevHome = process.env.HOME;
  process.env.CALLIOPE_NO_AUTORUN = '1';
  try {
    process.chdir(cwdDir);
    process.env.HOME = homeDir;
    Object.assign(process.env, env);
    await import('../src/bin.js');
  } finally {
    process.chdir(prevCwd);
    process.env.HOME = prevHome;
    delete process.env.CALLIOPE_NO_AUTORUN;
  }
}

describe('env file loading precedence (#219)', () => {
  it('loads the global ~/.config/calliope/cli.env', async () => {
    fs.writeFileSync(path.join(homeDir, '.config', 'calliope', 'cli.env'), 'CALLIOPE_T219_A=global\n');
    await loadBinWith({});
    expect(process.env.CALLIOPE_T219_A).toBe('global');
  });

  it('cwd files beat the global file; env beats everything', async () => {
    fs.writeFileSync(path.join(homeDir, '.config', 'calliope', 'cli.env'), 'CALLIOPE_T219_A=global\nCALLIOPE_T219_B=global\nCALLIOPE_T219_C=global\n');
    fs.writeFileSync(path.join(cwdDir, 'cli.env'), 'CALLIOPE_T219_B=cwd\nCALLIOPE_T219_C=cwd\n');
    await loadBinWith({ CALLIOPE_T219_C: 'realenv' });
    expect(process.env.CALLIOPE_T219_A).toBe('global');   // only global defines it
    expect(process.env.CALLIOPE_T219_B).toBe('cwd');      // cwd wins over global
    expect(process.env.CALLIOPE_T219_C).toBe('realenv');  // env wins over both
  });

  it('missing files are silent no-ops and malformed lines are skipped', async () => {
    fs.writeFileSync(path.join(homeDir, '.config', 'calliope', 'cli.env'), '# comment\nnot a valid line\nCALLIOPE_T219_M=ok\n');
    await loadBinWith({});
    expect(process.env.CALLIOPE_T219_M).toBe('ok');
  });
});
