import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import { devNull } from 'node:os';
import { join } from 'node:path';
import { digest } from '../approvals/index.js';
import type { PortableProjectIdentity } from './types.js';

const MAX_ROOTS = 16;
const GIT_TIMEOUT_MS = 5000;
const GIT_MAX_BUFFER = 65536;
const SCHEMES = ['https', 'http', 'ssh', 'git'];

/**
 * Reduce an origin URL to `host/path` so scp-style and URL spellings of one
 * remote agree. Credentials, scheme and port are dropped. A local path or
 * `file://` URL names a mount, not a repository, so it is unavailable.
 */
export function normalizeOrigin(url: string): string | undefined {
  const raw = url.trim();
  if (!raw || /[\s\x00-\x1f\x7f]/.test(raw)) return undefined;
  let host: string, path: string;
  const scheme = /^([a-zA-Z][a-zA-Z0-9+.-]*):\/\/(.*)$/.exec(raw);
  if (scheme) {
    if (!SCHEMES.includes(scheme[1]!.toLowerCase())) return undefined;
    const rest = scheme[2]!, slash = rest.indexOf('/');
    if (slash < 0) return undefined;
    const authority = rest.slice(0, slash).slice(rest.slice(0, slash).lastIndexOf('@') + 1);
    host = authority.startsWith('[') ? authority.slice(0, authority.indexOf(']') + 1) : authority.replace(/:\d*$/, '');
    path = rest.slice(slash);
  } else {
    const scp = /^(?:[^@/]+@)?([^:/]+):(.*)$/.exec(raw);
    if (!scp || scp[1]!.length < 2) return undefined;
    host = scp[1]!; path = scp[2]!;
  }
  path = path.replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/, '');
  if (!host || !path) return undefined;
  return `${host.toLowerCase()}/${path}`;
}

function git(cwd: string, args: string[]): string {
  const env: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(process.env)) if (!name.startsWith('GIT_')) env[name] = value;
  env.GIT_CONFIG_NOSYSTEM = '1'; env.GIT_CONFIG_GLOBAL = devNull; env.GIT_TERMINAL_PROMPT = '0';
  return execFileSync('git', ['-c', 'core.fsmonitor=false', '-c', `core.hooksPath=${devNull}`, ...args],
    { cwd, env, encoding: 'utf8', timeout: GIT_TIMEOUT_MS, maxBuffer: GIT_MAX_BUFFER, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
}

/**
 * Identify the repository behind a checkout: its root commits and a digest of
 * its normalized origin. It names a repository, not a checkout, and
 * authenticates nothing. Returns undefined whenever that cannot be derived
 * exactly, so callers fail closed.
 */
export function portableProjectIdentity(dir: string): PortableProjectIdentity | undefined {
  try {
    const real = fs.realpathSync(dir);
    if (fs.realpathSync(git(real, ['rev-parse', '--show-toplevel'])) !== real) return undefined;
    if (!fs.lstatSync(join(real, '.git')).isDirectory()) return undefined;
    if (git(real, ['rev-parse', '--is-shallow-repository']) !== 'false') return undefined;
    const roots = [...new Set(git(real, ['rev-list', '--max-parents=0', 'HEAD']).split('\n').filter(Boolean))].sort();
    if (roots.length < 1 || roots.length > MAX_ROOTS || roots.some(r => !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(r))) return undefined;
    const origin = normalizeOrigin(git(real, ['config', '--local', '--no-includes', '--get', 'remote.origin.url']));
    if (!origin) return undefined;
    return { version: 1, roots, origin: digest(origin) };
  } catch {
    return undefined;
  }
}
