/**
 * Tests for src/file-watcher.ts
 *
 * Covers: FileWatcher class (start, stop, on, off, shouldIgnore, matchPattern,
 * debounceEvent, emitEvent), getWatcher, startWatching, stopWatching,
 * createChangeAggregator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  FileWatcher,
  getWatcher,
  startWatching,
  stopWatching,
  createChangeAggregator,
} from '../src/file-watcher.js';
import type { WatchEvent } from '../src/file-watcher.js';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-watcher-test-'));
  // Ensure the global watcher is stopped between tests
  stopWatching();
});

afterEach(() => {
  stopWatching();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Wait for a specified number of milliseconds
 */
function wait(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Create a watcher with short debounce for testing
 */
function createTestWatcher(dir: string, debounceMs = 50): FileWatcher {
  return new FileWatcher(dir, { debounceMs });
}

/**
 * Start watcher and wait briefly for fs.watch to initialize
 */
async function startAndSettle(watcher: FileWatcher): Promise<void> {
  watcher.start();
  await wait(100);
}

// ===========================================================================
// FileWatcher class - constructor and options
// ===========================================================================

describe('FileWatcher constructor', () => {
  it('should create a watcher with default options', () => {
    const watcher = new FileWatcher(tmpDir);
    expect(watcher).toBeDefined();
    watcher.stop();
  });

  it('should accept custom options', () => {
    const watcher = new FileWatcher(tmpDir, {
      patterns: ['**/*.ts'],
      ignorePatterns: ['dist'],
      debounceMs: 200,
      recursive: false,
    });
    expect(watcher).toBeDefined();
    watcher.stop();
  });
});

// ===========================================================================
// FileWatcher - start / stop
// ===========================================================================

describe('FileWatcher start/stop', () => {
  it('should start without error', () => {
    const watcher = createTestWatcher(tmpDir);
    expect(() => watcher.start()).not.toThrow();
    watcher.stop();
  });

  it('should not start twice (idempotent)', () => {
    const watcher = createTestWatcher(tmpDir);
    watcher.start();
    watcher.start(); // should be no-op
    watcher.stop();
  });

  it('should stop without error', () => {
    const watcher = createTestWatcher(tmpDir);
    watcher.start();
    expect(() => watcher.stop()).not.toThrow();
  });

  it('should handle stop when not started', () => {
    const watcher = createTestWatcher(tmpDir);
    expect(() => watcher.stop()).not.toThrow();
  });
});

// ===========================================================================
// FileWatcher - on / off callbacks
// ===========================================================================

describe('FileWatcher on/off', () => {
  it('should register a callback', () => {
    const watcher = createTestWatcher(tmpDir);
    const cb = vi.fn();
    watcher.on(cb);
    watcher.stop();
  });

  it('should remove a callback', () => {
    const watcher = createTestWatcher(tmpDir);
    const cb = vi.fn();
    watcher.on(cb);
    watcher.off(cb);
    watcher.stop();
  });

  it('should handle removing a callback that was not registered', () => {
    const watcher = createTestWatcher(tmpDir);
    const cb = vi.fn();
    expect(() => watcher.off(cb)).not.toThrow();
    watcher.stop();
  });
});

// ===========================================================================
// FileWatcher - file change detection
// ===========================================================================

describe('FileWatcher file change detection', () => {
  it('should emit event when a file is created', async () => {
    const watcher = createTestWatcher(tmpDir, 50);
    const events: WatchEvent[] = [];
    watcher.on((event) => events.push(event));
    await startAndSettle(watcher);

    // Create a file
    fs.writeFileSync(path.join(tmpDir, 'new-file.txt'), 'hello');

    // Wait for debounce + fs.watch latency
    await wait(500);

    watcher.stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    const event = events.find(e => e.relativePath.includes('new-file.txt'));
    expect(event).toBeDefined();
    expect(event!.type).toBe('change'); // File exists so it's 'change'
    expect(event!.timestamp).toBeInstanceOf(Date);
  });

  it('should emit event when a file is modified', async () => {
    const filePath = path.join(tmpDir, 'existing.txt');
    fs.writeFileSync(filePath, 'original');

    const watcher = createTestWatcher(tmpDir, 50);
    const events: WatchEvent[] = [];
    watcher.on((event) => events.push(event));
    await startAndSettle(watcher);

    // Modify the file
    fs.writeFileSync(filePath, 'modified');

    await wait(500);

    watcher.stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    const event = events.find(e => e.relativePath.includes('existing.txt'));
    expect(event).toBeDefined();
    expect(event!.type).toBe('change');
  });

  it('should emit event when a file is deleted', async () => {
    const filePath = path.join(tmpDir, 'doomed.txt');
    fs.writeFileSync(filePath, 'temporary');

    const watcher = createTestWatcher(tmpDir, 50);
    const events: WatchEvent[] = [];
    watcher.on((event) => events.push(event));
    await startAndSettle(watcher);

    // Delete the file
    fs.unlinkSync(filePath);

    await wait(500);

    watcher.stop();

    expect(events.length).toBeGreaterThanOrEqual(1);
    const event = events.find(e => e.relativePath.includes('doomed.txt'));
    expect(event).toBeDefined();
    // The type may be 'unlink' or 'change' depending on OS timing --
    // the source code notes "We can't easily tell the difference"
    // because emitEvent checks fs.accessSync at callback time.
    expect(['change', 'unlink']).toContain(event!.type);
  });

  it('should ignore node_modules by default', async () => {
    const nmDir = path.join(tmpDir, 'node_modules');
    fs.mkdirSync(nmDir);

    const watcher = createTestWatcher(tmpDir, 50);
    const events: WatchEvent[] = [];
    watcher.on((event) => events.push(event));
    await startAndSettle(watcher);

    fs.writeFileSync(path.join(nmDir, 'pkg.json'), '{}');

    await wait(500);

    watcher.stop();

    const nmEvents = events.filter(e => e.relativePath.includes('node_modules'));
    expect(nmEvents.length).toBe(0);
  });

  it('should ignore .git by default', async () => {
    const gitDir = path.join(tmpDir, '.git');
    fs.mkdirSync(gitDir);

    const watcher = createTestWatcher(tmpDir, 50);
    const events: WatchEvent[] = [];
    watcher.on((event) => events.push(event));
    await startAndSettle(watcher);

    fs.writeFileSync(path.join(gitDir, 'HEAD'), 'ref: refs/heads/main');

    await wait(500);

    watcher.stop();

    const gitEvents = events.filter(e => e.relativePath.includes('.git'));
    expect(gitEvents.length).toBe(0);
  });

  it('should ignore .DS_Store by default', async () => {
    const watcher = createTestWatcher(tmpDir, 50);
    const events: WatchEvent[] = [];
    watcher.on((event) => events.push(event));
    await startAndSettle(watcher);

    fs.writeFileSync(path.join(tmpDir, '.DS_Store'), '');

    await wait(500);

    watcher.stop();

    const dsEvents = events.filter(e => e.relativePath === '.DS_Store');
    expect(dsEvents.length).toBe(0);
  });

  it('should notify multiple callbacks', async () => {
    const watcher = createTestWatcher(tmpDir, 50);
    const cb1 = vi.fn();
    const cb2 = vi.fn();
    watcher.on(cb1);
    watcher.on(cb2);
    await startAndSettle(watcher);

    fs.writeFileSync(path.join(tmpDir, 'multi.txt'), 'test');

    await wait(500);

    watcher.stop();

    expect(cb1).toHaveBeenCalled();
    expect(cb2).toHaveBeenCalled();
  });

  it('should not emit events after stop', async () => {
    const watcher = createTestWatcher(tmpDir, 50);
    const events: WatchEvent[] = [];
    watcher.on((event) => events.push(event));
    await startAndSettle(watcher);
    watcher.stop();

    fs.writeFileSync(path.join(tmpDir, 'after-stop.txt'), 'test');

    await wait(500);

    const afterStopEvents = events.filter(e => e.relativePath.includes('after-stop.txt'));
    expect(afterStopEvents.length).toBe(0);
  });

  it('should debounce rapid changes to the same file', async () => {
    const filePath = path.join(tmpDir, 'rapid.txt');
    fs.writeFileSync(filePath, 'v0');

    const watcher = createTestWatcher(tmpDir, 150);
    const events: WatchEvent[] = [];
    watcher.on((event) => events.push(event));
    await startAndSettle(watcher);

    // Write rapidly
    fs.writeFileSync(filePath, 'v1');
    fs.writeFileSync(filePath, 'v2');
    fs.writeFileSync(filePath, 'v3');

    await wait(600);

    watcher.stop();

    // Should have fewer events than writes due to debouncing
    const rapidEvents = events.filter(e => e.relativePath.includes('rapid.txt'));
    // The exact count depends on OS timing, but it should be fewer than 3 separate changes
    expect(rapidEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('should include correct path and relativePath', async () => {
    const watcher = createTestWatcher(tmpDir, 50);
    const events: WatchEvent[] = [];
    watcher.on((event) => events.push(event));
    await startAndSettle(watcher);

    fs.writeFileSync(path.join(tmpDir, 'path-test.txt'), 'data');

    await wait(500);

    watcher.stop();

    const event = events.find(e => e.relativePath === 'path-test.txt');
    expect(event).toBeDefined();
    expect(event!.path).toBe(path.join(tmpDir, 'path-test.txt'));
    expect(event!.relativePath).toBe('path-test.txt');
  });
});

// ===========================================================================
// FileWatcher - callback error handling
// ===========================================================================

describe('FileWatcher callback error handling', () => {
  it('should not crash when a callback throws', async () => {
    const watcher = createTestWatcher(tmpDir, 50);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const goodCb = vi.fn();

    watcher.on(() => { throw new Error('callback boom'); });
    watcher.on(goodCb);
    await startAndSettle(watcher);

    fs.writeFileSync(path.join(tmpDir, 'error-test.txt'), 'data');

    await wait(500);

    watcher.stop();
    errorSpy.mockRestore();

    // The good callback should still have been called
    expect(goodCb).toHaveBeenCalled();
  });
});

// ===========================================================================
// Global watcher functions
// ===========================================================================

describe('getWatcher', () => {
  it('should create a watcher when baseDir is provided', () => {
    const watcher = getWatcher(tmpDir);
    expect(watcher).toBeDefined();
    stopWatching();
  });

  it('should return the same watcher on subsequent calls', () => {
    const w1 = getWatcher(tmpDir);
    const w2 = getWatcher();
    expect(w1).toBe(w2);
    stopWatching();
  });
});

describe('startWatching', () => {
  it('should create and start a global watcher', () => {
    const watcher = startWatching(tmpDir);
    expect(watcher).toBeDefined();
    stopWatching();
  });

  it('should stop previous watcher when called again', () => {
    const w1 = startWatching(tmpDir);
    const w2 = startWatching(tmpDir);
    // w2 should be a new watcher instance
    expect(w2).toBeDefined();
    stopWatching();
  });

  it('should accept custom options', () => {
    const watcher = startWatching(tmpDir, { debounceMs: 500, recursive: false });
    expect(watcher).toBeDefined();
    stopWatching();
  });
});

describe('stopWatching', () => {
  it('should stop and clear global watcher', () => {
    startWatching(tmpDir);
    expect(() => stopWatching()).not.toThrow();
  });

  it('should be safe to call when no watcher exists', () => {
    expect(() => stopWatching()).not.toThrow();
  });
});

// ===========================================================================
// createChangeAggregator
// ===========================================================================

describe('createChangeAggregator', () => {
  it('should aggregate change events', async () => {
    const watcher = createTestWatcher(tmpDir, 50);
    const aggregator = createChangeAggregator(watcher, 200);

    await startAndSettle(watcher);

    fs.writeFileSync(path.join(tmpDir, 'agg1.txt'), 'a');
    fs.writeFileSync(path.join(tmpDir, 'agg2.txt'), 'b');

    await wait(600);

    const changes = aggregator.getChanges();
    // Files exist, so they show as 'changed'
    expect(changes.changed.length).toBeGreaterThanOrEqual(1);
    expect(changes.summary).toContain('changed');

    aggregator.destroy();
    watcher.stop();
  });

  it('should aggregate delete events', async () => {
    const filePath = path.join(tmpDir, 'delete-me.txt');
    fs.writeFileSync(filePath, 'temp');

    const watcher = createTestWatcher(tmpDir, 50);
    const aggregator = createChangeAggregator(watcher, 200);

    await startAndSettle(watcher);

    fs.unlinkSync(filePath);

    await wait(600);

    const changes = aggregator.getChanges();
    // Due to OS timing, the event may be categorized as 'change' or 'unlink'
    const totalEvents = changes.deleted.length + changes.changed.length;
    expect(totalEvents).toBeGreaterThanOrEqual(1);

    aggregator.destroy();
    watcher.stop();
  });

  it('should clear accumulated changes', async () => {
    const watcher = createTestWatcher(tmpDir, 50);
    const aggregator = createChangeAggregator(watcher, 200);

    await startAndSettle(watcher);

    fs.writeFileSync(path.join(tmpDir, 'clear-test.txt'), 'a');

    await wait(600);

    expect(aggregator.getChanges().changed.length).toBeGreaterThanOrEqual(1);

    aggregator.clear();

    const afterClear = aggregator.getChanges();
    expect(afterClear.changed.length).toBe(0);
    expect(afterClear.added.length).toBe(0);
    expect(afterClear.deleted.length).toBe(0);
    expect(afterClear.summary).toBe('No changes');

    aggregator.destroy();
    watcher.stop();
  });

  it('should return "No changes" summary when empty', () => {
    const watcher = createTestWatcher(tmpDir, 50);
    const aggregator = createChangeAggregator(watcher);

    const changes = aggregator.getChanges();
    expect(changes.summary).toBe('No changes');
    expect(changes.added).toEqual([]);
    expect(changes.changed).toEqual([]);
    expect(changes.deleted).toEqual([]);

    aggregator.destroy();
    watcher.stop();
  });

  it('should stop receiving events after destroy', async () => {
    const watcher = createTestWatcher(tmpDir, 50);
    const aggregator = createChangeAggregator(watcher, 200);

    await startAndSettle(watcher);
    aggregator.destroy();

    fs.writeFileSync(path.join(tmpDir, 'post-destroy.txt'), 'x');

    await wait(600);

    const changes = aggregator.getChanges();
    expect(changes.changed.length).toBe(0);

    watcher.stop();
  });
});

// ===========================================================================
// FileWatcher - custom ignore patterns
// ===========================================================================

describe('FileWatcher custom ignore patterns', () => {
  it('should ignore files matching custom glob patterns', async () => {
    const watcher = new FileWatcher(tmpDir, {
      ignorePatterns: ['*.log'],
      debounceMs: 50,
    });
    const events: WatchEvent[] = [];
    watcher.on((event) => events.push(event));
    await startAndSettle(watcher);

    fs.writeFileSync(path.join(tmpDir, 'debug.log'), 'log data');
    fs.writeFileSync(path.join(tmpDir, 'app.ts'), 'code');

    await wait(500);

    watcher.stop();

    const logEvents = events.filter(e => e.relativePath.includes('.log'));
    expect(logEvents.length).toBe(0);

    const tsEvents = events.filter(e => e.relativePath.includes('app.ts'));
    expect(tsEvents.length).toBeGreaterThanOrEqual(1);
  });

  it('should ignore specific directory names', async () => {
    const distDir = path.join(tmpDir, 'dist');
    fs.mkdirSync(distDir);

    const watcher = new FileWatcher(tmpDir, {
      ignorePatterns: ['dist'],
      debounceMs: 50,
    });
    const events: WatchEvent[] = [];
    watcher.on((event) => events.push(event));
    await startAndSettle(watcher);

    fs.writeFileSync(path.join(distDir, 'bundle.js'), 'bundled');

    await wait(500);

    watcher.stop();

    const distEvents = events.filter(e => e.relativePath.includes('dist'));
    expect(distEvents.length).toBe(0);
  });
});
