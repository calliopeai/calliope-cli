/**
 * Calliope CLI - Conversation Branching
 *
 * Fork conversations to try different approaches.
 * Supports creating, switching, and merging branches.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Message as LLMMessage } from './types.js';

// ============================================================================
// Types
// ============================================================================

export interface Branch {
  id: string;
  name: string;
  parentId: string | null;
  parentMessageIndex: number;  // Fork point in parent branch
  createdAt: string;
  description?: string;
}

export interface BranchState {
  currentBranch: string;
  branches: Record<string, Branch>;
}

// ============================================================================
// Paths
// ============================================================================

const BRANCHES_DIR = path.join(os.homedir(), '.calliope-cli', 'branches');

function ensureBranchesDir(sessionId: string): string {
  const dir = path.join(BRANCHES_DIR, sessionId);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  return dir;
}

function getStateFile(sessionId: string): string {
  return path.join(ensureBranchesDir(sessionId), 'state.json');
}

function getBranchFile(sessionId: string, branchId: string): string {
  return path.join(ensureBranchesDir(sessionId), `${branchId}.jsonl`);
}

// ============================================================================
// State Management
// ============================================================================

/**
 * Load branch state for a session
 */
export function loadBranchState(sessionId: string): BranchState {
  const stateFile = getStateFile(sessionId);
  if (fs.existsSync(stateFile)) {
    try {
      return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
    } catch {
      // Fall through to default
    }
  }

  // Default state with main branch
  return {
    currentBranch: 'main',
    branches: {
      main: {
        id: 'main',
        name: 'main',
        parentId: null,
        parentMessageIndex: 0,
        createdAt: new Date().toISOString(),
      },
    },
  };
}

/**
 * Save branch state
 */
export function saveBranchState(sessionId: string, state: BranchState): void {
  const stateFile = getStateFile(sessionId);
  // Atomic write: a crash or concurrent instance must never leave a truncated
  // branch-state file (readers fall back to defaults on parse error).
  const tmp = `${stateFile}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, JSON.stringify(state, null, 2));
    fs.renameSync(tmp, stateFile);
  } catch (e) {
    try { fs.unlinkSync(tmp); } catch { /* best effort */ }
    throw e;
  }
}

// ============================================================================
// Branch Operations
// ============================================================================

/**
 * Create a new branch from current position
 */
export function createBranch(
  sessionId: string,
  name: string,
  messages: LLMMessage[],
  description?: string
): Branch {
  const state = loadBranchState(sessionId);

  // Generate unique ID
  const id = `branch_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;

  // Create branch
  const branch: Branch = {
    id,
    name,
    parentId: state.currentBranch,
    parentMessageIndex: messages.length,
    createdAt: new Date().toISOString(),
    description,
  };

  // Save current messages to parent branch
  saveBranchMessages(sessionId, state.currentBranch, messages);

  // Copy messages to new branch
  saveBranchMessages(sessionId, id, messages);

  // Update state
  state.branches[id] = branch;
  state.currentBranch = id;
  saveBranchState(sessionId, state);

  return branch;
}

/**
 * Switch to a different branch
 */
export function switchBranch(
  sessionId: string,
  branchIdOrName: string,
  currentMessages: LLMMessage[]
): LLMMessage[] | null {
  const state = loadBranchState(sessionId);

  // Find branch by ID or name
  const branch = Object.values(state.branches).find(
    b => b.id === branchIdOrName || b.name === branchIdOrName
  );

  if (!branch) return null;

  // Save current branch messages
  saveBranchMessages(sessionId, state.currentBranch, currentMessages);

  // Load target branch messages
  const messages = loadBranchMessages(sessionId, branch.id);

  // Update state
  state.currentBranch = branch.id;
  saveBranchState(sessionId, state);

  return messages;
}

/**
 * List all branches
 */
export function listBranches(sessionId: string): Branch[] {
  const state = loadBranchState(sessionId);
  return Object.values(state.branches).sort(
    (a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()
  );
}

/**
 * Get current branch
 */
export function getCurrentBranch(sessionId: string): Branch {
  const state = loadBranchState(sessionId);
  return state.branches[state.currentBranch];
}

/**
 * Delete a branch
 */
export function deleteBranch(sessionId: string, branchIdOrName: string): boolean {
  const state = loadBranchState(sessionId);

  // Find branch
  const branch = Object.values(state.branches).find(
    b => b.id === branchIdOrName || b.name === branchIdOrName
  );

  if (!branch || branch.id === 'main') return false;

  // Can't delete current branch
  if (state.currentBranch === branch.id) return false;

  // Delete branch file
  const branchFile = getBranchFile(sessionId, branch.id);
  if (fs.existsSync(branchFile)) {
    fs.unlinkSync(branchFile);
  }

  // Remove from state
  delete state.branches[branch.id];
  saveBranchState(sessionId, state);

  return true;
}

/**
 * Rename a branch
 */
export function renameBranch(
  sessionId: string,
  branchIdOrName: string,
  newName: string
): boolean {
  const state = loadBranchState(sessionId);

  const branch = Object.values(state.branches).find(
    b => b.id === branchIdOrName || b.name === branchIdOrName
  );

  if (!branch) return false;

  branch.name = newName;
  saveBranchState(sessionId, state);
  return true;
}

// ============================================================================
// Message Storage
// ============================================================================

/**
 * Save messages to branch file (JSONL format)
 */
function saveBranchMessages(sessionId: string, branchId: string, messages: LLMMessage[]): void {
  const file = getBranchFile(sessionId, branchId);
  const content = messages.map(m => JSON.stringify(m)).join('\n');
  fs.writeFileSync(file, content);
}

/**
 * Load messages from branch file
 */
function loadBranchMessages(sessionId: string, branchId: string): LLMMessage[] {
  const file = getBranchFile(sessionId, branchId);
  if (!fs.existsSync(file)) return [];

  try {
    const content = fs.readFileSync(file, 'utf-8');
    return content.split('\n').filter(Boolean).map(line => JSON.parse(line));
  } catch {
    return [];
  }
}

/**
 * Get branch tree for display
 */
export function getBranchTree(sessionId: string): string {
  const state = loadBranchState(sessionId);
  const branches = Object.values(state.branches);

  const lines: string[] = [];

  function addBranch(branch: Branch, indent: string, isLast: boolean): void {
    const prefix = isLast ? '└── ' : '├── ';
    const current = branch.id === state.currentBranch ? ' *' : '';
    const desc = branch.description ? ` (${branch.description})` : '';
    lines.push(`${indent}${prefix}${branch.name}${current}${desc}`);

    // Find children
    const children = branches.filter(b => b.parentId === branch.id);
    const childIndent = indent + (isLast ? '    ' : '│   ');
    children.forEach((child, i) => {
      addBranch(child, childIndent, i === children.length - 1);
    });
  }

  // Start with main branch
  const main = branches.find(b => b.id === 'main');
  if (main) {
    addBranch(main, '', true);
  }

  return lines.join('\n');
}
