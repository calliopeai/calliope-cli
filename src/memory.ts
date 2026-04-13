/**
 * Calliope CLI - Memory System
 *
 * Persistent memory across sessions using CALLIOPE.md files.
 * Supports project-level and global memories.
 *
 * Format (human-readable markdown):
 * ```
 * # Project Memory
 *
 * ## Context
 * - Key fact about the project
 * - Another important detail
 *
 * ## Preferences
 * - User prefers functional components
 * - Always use TypeScript
 *
 * ## History
 * - 2025-01-09: Implemented auth system
 * - 2025-01-08: Set up project structure
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { checkTrust, autoTrustIfNew } from './trust.js';

// ============================================================================
// Types
// ============================================================================

export interface Memory {
  context: string[];      // Key facts about project/codebase
  preferences: string[];  // User preferences and conventions
  history: string[];      // Important events/milestones
  notes: string[];        // Freeform notes
}

export interface MemoryEntry {
  type: 'context' | 'preference' | 'history' | 'note';
  content: string;
  timestamp?: string;
}

// ============================================================================
// Paths
// ============================================================================

const GLOBAL_MEMORY_DIR = path.join(os.homedir(), '.calliope-cli', 'memory');
const MEMORY_FILENAME = 'CALLIOPE.md';

/**
 * Find project memory file (searches up directory tree)
 */
export function findProjectMemory(startDir: string): string | null {
  let currentDir = startDir;

  while (currentDir !== path.dirname(currentDir)) {
    const memoryPath = path.join(currentDir, MEMORY_FILENAME);
    if (fs.existsSync(memoryPath)) {
      return memoryPath;
    }
    currentDir = path.dirname(currentDir);
  }

  return null;
}

/**
 * Get global memory file path
 */
export function getGlobalMemoryPath(): string {
  if (!fs.existsSync(GLOBAL_MEMORY_DIR)) {
    fs.mkdirSync(GLOBAL_MEMORY_DIR, { recursive: true });
  }
  return path.join(GLOBAL_MEMORY_DIR, 'global.md');
}

// ============================================================================
// Parsing
// ============================================================================

/**
 * Parse CALLIOPE.md file into Memory object
 */
export function parseMemoryFile(content: string): Memory {
  const memory: Memory = {
    context: [],
    preferences: [],
    history: [],
    notes: [],
  };

  let currentSection: keyof Memory | null = null;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();

    // Section headers
    if (trimmed.startsWith('## ')) {
      const section = trimmed.slice(3).toLowerCase();
      if (section === 'context') currentSection = 'context';
      else if (section === 'preferences') currentSection = 'preferences';
      else if (section === 'history') currentSection = 'history';
      else if (section === 'notes') currentSection = 'notes';
      else currentSection = null;
      continue;
    }

    // Skip main title and empty lines
    if (trimmed.startsWith('# ') || !trimmed) {
      continue;
    }

    // List items
    if (currentSection && trimmed.startsWith('- ')) {
      memory[currentSection].push(trimmed.slice(2));
    }
  }

  return memory;
}

/**
 * Format Memory object as markdown
 */
export function formatMemoryFile(memory: Memory, title = 'Project Memory'): string {
  const lines: string[] = [`# ${title}`, ''];

  if (memory.context.length > 0) {
    lines.push('## Context', '');
    for (const item of memory.context) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  if (memory.preferences.length > 0) {
    lines.push('## Preferences', '');
    for (const item of memory.preferences) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  if (memory.history.length > 0) {
    lines.push('## History', '');
    for (const item of memory.history) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  if (memory.notes.length > 0) {
    lines.push('## Notes', '');
    for (const item of memory.notes) {
      lines.push(`- ${item}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ============================================================================
// Memory Operations
// ============================================================================

/**
 * Load memory from file
 */
export function loadMemory(filePath: string): Memory {
  if (!fs.existsSync(filePath)) {
    return { context: [], preferences: [], history: [], notes: [] };
  }

  const content = fs.readFileSync(filePath, 'utf-8');
  return parseMemoryFile(content);
}

/**
 * Save memory to file
 */
export function saveMemory(filePath: string, memory: Memory, title?: string): void {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  fs.writeFileSync(filePath, formatMemoryFile(memory, title));
}

/**
 * Get project memory for current directory
 */
export function getProjectMemory(dir: string): Memory {
  const memoryPath = findProjectMemory(dir);
  if (!memoryPath) {
    return { context: [], preferences: [], history: [], notes: [] };
  }
  return loadMemory(memoryPath);
}

/**
 * Get global memory
 */
export function getGlobalMemory(): Memory {
  return loadMemory(getGlobalMemoryPath());
}

/**
 * Add entry to memory
 */
export function addMemoryEntry(
  filePath: string,
  entry: MemoryEntry,
  title?: string
): void {
  const memory = loadMemory(filePath);

  let content = entry.content;
  if (entry.type === 'history' && entry.timestamp) {
    content = `${entry.timestamp}: ${content}`;
  }

  switch (entry.type) {
    case 'context':
      if (!memory.context.includes(content)) {
        memory.context.push(content);
      }
      break;
    case 'preference':
      if (!memory.preferences.includes(content)) {
        memory.preferences.push(content);
      }
      break;
    case 'history':
      memory.history.push(content);
      break;
    case 'note':
      memory.notes.push(content);
      break;
  }

  saveMemory(filePath, memory, title);
}

/**
 * Remove entry from memory
 */
export function removeMemoryEntry(
  filePath: string,
  type: MemoryEntry['type'],
  content: string,
  title?: string
): boolean {
  const memory = loadMemory(filePath);

  const section = type === 'preference' ? 'preferences' : `${type}s` as keyof Memory;
  const index = memory[section].findIndex(item =>
    item.toLowerCase().includes(content.toLowerCase())
  );

  if (index === -1) return false;

  memory[section].splice(index, 1);
  saveMemory(filePath, memory, title);
  return true;
}

/**
 * Initialize project memory file
 */
export function initProjectMemory(dir: string, projectName?: string): string {
  const memoryPath = path.join(dir, MEMORY_FILENAME);

  const memory: Memory = {
    context: [
      `Project: ${projectName || path.basename(dir)}`,
    ],
    preferences: [],
    history: [
      `${new Date().toISOString().split('T')[0]}: Initialized project memory`,
    ],
    notes: [],
  };

  saveMemory(memoryPath, memory, 'Project Memory');
  return memoryPath;
}

// ============================================================================
// Standard Context Files
// ============================================================================

/**
 * Standard files that provide project context
 * These are loaded automatically when found in the project root
 */
const CONTEXT_FILES = [
  { name: 'CALLIOPE.md', label: 'Memory', maxLines: 100 },
  { name: 'CLAUDE.md', label: 'Claude Context', maxLines: 100 },
  { name: 'README.md', label: 'README', maxLines: 50 },
  { name: 'SPEC.md', label: 'Specification', maxLines: 100 },
  { name: 'TODO.md', label: 'TODO', maxLines: 50 },
  { name: 'ARCHITECTURE.md', label: 'Architecture', maxLines: 100 },
  { name: 'CONTRIBUTING.md', label: 'Contributing', maxLines: 50 },
  { name: 'DESIGN.md', label: 'Design', maxLines: 100 },
  { name: 'NOTES.md', label: 'Notes', maxLines: 50 },
  { name: 'CONTEXT.md', label: 'Context', maxLines: 100 },
  { name: '.cursorrules', label: 'Cursor Rules', maxLines: 100 },
  { name: '.github/copilot-instructions.md', label: 'Copilot Instructions', maxLines: 100 },
];

/**
 * Find and load context from standard files
 */
export function loadContextFiles(dir: string): Array<{ name: string; label: string; content: string }> {
  const results: Array<{ name: string; label: string; content: string }> = [];

  for (const file of CONTEXT_FILES) {
    const filePath = path.join(dir, file.name);
    if (fs.existsSync(filePath)) {
      try {
        const content = fs.readFileSync(filePath, 'utf-8');
        const lines = content.split('\n');
        const truncated = lines.slice(0, file.maxLines).join('\n');
        const suffix = lines.length > file.maxLines ? `\n... (${lines.length - file.maxLines} more lines)` : '';
        results.push({
          name: file.name,
          label: file.label,
          content: truncated + suffix,
        });
      } catch {
        // Skip files we can't read
      }
    }
  }

  return results;
}

/**
 * Get list of context files that exist in directory
 */
export function listContextFiles(dir: string): string[] {
  return CONTEXT_FILES
    .map(f => path.join(dir, f.name))
    .filter(p => fs.existsSync(p));
}

// ============================================================================
// Memory Context for LLM
// ============================================================================

/**
 * Build memory context string for system prompt
 */
export function buildMemoryContext(dir: string): string {
  // Check project trust before loading project-level context (#23)
  // Auto-trust on first visit (user-friendly default)
  autoTrustIfNew(dir);
  const projectTrusted = checkTrust(dir).trusted;

  const projectMemory = projectTrusted ? getProjectMemory(dir) : { context: [], preferences: [], history: [], notes: [] };
  const globalMemory = getGlobalMemory();
  const contextFiles = projectTrusted ? loadContextFiles(dir) : [];

  const parts: string[] = [];

  // Global preferences first
  if (globalMemory.preferences.length > 0) {
    parts.push('Global preferences:');
    for (const pref of globalMemory.preferences) {
      parts.push(`- ${pref}`);
    }
    parts.push('');
  }

  // Project context from CALLIOPE.md
  if (projectMemory.context.length > 0) {
    parts.push('Project context:');
    for (const ctx of projectMemory.context) {
      parts.push(`- ${ctx}`);
    }
    parts.push('');
  }

  // Project preferences
  if (projectMemory.preferences.length > 0) {
    parts.push('Project preferences:');
    for (const pref of projectMemory.preferences) {
      parts.push(`- ${pref}`);
    }
    parts.push('');
  }

  // Recent history (last 5)
  const recentHistory = projectMemory.history.slice(-5);
  if (recentHistory.length > 0) {
    parts.push('Recent history:');
    for (const hist of recentHistory) {
      parts.push(`- ${hist}`);
    }
    parts.push('');
  }

  // Context from other files (excluding CALLIOPE.md which we already parsed)
  for (const file of contextFiles) {
    if (file.name === 'CALLIOPE.md') continue;
    parts.push(`--- ${file.label} (${file.name}) ---`);
    parts.push(file.content);
    parts.push('');
  }

  return parts.join('\n');
}

/**
 * Build compact context summary (for token-limited situations)
 */
export function buildCompactContext(dir: string): string {
  const projectMemory = getProjectMemory(dir);
  const parts: string[] = [];

  if (projectMemory.context.length > 0) {
    parts.push('Context: ' + projectMemory.context.join('; '));
  }

  if (projectMemory.preferences.length > 0) {
    parts.push('Prefs: ' + projectMemory.preferences.join('; '));
  }

  return parts.join('\n');
}

/**
 * Auto-extract potential memories from conversation
 * Returns suggestions for memories to add
 */
export function suggestMemories(content: string): MemoryEntry[] {
  const suggestions: MemoryEntry[] = [];

  // Look for patterns that suggest preferences
  const prefPatterns = [
    /(?:always|prefer|use|want)\s+(?:to\s+)?(.+?)(?:\.|$)/gi,
    /(?:don't|never|avoid)\s+(.+?)(?:\.|$)/gi,
  ];

  for (const pattern of prefPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1].length > 10 && match[1].length < 100) {
        suggestions.push({
          type: 'preference',
          content: match[1].trim(),
        });
      }
    }
  }

  // Look for patterns that suggest context
  const contextPatterns = [
    /(?:this project|the codebase|this repo)\s+(?:is|uses|has)\s+(.+?)(?:\.|$)/gi,
    /(?:we're using|built with|powered by)\s+(.+?)(?:\.|$)/gi,
  ];

  for (const pattern of contextPatterns) {
    let match;
    while ((match = pattern.exec(content)) !== null) {
      if (match[1].length > 5 && match[1].length < 100) {
        suggestions.push({
          type: 'context',
          content: match[1].trim(),
        });
      }
    }
  }

  return suggestions;
}
