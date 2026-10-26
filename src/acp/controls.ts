/** Session controls are preferences, never a grant of execution authority. */
import * as fs from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { getSessionById, getSessionDirById } from '../storage.js';
import { assertSessionDirectory, readPrivateSessionFile } from '../sessions/index.js';
import { validatePreference } from '../preferences/validate.js';
import type { ModelPreference } from '../preferences/types.js';

export interface AcpControls {
  version: 1;
  revision: string | null;
  mode: 'work' | 'plan';
  selection?: ModelPreference;
}
const invalid = () => new Error('ACP session controls are missing, damaged or changed; reload the session or restore its saved controls.');
function location(id: string): string {
  const dir = getSessionDirById(id);
  if (!dir) throw invalid();
  assertSessionDirectory(dir);
  return join(dir, 'acp-controls.json');
}
export function readAcpControls(id: string, creating = false): AcpControls {
  const raw = readPrivateSessionFile(location(id), 16384);
  if (raw === null) {
    if (!creating && getSessionById(id)?.acpControlsVersion === 1) throw invalid();
    return { version: 1, revision: null, mode: 'work' };
  }
  let value: AcpControls;
  try { value = JSON.parse(raw); } catch { throw invalid(); }
  if (!value || Array.isArray(value) || value.version !== 1 || typeof value.revision !== 'string' ||
      !/^[a-f0-9-]{36}$/.test(value.revision) || !['work', 'plan'].includes(value.mode) ||
      Object.keys(value).some(key => !['version', 'revision', 'mode', 'selection'].includes(key))) throw invalid();
  if (value.selection !== undefined) value.selection = validatePreference(value.selection);
  return value;
}
export function saveAcpControls(id: string, value: AcpControls, creating = false): AcpControls {
  const file = location(id), lock = file + '.lock', temporary = file + '.' + randomUUID() + '.tmp';
  let fd: number;
  try { fd = fs.openSync(lock, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600); }
  catch { throw new Error('ACP session controls have another writer; reload before retrying.'); }
  try {
    if (readAcpControls(id, creating).revision !== value.revision) throw invalid();
    const next: AcpControls = { version: 1, revision: randomUUID(), mode: value.mode,
      ...(value.selection ? { selection: validatePreference(value.selection) } : {}) };
    if (!['work', 'plan'].includes(next.mode)) throw invalid();
    const output = fs.openSync(temporary, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY, 0o600);
    try { fs.writeFileSync(output, JSON.stringify(next) + '\n'); fs.fsyncSync(output); } finally { fs.closeSync(output); }
    fs.renameSync(temporary, file);
    // Match native session commits: NTFS does not support flushing a read-only directory handle.
    if(process.platform!=='win32') {
      const directory = fs.openSync(dirname(file), fs.constants.O_RDONLY);
      try { fs.fsyncSync(directory); } finally { fs.closeSync(directory); }
    }
    return next;
  } finally {
    fs.closeSync(fd);
    fs.rmSync(temporary, { force: true });
    fs.unlinkSync(lock);
  }
}
