/**
 * Calliope CLI - Project Configuration
 *
 * Loads project-specific settings from .calliope file (simple human-readable format)
 *
 * Format:
 * ```
 * # Comment
 * project: My Project Name
 * provider: anthropic
 * model: claude-sonnet-4
 *
 * [tech]
 * typescript
 * react
 * node
 *
 * [conventions]
 * Use functional components
 * Prefer async/await
 *
 * [ignore]
 * node_modules/
 * dist/
 *
 * [commands]
 * build: npm run build
 * test: npm test
 * ```
 */

import * as fs from 'fs';
import * as path from 'path';
import type { LLMProvider } from './types.js';

// ============================================================================
// Types
// ============================================================================

export interface ProjectConfig {
  // Basic info
  project?: string;
  description?: string;

  // Provider settings
  provider?: LLMProvider;
  model?: string;

  // Agent settings
  maxIterations?: number;

  // System prompt additions
  systemPromptPrefix?: string;
  systemPromptSuffix?: string;

  // Project context
  tech?: string[];
  conventions?: string[];

  // File handling
  ignore?: string[];
  include?: string[];

  // Skills/tools
  skills?: string[];
  disabledTools?: string[];

  // Custom commands
  commands?: Record<string, string>;

  // MCP servers
  mcpServers?: string[];
}

// ============================================================================
// Config File Detection
// ============================================================================

const CONFIG_FILENAMES = [
  '.calliope',
  '.calliope.conf',
  'calliope.conf',
];

/**
 * Find project config file in directory tree
 */
export function findProjectConfig(startDir: string): string | null {
  let currentDir = startDir;

  while (currentDir !== path.dirname(currentDir)) {
    for (const filename of CONFIG_FILENAMES) {
      const configPath = path.join(currentDir, filename);
      if (fs.existsSync(configPath)) {
        return configPath;
      }
    }
    currentDir = path.dirname(currentDir);
  }

  return null;
}

// ============================================================================
// Config Parsing (Simple human-readable format)
// ============================================================================

/**
 * Parse .calliope config file
 *
 * Format:
 * - Lines starting with # are comments
 * - key: value for simple values
 * - [section] starts a list section
 * - Indented or unindented lines in sections are list items
 */
export function parseConfigFile(content: string): ProjectConfig {
  const config: ProjectConfig = {};
  const lines = content.split('\n');

  let currentSection: string | null = null;
  let currentList: string[] = [];

  const flushSection = () => {
    if (currentSection && currentList.length > 0) {
      (config as Record<string, unknown>)[currentSection] = [...currentList];
      currentList = [];
    }
    currentSection = null;
  };

  for (const rawLine of lines) {
    const line = rawLine.trim();

    // Skip empty lines and comments
    if (!line || line.startsWith('#')) {
      continue;
    }

    // Section header [name]
    if (line.startsWith('[') && line.endsWith(']')) {
      flushSection();
      currentSection = line.slice(1, -1).toLowerCase();
      continue;
    }

    // In a section - add as list item
    if (currentSection) {
      // Handle command format: name: script
      if (currentSection === 'commands' && line.includes(':')) {
        const colonIdx = line.indexOf(':');
        const name = line.slice(0, colonIdx).trim();
        const script = line.slice(colonIdx + 1).trim();
        if (!config.commands) config.commands = {};
        config.commands[name] = script;
      } else {
        currentList.push(line);
      }
      continue;
    }

    // Key: value pair
    if (line.includes(':')) {
      const colonIdx = line.indexOf(':');
      const key = line.slice(0, colonIdx).trim().toLowerCase();
      const value = line.slice(colonIdx + 1).trim();

      switch (key) {
        case 'project':
          config.project = value;
          break;
        case 'description':
          config.description = value;
          break;
        case 'provider':
          config.provider = value as LLMProvider;
          break;
        case 'model':
          config.model = value;
          break;
        case 'maxiterations':
        case 'max-iterations':
        case 'max_iterations':
          config.maxIterations = parseInt(value, 10);
          break;
        case 'prefix':
        case 'systempromptprefix':
          config.systemPromptPrefix = value;
          break;
        case 'suffix':
        case 'systempromptsuffix':
          config.systemPromptSuffix = value;
          break;
      }
    }
  }

  // Flush final section
  flushSection();

  return config;
}

/**
 * Load project config from file
 */
export function loadProjectConfig(configPath: string): ProjectConfig | null {
  try {
    const content = fs.readFileSync(configPath, 'utf-8');
    return parseConfigFile(content);
  } catch (e) {
    console.error(`Warning: Failed to load project config: ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

/**
 * Get project config for a directory
 */
export function getProjectConfig(dir: string): ProjectConfig | null {
  const configPath = findProjectConfig(dir);
  if (!configPath) return null;
  return loadProjectConfig(configPath);
}

// ============================================================================
// Config Generation
// ============================================================================

/**
 * Generate a default project config
 */
export function generateDefaultConfig(projectName?: string): string {
  return `# Calliope Project Configuration
# https://github.com/calliopelabs/calliope-cli

project: ${projectName || 'My Project'}
# provider: anthropic
# model: claude-sonnet-4

[tech]
# Add your tech stack
# typescript
# react
# node

[conventions]
# Add coding conventions for this project
# Use functional components
# Prefer async/await over promises

[ignore]
node_modules/
dist/
.git/
*.log

[commands]
# Custom commands (name: script)
# build: npm run build
# test: npm test
# lint: npm run lint
`;
}

/**
 * Create a project config file
 */
export function createProjectConfig(dir: string, projectName?: string): string {
  const configPath = path.join(dir, '.calliope');
  const content = generateDefaultConfig(projectName || path.basename(dir));
  fs.writeFileSync(configPath, content);
  return configPath;
}

// ============================================================================
// System Prompt Builder
// ============================================================================

/**
 * Build additional context from project config
 */
export function buildProjectContext(config: ProjectConfig): string {
  const parts: string[] = [];

  if (config.project) {
    parts.push(`Project: ${config.project}`);
  }

  if (config.description) {
    parts.push(`Description: ${config.description}`);
  }

  if (config.tech && config.tech.length > 0) {
    parts.push(`Tech stack: ${config.tech.join(', ')}`);
  }

  if (config.conventions && config.conventions.length > 0) {
    parts.push('\nProject conventions:');
    for (const conv of config.conventions) {
      parts.push(`- ${conv}`);
    }
  }

  if (config.systemPromptPrefix) {
    parts.unshift(config.systemPromptPrefix);
  }

  if (config.systemPromptSuffix) {
    parts.push(config.systemPromptSuffix);
  }

  return parts.join('\n');
}
