/**
 * Calliope CLI - Storage System
 *
 * Manages ~/.calliope-cli/ directory structure for sessions, todos, and history.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types
// ============================================================================

export interface Session {
  id: string;
  projectPath: string;
  projectName: string;
  createdAt: string;
  lastAccessedAt: string;
  messageCount: number;
  provider: string;
  model: string;
}

export interface ChatMessage {
  id: string;
  timestamp: string;
  role: 'user' | 'assistant' | 'system' | 'tool';
  content: string;
  toolCallId?: string;
}

export interface Todo {
  id: string;
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  priority: 'low' | 'normal' | 'high';
  tags: string[];
  createdAt: string;
  completedAt?: string;
}

export interface Plan {
  id: string;
  title: string;
  phases: PlanPhase[];
  createdAt: string;
  status: 'draft' | 'approved' | 'in_progress' | 'completed' | 'cancelled';
}

export interface PlanPhase {
  name: string;
  steps: string[];
  risk: 'low' | 'medium' | 'high';
  status: 'pending' | 'in_progress' | 'completed' | 'skipped';
}

// ============================================================================
// Paths
// ============================================================================

const CALLIOPE_DIR = path.join(os.homedir(), '.calliope-cli');

export const paths = {
  root: CALLIOPE_DIR,
  config: path.join(CALLIOPE_DIR, 'config.json'),
  sessions: path.join(CALLIOPE_DIR, 'sessions'),
  currentSession: path.join(CALLIOPE_DIR, 'sessions', 'current'),
  todos: path.join(CALLIOPE_DIR, 'todos'),
  globalTodos: path.join(CALLIOPE_DIR, 'todos', 'global.json'),
  projectTodos: path.join(CALLIOPE_DIR, 'todos', 'by-project'),
  templates: path.join(CALLIOPE_DIR, 'templates'),
  planTemplates: path.join(CALLIOPE_DIR, 'templates', 'plans'),
  plugins: path.join(CALLIOPE_DIR, 'plugins'),
  history: path.join(CALLIOPE_DIR, 'history'),
  commandHistory: path.join(CALLIOPE_DIR, 'history', 'commands.txt'),
};

// ============================================================================
// Initialization
// ============================================================================

/**
 * Initialize the storage directory structure
 */
export function initStorage(): void {
  const dirs = [
    paths.root,
    paths.sessions,
    paths.todos,
    paths.projectTodos,
    paths.templates,
    paths.planTemplates,
    paths.plugins,
    paths.history,
  ];

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }
  }

  // Initialize global todos if not exists
  if (!fs.existsSync(paths.globalTodos)) {
    writeJSON(paths.globalTodos, []);
  }
}

// ============================================================================
// JSON Helpers
// ============================================================================

function readJSON<T>(filePath: string, defaultValue: T): T {
  try {
    if (fs.existsSync(filePath)) {
      const content = fs.readFileSync(filePath, 'utf-8');
      return JSON.parse(content);
    }
  } catch {
    // Ignore parse errors, return default
  }
  return defaultValue;
}

function writeJSON(filePath: string, data: unknown): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, JSON.stringify(data, null, 2));
}

// ============================================================================
// Session Management
// ============================================================================

/**
 * Get session directory for a project
 */
function getSessionDir(projectPath: string): string {
  const projectName = path.basename(projectPath) || 'unnamed';
  const date = new Date().toISOString().split('T')[0];
  return path.join(paths.sessions, `${date}_${projectName}`);
}

/**
 * Create or resume a session for the current project
 */
export function getOrCreateSession(projectPath: string): Session {
  initStorage();

  const sessionDir = getSessionDir(projectPath);
  const sessionFile = path.join(sessionDir, 'session.json');

  // Check for existing session today
  if (fs.existsSync(sessionFile)) {
    const session = readJSON<Session>(sessionFile, null as unknown as Session);
    if (session) {
      session.lastAccessedAt = new Date().toISOString();
      writeJSON(sessionFile, session);
      updateCurrentSymlink(sessionDir);
      return session;
    }
  }

  // Create new session
  if (!fs.existsSync(sessionDir)) {
    fs.mkdirSync(sessionDir, { recursive: true });
    fs.mkdirSync(path.join(sessionDir, 'plans'), { recursive: true });
  }

  const session: Session = {
    id: `session_${Date.now()}`,
    projectPath,
    projectName: path.basename(projectPath) || 'unnamed',
    createdAt: new Date().toISOString(),
    lastAccessedAt: new Date().toISOString(),
    messageCount: 0,
    provider: '',
    model: '',
  };

  writeJSON(sessionFile, session);
  writeJSON(path.join(sessionDir, 'chat-history.json'), []);
  writeJSON(path.join(sessionDir, 'todos.json'), []);

  updateCurrentSymlink(sessionDir);

  return session;
}

/**
 * Update the 'current' symlink to point to active session
 */
function updateCurrentSymlink(sessionDir: string): void {
  try {
    if (fs.existsSync(paths.currentSession)) {
      fs.unlinkSync(paths.currentSession);
    }
    fs.symlinkSync(sessionDir, paths.currentSession);
  } catch {
    // Symlinks may not work on all platforms
  }
}

/**
 * Get current session info
 */
export function getCurrentSession(): Session | null {
  try {
    if (fs.existsSync(paths.currentSession)) {
      const sessionFile = path.join(paths.currentSession, 'session.json');
      return readJSON<Session>(sessionFile, null as unknown as Session);
    }
  } catch {
    // Ignore errors
  }
  return null;
}

/**
 * List recent sessions
 */
export function listSessions(limit = 10): Session[] {
  initStorage();

  try {
    const entries = fs.readdirSync(paths.sessions, { withFileTypes: true });
    const sessions: Session[] = [];

    for (const entry of entries) {
      if (entry.isDirectory() && entry.name !== 'current') {
        const sessionFile = path.join(paths.sessions, entry.name, 'session.json');
        const session = readJSON<Session>(sessionFile, null as unknown as Session);
        if (session) {
          sessions.push(session);
        }
      }
    }

    // Sort by last accessed, newest first
    sessions.sort((a, b) =>
      new Date(b.lastAccessedAt).getTime() - new Date(a.lastAccessedAt).getTime()
    );

    return sessions.slice(0, limit);
  } catch {
    return [];
  }
}

// ============================================================================
// Chat History
// ============================================================================

/**
 * Add a message to the current session's chat history
 */
export function addChatMessage(message: Omit<ChatMessage, 'id' | 'timestamp'>): void {
  const session = getCurrentSession();
  if (!session) return;

  const historyFile = path.join(paths.currentSession, 'chat-history.json');
  const history = readJSON<ChatMessage[]>(historyFile, []);

  const newMessage: ChatMessage = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    ...message,
  };

  history.push(newMessage);
  writeJSON(historyFile, history);

  // Update session message count
  const sessionFile = path.join(paths.currentSession, 'session.json');
  session.messageCount = history.length;
  session.lastAccessedAt = new Date().toISOString();
  writeJSON(sessionFile, session);
}

/**
 * Get chat history for current session
 */
export function getChatHistory(limit?: number): ChatMessage[] {
  const historyFile = path.join(paths.currentSession, 'chat-history.json');
  const history = readJSON<ChatMessage[]>(historyFile, []);

  if (limit) {
    return history.slice(-limit);
  }
  return history;
}

/**
 * Search chat history
 */
export function searchChatHistory(query: string): ChatMessage[] {
  const history = getChatHistory();
  const lower = query.toLowerCase();

  return history.filter(msg =>
    msg.content.toLowerCase().includes(lower)
  );
}

// ============================================================================
// TODO Management
// ============================================================================

/**
 * Get todos for current session
 */
export function getSessionTodos(): Todo[] {
  const todosFile = path.join(paths.currentSession, 'todos.json');
  return readJSON<Todo[]>(todosFile, []);
}

/**
 * Get global todos
 */
export function getGlobalTodos(): Todo[] {
  return readJSON<Todo[]>(paths.globalTodos, []);
}

/**
 * Add a todo
 */
export function addTodo(
  content: string,
  options: {
    priority?: 'low' | 'normal' | 'high';
    tags?: string[];
    global?: boolean;
  } = {}
): Todo {
  const todo: Todo = {
    id: `todo_${Date.now()}`,
    content,
    status: 'pending',
    priority: options.priority || 'normal',
    tags: options.tags || [],
    createdAt: new Date().toISOString(),
  };

  if (options.global) {
    const todos = getGlobalTodos();
    todos.push(todo);
    writeJSON(paths.globalTodos, todos);
  } else {
    const todosFile = path.join(paths.currentSession, 'todos.json');
    const todos = readJSON<Todo[]>(todosFile, []);
    todos.push(todo);
    writeJSON(todosFile, todos);
  }

  return todo;
}

/**
 * Update a todo's status
 */
export function updateTodo(
  id: string,
  updates: Partial<Pick<Todo, 'status' | 'content' | 'priority' | 'tags'>>,
  global = false
): Todo | null {
  const filePath = global ? paths.globalTodos : path.join(paths.currentSession, 'todos.json');
  const todos = readJSON<Todo[]>(filePath, []);

  const index = todos.findIndex(t => t.id === id);
  if (index === -1) return null;

  const todo = todos[index];
  Object.assign(todo, updates);

  if (updates.status === 'completed') {
    todo.completedAt = new Date().toISOString();
  }

  writeJSON(filePath, todos);
  return todo;
}

/**
 * Delete a todo
 */
export function deleteTodo(id: string, global = false): boolean {
  const filePath = global ? paths.globalTodos : path.join(paths.currentSession, 'todos.json');
  const todos = readJSON<Todo[]>(filePath, []);

  const index = todos.findIndex(t => t.id === id);
  if (index === -1) return false;

  todos.splice(index, 1);
  writeJSON(filePath, todos);
  return true;
}

// ============================================================================
// Plan Management
// ============================================================================

/**
 * Get plans for current session
 */
export function getPlans(): Plan[] {
  const plansDir = path.join(paths.currentSession, 'plans');
  if (!fs.existsSync(plansDir)) return [];

  const plans: Plan[] = [];
  const entries = fs.readdirSync(plansDir);

  for (const entry of entries) {
    if (entry.endsWith('.json') && entry !== 'active.json') {
      const plan = readJSON<Plan>(path.join(plansDir, entry), null as unknown as Plan);
      if (plan) plans.push(plan);
    }
  }

  return plans.sort((a, b) =>
    new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Save a plan
 */
export function savePlan(plan: Plan): void {
  const plansDir = path.join(paths.currentSession, 'plans');
  if (!fs.existsSync(plansDir)) {
    fs.mkdirSync(plansDir, { recursive: true });
  }

  const planFile = path.join(plansDir, `${plan.id}.json`);
  writeJSON(planFile, plan);
}

/**
 * Get active plan
 */
export function getActivePlan(): Plan | null {
  const activeFile = path.join(paths.currentSession, 'plans', 'active.json');
  return readJSON<Plan>(activeFile, null as unknown as Plan);
}

/**
 * Set active plan
 */
export function setActivePlan(plan: Plan | null): void {
  const activeFile = path.join(paths.currentSession, 'plans', 'active.json');
  if (plan) {
    writeJSON(activeFile, plan);
  } else if (fs.existsSync(activeFile)) {
    fs.unlinkSync(activeFile);
  }
}

// ============================================================================
// Command History
// ============================================================================

/**
 * Add a command to history
 */
export function addCommandToHistory(command: string): void {
  initStorage();

  const timestamp = new Date().toISOString();
  const line = `${timestamp}\t${command}\n`;

  fs.appendFileSync(paths.commandHistory, line);
}

/**
 * Get command history
 */
export function getCommandHistory(limit = 100): string[] {
  if (!fs.existsSync(paths.commandHistory)) return [];

  const content = fs.readFileSync(paths.commandHistory, 'utf-8');
  const lines = content.trim().split('\n');

  return lines
    .slice(-limit)
    .map(line => line.split('\t')[1] || line)
    .filter(Boolean);
}

/**
 * Search command history
 */
export function searchCommandHistory(query: string): string[] {
  const history = getCommandHistory(1000);
  const lower = query.toLowerCase();

  return history.filter(cmd => cmd.toLowerCase().includes(lower));
}
