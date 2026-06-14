/**
 * Storage integrity regression tests.
 *
 * Covers code-review fixes:
 *   #148 - deleteSession resolves the session dir by ID, not raw path join.
 *   #149 - atomic temp-file+rename for JSON persistence (no truncated reads).
 *   #150 - chat.log rotation + bounded messages.json write amplification.
 *
 * Paths are monkey-patched to a temp dir, mirroring tests/storage-extended.test.ts.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  paths,
  getOrCreateSession,
  deleteSession,
  addChatMessage,
  getChatHistory,
  saveMessageHistory,
  loadMessageHistory,
} from '../src/storage.js';

let tmpRoot: string;
let origPaths: Record<string, string>;

function patchPaths(root: string): void {
  origPaths = { ...paths };
  paths.root = root;
  paths.config = path.join(root, 'config.json');
  paths.sessions = path.join(root, 'sessions');
  paths.currentSession = path.join(root, 'sessions', 'current');
  paths.todos = path.join(root, 'todos');
  paths.globalTodos = path.join(root, 'todos', 'global.json');
  paths.projectTodos = path.join(root, 'todos', 'by-project');
  paths.templates = path.join(root, 'templates');
  paths.planTemplates = path.join(root, 'templates', 'plans');
  paths.plugins = path.join(root, 'plugins');
  paths.history = path.join(root, 'history');
  paths.commandHistory = path.join(root, 'history', 'commands.txt');
}

function restorePaths(): void {
  if (origPaths) {
    Object.assign(paths, origPaths);
  }
}

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-integrity-test-'));
  patchPaths(tmpRoot);
});

afterEach(() => {
  restorePaths();
  delete process.env.CALLIOPE_CHAT_LOG_MAX_BYTES;
  delete process.env.CALLIOPE_MAX_PERSISTED_MESSAGES;
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================
// #148 - deleteSession by ID
// ============================================================================

describe('deleteSession (#148)', () => {
  it('deletes a real ${date}_${project} session directory by its session id', () => {
    const session = getOrCreateSession('/some/project/alpha');

    // The on-disk dir is named by date+project, NOT by the session id.
    const dirs = fs
      .readdirSync(paths.sessions, { withFileTypes: true })
      .filter((e) => e.isDirectory() && e.name !== 'current')
      .map((e) => e.name);
    expect(dirs.length).toBe(1);
    expect(dirs[0]).not.toBe(session.id); // proves the raw join would have missed it
    const realDir = path.join(paths.sessions, dirs[0]);
    expect(fs.existsSync(realDir)).toBe(true);

    const result = deleteSession(session.id);

    expect(result).toBe(true);
    expect(fs.existsSync(realDir)).toBe(false);
  });

  it('returns false (without throwing) for a non-existent session id', () => {
    getOrCreateSession('/some/project/beta');
    expect(deleteSession('session_does_not_exist')).toBe(false);
  });
});

// ============================================================================
// #149 - atomic JSON writes
// ============================================================================

describe('atomic JSON writes (#149)', () => {
  it('persists valid messages.json and round-trips them (happy path)', () => {
    getOrCreateSession('/some/project/gamma');
    const messages = [{ role: 'user', content: 'hi' }, { role: 'assistant', content: 'yo' }];

    saveMessageHistory(messages);

    expect(loadMessageHistory()).toEqual(messages);
  });

  it('leaves the previously persisted JSON intact and readable after a failed write', () => {
    getOrCreateSession('/some/project/delta');
    const good = [{ role: 'user', content: 'keep me' }];
    saveMessageHistory(good);

    const messagesFile = path.join(paths.currentSession, 'messages.json');
    const before = fs.readFileSync(messagesFile, 'utf-8');

    // Simulate a crash mid-write: stub JSON.stringify to throw on the next call.
    const origStringify = JSON.stringify;
    let calls = 0;
    (JSON as { stringify: typeof JSON.stringify }).stringify = ((...args: Parameters<typeof JSON.stringify>) => {
      calls += 1;
      if (calls === 1) throw new Error('boom: serialization failed mid-write');
      return origStringify(...args);
    }) as typeof JSON.stringify;

    try {
      // saveMessageHistory swallows errors, so this must not throw...
      expect(() => saveMessageHistory([{ role: 'user', content: 'partial' }])).not.toThrow();
    } finally {
      (JSON as { stringify: typeof JSON.stringify }).stringify = origStringify;
    }

    // ...and the original file must be untouched (never truncated) and still parseable.
    const after = fs.readFileSync(messagesFile, 'utf-8');
    expect(after).toBe(before);
    expect(loadMessageHistory()).toEqual(good);

    // No stray temp files left behind in the session dir.
    const leftover = fs
      .readdirSync(paths.currentSession)
      .filter((name) => name.includes('.tmp'));
    expect(leftover).toEqual([]);
  });
});

// ============================================================================
// #150 - chat.log rotation + bounded messages.json
// ============================================================================

describe('chat.log rotation (#150)', () => {
  it('rotates chat.log to chat.log.1 once it exceeds the configured cap', () => {
    process.env.CALLIOPE_CHAT_LOG_MAX_BYTES = '200'; // tiny cap to force rotation
    getOrCreateSession('/some/project/epsilon');

    const chatLog = path.join(paths.currentSession, 'chat.log');
    const rotated = `${chatLog}.1`;

    // Append enough messages to blow past the 200-byte cap.
    for (let i = 0; i < 20; i++) {
      addChatMessage({ role: 'user', content: `message number ${i} with some padding text` });
    }

    expect(fs.existsSync(rotated)).toBe(true);
    // Active log stays bounded (well under 2x cap after a fresh rotation).
    expect(fs.statSync(chatLog).size).toBeLessThan(400 + 200);
  });

  it('does not rotate while under the cap (happy path) and history still reads back', () => {
    process.env.CALLIOPE_CHAT_LOG_MAX_BYTES = String(5 * 1024 * 1024);
    getOrCreateSession('/some/project/zeta');

    addChatMessage({ role: 'user', content: 'hello' });
    addChatMessage({ role: 'assistant', content: 'hi there' });

    const rotated = path.join(paths.currentSession, 'chat.log.1');
    expect(fs.existsSync(rotated)).toBe(false);

    const history = getChatHistory();
    expect(history.map((m) => m.content)).toEqual(['hello', 'hi there']);
  });
});

describe('messages.json cap (#150)', () => {
  it('caps the persisted array to the most recent N and resume still works', () => {
    process.env.CALLIOPE_MAX_PERSISTED_MESSAGES = '5';
    const session = getOrCreateSession('/some/project/eta');

    const messages = Array.from({ length: 12 }, (_, i) => ({ role: 'user', content: `m${i}` }));
    saveMessageHistory(messages);

    const loaded = loadMessageHistory();
    expect(Array.isArray(loaded)).toBe(true);
    expect(loaded!.length).toBe(5);
    // Most recent messages are retained (m7..m11).
    expect(loaded).toEqual(messages.slice(-5));

    // session.json messageCount reflects the persisted (capped) count.
    const sessionFile = path.join(paths.currentSession, 'session.json');
    const meta = JSON.parse(fs.readFileSync(sessionFile, 'utf-8'));
    expect(meta.messageCount).toBe(5);
    expect(meta.id).toBe(session.id);
  });

  it('persists everything when under the cap (happy path)', () => {
    process.env.CALLIOPE_MAX_PERSISTED_MESSAGES = '100';
    getOrCreateSession('/some/project/theta');

    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    saveMessageHistory(messages);

    expect(loadMessageHistory()).toEqual(messages);
  });
});
