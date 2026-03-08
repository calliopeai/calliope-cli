/**
 * Calliope CLI - Terminal Recording & Playback
 *
 * Record session events (user input, assistant output, tool calls/results)
 * with timestamps for replay, review, and debugging.
 */

import * as fs from 'fs';
import * as path from 'path';

// Types
export interface RecordingEvent {
  type: 'input' | 'output' | 'tool_call' | 'tool_result' | 'system' | 'error';
  timestamp: number;  // ms since recording start
  data: string;
  metadata?: Record<string, unknown>;
}

export interface Recording {
  id: string;
  startTime: string;  // ISO
  endTime?: string;
  events: RecordingEvent[];
  metadata: {
    provider?: string;
    model?: string;
    cwd?: string;
    version?: string;
  };
}

// Recording state
let activeRecording: Recording | null = null;
let recordingStartMs = 0;

// Storage directory
function getRecordingsDir(): string {
  const home = process.env.HOME || '/tmp';
  const dir = path.join(home, '.calliope-cli', 'recordings');
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

/** Start a new recording */
export function startRecording(metadata?: Recording['metadata']): string {
  const id = `rec-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  activeRecording = {
    id,
    startTime: new Date().toISOString(),
    events: [],
    metadata: metadata || {},
  };
  recordingStartMs = Date.now();
  return id;
}

/** Stop active recording and save to disk */
export function stopRecording(): Recording | null {
  if (!activeRecording) return null;
  activeRecording.endTime = new Date().toISOString();
  const recording = { ...activeRecording };

  // Save to disk
  const filePath = path.join(getRecordingsDir(), `${recording.id}.json`);
  fs.writeFileSync(filePath, JSON.stringify(recording, null, 2));

  activeRecording = null;
  recordingStartMs = 0;
  return recording;
}

/** Record an event */
export function recordEvent(type: RecordingEvent['type'], data: string, metadata?: Record<string, unknown>): void {
  if (!activeRecording) return;
  activeRecording.events.push({
    type,
    timestamp: Date.now() - recordingStartMs,
    data: data.slice(0, 10000),  // Cap event data at 10KB
    metadata,
  });
}

/** Check if recording is active */
export function isRecording(): boolean {
  return activeRecording !== null;
}

/** Get active recording ID */
export function getActiveRecordingId(): string | null {
  return activeRecording?.id ?? null;
}

/** List saved recordings */
export function listRecordings(): Array<{ id: string; startTime: string; eventCount: number; duration: number }> {
  const dir = getRecordingsDir();
  try {
    const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
    return files.map(f => {
      try {
        const data = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf-8')) as Recording;
        const duration = data.events.length > 0 ? data.events[data.events.length - 1].timestamp : 0;
        return { id: data.id, startTime: data.startTime, eventCount: data.events.length, duration };
      } catch { return null; }
    }).filter((r): r is NonNullable<typeof r> => r !== null)
      .sort((a, b) => b.startTime.localeCompare(a.startTime));
  } catch { return []; }
}

/** Load a recording by ID */
export function loadRecording(id: string): Recording | null {
  const filePath = path.join(getRecordingsDir(), `${id}.json`);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf-8')) as Recording;
  } catch { return null; }
}

/** Delete a recording */
export function deleteRecording(id: string): boolean {
  const filePath = path.join(getRecordingsDir(), `${id}.json`);
  try {
    fs.unlinkSync(filePath);
    return true;
  } catch { return false; }
}

/** Format recording for display (text playback) */
export function formatRecording(recording: Recording): string {
  const lines: string[] = [];
  lines.push(`Recording: ${recording.id}`);
  lines.push(`Started: ${recording.startTime}`);
  lines.push(`Events: ${recording.events.length}`);
  lines.push('---');

  for (const event of recording.events) {
    const time = formatMs(event.timestamp);
    switch (event.type) {
      case 'input':
        lines.push(`[${time}] > ${event.data}`);
        break;
      case 'output':
        lines.push(`[${time}] ${event.data}`);
        break;
      case 'tool_call':
        lines.push(`[${time}] [tool:${event.metadata?.name || 'unknown'}] ${event.data}`);
        break;
      case 'tool_result':
        lines.push(`[${time}] [result] ${event.data.slice(0, 200)}`);
        break;
      case 'system':
        lines.push(`[${time}] [system] ${event.data}`);
        break;
      case 'error':
        lines.push(`[${time}] [ERROR] ${event.data}`);
        break;
    }
  }
  return lines.join('\n');
}

function formatMs(ms: number): string {
  const secs = Math.floor(ms / 1000);
  const mins = Math.floor(secs / 60);
  const s = secs % 60;
  return `${mins}:${String(s).padStart(2, '0')}`;
}

/** Clean up old recordings (older than retentionDays) */
export function cleanupRecordings(retentionDays = 30): number {
  const dir = getRecordingsDir();
  const cutoff = Date.now() - retentionDays * 24 * 60 * 60 * 1000;
  let cleaned = 0;
  try {
    for (const f of fs.readdirSync(dir).filter(f => f.endsWith('.json'))) {
      const stat = fs.statSync(path.join(dir, f));
      if (stat.mtimeMs < cutoff) {
        fs.unlinkSync(path.join(dir, f));
        cleaned++;
      }
    }
  } catch { /* ignore */ }
  return cleaned;
}
