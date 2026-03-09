/**
 * Tests for src/terminal-recording.ts
 *
 * Covers: startRecording, stopRecording, recordEvent, isRecording,
 * getActiveRecordingId, listRecordings, loadRecording, deleteRecording,
 * formatRecording, cleanupRecordings, and edge cases.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Save and override HOME before importing the module so getRecordingsDir()
// points at our temp directory.
let tmpDir: string;
const originalHome = process.env.HOME;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-rec-test-'));
  process.env.HOME = tmpDir;
});

afterEach(() => {
  // Make sure recording state is reset between tests
  // stopRecording is safe to call even when nothing is active
  stopRecording();
  process.env.HOME = originalHome;
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

import {
  startRecording,
  stopRecording,
  recordEvent,
  isRecording,
  getActiveRecordingId,
  listRecordings,
  loadRecording,
  deleteRecording,
  formatRecording,
  cleanupRecordings,
  type Recording,
  type RecordingEvent,
} from '../src/terminal-recording.js';

// ---------------------------------------------------------------------------
// startRecording / stopRecording lifecycle
// ---------------------------------------------------------------------------

describe('startRecording / stopRecording lifecycle', () => {
  it('should return a string id starting with "rec-"', () => {
    const id = startRecording();
    expect(id).toMatch(/^rec-\d+-[a-z0-9]+$/);
  });

  it('should set isRecording to true after start', () => {
    expect(isRecording()).toBe(false);
    startRecording();
    expect(isRecording()).toBe(true);
  });

  it('should set isRecording to false after stop', () => {
    startRecording();
    stopRecording();
    expect(isRecording()).toBe(false);
  });

  it('stopRecording should return the recording with endTime set', () => {
    startRecording({ provider: 'anthropic', model: 'claude-3' });
    const rec = stopRecording();
    expect(rec).not.toBeNull();
    expect(rec!.endTime).toBeDefined();
    expect(rec!.startTime).toBeDefined();
    expect(rec!.metadata.provider).toBe('anthropic');
    expect(rec!.metadata.model).toBe('claude-3');
  });

  it('stopRecording should save a JSON file to disk', () => {
    const id = startRecording();
    stopRecording();
    const filePath = path.join(tmpDir, '.calliope-cli', 'recordings', `${id}.json`);
    expect(fs.existsSync(filePath)).toBe(true);
    const data = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    expect(data.id).toBe(id);
  });

  it('stopRecording when not recording should return null', () => {
    const result = stopRecording();
    expect(result).toBeNull();
  });

  it('starting a new recording replaces the active one', () => {
    const id1 = startRecording();
    const id2 = startRecording();
    expect(id2).not.toBe(id1);
    expect(getActiveRecordingId()).toBe(id2);
  });

  it('should accept empty metadata', () => {
    startRecording();
    const rec = stopRecording();
    expect(rec!.metadata).toEqual({});
  });
});

// ---------------------------------------------------------------------------
// recordEvent
// ---------------------------------------------------------------------------

describe('recordEvent', () => {
  it('should add events to active recording', () => {
    startRecording();
    recordEvent('input', 'hello world');
    recordEvent('output', 'response text');
    const rec = stopRecording();
    expect(rec!.events).toHaveLength(2);
    expect(rec!.events[0].type).toBe('input');
    expect(rec!.events[0].data).toBe('hello world');
    expect(rec!.events[1].type).toBe('output');
  });

  it('should set timestamp relative to recording start', () => {
    startRecording();
    recordEvent('input', 'test');
    const rec = stopRecording();
    // Timestamp should be very small since we recorded immediately
    expect(rec!.events[0].timestamp).toBeGreaterThanOrEqual(0);
    expect(rec!.events[0].timestamp).toBeLessThan(1000);
  });

  it('should support all event types', () => {
    startRecording();
    const types: RecordingEvent['type'][] = ['input', 'output', 'tool_call', 'tool_result', 'system', 'error'];
    for (const t of types) {
      recordEvent(t, `data-${t}`);
    }
    const rec = stopRecording();
    expect(rec!.events).toHaveLength(6);
    for (let i = 0; i < types.length; i++) {
      expect(rec!.events[i].type).toBe(types[i]);
    }
  });

  it('should include metadata when provided', () => {
    startRecording();
    recordEvent('tool_call', 'run command', { name: 'bash', args: '--version' });
    const rec = stopRecording();
    expect(rec!.events[0].metadata).toEqual({ name: 'bash', args: '--version' });
  });

  it('should not include metadata when not provided', () => {
    startRecording();
    recordEvent('input', 'test');
    const rec = stopRecording();
    expect(rec!.events[0].metadata).toBeUndefined();
  });

  it('should silently do nothing when not recording', () => {
    // No active recording - should not throw
    expect(() => recordEvent('input', 'orphan event')).not.toThrow();
  });

  it('should cap event data at 10KB (10000 chars)', () => {
    startRecording();
    const longData = 'x'.repeat(20000);
    recordEvent('output', longData);
    const rec = stopRecording();
    expect(rec!.events[0].data).toHaveLength(10000);
  });

  it('should not truncate data under 10KB', () => {
    startRecording();
    const data = 'y'.repeat(9999);
    recordEvent('output', data);
    const rec = stopRecording();
    expect(rec!.events[0].data).toHaveLength(9999);
  });

  it('should handle exactly 10000 chars without truncation', () => {
    startRecording();
    const data = 'z'.repeat(10000);
    recordEvent('output', data);
    const rec = stopRecording();
    expect(rec!.events[0].data).toHaveLength(10000);
  });
});

// ---------------------------------------------------------------------------
// isRecording / getActiveRecordingId
// ---------------------------------------------------------------------------

describe('isRecording / getActiveRecordingId', () => {
  it('should return false and null when idle', () => {
    expect(isRecording()).toBe(false);
    expect(getActiveRecordingId()).toBeNull();
  });

  it('should return true and the id when recording', () => {
    const id = startRecording();
    expect(isRecording()).toBe(true);
    expect(getActiveRecordingId()).toBe(id);
  });

  it('should return false and null after stopping', () => {
    startRecording();
    stopRecording();
    expect(isRecording()).toBe(false);
    expect(getActiveRecordingId()).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// listRecordings
// ---------------------------------------------------------------------------

describe('listRecordings', () => {
  it('should return empty array when no recordings exist', () => {
    const list = listRecordings();
    expect(list).toEqual([]);
  });

  it('should list saved recordings', () => {
    startRecording({ provider: 'openai' });
    recordEvent('input', 'hello');
    stopRecording();

    startRecording({ provider: 'google' });
    recordEvent('output', 'world');
    recordEvent('system', 'done');
    stopRecording();

    const list = listRecordings();
    expect(list).toHaveLength(2);
    // Each entry should have the expected shape
    for (const entry of list) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('startTime');
      expect(entry).toHaveProperty('eventCount');
      expect(entry).toHaveProperty('duration');
    }
  });

  it('should sort recordings by startTime descending (newest first)', () => {
    const id1 = startRecording();
    stopRecording();

    const id2 = startRecording();
    stopRecording();

    // Patch saved files to have distinct startTimes so sort order is deterministic
    const dir = path.join(tmpDir, '.calliope-cli', 'recordings');
    const file1 = path.join(dir, `${id1}.json`);
    const file2 = path.join(dir, `${id2}.json`);
    const data1 = JSON.parse(fs.readFileSync(file1, 'utf-8'));
    const data2 = JSON.parse(fs.readFileSync(file2, 'utf-8'));
    data1.startTime = '2025-01-01T00:00:00.000Z';
    data2.startTime = '2025-01-02T00:00:00.000Z';
    fs.writeFileSync(file1, JSON.stringify(data1));
    fs.writeFileSync(file2, JSON.stringify(data2));

    const list = listRecordings();
    // The second recording should appear first (newest)
    expect(list[0].id).toBe(id2);
    expect(list[1].id).toBe(id1);
  });

  it('should report correct event count and duration', () => {
    startRecording();
    recordEvent('input', 'a');
    recordEvent('output', 'b');
    stopRecording();

    const list = listRecordings();
    expect(list[0].eventCount).toBe(2);
    expect(list[0].duration).toBeGreaterThanOrEqual(0);
  });

  it('should skip malformed JSON files gracefully', () => {
    // Create a valid recording first
    const id = startRecording();
    stopRecording();

    // Write a corrupt file
    const dir = path.join(tmpDir, '.calliope-cli', 'recordings');
    fs.writeFileSync(path.join(dir, 'bad-file.json'), 'not valid json{{{');

    const list = listRecordings();
    expect(list).toHaveLength(1);
    expect(list[0].id).toBe(id);
  });
});

// ---------------------------------------------------------------------------
// loadRecording
// ---------------------------------------------------------------------------

describe('loadRecording', () => {
  it('should load a saved recording by id', () => {
    const id = startRecording({ model: 'gpt-4' });
    recordEvent('input', 'test input');
    stopRecording();

    const loaded = loadRecording(id);
    expect(loaded).not.toBeNull();
    expect(loaded!.id).toBe(id);
    expect(loaded!.metadata.model).toBe('gpt-4');
    expect(loaded!.events).toHaveLength(1);
    expect(loaded!.events[0].data).toBe('test input');
  });

  it('should return null for nonexistent id', () => {
    const result = loadRecording('rec-does-not-exist');
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// deleteRecording
// ---------------------------------------------------------------------------

describe('deleteRecording', () => {
  it('should delete a saved recording and return true', () => {
    const id = startRecording();
    stopRecording();

    expect(deleteRecording(id)).toBe(true);
    expect(loadRecording(id)).toBeNull();
  });

  it('should return false when deleting nonexistent recording', () => {
    expect(deleteRecording('rec-nonexistent')).toBe(false);
  });

  it('deleted recording should not appear in listRecordings', () => {
    const id = startRecording();
    stopRecording();
    deleteRecording(id);
    const list = listRecordings();
    expect(list).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// formatRecording
// ---------------------------------------------------------------------------

describe('formatRecording', () => {
  it('should format header with id, start time, and event count', () => {
    const recording: Recording = {
      id: 'rec-test-abc',
      startTime: '2025-01-15T10:00:00.000Z',
      events: [],
      metadata: {},
    };
    const output = formatRecording(recording);
    expect(output).toContain('Recording: rec-test-abc');
    expect(output).toContain('Started: 2025-01-15T10:00:00.000Z');
    expect(output).toContain('Events: 0');
    expect(output).toContain('---');
  });

  it('should format input events with > prefix', () => {
    const recording: Recording = {
      id: 'rec-1',
      startTime: '2025-01-01T00:00:00Z',
      events: [{ type: 'input', timestamp: 0, data: 'hello' }],
      metadata: {},
    };
    const output = formatRecording(recording);
    expect(output).toContain('[0:00] > hello');
  });

  it('should format output events without prefix', () => {
    const recording: Recording = {
      id: 'rec-1',
      startTime: '2025-01-01T00:00:00Z',
      events: [{ type: 'output', timestamp: 5000, data: 'response' }],
      metadata: {},
    };
    const output = formatRecording(recording);
    expect(output).toContain('[0:05] response');
  });

  it('should format tool_call events with tool name from metadata', () => {
    const recording: Recording = {
      id: 'rec-1',
      startTime: '2025-01-01T00:00:00Z',
      events: [{ type: 'tool_call', timestamp: 60000, data: 'ls -la', metadata: { name: 'bash' } }],
      metadata: {},
    };
    const output = formatRecording(recording);
    expect(output).toContain('[1:00] [tool:bash] ls -la');
  });

  it('should format tool_call with unknown when no metadata name', () => {
    const recording: Recording = {
      id: 'rec-1',
      startTime: '2025-01-01T00:00:00Z',
      events: [{ type: 'tool_call', timestamp: 0, data: 'cmd' }],
      metadata: {},
    };
    const output = formatRecording(recording);
    expect(output).toContain('[tool:unknown]');
  });

  it('should format tool_result events truncated to 200 chars', () => {
    const longResult = 'A'.repeat(500);
    const recording: Recording = {
      id: 'rec-1',
      startTime: '2025-01-01T00:00:00Z',
      events: [{ type: 'tool_result', timestamp: 0, data: longResult }],
      metadata: {},
    };
    const output = formatRecording(recording);
    const resultLine = output.split('\n').find(l => l.includes('[result]'));
    expect(resultLine).toBeDefined();
    // The [result] line should contain at most 200 chars of data
    const dataAfterResult = resultLine!.split('[result] ')[1];
    expect(dataAfterResult).toHaveLength(200);
  });

  it('should format system events', () => {
    const recording: Recording = {
      id: 'rec-1',
      startTime: '2025-01-01T00:00:00Z',
      events: [{ type: 'system', timestamp: 0, data: 'session started' }],
      metadata: {},
    };
    const output = formatRecording(recording);
    expect(output).toContain('[system] session started');
  });

  it('should format error events', () => {
    const recording: Recording = {
      id: 'rec-1',
      startTime: '2025-01-01T00:00:00Z',
      events: [{ type: 'error', timestamp: 0, data: 'something broke' }],
      metadata: {},
    };
    const output = formatRecording(recording);
    expect(output).toContain('[ERROR] something broke');
  });

  it('should format timestamps correctly for multi-minute durations', () => {
    const recording: Recording = {
      id: 'rec-1',
      startTime: '2025-01-01T00:00:00Z',
      events: [
        { type: 'input', timestamp: 0, data: 'start' },
        { type: 'output', timestamp: 65000, data: 'after 1m5s' },
        { type: 'output', timestamp: 600000, data: 'after 10m' },
      ],
      metadata: {},
    };
    const output = formatRecording(recording);
    expect(output).toContain('[0:00]');
    expect(output).toContain('[1:05]');
    expect(output).toContain('[10:00]');
  });
});

// ---------------------------------------------------------------------------
// cleanupRecordings
// ---------------------------------------------------------------------------

describe('cleanupRecordings', () => {
  it('should return 0 when no recordings exist', () => {
    expect(cleanupRecordings()).toBe(0);
  });

  it('should not delete recent recordings', () => {
    const id = startRecording();
    stopRecording();

    const cleaned = cleanupRecordings(30);
    expect(cleaned).toBe(0);
    expect(loadRecording(id)).not.toBeNull();
  });

  it('should delete recordings older than retention period', () => {
    const id = startRecording();
    stopRecording();

    // Backdate the file's mtime to 60 days ago
    const filePath = path.join(tmpDir, '.calliope-cli', 'recordings', `${id}.json`);
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, oldDate, oldDate);

    const cleaned = cleanupRecordings(30);
    expect(cleaned).toBe(1);
    expect(loadRecording(id)).toBeNull();
  });

  it('should use default retention of 30 days', () => {
    const id = startRecording();
    stopRecording();

    const filePath = path.join(tmpDir, '.calliope-cli', 'recordings', `${id}.json`);
    const oldDate = new Date(Date.now() - 31 * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, oldDate, oldDate);

    const cleaned = cleanupRecordings();
    expect(cleaned).toBe(1);
  });

  it('should only delete old recordings, keeping recent ones', () => {
    const idOld = startRecording();
    stopRecording();
    const idNew = startRecording();
    stopRecording();

    // Backdate only the first recording
    const oldPath = path.join(tmpDir, '.calliope-cli', 'recordings', `${idOld}.json`);
    const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
    fs.utimesSync(oldPath, oldDate, oldDate);

    const cleaned = cleanupRecordings(30);
    expect(cleaned).toBe(1);
    expect(loadRecording(idOld)).toBeNull();
    expect(loadRecording(idNew)).not.toBeNull();
  });

  it('should support custom retention days', () => {
    const id = startRecording();
    stopRecording();

    const filePath = path.join(tmpDir, '.calliope-cli', 'recordings', `${id}.json`);
    const oldDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    fs.utimesSync(filePath, oldDate, oldDate);

    // 7-day retention should keep it
    expect(cleanupRecordings(7)).toBe(0);

    // 2-day retention should delete it
    expect(cleanupRecordings(2)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// Edge cases
// ---------------------------------------------------------------------------

describe('edge cases', () => {
  it('recordEvent does nothing when no recording is active', () => {
    expect(() => recordEvent('input', 'orphan')).not.toThrow();
    expect(isRecording()).toBe(false);
  });

  it('stopRecording returns null when not recording', () => {
    expect(stopRecording()).toBeNull();
  });

  it('recording with no events has duration 0 in listing', () => {
    startRecording();
    stopRecording();
    const list = listRecordings();
    expect(list[0].duration).toBe(0);
  });

  it('recordings directory is created automatically', () => {
    const dir = path.join(tmpDir, '.calliope-cli', 'recordings');
    expect(fs.existsSync(dir)).toBe(false);
    startRecording();
    stopRecording();
    expect(fs.existsSync(dir)).toBe(true);
  });

  it('empty string data is recorded correctly', () => {
    startRecording();
    recordEvent('input', '');
    const rec = stopRecording();
    expect(rec!.events[0].data).toBe('');
  });

  it('multiple start/stop cycles work correctly', () => {
    for (let i = 0; i < 5; i++) {
      const id = startRecording();
      recordEvent('input', `cycle-${i}`);
      const rec = stopRecording();
      expect(rec!.id).toBe(id);
      expect(rec!.events[0].data).toBe(`cycle-${i}`);
    }
    const list = listRecordings();
    expect(list).toHaveLength(5);
  });
});
