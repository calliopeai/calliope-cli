/**
 * `calliope --version --json` (#379): what an embedder (Chat Studio) reads to
 * check compatibility before it spawns `calliope acp`. Runs today's source,
 * compiled into an isolated package, as a real process with a private HOME.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { PROTOCOL_VERSION } from '@zed-industries/agent-client-protocol';

const { version } = JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
let build: string;

beforeAll(() => {
  build = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-version-json-')));
  execFileSync(resolve('node_modules/.bin/tsc'), ['--outDir', join(build, 'dist'), '--incremental', 'false'], { cwd: process.cwd(), timeout: 60000, stdio: 'pipe' });
  fs.writeFileSync(join(build, 'package.json'), JSON.stringify({ type: 'module', version }));
  fs.symlinkSync(resolve('node_modules'), join(build, 'node_modules'), 'junction');
}, 90000);

afterAll(() => fs.rmSync(build, { recursive: true, force: true }));

it('prints only {version, acp} and never checks npm for updates', () => {
  const home = join(build, 'home');
  fs.mkdirSync(home);
  for (const args of [['--version', '--json'], ['-v', '--json']]) {
    const result = spawnSync(process.execPath, [join(build, 'dist', 'bin.js'), ...args], {
      cwd: build,
      env: { PATH: process.env.PATH, HOME: home, USERPROFILE: home, CALLIOPE_CONFIG_DIR: join(home, 'config') },
      encoding: 'utf8',
      timeout: 20000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toBe(`${JSON.stringify({ version, acp: PROTOCOL_VERSION })}\n`);
    expect(JSON.parse(result.stdout)).toEqual({ version, acp: 1 });
  }
  // Plain --version records its npm lookup in this cache; the JSON form must not make one.
  expect(fs.existsSync(join(home, '.config', 'calliope', 'version-cache.json'))).toBe(false);
}, 30000);
