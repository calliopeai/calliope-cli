/** Project-scoped, private and exclusive session transfer files. */
import * as fs from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { hash, readPrivateSessionFile, MAX_BUNDLE_BYTES } from '../sessions/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { authorizeSessionAction, type SessionActionOptions } from './permissions.js';
import { RunLog } from '../runlog.js';

function location(cwd: string, path: string) {
  if (!path || /[\x00-\x1f\x7f]/.test(path)) throw new Error('Use a regular file path inside the current project.');
  const root = fs.realpathSync(cwd), file = resolve(root, path), parent = dirname(file);
  const rel = relative(root, file);
  if (!rel || rel === '..' || rel.startsWith('../') || isAbsolute(rel) || fs.realpathSync(parent) !== parent)
    throw new Error('Session transfers require a file inside the current project without symlink directories.');
  const rootStat = fs.statSync(root), parentStat = fs.statSync(parent);
  if (!rootStat.isDirectory() || !parentStat.isDirectory()) throw new Error('Session transfer parent must be a directory.');
  const recheck = () => {
    for (const [path, before] of [[root, rootStat], [parent, parentStat]] as const) {
      const current = fs.lstatSync(path);
      if (current.isSymbolicLink() || current.dev !== before.dev || current.ino !== before.ino || fs.realpathSync(path) !== path)
        throw new Error('Session transfer directory changed during permission checks; retry.');
    }
  };
  return { root, file, parent, recheck };
}

export async function readSessionTransfer(cwd: string, path: string, options: SessionActionOptions = {}): Promise<string> {
  throwIfCancelled(options.signal);
  const target = location(cwd, path);
  await authorizeSessionAction(target.root, 'read_file', { path: target.file, operation: 'session-import' }, options);
  target.recheck(); throwIfCancelled(options.signal);
  const content = readPrivateSessionFile(target.file, MAX_BUNDLE_BYTES);
  if (content === null) throw new Error('Session transfer file not found.');
  return content;
}

/** No overwrite option: source exports remain useful rollback references. */
export async function writeSessionTransfer(cwd: string, path: string, content: string, options: SessionActionOptions = {}): Promise<string> {
  throwIfCancelled(options.signal);
  if (Buffer.byteLength(content) > MAX_BUNDLE_BYTES) throw new Error('Session export exceeds the portable file budget.');
  const target = location(cwd, path);
  const log = options.runlog ?? RunLog.open(`session_export_${randomUUID()}`);
  await authorizeSessionAction(target.root, 'write_file', { path: target.file, operation: 'session-export', bytes: Buffer.byteLength(content), checksum: hash(content) }, { ...options, runlog: log });
  target.recheck(); throwIfCancelled(options.signal);
  const temp = join(target.parent, `.${basename(target.file)}-${randomUUID()}.tmp`);
  let created = false;
  try {
    const fd = fs.openSync(temp, 'wx', 0o600); created = true;
    try { fs.writeFileSync(fd, content); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
    target.recheck(); throwIfCancelled(options.signal);
    fs.linkSync(temp, target.file);
    // POSIX-only: Windows denies FlushFileBuffers on a directory handle opened via 'r' (#382, #384, #388).
    if (process.platform !== 'win32') {
      const parentFd = fs.openSync(target.parent, 'r');
      try { fs.fsyncSync(parentFd); } finally { fs.closeSync(parentFd); }
    }
    log.policyEvent({ tool: 'session_export', source: 'session-history', decision: 'allow', durationMs: 0,
      reason: `committed=${target.file} checksum=${hash(content)}` });
    return target.file;
  } catch (error) {
    log.policyEvent({ tool: 'session_export', source: 'session-history', decision: 'deny', durationMs: 0, reason: `Export failed; inspect destination before retrying: ${target.file}` });
    if (options.signal?.aborted) throw error;
    throw new Error('Session export could not be saved; choose a new file and check directory permissions and free space.');
  } finally {
    if (created) { try { target.recheck(); fs.unlinkSync(temp); } catch { /* Never clean files in a replaced directory. */ } }
    await log.flush();
  }
}
