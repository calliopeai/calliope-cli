/**
 * Calliope CLI - File Watcher
 *
 * Watch for file changes and notify the agent.
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export type WatchEventType = 'add' | 'change' | 'unlink';

export interface WatchEvent {
  type: WatchEventType;
  path: string;
  relativePath: string;
  timestamp: Date;
}

export interface WatcherOptions {
  patterns?: string[];         // Glob patterns to watch (default: all)
  ignorePatterns?: string[];   // Patterns to ignore
  debounceMs?: number;         // Debounce events (default: 100ms)
  recursive?: boolean;         // Watch recursively (default: true)
}

export type WatchCallback = (event: WatchEvent) => void;

// ============================================================================
// Default Ignore Patterns
// ============================================================================

const DEFAULT_IGNORE = [
  'node_modules',
  '.git',
  'dist',
  'build',
  '.next',
  '__pycache__',
  '*.log',
  '*.lock',
  '.DS_Store',
  'Thumbs.db',
];

// ============================================================================
// File Watcher
// ============================================================================

export class FileWatcher {
  private watchers: fs.FSWatcher[] = [];
  private callbacks: WatchCallback[] = [];
  private debounceTimers: Map<string, NodeJS.Timeout> = new Map();
  private options: Required<WatcherOptions>;
  private baseDir: string;
  private running = false;

  constructor(baseDir: string, options: WatcherOptions = {}) {
    this.baseDir = baseDir;
    this.options = {
      patterns: options.patterns || ['**/*'],
      ignorePatterns: options.ignorePatterns || DEFAULT_IGNORE,
      debounceMs: options.debounceMs || 100,
      recursive: options.recursive !== false,
    };
  }

  /**
   * Start watching
   */
  start(): void {
    if (this.running) return;
    this.running = true;

    this.watchDirectory(this.baseDir);
  }

  /**
   * Stop watching
   */
  stop(): void {
    this.running = false;
    for (const watcher of this.watchers) {
      watcher.close();
    }
    this.watchers = [];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }

  /**
   * Add event listener
   */
  on(callback: WatchCallback): void {
    this.callbacks.push(callback);
  }

  /**
   * Remove event listener
   */
  off(callback: WatchCallback): void {
    const index = this.callbacks.indexOf(callback);
    if (index >= 0) {
      this.callbacks.splice(index, 1);
    }
  }

  /**
   * Watch a directory
   */
  private watchDirectory(dir: string): void {
    if (!this.running) return;

    try {
      const watcher = fs.watch(dir, { recursive: this.options.recursive }, (eventType, filename) => {
        if (!filename) return;

        const fullPath = path.join(dir, filename);
        const relativePath = path.relative(this.baseDir, fullPath);

        // Check ignore patterns
        if (this.shouldIgnore(relativePath)) return;

        // Debounce events
        this.debounceEvent(fullPath, relativePath);
      });

      this.watchers.push(watcher);

      watcher.on('error', (error) => {
        console.error('Watcher error:', error);
      });
    } catch (error) {
      console.error('Failed to watch directory:', dir, error);
    }
  }

  /**
   * Check if path should be ignored
   */
  private shouldIgnore(relativePath: string): boolean {
    for (const pattern of this.options.ignorePatterns) {
      if (this.matchPattern(relativePath, pattern)) {
        return true;
      }
    }
    return false;
  }

  /**
   * Simple pattern matching
   */
  private matchPattern(path: string, pattern: string): boolean {
    // Handle glob patterns
    if (pattern.includes('*')) {
      const regex = pattern
        .replace(/\./g, '\\.')
        .replace(/\*\*/g, '.*')
        .replace(/\*/g, '[^/]*');
      return new RegExp(regex).test(path);
    }
    // Direct match or directory match
    return path === pattern || path.startsWith(pattern + '/') || path.includes('/' + pattern + '/') || path.includes('/' + pattern);
  }

  /**
   * Debounce file events
   */
  private debounceEvent(fullPath: string, relativePath: string): void {
    // Clear existing timer
    const existing = this.debounceTimers.get(fullPath);
    if (existing) {
      clearTimeout(existing);
    }

    // Set new timer
    const timer = setTimeout(() => {
      this.debounceTimers.delete(fullPath);
      this.emitEvent(fullPath, relativePath);
    }, this.options.debounceMs);

    this.debounceTimers.set(fullPath, timer);
  }

  /**
   * Emit event to callbacks
   */
  private emitEvent(fullPath: string, relativePath: string): void {
    let type: WatchEventType;

    try {
      fs.accessSync(fullPath);
      // File exists - is it new or changed?
      type = 'change';  // We can't easily tell the difference
    } catch {
      type = 'unlink';
    }

    const event: WatchEvent = {
      type,
      path: fullPath,
      relativePath,
      timestamp: new Date(),
    };

    for (const callback of this.callbacks) {
      try {
        callback(event);
      } catch (error) {
        console.error('Watch callback error:', error);
      }
    }
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

let globalWatcher: FileWatcher | null = null;

/**
 * Get or create global file watcher
 */
export function getWatcher(baseDir?: string): FileWatcher {
  if (!globalWatcher && baseDir) {
    globalWatcher = new FileWatcher(baseDir);
  }
  return globalWatcher!;
}

/**
 * Start global file watcher
 */
export function startWatching(baseDir: string, options?: WatcherOptions): FileWatcher {
  if (globalWatcher) {
    globalWatcher.stop();
  }
  globalWatcher = new FileWatcher(baseDir, options);
  globalWatcher.start();
  return globalWatcher;
}

/**
 * Stop global file watcher
 */
export function stopWatching(): void {
  if (globalWatcher) {
    globalWatcher.stop();
    globalWatcher = null;
  }
}

// ============================================================================
// Event Aggregation
// ============================================================================

export interface AggregatedChanges {
  added: string[];
  changed: string[];
  deleted: string[];
  summary: string;
}

/**
 * Aggregate watch events over a time period
 */
export function createChangeAggregator(
  watcher: FileWatcher,
  windowMs = 1000
): {
  getChanges: () => AggregatedChanges;
  clear: () => void;
  destroy: () => void;
} {
  const changes: Map<string, WatchEventType> = new Map();
  let timer: NodeJS.Timeout | null = null;

  const callback = (event: WatchEvent) => {
    changes.set(event.relativePath, event.type);

    // Reset timer
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      // Changes are ready to be consumed
    }, windowMs);
  };

  watcher.on(callback);

  return {
    getChanges(): AggregatedChanges {
      const added: string[] = [];
      const changed: string[] = [];
      const deleted: string[] = [];

      for (const [path, type] of changes) {
        switch (type) {
          case 'add':
            added.push(path);
            break;
          case 'change':
            changed.push(path);
            break;
          case 'unlink':
            deleted.push(path);
            break;
        }
      }

      const parts: string[] = [];
      if (added.length) parts.push(`${added.length} added`);
      if (changed.length) parts.push(`${changed.length} changed`);
      if (deleted.length) parts.push(`${deleted.length} deleted`);

      return {
        added,
        changed,
        deleted,
        summary: parts.length > 0 ? parts.join(', ') : 'No changes',
      };
    },

    clear(): void {
      changes.clear();
    },

    destroy(): void {
      watcher.off(callback);
      if (timer) clearTimeout(timer);
    },
  };
}
