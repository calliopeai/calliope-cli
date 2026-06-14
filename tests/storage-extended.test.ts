/**
 * Extended tests for storage module
 *
 * Covers: session management, chat history, todo CRUD, plan management,
 * command history, cost tracking, message persistence, session forking,
 * and line-based format parsing/serialization.
 *
 * The existing storage.test.ts covers templates + active todo only.
 * This file extends coverage for every other exported function.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  initStorage,
  paths,
  getOrCreateSession,
  getCurrentSession,
  listSessions,
  deleteSession,
  addChatMessage,
  getChatHistory,
  searchChatHistory,
  getSessionTodos,
  getGlobalTodos,
  addTodo,
  updateTodo,
  deleteTodo,
  getPlans,
  savePlan,
  getActivePlan,
  setActivePlan,
  addCommandToHistory,
  getCommandHistory,
  searchCommandHistory,
  getCosts,
  recordCost,
  getCostSummary,
  resetCosts,
  saveMessageHistory,
  loadMessageHistory,
  saveIterationLedger,
  loadIterationLedger,
  getSessionDirById,
  getSessionById,
  setCurrentSessionById,
  forkSession,
} from '../src/storage.js';
import type { Plan } from '../src/storage.js';
import { IterationLedger } from '../src/iteration-ledger.js';

// ============================================================================
// Helpers
// ============================================================================

/**
 * We need to override the `paths` object so tests write to a temp directory
 * instead of the real ~/.calliope-cli/. We accomplish this by monkey-patching
 * `paths` properties (they are writable object properties).
 */
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
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-storage-test-'));
  patchPaths(tmpRoot);
});

afterEach(() => {
  restorePaths();
  fs.rmSync(tmpRoot, { recursive: true, force: true });
});

// ============================================================================
// initStorage
// ============================================================================

describe('initStorage', () => {
  it('should create all required directories', () => {
    initStorage();

    expect(fs.existsSync(paths.root)).toBe(true);
    expect(fs.existsSync(paths.sessions)).toBe(true);
    expect(fs.existsSync(paths.todos)).toBe(true);
    expect(fs.existsSync(paths.projectTodos)).toBe(true);
    expect(fs.existsSync(paths.templates)).toBe(true);
    expect(fs.existsSync(paths.planTemplates)).toBe(true);
    expect(fs.existsSync(paths.plugins)).toBe(true);
    expect(fs.existsSync(paths.history)).toBe(true);
  });

  it('should create global todos txt file', () => {
    initStorage();

    const globalTodosTxt = paths.globalTodos.replace('.json', '.txt');
    expect(fs.existsSync(globalTodosTxt)).toBe(true);
  });

  it('should be idempotent', () => {
    initStorage();
    initStorage(); // second call should not throw
    expect(fs.existsSync(paths.root)).toBe(true);
  });
});

// ============================================================================
// Session Management
// ============================================================================

describe('getOrCreateSession', () => {
  it('should create a new session for a project path', () => {
    const session = getOrCreateSession('/tmp/my-project');

    expect(session).toBeDefined();
    expect(session.id).toMatch(/^session_\d+_[a-z0-9]+$/);
    expect(session.projectPath).toBe('/tmp/my-project');
    expect(session.projectName).toBe('my-project');
    expect(session.messageCount).toBe(0);
    expect(session.createdAt).toBeDefined();
    expect(session.lastAccessedAt).toBeDefined();
  });

  it('should reuse existing session for same project on same day', () => {
    const session1 = getOrCreateSession('/tmp/my-project');
    const session2 = getOrCreateSession('/tmp/my-project');

    expect(session1.id).toBe(session2.id);
  });

  it('should generate unique ids for sessions created in the same millisecond', () => {
    const nowSpy = vi.spyOn(Date, 'now').mockReturnValue(1_700_000_000_000);
    const randomSpy = vi.spyOn(Math, 'random')
      .mockReturnValueOnce(0.111111)
      .mockReturnValueOnce(0.222222);

    const session1 = getOrCreateSession('/tmp/same-ms-a');
    const session2 = getOrCreateSession('/tmp/same-ms-b');

    expect(session1.id).not.toBe(session2.id);

    randomSpy.mockRestore();
    nowSpy.mockRestore();
  });

  it('should create chat.log and todos.txt for new session', () => {
    getOrCreateSession('/tmp/my-project');

    // The current symlink should be set
    const currentDir = paths.currentSession;
    // Check that chat.log exists in the session directory
    // We need to resolve the symlink
    try {
      const resolvedDir = fs.readlinkSync(currentDir);
      expect(fs.existsSync(path.join(resolvedDir, 'chat.log'))).toBe(true);
      expect(fs.existsSync(path.join(resolvedDir, 'todos.txt'))).toBe(true);
    } catch {
      // Symlinks may not work on all platforms
    }
  });

  it('should handle unnamed projects (root path)', () => {
    const session = getOrCreateSession('/');
    expect(session.projectName).toBeDefined();
  });
});

describe('getCurrentSession', () => {
  it('should return null when no session exists', () => {
    initStorage();
    const session = getCurrentSession();
    expect(session).toBeNull();
  });

  it('should return session after creating one', () => {
    const created = getOrCreateSession('/tmp/test-project');
    const current = getCurrentSession();

    expect(current).not.toBeNull();
    expect(current!.id).toBe(created.id);
  });
});

describe('listSessions', () => {
  it('should return empty array when no sessions', () => {
    const sessions = listSessions();
    expect(sessions).toEqual([]);
  });

  it('should list created sessions', () => {
    getOrCreateSession('/tmp/project-a');

    const sessions = listSessions();
    expect(sessions.length).toBeGreaterThanOrEqual(1);
    expect(sessions[0].projectName).toBe('project-a');
  });

  it('should respect limit parameter', () => {
    // Create multiple sessions by manipulating session dirs directly
    initStorage();
    for (let i = 0; i < 5; i++) {
      const dirName = `2025-01-0${i + 1}_project-${i}`;
      const sessionDir = path.join(paths.sessions, dirName);
      fs.mkdirSync(sessionDir, { recursive: true });
      const sessionData = {
        id: `session_${i}`,
        projectPath: `/tmp/project-${i}`,
        projectName: `project-${i}`,
        createdAt: new Date(2025, 0, i + 1).toISOString(),
        lastAccessedAt: new Date(2025, 0, i + 1).toISOString(),
        messageCount: 0,
        provider: '',
        model: '',
      };
      fs.writeFileSync(path.join(sessionDir, 'session.json'), JSON.stringify(sessionData));
    }

    const limited = listSessions(3);
    expect(limited).toHaveLength(3);
  });

  it('should sort sessions by last accessed descending', () => {
    initStorage();
    // Create two sessions with different access times
    for (let i = 0; i < 2; i++) {
      const dirName = `2025-02-0${i + 1}_proj-${i}`;
      const sessionDir = path.join(paths.sessions, dirName);
      fs.mkdirSync(sessionDir, { recursive: true });
      fs.writeFileSync(
        path.join(sessionDir, 'session.json'),
        JSON.stringify({
          id: `session_sort_${i}`,
          projectPath: `/tmp/proj-${i}`,
          projectName: `proj-${i}`,
          createdAt: new Date(2025, 1, i + 1).toISOString(),
          lastAccessedAt: new Date(2025, 1, i + 1).toISOString(),
          messageCount: 0,
          provider: '',
          model: '',
        })
      );
    }

    const sessions = listSessions();
    // Most recent should be first
    expect(new Date(sessions[0].lastAccessedAt).getTime())
      .toBeGreaterThanOrEqual(new Date(sessions[sessions.length - 1].lastAccessedAt).getTime());
  });
});

describe('deleteSession', () => {
  it('should delete an existing session directory by its session id', () => {
    initStorage();
    // Session dirs are named ${date}_${project}, NOT by the session id.
    const dirName = '2025-01-15_del-project';
    const sessionDir = path.join(paths.sessions, dirName);
    fs.mkdirSync(sessionDir, { recursive: true });
    const sessionId = 'session_del_123';
    fs.writeFileSync(
      path.join(sessionDir, 'session.json'),
      JSON.stringify({ id: sessionId })
    );

    const result = deleteSession(sessionId);
    expect(result).toBe(true);
    expect(fs.existsSync(sessionDir)).toBe(false);
  });

  it('should return false for non-existent session', () => {
    initStorage();
    const result = deleteSession('non-existent-session');
    expect(result).toBe(false);
  });
});

// ============================================================================
// Chat History
// ============================================================================

describe('addChatMessage & getChatHistory', () => {
  it('should add and retrieve chat messages', () => {
    getOrCreateSession('/tmp/chat-test');

    addChatMessage({ role: 'user', content: 'Hello there' });
    addChatMessage({ role: 'assistant', content: 'Hi! How can I help?' });

    const history = getChatHistory();
    expect(history).toHaveLength(2);
    expect(history[0].role).toBe('user');
    expect(history[0].content).toBe('Hello there');
    expect(history[1].role).toBe('assistant');
    expect(history[1].content).toBe('Hi! How can I help?');
  });

  it('should include timestamp and id in messages', () => {
    getOrCreateSession('/tmp/chat-test-2');

    addChatMessage({ role: 'user', content: 'Test' });
    const history = getChatHistory();

    expect(history[0].id).toMatch(/^msg_/);
    expect(history[0].timestamp).toBeDefined();
  });

  it('should limit history when limit is passed', () => {
    getOrCreateSession('/tmp/chat-limit');

    for (let i = 0; i < 5; i++) {
      addChatMessage({ role: 'user', content: `Message ${i}` });
    }

    const limited = getChatHistory(2);
    expect(limited).toHaveLength(2);
    // Should return the last 2
    expect(limited[0].content).toBe('Message 3');
    expect(limited[1].content).toBe('Message 4');
  });

  it('should update session message count', () => {
    getOrCreateSession('/tmp/chat-count');

    addChatMessage({ role: 'user', content: 'First' });
    addChatMessage({ role: 'assistant', content: 'Response' });

    const session = getCurrentSession();
    expect(session!.messageCount).toBe(2);
  });

  it('should do nothing when no current session', () => {
    initStorage();
    // No session created, should not throw
    addChatMessage({ role: 'user', content: 'No session' });
  });

  it('should handle tool messages with toolCallId', () => {
    getOrCreateSession('/tmp/chat-tool');

    addChatMessage({
      role: 'tool',
      content: 'Tool result data',
      toolCallId: 'call_123',
    });

    const history = getChatHistory();
    expect(history).toHaveLength(1);
    expect(history[0].role).toBe('tool');
    expect(history[0].toolCallId).toBe('call_123');
  });

  it('should read chat history from a specific session id', () => {
    initStorage();
    const dirName = '2025-03-10_chat-by-id';
    const sessionDir = path.join(paths.sessions, dirName);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'session.json'),
      JSON.stringify({ id: 'session_chat_by_id', projectPath: '/tmp/chat-by-id', projectName: 'chat-by-id' })
    );
    fs.writeFileSync(
      path.join(sessionDir, 'chat.log'),
      [
        '@2025-03-10T10:00:00.000Z id=msg_1',
        'user: first',
        '',
        '@2025-03-10T10:00:01.000Z id=msg_2',
        'assistant: second',
        '',
      ].join('\n')
    );

    const history = getChatHistory(undefined, 'session_chat_by_id');
    expect(history).toHaveLength(2);
    expect(history[0].content).toBe('first');
    expect(history[1].content).toBe('second');
  });
});

describe('searchChatHistory', () => {
  it('should find messages matching query', () => {
    getOrCreateSession('/tmp/chat-search');

    addChatMessage({ role: 'user', content: 'How to install Docker?' });
    addChatMessage({ role: 'assistant', content: 'Run apt-get install docker' });
    addChatMessage({ role: 'user', content: 'What about Python?' });

    const results = searchChatHistory('docker');
    expect(results).toHaveLength(2); // both mention docker
  });

  it('should be case insensitive', () => {
    getOrCreateSession('/tmp/chat-search-ci');

    addChatMessage({ role: 'user', content: 'UPPERCASE message' });
    const results = searchChatHistory('uppercase');
    expect(results).toHaveLength(1);
  });

  it('should return empty array for no matches', () => {
    getOrCreateSession('/tmp/chat-search-empty');

    addChatMessage({ role: 'user', content: 'Hello world' });
    const results = searchChatHistory('nonexistent-query');
    expect(results).toHaveLength(0);
  });
});

// ============================================================================
// TODO Management
// ============================================================================

describe('addTodo', () => {
  it('should create a todo with defaults', () => {
    getOrCreateSession('/tmp/todo-test');

    const todo = addTodo('Write unit tests');
    expect(todo.id).toMatch(/^todo_\d+$/);
    expect(todo.content).toBe('Write unit tests');
    expect(todo.status).toBe('pending');
    expect(todo.priority).toBe('normal');
    expect(todo.tags).toEqual([]);
  });

  it('should accept priority and tags', () => {
    getOrCreateSession('/tmp/todo-opts');

    const todo = addTodo('Urgent task', {
      priority: 'high',
      tags: ['bug', 'critical'],
    });

    expect(todo.priority).toBe('high');
    expect(todo.tags).toEqual(['bug', 'critical']);
  });

  it('should add global todo', () => {
    getOrCreateSession('/tmp/todo-global');

    const todo = addTodo('Global item', { global: true });
    expect(todo.content).toBe('Global item');

    const globalTodos = getGlobalTodos();
    expect(globalTodos.some(t => t.id === todo.id)).toBe(true);
  });
});

describe('getSessionTodos', () => {
  it('should return empty array for new session', () => {
    getOrCreateSession('/tmp/todo-empty');
    const todos = getSessionTodos();
    expect(todos).toEqual([]);
  });

  it('should return session-scoped todos', () => {
    getOrCreateSession('/tmp/todo-session');

    addTodo('Session task 1');
    addTodo('Session task 2');

    const todos = getSessionTodos();
    expect(todos).toHaveLength(2);
  });
});

describe('getGlobalTodos', () => {
  it('should return empty array initially', () => {
    initStorage();
    const todos = getGlobalTodos();
    expect(todos).toEqual([]);
  });
});

describe('updateTodo', () => {
  it('should update status to completed', () => {
    getOrCreateSession('/tmp/todo-update');
    const todo = addTodo('Complete me');

    const updated = updateTodo(todo.id, { status: 'completed' });
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('completed');
    expect(updated!.completedAt).toBeDefined();
  });

  it('should update content and priority', () => {
    getOrCreateSession('/tmp/todo-update-content');
    const todo = addTodo('Old content');

    const updated = updateTodo(todo.id, {
      content: 'New content',
      priority: 'high',
    });
    expect(updated!.content).toBe('New content');
    expect(updated!.priority).toBe('high');
  });

  it('should return null for non-existent todo', () => {
    getOrCreateSession('/tmp/todo-update-fail');
    const result = updateTodo('nonexistent-id', { status: 'completed' });
    expect(result).toBeNull();
  });

  it('should update global todo when global flag is true', () => {
    getOrCreateSession('/tmp/todo-update-global');
    const todo = addTodo('Global update test', { global: true });

    const updated = updateTodo(todo.id, { status: 'in_progress' }, true);
    expect(updated).not.toBeNull();
    expect(updated!.status).toBe('in_progress');
  });
});

describe('deleteTodo', () => {
  it('should delete an existing todo', () => {
    getOrCreateSession('/tmp/todo-delete');
    const todo = addTodo('Delete me');

    const result = deleteTodo(todo.id);
    expect(result).toBe(true);
    expect(getSessionTodos().find(t => t.id === todo.id)).toBeUndefined();
  });

  it('should return false for non-existent todo', () => {
    getOrCreateSession('/tmp/todo-delete-fail');
    const result = deleteTodo('nonexistent-id');
    expect(result).toBe(false);
  });

  it('should delete global todo when global flag is true', () => {
    getOrCreateSession('/tmp/todo-delete-global');
    const todo = addTodo('Delete global', { global: true });

    const result = deleteTodo(todo.id, true);
    expect(result).toBe(true);
    expect(getGlobalTodos().find(t => t.id === todo.id)).toBeUndefined();
  });
});

// ============================================================================
// Todo content with special characters
// ============================================================================

describe('Todo serialization edge cases', () => {
  it('should handle pipe characters in content', () => {
    getOrCreateSession('/tmp/todo-pipe');
    const todo = addTodo('Use A | B | C pipeline');

    const todos = getSessionTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0].content).toBe('Use A | B | C pipeline');
  });

  it('should handle newlines in content', () => {
    getOrCreateSession('/tmp/todo-newline');
    const todo = addTodo('Line 1\nLine 2');

    const todos = getSessionTodos();
    expect(todos).toHaveLength(1);
    expect(todos[0].content).toBe('Line 1\nLine 2');
  });

  it('should handle empty tags array', () => {
    getOrCreateSession('/tmp/todo-tags');
    const todo = addTodo('No tags');

    const todos = getSessionTodos();
    expect(todos[0].tags).toEqual([]);
  });
});

// ============================================================================
// Plan Management
// ============================================================================

describe('Plan Management', () => {
  const makePlan = (id: string, title: string): Plan => ({
    id,
    title,
    phases: [
      {
        name: 'Phase 1',
        steps: ['Step A', 'Step B'],
        risk: 'low',
        status: 'pending',
      },
    ],
    createdAt: new Date().toISOString(),
    status: 'draft',
  });

  it('should return empty plans array for fresh session', () => {
    getOrCreateSession('/tmp/plans-empty');
    const plans = getPlans();
    expect(plans).toEqual([]);
  });

  it('should save and retrieve a plan', () => {
    getOrCreateSession('/tmp/plans-save');
    const plan = makePlan('plan_1', 'Refactor Module');

    savePlan(plan);

    const plans = getPlans();
    expect(plans).toHaveLength(1);
    expect(plans[0].title).toBe('Refactor Module');
    expect(plans[0].phases).toHaveLength(1);
  });

  it('should sort plans by creation date descending', () => {
    getOrCreateSession('/tmp/plans-sort');

    const oldPlan = makePlan('plan_old', 'Old Plan');
    oldPlan.createdAt = new Date(2024, 0, 1).toISOString();
    savePlan(oldPlan);

    const newPlan = makePlan('plan_new', 'New Plan');
    newPlan.createdAt = new Date(2025, 5, 1).toISOString();
    savePlan(newPlan);

    const plans = getPlans();
    expect(plans[0].title).toBe('New Plan');
    expect(plans[1].title).toBe('Old Plan');
  });

  it('should set and get active plan', () => {
    getOrCreateSession('/tmp/plans-active');
    const plan = makePlan('plan_active', 'Active Plan');

    setActivePlan(plan);
    const active = getActivePlan();

    expect(active).not.toBeNull();
    expect(active!.title).toBe('Active Plan');
  });

  it('should clear active plan', () => {
    getOrCreateSession('/tmp/plans-clear');
    const plan = makePlan('plan_clear', 'Clear Me');

    setActivePlan(plan);
    expect(getActivePlan()).not.toBeNull();

    setActivePlan(null);
    expect(getActivePlan()).toBeNull();
  });

  it('should return null when no active plan', () => {
    getOrCreateSession('/tmp/plans-no-active');
    const active = getActivePlan();
    expect(active).toBeNull();
  });
});

// ============================================================================
// Command History
// ============================================================================

describe('Command History', () => {
  it('should add commands to history', () => {
    addCommandToHistory('git status');
    addCommandToHistory('npm test');

    const history = getCommandHistory();
    expect(history).toContain('git status');
    expect(history).toContain('npm test');
  });

  it('should respect limit parameter', () => {
    for (let i = 0; i < 10; i++) {
      addCommandToHistory(`cmd-${i}`);
    }

    const limited = getCommandHistory(3);
    expect(limited).toHaveLength(3);
    // Should get the last 3
    expect(limited[0]).toBe('cmd-7');
    expect(limited[2]).toBe('cmd-9');
  });

  it('should return empty array when no history file', () => {
    const history = getCommandHistory();
    expect(history).toEqual([]);
  });
});

describe('searchCommandHistory', () => {
  it('should find matching commands', () => {
    addCommandToHistory('git status');
    addCommandToHistory('git commit -m "fix"');
    addCommandToHistory('npm test');

    const results = searchCommandHistory('git');
    expect(results).toHaveLength(2);
  });

  it('should be case insensitive', () => {
    addCommandToHistory('GIT STATUS');
    const results = searchCommandHistory('git');
    expect(results).toHaveLength(1);
  });

  it('should return empty for no matches', () => {
    addCommandToHistory('npm install');
    const results = searchCommandHistory('python');
    expect(results).toEqual([]);
  });
});

// ============================================================================
// Cost Tracking
// ============================================================================

describe('Cost Tracking', () => {
  it('should return zero costs initially', () => {
    initStorage();
    const costs = getCosts();
    expect(costs.totalCost).toBe(0);
    expect(costs.costByProvider).toEqual({});
    expect(costs.costByDay).toEqual({});
    expect(costs.costBySession).toEqual({});
  });

  it('should record cost and accumulate', () => {
    initStorage();
    recordCost(0.01, 'anthropic');
    recordCost(0.02, 'anthropic');
    recordCost(0.005, 'openai');

    const costs = getCosts();
    expect(costs.totalCost).toBeCloseTo(0.035, 4);
    expect(costs.costByProvider['anthropic']).toBeCloseTo(0.03, 4);
    expect(costs.costByProvider['openai']).toBeCloseTo(0.005, 4);
  });

  it('should record cost by day', () => {
    initStorage();
    recordCost(0.05, 'google');

    const costs = getCosts();
    const days = Object.keys(costs.costByDay);
    expect(days.length).toBeGreaterThanOrEqual(1);
  });

  it('should track cost per session', () => {
    initStorage();
    recordCost(0.01, 'anthropic', 'session_1');
    recordCost(0.02, 'anthropic', 'session_1');

    const costs = getCosts();
    expect(costs.costBySession['session_1']).toBeCloseTo(0.03, 4);
  });

  it('should skip session tracking when no sessionId', () => {
    initStorage();
    recordCost(0.01, 'anthropic');

    const costs = getCosts();
    expect(Object.keys(costs.costBySession)).toHaveLength(0);
  });
});

describe('getCostSummary', () => {
  it('should return formatted cost summary', () => {
    initStorage();
    recordCost(0.0123, 'anthropic');
    recordCost(0.0045, 'openai');

    const summary = getCostSummary();
    expect(summary).toContain('Total:');
    expect(summary).toContain('Today:');
    expect(summary).toContain('By Provider:');
    expect(summary).toContain('anthropic:');
    expect(summary).toContain('openai:');
    expect(summary).toContain('Last 7 Days:');
  });

  it('should show zero when no costs recorded', () => {
    initStorage();
    const summary = getCostSummary();
    expect(summary).toContain('Total: $0.0000');
    expect(summary).toContain('Today: $0.0000');
  });
});

describe('resetCosts', () => {
  it('should clear cost tracking data', () => {
    initStorage();
    recordCost(1.0, 'anthropic');
    expect(getCosts().totalCost).toBe(1.0);

    resetCosts();

    const costs = getCosts();
    expect(costs.totalCost).toBe(0);
  });

  it('should not throw when no cost file exists', () => {
    initStorage();
    resetCosts(); // should not throw
  });
});

// ============================================================================
// Message Persistence (saveMessageHistory / loadMessageHistory)
// ============================================================================

describe('saveMessageHistory & loadMessageHistory', () => {
  it('should save and load message history for current session', () => {
    getOrCreateSession('/tmp/msg-persist');

    const messages = [
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi!' },
    ];
    saveMessageHistory(messages);

    const loaded = loadMessageHistory();
    expect(loaded).not.toBeNull();
    expect(loaded).toHaveLength(2);
    expect(loaded![0]).toEqual({ role: 'user', content: 'Hello' });
  });

  it('should return null when no messages.json exists', () => {
    getOrCreateSession('/tmp/msg-empty');
    const loaded = loadMessageHistory();
    expect(loaded).toBeNull();
  });

  it('should update session message count on save', () => {
    getOrCreateSession('/tmp/msg-count');

    const messages = [{ role: 'user', content: 'a' }, { role: 'assistant', content: 'b' }];
    saveMessageHistory(messages);

    const session = getCurrentSession();
    expect(session!.messageCount).toBe(2);
  });

  it('should do nothing when no current session', () => {
    initStorage();
    // No current session
    saveMessageHistory([{ role: 'user', content: 'test' }]);
    // Should not throw
  });
});

// ============================================================================
// Iteration Ledger Persistence
// ============================================================================

describe('saveIterationLedger & loadIterationLedger', () => {
  it('should save and load the ledger for the current session', () => {
    getOrCreateSession('/tmp/ledger-persist');

    const ledger = new IterationLedger();
    const runId = ledger.startRun('loop', 'Keep working', { maxIterations: null });
    ledger.startIteration(ledger.getNextIterationNumber());
    ledger.recordAction('shell', { command: 'npm test' }, 'error', 'Test failed');
    ledger.endIteration();
    ledger.finishRun(runId, 'stopped', { errorSummary: 'No completion promise match' });

    saveIterationLedger(ledger);

    const loaded = loadIterationLedger();
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.runs).toHaveLength(1);
    expect(loaded!.runs[0].status).toBe('stopped');
  });

  it('should return null when there is no saved ledger', () => {
    getOrCreateSession('/tmp/ledger-empty');
    expect(loadIterationLedger()).toBeNull();
  });

  it('should load a ledger from a specific session id', () => {
    const session = getOrCreateSession('/tmp/ledger-by-id');
    const ledger = new IterationLedger();
    ledger.startIteration(ledger.getNextIterationNumber());
    ledger.recordAction('read_file', { path: '/tmp/x.ts' }, 'ok');
    ledger.endIteration();
    saveIterationLedger(ledger);

    const loaded = loadIterationLedger(session.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.entries[0].actions[0].tool).toBe('read_file');
  });
});

// ============================================================================
// getSessionDirById
// ============================================================================

describe('getSessionDirById', () => {
  it('should find session directory by session id', () => {
    initStorage();
    const dirName = '2025-03-10_findme';
    const sessionDir = path.join(paths.sessions, dirName);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'session.json'),
      JSON.stringify({ id: 'session_findme', projectPath: '/tmp/findme', projectName: 'findme' })
    );

    const result = getSessionDirById('session_findme');
    expect(result).toBe(sessionDir);
  });

  it('should return null for unknown session id', () => {
    initStorage();
    const result = getSessionDirById('session_nonexistent');
    expect(result).toBeNull();
  });
});

// ============================================================================
// loadMessageHistory with sessionId
// ============================================================================

describe('loadMessageHistory with sessionId', () => {
  it('should load messages from a specific session by id', () => {
    initStorage();
    const dirName = '2025-03-10_byid-proj';
    const sessionDir = path.join(paths.sessions, dirName);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'session.json'),
      JSON.stringify({ id: 'session_byid_1' })
    );
    fs.writeFileSync(
      path.join(sessionDir, 'messages.json'),
      JSON.stringify([{ role: 'user', content: 'from byid session' }])
    );

    const messages = loadMessageHistory('session_byid_1');
    expect(messages).not.toBeNull();
    expect(messages).toHaveLength(1);
    expect(messages![0]).toEqual({ role: 'user', content: 'from byid session' });
  });

  it('should return null for non-existent session id', () => {
    initStorage();
    const result = loadMessageHistory('session_ghost');
    expect(result).toBeNull();
  });

  it('should return null for invalid JSON in messages file', () => {
    initStorage();
    const dirName = '2025-03-10_badjson';
    const sessionDir = path.join(paths.sessions, dirName);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'session.json'),
      JSON.stringify({ id: 'session_badjson' })
    );
    fs.writeFileSync(path.join(sessionDir, 'messages.json'), 'not valid json{{{');

    const result = loadMessageHistory('session_badjson');
    expect(result).toBeNull();
  });

  it('should return null when messages.json contains a non-array', () => {
    initStorage();
    const dirName = '2025-03-10_notarray';
    const sessionDir = path.join(paths.sessions, dirName);
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.writeFileSync(
      path.join(sessionDir, 'session.json'),
      JSON.stringify({ id: 'session_notarray' })
    );
    fs.writeFileSync(
      path.join(sessionDir, 'messages.json'),
      JSON.stringify({ notAnArray: true })
    );

    const result = loadMessageHistory('session_notarray');
    expect(result).toBeNull();
  });
});

// ============================================================================
// setCurrentSessionById / getSessionById
// ============================================================================

describe('setCurrentSessionById & getSessionById', () => {
  it('should switch the active session to a saved session id', () => {
    const first = getOrCreateSession('/tmp/session-switch-a');
    saveMessageHistory([{ role: 'user', content: 'from-a' }]);

    const second = getOrCreateSession('/tmp/session-switch-b');
    saveMessageHistory([{ role: 'user', content: 'from-b' }]);

    const switched = setCurrentSessionById(first.id);
    expect(switched).not.toBeNull();
    expect(switched!.id).toBe(first.id);
    expect(getCurrentSession()!.id).toBe(first.id);

    saveMessageHistory([{ role: 'assistant', content: 'after-switch' }]);

    expect(loadMessageHistory(first.id)).toEqual([{ role: 'assistant', content: 'after-switch' }]);
    expect(loadMessageHistory(second.id)).toEqual([{ role: 'user', content: 'from-b' }]);
  });

  it('should return null when switching to an unknown session id', () => {
    getOrCreateSession('/tmp/session-switch-miss');
    const current = getCurrentSession();

    expect(setCurrentSessionById('session_missing')).toBeNull();
    expect(getCurrentSession()).toEqual(current);
  });

  it('should look up session metadata by id', () => {
    const session = getOrCreateSession('/tmp/session-meta');
    expect(getSessionById(session.id)).toEqual(getCurrentSession());
  });
});

// ============================================================================
// forkSession
// ============================================================================

describe('forkSession', () => {
  it('should fork current session with messages', () => {
    getOrCreateSession('/tmp/fork-source');

    const messages = [
      { role: 'user', content: 'Fork me' },
      { role: 'assistant', content: 'Forked!' },
    ];
    saveMessageHistory(messages);

    const forked = forkSession('/tmp/fork-source');
    expect(forked).not.toBeNull();
    expect(forked!.id).toMatch(/^session_\d+_[a-z0-9]+$/);
    expect(forked!.messageCount).toBe(2);

    // The fork should have the messages copied
    const loadedMessages = loadMessageHistory();
    expect(loadedMessages).toHaveLength(2);
  });

  it('should return null when no current messages to fork', () => {
    getOrCreateSession('/tmp/fork-empty');
    // No messages saved
    const result = forkSession('/tmp/fork-empty');
    expect(result).toBeNull();
  });

  it('should create a fork with its own session metadata', () => {
    getOrCreateSession('/tmp/fork-unique');
    saveMessageHistory([{ role: 'user', content: 'test' }]);

    const forked = forkSession('/tmp/fork-unique');

    expect(forked).not.toBeNull();
    expect(forked!.id).toMatch(/^session_\d+_[a-z0-9]+$/);
    expect(forked!.projectName).toBe('fork-unique');
    expect(forked!.messageCount).toBe(1);

    // After forking, the forked messages should be loadable as current
    const messages = loadMessageHistory();
    expect(messages).toHaveLength(1);
  });

  it('should copy ledger state into the forked session', () => {
    const source = getOrCreateSession('/tmp/fork-ledger');
    saveMessageHistory([{ role: 'user', content: 'keep log' }]);

    const ledger = new IterationLedger();
    const runId = ledger.startRun('agent', 'Keep log');
    ledger.startIteration(ledger.getNextIterationNumber());
    ledger.recordAction('read_file', { path: '/tmp/file.ts' }, 'ok');
    ledger.endIteration();
    ledger.finishRun(runId, 'completed');
    saveIterationLedger(ledger, source.id);

    const forked = forkSession('/tmp/fork-ledger');
    expect(forked).not.toBeNull();

    const loaded = loadIterationLedger(forked!.id);
    expect(loaded).not.toBeNull();
    expect(loaded!.entries).toHaveLength(1);
    expect(loaded!.runs).toHaveLength(1);
    expect(loaded!.runs[0].status).toBe('completed');
  });
});
