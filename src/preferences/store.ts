import * as fs from 'node:fs';
import { join } from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { checkTrust } from '../trust.js';
import { parseConfigFile } from '../project-config.js';
import { withScope } from '../scope.js';
import { resolvePermission, type PermissionContext } from '../runtime/permissions.js';
import { throwIfCancelled } from '../cancellation.js';
import { RunLog } from '../runlog.js';
import { validatePreference } from './validate.js';
import type { ModelPreference, ProjectModelDefaults } from './types.js';

export const PROJECT_MODEL_DEFAULTS = '.calliope-models.json';
const MAX_BYTES = 64 * 1024;
const digest = (text: string) => createHash('sha256').update(text).digest('hex');

/** A selected project directory is the scope. Never search an enclosing checkout. */
function location(cwd: string) {
  const root = fs.realpathSync(cwd);
  if (!fs.statSync(root).isDirectory()) throw new Error('Project directory is not a directory');
  return { root, file: join(root, PROJECT_MODEL_DEFAULTS) };
}
function present(file: string): boolean {
  try { fs.lstatSync(file); return true; }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false; throw error; }
}
function read(file: string): string | undefined {
  let fd: number;
  try { fd = fs.openSync(file, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW | fs.constants.O_NONBLOCK); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined; throw new Error('Project model defaults must be a readable regular file without symlinks'); }
  try {
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_BYTES) throw new Error('Project model defaults exceed the file size/type limit');
    const bytes = Buffer.alloc(MAX_BYTES + 1), count = fs.readSync(fd, bytes, 0, bytes.length, 0);
    if (count > MAX_BYTES) throw new Error('Project model defaults exceed the file size limit');
    return bytes.subarray(0, count).toString('utf8');
  } finally { fs.closeSync(fd); }
}
function parse(text: string): ProjectModelDefaults {
  let data: ProjectModelDefaults;
  try { data = JSON.parse(text); } catch { throw new Error('Project model defaults contain invalid JSON'); }
  if (!data || Array.isArray(data) || data.version !== 1 || typeof data.updatedAt !== 'string' || !Number.isFinite(Date.parse(data.updatedAt))) throw new Error('Unsupported or malformed project model defaults schema');
  validatePreference(data.selection);
  return data;
}
export function readProjectDefaults(cwd: string): { root: string; file: string; selection?: ModelPreference; warning?: string; legacy?: boolean } {
  const { root, file } = location(cwd);
  const legacyFile = ['.calliope', '.calliope.conf', 'calliope.conf'].map(name => join(root, name)).find(present);
  if (!present(file) && !legacyFile) return { root, file };
  if (!checkTrust(root).trusted) return { root, file, warning: 'Project model defaults were ignored because this project is not trusted. Use /trust add to opt in.' };
  try {
    const raw = read(file);
    if (raw !== undefined) return { root, file, selection: validatePreference(parse(raw).selection) };
    if (legacyFile) {
      const legacy = parseConfigFile(read(legacyFile) ?? '');
      return { root, file, legacy: true, selection: validatePreference({ ...(legacy.provider ? { provider: legacy.provider } : {}), ...(legacy.model ? { model: legacy.model } : {}) }) };
    }
    return { root, file };
  } catch (error) { throw new Error(`Cannot load project model defaults: ${error instanceof Error ? error.message : String(error)}`); }
}

/** Policy checks precede writes; a lock and comparison prevent concurrent lost updates. */
export async function saveProjectDefaults(cwd: string, selection: ModelPreference, options: {
  signal?: AbortSignal; runlog?: RunLog; confirmation?: PermissionContext['confirmation']; approve?: PermissionContext['approve'];
} = {}): Promise<string> {
  throwIfCancelled(options.signal);
  const { root, file } = location(cwd), value = validatePreference(selection);
  const rootStat = fs.statSync(root);
  const log = options.runlog ?? RunLog.open(`defaults_${randomUUID()}`), id = randomUUID(), started = Date.now();
  const before = read(file), previous = before === undefined ? {} : parse(before);
  const next: ProjectModelDefaults = { ...previous, version: 1, updatedAt: new Date().toISOString(), selection: value };
  const content = JSON.stringify(next, null, 2) + '\n';
  if (Buffer.byteLength(content) > MAX_BYTES) throw new Error('Project model defaults exceed the file size limit');
  const call = { id, name: 'write_file', arguments: { path: file, content } };
  log.toolCall({ id, name: call.name, args: { path: file, operation: 'project-model-defaults', selection: value, before: before === undefined ? null : digest(before), after: digest(content) } });
  let lock: number | undefined, temporary: string | undefined;
  try {
    const decision = await withScope(root, () => resolvePermission(call, { cwd: root, confirmation: options.confirmation ?? 'none', signal: options.signal, approve: options.approve, audit: event => log.policyEvent(event) }));
    if (decision.decision !== 'allow') throw new Error(decision.reason);
    throwIfCancelled(options.signal);
    const currentRoot = fs.statSync(root);
    if (fs.realpathSync(root) !== root || currentRoot.dev !== rootStat.dev || currentRoot.ino !== rootStat.ino) throw new Error('Project directory changed during approval');
    // Recheck policy-independent path constraints after asynchronous approval.
    const current = read(file);
    if (current !== before) throw new Error('Project model defaults changed during approval; reload and retry');
    try { lock = fs.openSync(file + '.lock', 'wx', 0o600); }
    catch { throw new Error('Project defaults writer lock exists; inspect .calliope-models.json.lock before retrying'); }
    fs.writeFileSync(lock, JSON.stringify({ pid: process.pid, id, at: new Date().toISOString() }));
    if (read(file) !== before) throw new Error('Project model defaults changed concurrently; reload and retry');
    throwIfCancelled(options.signal);
    temporary = file + '.' + randomUUID() + '.tmp';
    fs.writeFileSync(temporary, content, { flag: 'wx', mode: 0o600 });
    fs.renameSync(temporary, file); temporary = undefined;
    log.toolResult({ id, result: 'Project model defaults saved', isError: false, durationMs: Date.now() - started });
    return file;
  } catch (error) {
    log.toolResult({ id, result: error instanceof Error ? error.message : String(error), isError: true, durationMs: Date.now() - started });
    throw error;
  } finally {
    if (temporary) fs.rmSync(temporary, { force: true });
    if (lock !== undefined) { fs.closeSync(lock); fs.rmSync(file + '.lock', { force: true }); }
    await log.flush();
  }
}
