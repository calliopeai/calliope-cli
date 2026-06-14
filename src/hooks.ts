/**
 * Calliope CLI - Hooks System
 *
 * Pre/post hooks for tool execution, file changes, and events.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { spawn } from 'child_process';

// Debug logging helper
const DEBUG = process.env.CALLIOPE_DEBUG === '1';
function debugLog(message: string, ...args: unknown[]): void {
  if (DEBUG) console.log(`[DEBUG:hooks] ${message}`, ...args);
}

// ============================================================================
// Types
// ============================================================================

export type HookEvent =
  | 'pre-tool'      // Before any tool executes
  | 'post-tool'     // After any tool executes
  | 'pre-shell'     // Before shell command
  | 'post-shell'    // After shell command
  | 'pre-write'     // Before file write
  | 'post-write'    // After file write
  | 'pre-read'      // Before file read
  | 'session-start' // When session starts
  | 'session-end'   // When session ends
  | 'error'         // On error
  | 'message';      // On new message

export interface Hook {
  id: string;
  event: HookEvent;
  name: string;
  command: string;          // Shell command to run
  enabled: boolean;
  async: boolean;           // Run async (don't wait)
  timeout?: number;         // Timeout in ms
  condition?: string;       // Optional condition (tool name, file pattern, etc.)
}

export interface HookContext {
  event: HookEvent;
  tool?: string;
  toolArgs?: Record<string, unknown>;
  toolResult?: string;
  filePath?: string;
  fileContent?: string;
  command?: string;
  exitCode?: number;
  error?: string;
  message?: string;
  messageRole?: string;
}

export interface HookResult {
  success: boolean;
  output?: string;
  error?: string;
  blocked?: boolean;  // If hook blocks the operation
}

// ============================================================================
// Configuration
// ============================================================================

const HOOKS_DIR = path.join(os.homedir(), '.calliope-cli', 'hooks');
const HOOKS_FILE = path.join(HOOKS_DIR, 'hooks.json');

/**
 * Events on which a hook may veto an operation (exit code 42). For these
 * events the hook MUST be awaited so its blocking result is honored, even
 * if the hook is flagged `async`. Otherwise an `async: true` flag could
 * silently neutralize a guardrail.
 */
const BLOCKING_EVENTS: ReadonlySet<HookEvent> = new Set<HookEvent>([
  'pre-tool',
  'pre-shell',
  'pre-write',
  'pre-read',
  'session-start',
]);

function ensureHooksDir(): void {
  if (!fs.existsSync(HOOKS_DIR)) {
    fs.mkdirSync(HOOKS_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * hooks.json is a trust boundary: its `command` strings run as arbitrary
 * shell on routine events. Refuse to load it if it is writable by group or
 * other, since any process that can write it gains persistent code-exec.
 * Returns true if safe to load.
 */
function hooksFileIsSafe(): boolean {
  try {
    const mode = fs.statSync(HOOKS_FILE).mode;
    // Reject if group-writable (0o020) or world-writable (0o002).
    if (mode & 0o022) {
      debugLog(
        `Refusing to load hooks.json: file is group/world-writable (mode ${(mode & 0o777).toString(8)}). ` +
          `Run: chmod 600 ${HOOKS_FILE}`
      );
      return false;
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Load hooks configuration.
 *
 * SECURITY: hooks.json is a trusted file — its `command` strings are executed
 * as shell. It must not be writable by group/other, and the directory must
 * never be agent-writable. Hooks are refused (not executed) if the file has
 * loose permissions.
 */
export function loadHooks(): Hook[] {
  ensureHooksDir();
  if (!fs.existsSync(HOOKS_FILE)) {
    return [];
  }
  if (!hooksFileIsSafe()) {
    return [];
  }
  try {
    return JSON.parse(fs.readFileSync(HOOKS_FILE, 'utf-8'));
  } catch {
    return [];
  }
}

/**
 * Save hooks configuration. Written with restrictive (0600) permissions so the
 * trusted command list is not exposed to or writable by other users.
 */
export function saveHooks(hooks: Hook[]): void {
  ensureHooksDir();
  fs.writeFileSync(HOOKS_FILE, JSON.stringify(hooks, null, 2), { mode: 0o600 });
  // writeFileSync `mode` only applies on create; enforce perms on existing files too.
  try {
    fs.chmodSync(HOOKS_FILE, 0o600);
  } catch {
    /* best effort */
  }
}

// ============================================================================
// Hook Management
// ============================================================================

/**
 * Add a new hook
 */
export function addHook(hook: Omit<Hook, 'id'>): Hook {
  const hooks = loadHooks();
  const newHook: Hook = {
    ...hook,
    id: `hook_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
  };
  hooks.push(newHook);
  saveHooks(hooks);
  return newHook;
}

/**
 * Remove a hook
 */
export function removeHook(id: string): boolean {
  const hooks = loadHooks();
  const index = hooks.findIndex(h => h.id === id);
  if (index === -1) return false;
  hooks.splice(index, 1);
  saveHooks(hooks);
  return true;
}

/**
 * Enable/disable a hook
 */
export function toggleHook(id: string, enabled: boolean): boolean {
  const hooks = loadHooks();
  const hook = hooks.find(h => h.id === id);
  if (!hook) return false;
  hook.enabled = enabled;
  saveHooks(hooks);
  return true;
}

/**
 * Get hooks for a specific event
 */
export function getHooksForEvent(event: HookEvent): Hook[] {
  return loadHooks().filter(h => h.enabled && h.event === event);
}

// ============================================================================
// Hook Execution
// ============================================================================

/**
 * Run a hook command
 */
async function runHookCommand(
  hook: Hook,
  context: HookContext
): Promise<HookResult> {
  return new Promise((resolve) => {
    const timeout = hook.timeout || 10000;

    // Build environment with context
    const env: Record<string, string | undefined> = {
      ...process.env,
      CALLIOPE_EVENT: context.event,
      CALLIOPE_TOOL: context.tool || '',
      CALLIOPE_FILE: context.filePath || '',
      CALLIOPE_COMMAND: context.command || '',
      CALLIOPE_MESSAGE: context.message || '',
      CALLIOPE_ERROR: context.error || '',
    };

    // For tool args, serialize to JSON
    if (context.toolArgs) {
      env.CALLIOPE_TOOL_ARGS = JSON.stringify(context.toolArgs);
    }

    // `detached` puts the shell and its children in their own process group so
    // the timeout can kill the whole group (a shell child cannot escape it).
    const proc = spawn('sh', ['-c', hook.command], {
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
      detached: true,
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    proc.stdout?.on('data', (data) => {
      stdout += data.toString();
    });

    proc.stderr?.on('data', (data) => {
      stderr += data.toString();
    });

    // Signal the whole process group (negative pid) so the shell's children die
    // too. Fall back to signalling the process directly if the group is gone.
    const signalGroup = (signal: NodeJS.Signals): void => {
      try {
        if (proc.pid !== undefined) {
          process.kill(-proc.pid, signal);
        }
      } catch {
        try {
          proc.kill(signal);
        } catch {
          /* already dead */
        }
      }
    };

    // Hard timeout: SIGTERM, then SIGKILL after a short grace period so a
    // command that traps/ignores SIGTERM cannot outlive its timeout.
    const timer = setTimeout(() => {
      timedOut = true;
      signalGroup('SIGTERM');
      killTimer = setTimeout(() => signalGroup('SIGKILL'), 2000);
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);

      if (timedOut) {
        resolve({
          success: false,
          error: 'Hook timed out',
        });
        return;
      }

      // Exit code 42 means "block the operation"
      const blocked = code === 42;

      resolve({
        success: code === 0 || blocked,
        output: stdout.trim(),
        error: stderr.trim() || undefined,
        blocked,
      });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      resolve({
        success: false,
        error: err.message,
      });
    });
  });
}

/**
 * Execute hooks for an event
 */
export async function executeHooks(
  event: HookEvent,
  context: Partial<HookContext>
): Promise<HookResult[]> {
  const hooks = getHooksForEvent(event);
  const results: HookResult[] = [];
  const fullContext: HookContext = { event, ...context };

  for (const hook of hooks) {
    // Check condition if specified
    if (hook.condition) {
      let matches = false;

      // Tool name condition
      if (context.tool && hook.condition.startsWith('tool:')) {
        const toolPattern = hook.condition.slice(5);
        matches = context.tool.includes(toolPattern);
      }
      // File pattern condition
      else if (context.filePath && hook.condition.startsWith('file:')) {
        const filePattern = hook.condition.slice(5);
        matches = context.filePath.includes(filePattern);
      }
      // Command pattern condition
      else if (context.command && hook.condition.startsWith('cmd:')) {
        const cmdPattern = hook.condition.slice(4);
        matches = context.command.includes(cmdPattern);
      }
      // Default: treat as general pattern
      else {
        matches = JSON.stringify(context).includes(hook.condition);
      }

      if (!matches) continue;
    }

    // For blocking events, the exit-42 veto contract must be enforced, so the
    // hook is always awaited regardless of its `async` flag. Allowing
    // fire-and-forget here would let `async: true` silently neutralize a
    // guardrail (the discarded result could never set `blocked`).
    if (hook.async && !BLOCKING_EVENTS.has(event)) {
      // Fire and forget with debug logging
      runHookCommand(hook, fullContext).catch((err) => {
        debugLog(`Async hook '${hook.id}' failed:`, err instanceof Error ? err.message : err);
      });
      results.push({ success: true });
    } else {
      const result = await runHookCommand(hook, fullContext);
      results.push(result);

      // If hook blocks, stop executing more hooks
      if (result.blocked) {
        break;
      }
    }
  }

  return results;
}

/**
 * Check if any hooks would block an operation
 */
export async function checkHooksAllow(
  event: HookEvent,
  context: Partial<HookContext>
): Promise<{ allowed: boolean; reason?: string }> {
  const results = await executeHooks(event, context);

  for (const result of results) {
    if (result.blocked) {
      return {
        allowed: false,
        reason: result.output || result.error || 'Blocked by hook',
      };
    }
  }

  return { allowed: true };
}

// ============================================================================
// Built-in Hooks
// ============================================================================

/**
 * Initialize default hooks
 */
export function initDefaultHooks(): void {
  const hooks = loadHooks();
  if (hooks.length > 0) return;

  // Add some example hooks (disabled by default)
  const defaults: Array<Omit<Hook, 'id'>> = [
    {
      event: 'post-shell',
      name: 'Log dangerous commands',
      command: 'echo "$CALLIOPE_COMMAND" >> ~/.calliope-cli/hooks/command-log.txt',
      enabled: false,
      async: true,
      condition: 'cmd:rm -rf',
    },
    {
      event: 'post-write',
      name: 'Format on save',
      command: 'prettier --write "$CALLIOPE_FILE" 2>/dev/null || true',
      enabled: false,
      async: true,
      condition: 'file:.ts',
    },
    {
      event: 'pre-shell',
      name: 'Block sudo',
      command: 'if echo "$CALLIOPE_COMMAND" | grep -q "^sudo"; then exit 42; fi',
      enabled: false,
      async: false,
      condition: 'cmd:sudo',
    },
  ];

  for (const hook of defaults) {
    addHook(hook);
  }
}

/**
 * List all hooks formatted for display
 */
export function listHooksFormatted(): string {
  const hooks = loadHooks();
  if (hooks.length === 0) {
    return 'No hooks configured.';
  }

  const lines = hooks.map(h => {
    const status = h.enabled ? '✓' : '✗';
    const async = h.async ? '(async)' : '';
    return `${status} [${h.event}] ${h.name} ${async}\n  ${h.command}`;
  });

  return lines.join('\n\n');
}
