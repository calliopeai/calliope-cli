/**
 * Test store isolation (#217).
 *
 * Every on-disk store the CLI touches — the conf config store, and every
 * `~/.calliope-cli/*` / `~/.config/calliope/*` writer (runlog, budget, skills,
 * themes, storage, memory, hooks, mcp, plugins, trust, version cache) — must be
 * redirected to a throwaway directory so the suite can never read or clobber the
 * developer's real config. (The config test suite calls `resetConfig()`, which
 * is `conf.clear()`; under the real path that wiped the developer's store.)
 *
 * Vitest runs setupFiles before each test file, but `process.env` persists for
 * the life of a worker, so the `if (!already-set)` guard makes this effectively
 * per-worker: the first file in a worker mints one base dir; later files in the
 * same worker reuse it. Distinct workers get distinct dirs (unique mkdtemp +
 * VITEST_POOL_ID), which also removes the cross-worker store races behind the
 * flaky bedrock (#214) and skills (#206) suites.
 *
 * Two levers:
 *   - CALLIOPE_CONFIG_DIR → conf's `cwd` (src/config.ts honors it).
 *   - HOME / USERPROFILE  → os.homedir(), which every state dir derives from.
 *     env-paths (used by conf) also follows HOME, so this is belt-and-suspenders
 *     on top of CALLIOPE_CONFIG_DIR.
 *
 * Tests that `vi.mock('os')` to their own tmp home still win for their own
 * module graph — this only redirects the unmocked default.
 */
import { mkdtempSync, realpathSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

if (!process.env.CALLIOPE_CONFIG_DIR) {
  const tag = process.env.VITEST_POOL_ID ?? String(process.pid);
  // realpath the base so $HOME is already canonical (macOS os.tmpdir() lives
  // under the symlinked /var/folders → /private/var/folders). Code that
  // realpath-resolves a target path and compares it against os.homedir()
  // (e.g. src/scope.ts) then still matches.
  const base = realpathSync(mkdtempSync(join(tmpdir(), `calliope-test-${tag}-`)));

  // conf store → <base>/config.json (base already exists from mkdtemp).
  process.env.CALLIOPE_CONFIG_DIR = base;

  // Redirect the home directory so os.homedir()-derived state dirs
  // (~/.calliope-cli/*, ~/.config/calliope/*) land under the throwaway base.
  process.env.HOME = base;
  process.env.USERPROFILE = base; // Windows CI
}

// Hermeticity: never let the AWS SDK's credential chain reach for the EC2
// metadata endpoint (on CI runners the IMDS attempt retries past test
// timeouts — the cause of the #214 bedrock hang). Tests that need
// credentials set their own env explicitly.
process.env.AWS_EC2_METADATA_DISABLED = 'true';
process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI = '';
