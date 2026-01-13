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

  // Initialize global todos if not exists (line-based format)
  const globalTodosFile = paths.globalTodos.replace('.json', '.txt');
  if (!fs.existsSync(globalTodosFile)) {
    fs.writeFileSync(globalTodosFile, '');
  }
}

// ============================================================================
// JSON Helpers (for config/session metadata)
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
// Line-based Format Helpers (for chat/todos - more token efficient)
// ============================================================================

/**
 * Chat format (human readable, minimal tokens):
 * @2025-01-09T12:34:56 id=msg_123
 * role: content here
 * can span multiple lines
 *
 * @2025-01-09T12:34:57 id=msg_124
 * assistant: response here
 */

function formatChatMessage(msg: ChatMessage): string {
  const header = `@${msg.timestamp} id=${msg.id}${msg.toolCallId ? ` tool=${msg.toolCallId}` : ''}`;
  const content = `${msg.role}: ${msg.content}`;
  return `${header}\n${content}\n`;
}

function parseChatLine(block: string): ChatMessage | null {
  const lines = block.trim().split('\n');
  if (lines.length < 2) return null;

  // Parse header: @timestamp id=xxx [tool=yyy]
  const headerMatch = lines[0].match(/^@(\S+)\s+id=(\S+)(?:\s+tool=(\S+))?$/);
  if (!headerMatch) return null;

  const [, timestamp, id, toolCallId] = headerMatch;

  // Parse content: role: text
  const contentLine = lines.slice(1).join('\n');
  const roleMatch = contentLine.match(/^(user|assistant|system|tool):\s*([\s\S]*)$/);
  if (!roleMatch) return null;

  const [, role, content] = roleMatch;

  return {
    id,
    timestamp,
    role: role as ChatMessage['role'],
    content: content.trim(),
    toolCallId,
  };
}

function readChatHistory(filePath: string): ChatMessage[] {
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const blocks = content.split(/\n(?=@\d)/); // Split on newline followed by @timestamp
    const messages: ChatMessage[] = [];

    for (const block of blocks) {
      if (!block.trim()) continue;
      const msg = parseChatLine(block);
      if (msg) messages.push(msg);
    }

    return messages;
  } catch {
    return [];
  }
}

function appendChatMessage(filePath: string, msg: ChatMessage): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.appendFileSync(filePath, formatChatMessage(msg) + '\n');
}

/**
 * Todo format (simple line-based):
 * id|status|priority|tags|createdAt|completedAt|content
 */

function formatTodo(todo: Todo): string {
  const tags = todo.tags.join(',');
  const completed = todo.completedAt || '';
  // Escape | in content
  const content = todo.content.replace(/\|/g, '\\|').replace(/\n/g, '\\n');
  return `${todo.id}|${todo.status}|${todo.priority}|${tags}|${todo.createdAt}|${completed}|${content}`;
}

function parseTodoLine(line: string): Todo | null {
  const parts = line.split('|');
  if (parts.length < 7) return null;

  const [id, status, priority, tags, createdAt, completedAt, ...contentParts] = parts;
  const content = contentParts.join('|').replace(/\\n/g, '\n').replace(/\\\|/g, '|');

  return {
    id,
    status: status as Todo['status'],
    priority: priority as Todo['priority'],
    tags: tags ? tags.split(',') : [],
    createdAt,
    completedAt: completedAt || undefined,
    content,
  };
}

function readTodos(filePath: string): Todo[] {
  if (!fs.existsSync(filePath)) return [];

  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.trim().split('\n');
    const todos: Todo[] = [];

    for (const line of lines) {
      if (!line.trim()) continue;
      const todo = parseTodoLine(line);
      if (todo) todos.push(todo);
    }

    return todos;
  } catch {
    return [];
  }
}

function writeTodos(filePath: string, todos: Todo[]): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const content = todos.map(formatTodo).join('\n') + (todos.length > 0 ? '\n' : '');
  fs.writeFileSync(filePath, content);
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
  // Create empty chat history file (line-based format)
  fs.writeFileSync(path.join(sessionDir, 'chat.log'), '');
  // Create empty todos file (line-based format)
  fs.writeFileSync(path.join(sessionDir, 'todos.txt'), '');

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

  const historyFile = path.join(paths.currentSession, 'chat.log');

  const newMessage: ChatMessage = {
    id: `msg_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    timestamp: new Date().toISOString(),
    ...message,
  };

  // Append to chat log (line-based format)
  appendChatMessage(historyFile, newMessage);

  // Update session message count
  const sessionFile = path.join(paths.currentSession, 'session.json');
  session.messageCount += 1;
  session.lastAccessedAt = new Date().toISOString();
  writeJSON(sessionFile, session);
}

/**
 * Get chat history for current session
 */
export function getChatHistory(limit?: number): ChatMessage[] {
  const historyFile = path.join(paths.currentSession, 'chat.log');
  const history = readChatHistory(historyFile);

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
  const todosFile = path.join(paths.currentSession, 'todos.txt');
  return readTodos(todosFile);
}

/**
 * Get global todos
 */
export function getGlobalTodos(): Todo[] {
  const globalTodosFile = paths.globalTodos.replace('.json', '.txt');
  return readTodos(globalTodosFile);
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
    const globalTodosFile = paths.globalTodos.replace('.json', '.txt');
    const todos = getGlobalTodos();
    todos.push(todo);
    writeTodos(globalTodosFile, todos);
  } else {
    const todosFile = path.join(paths.currentSession, 'todos.txt');
    const todos = readTodos(todosFile);
    todos.push(todo);
    writeTodos(todosFile, todos);
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
  const filePath = global
    ? paths.globalTodos.replace('.json', '.txt')
    : path.join(paths.currentSession, 'todos.txt');
  const todos = readTodos(filePath);

  const index = todos.findIndex(t => t.id === id);
  if (index === -1) return null;

  const todo = todos[index];
  Object.assign(todo, updates);

  if (updates.status === 'completed') {
    todo.completedAt = new Date().toISOString();
  }

  writeTodos(filePath, todos);
  return todo;
}

/**
 * Delete a todo
 */
export function deleteTodo(id: string, global = false): boolean {
  const filePath = global
    ? paths.globalTodos.replace('.json', '.txt')
    : path.join(paths.currentSession, 'todos.txt');
  const todos = readTodos(filePath);

  const index = todos.findIndex(t => t.id === id);
  if (index === -1) return false;

  todos.splice(index, 1);
  writeTodos(filePath, todos);
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

// ============================================================================
// Cost Tracking
// ============================================================================

export interface CostRecord {
  totalCost: number;
  costByProvider: Record<string, number>;
  costByDay: Record<string, number>;
  costBySession: Record<string, number>;
  lastUpdated: string;
}

/**
 * Get cost tracking file path
 */
function getCostFilePath(): string {
  return path.join(paths.root, 'costs.json');
}

/**
 * Load cost records
 */
export function getCosts(): CostRecord {
  const filePath = getCostFilePath();
  if (!fs.existsSync(filePath)) {
    return {
      totalCost: 0,
      costByProvider: {},
      costByDay: {},
      costBySession: {},
      lastUpdated: new Date().toISOString(),
    };
  }
  return readJSON(filePath, {
    totalCost: 0,
    costByProvider: {},
    costByDay: {},
    costBySession: {},
    lastUpdated: new Date().toISOString(),
  } as CostRecord) || {
    totalCost: 0,
    costByProvider: {},
    costByDay: {},
    costBySession: {},
    lastUpdated: new Date().toISOString(),
  };
}

/**
 * Record a cost
 */
export function recordCost(cost: number, provider: string, sessionId?: string): void {
  initStorage();
  const costs = getCosts();
  const today = new Date().toISOString().split('T')[0];

  costs.totalCost += cost;
  costs.costByProvider[provider] = (costs.costByProvider[provider] || 0) + cost;
  costs.costByDay[today] = (costs.costByDay[today] || 0) + cost;
  
  if (sessionId) {
    costs.costBySession[sessionId] = (costs.costBySession[sessionId] || 0) + cost;
  }
  
  costs.lastUpdated = new Date().toISOString();
  writeJSON(getCostFilePath(), costs);
}

/**
 * Get cost summary for display
 */
export function getCostSummary(): string {
  const costs = getCosts();
  const today = new Date().toISOString().split('T')[0];
  const todayCost = costs.costByDay[today] || 0;

  const lines = [
    `Total: $${costs.totalCost.toFixed(4)}`,
    `Today: $${todayCost.toFixed(4)}`,
    '',
    'By Provider:',
  ];

  for (const [provider, cost] of Object.entries(costs.costByProvider)) {
    lines.push(`  ${provider}: $${cost.toFixed(4)}`);
  }

  // Last 7 days
  lines.push('', 'Last 7 Days:');
  const dates = Object.keys(costs.costByDay).sort().slice(-7);
  for (const date of dates) {
    lines.push(`  ${date}: $${costs.costByDay[date].toFixed(4)}`);
  }

  return lines.join('\n');
}

/**
 * Reset cost tracking
 */
export function resetCosts(): void {
  const filePath = getCostFilePath();
  if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

// ============================================================================
// Template Management
// ============================================================================

export interface PromptTemplate {
  name: string;
  prompt: string;
  createdAt: string;
}

/**
 * Get templates file path
 */
function getTemplatesFilePath(): string {
  return path.join(paths.templates, 'prompts.json');
}

/**
 * Load all templates
 */
export function getTemplates(): PromptTemplate[] {
  const filePath = getTemplatesFilePath();
  return readJSON<PromptTemplate[]>(filePath, []);
}

/**
 * Save a template
 */
export function saveTemplate(name: string, prompt: string): PromptTemplate {
  initStorage();
  const templates = getTemplates();

  // Remove existing template with same name
  const filtered = templates.filter(t => t.name !== name);

  const template: PromptTemplate = {
    name,
    prompt,
    createdAt: new Date().toISOString(),
  };

  filtered.push(template);
  writeJSON(getTemplatesFilePath(), filtered);
  return template;
}

/**
 * Delete a template
 */
export function deleteTemplate(name: string): boolean {
  const templates = getTemplates();
  const filtered = templates.filter(t => t.name !== name);

  if (filtered.length === templates.length) return false;

  writeJSON(getTemplatesFilePath(), filtered);
  return true;
}

// ============================================================================
// Active TODO Tracking
// ============================================================================

/**
 * Get active TODO file path
 */
function getActiveTodoFilePath(): string {
  return path.join(paths.currentSession, 'active-todo.json');
}

/**
 * Set the active TODO
 */
export function setActiveTodo(todoId: string | null): void {
  const filePath = getActiveTodoFilePath();
  if (todoId) {
    writeJSON(filePath, { todoId, setAt: new Date().toISOString() });
  } else if (fs.existsSync(filePath)) {
    fs.unlinkSync(filePath);
  }
}

/**
 * Get the active TODO
 */
export function getActiveTodo(): Todo | null {
  const filePath = getActiveTodoFilePath();
  const data = readJSON<{ todoId: string }>(filePath, null as unknown as { todoId: string });

  if (!data?.todoId) return null;

  // Find in session todos first, then global
  const sessionTodos = getSessionTodos();
  const globalTodos = getGlobalTodos();

  return sessionTodos.find(t => t.id === data.todoId)
    || globalTodos.find(t => t.id === data.todoId)
    || null;
}
