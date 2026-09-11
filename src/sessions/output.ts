/** Private, bounded inspection cache. Audit history retains references after eviction. */
import * as fs from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { assertSessionDirectory, readPrivateSessionFile, object, hash } from './format.js';
import { approvalDisplayText } from '../approvals/request.js';
import { throwIfCancelled } from '../cancellation.js';
export const MAX_TOOL_OUTPUT_CHARS = 65536;
export const MAX_TOOL_OUTPUTS = 100;
export const MAX_TOOL_OUTPUT_BYTES = 4 * 1024 * 1024;
export interface ToolOutputRecord {
  version: 1; id: string; toolCallId: string; tool: string; channel: 'tool' | 'thinking';
  content: string; sourceChars: number; truncated: boolean; isError: boolean; createdAt: string; hash: string;
}
export interface CapturedToolOutput { record: ToolOutputRecord; saved: boolean }
export interface ToolOutputSnapshot { version: 1; dropped: number; records: ToolOutputRecord[]; checksum: string }
const uuid = (value: unknown) => typeof value === 'string' && /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(value);
const bad = () => new Error('Tool output records are unavailable or damaged; preserve them and inspect session storage.');
const clip = (value: string, limit: number) => value.slice(0, limit).replace(/[\uD800-\uDBFF]$/, '');
export function makeToolOutput(toolCallId: string, tool: string, text: string, isError: boolean): ToolOutputRecord {
  if (!toolCallId || toolCallId.length > 256 || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(tool) || typeof text !== 'string') throw bad();
  const visible = approvalDisplayText(clip(text, MAX_TOOL_OUTPUT_CHARS * 2));
  const content = clip(visible, MAX_TOOL_OUTPUT_CHARS);
  return { version: 1, id: randomUUID(), toolCallId, tool, channel: tool === 'think' ? 'thinking' : 'tool', content,
    sourceChars: text.length, truncated: text.length > MAX_TOOL_OUTPUT_CHARS * 2 || visible.length > content.length,
    isError, createdAt: new Date().toISOString(), hash: hash(content) };
}
const envelope = (records: ToolOutputRecord[], dropped: number): ToolOutputSnapshot => {
  const data = { version: 1 as const, dropped, records }; return { ...data, checksum: hash(JSON.stringify(data)) };
};
export function validateToolOutputSnapshot(value: unknown): ToolOutputSnapshot {
  if (!object(value) || Object.keys(value).sort().join() !== 'checksum,dropped,records,version' || value.version !== 1 ||
    !Number.isSafeInteger(value.dropped) || Number(value.dropped) < 0 || !Array.isArray(value.records) || value.records.length > MAX_TOOL_OUTPUTS) throw bad();
  const ids = new Set<string>();
  for (const record of value.records) {
    if (!object(record) || Object.keys(record).sort().join() !== 'channel,content,createdAt,hash,id,isError,sourceChars,tool,toolCallId,truncated,version' || record.version !== 1 ||
      !uuid(record.id) || ids.has(String(record.id)) || typeof record.toolCallId !== 'string' || !record.toolCallId || record.toolCallId.length > 256 ||
      typeof record.tool !== 'string' || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(record.tool) || record.channel !== (record.tool === 'think' ? 'thinking' : 'tool') ||
      typeof record.content !== 'string' || record.content.length > MAX_TOOL_OUTPUT_CHARS || record.hash !== hash(record.content) ||
      !Number.isSafeInteger(record.sourceChars) || Number(record.sourceChars) < 0 || typeof record.truncated !== 'boolean' || typeof record.isError !== 'boolean' ||
      typeof record.createdAt !== 'string' || record.createdAt.length > 40 || !Number.isFinite(Date.parse(record.createdAt))) throw bad();
    ids.add(record.id as string);
  }
  const checked = envelope(value.records as ToolOutputRecord[], Number(value.dropped));
  if (checked.checksum !== value.checksum || Buffer.byteLength(JSON.stringify(checked)) > MAX_TOOL_OUTPUT_BYTES) throw bad();
  return checked;
}
function parse(raw: string | null): ToolOutputSnapshot {
  if (raw === null) return envelope([], 0);
  try { return validateToolOutputSnapshot(JSON.parse(raw)); } catch { throw bad(); }
}
export function readToolOutputs(dir: string): ToolOutputSnapshot {
  assertSessionDirectory(dir); return parse(readPrivateSessionFile(join(dir, 'tool-output.json'), MAX_TOOL_OUTPUT_BYTES));
}
export function saveToolOutput(dir: string, record: ToolOutputRecord, signal?: AbortSignal): void {
  throwIfCancelled(signal); assertSessionDirectory(dir); validateToolOutputSnapshot(envelope([record], 0));
  const identity = fs.statSync(dir), file = join(dir, 'tool-output.json'), lock = file + '.lock', temp = join(dir, `.output-${randomUUID()}.tmp`);
  let fd: number;
  try { fd = fs.openSync(lock, 'wx', 0o600); } catch { throw new Error('Tool output writer is busy; this result remains available in the current transcript.'); }
  try {
    fs.writeFileSync(fd, String(process.pid));
    const raw = readPrivateSessionFile(file, MAX_TOOL_OUTPUT_BYTES), previous = parse(raw);
    if (previous.records.some(item => item.id === record.id)) throw new Error('Tool output ID already exists; refusing to replace evidence.');
    const records = [...previous.records, record]; let dropped = previous.dropped, next = envelope(records, dropped);
    while (records.length > MAX_TOOL_OUTPUTS || Buffer.byteLength(JSON.stringify(next)) > MAX_TOOL_OUTPUT_BYTES) { records.shift(); next = envelope(records, ++dropped); }
    validateToolOutputSnapshot(next);
    const output = fs.openSync(temp, 'wx', 0o600);
    try { fs.writeFileSync(output, JSON.stringify(next)); fs.fsyncSync(output); } finally { fs.closeSync(output); }
    throwIfCancelled(signal); assertSessionDirectory(dir);
    const current = fs.statSync(dir);
    if (current.ino !== identity.ino || current.dev !== identity.dev || readPrivateSessionFile(file, MAX_TOOL_OUTPUT_BYTES) !== raw) throw new Error('Tool output store changed during save; current transcript retains the result.');
    fs.renameSync(temp, file);
  } finally {
    fs.closeSync(fd);
    try {
      const current = fs.lstatSync(dir);
      if (!current.isSymbolicLink() && current.ino === identity.ino && current.dev === identity.dev) {
        try { fs.unlinkSync(temp); } catch { /* Already committed. */ }
        fs.unlinkSync(lock);
      }
    } catch { /* Never clean a replacement directory. */ }
  }
}
