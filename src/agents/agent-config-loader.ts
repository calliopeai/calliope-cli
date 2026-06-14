/**
 * Agent & Team Configuration Loader
 *
 * Loads agent and team definitions from:
 * 1. Built-in presets (lowest priority)
 * 2. Global ~/.calliope-cli/agents/
 * 3. Project .calliope/agents/ (highest priority)
 *
 * Supports YAML (.yaml, .yml) and JSON (.json) files.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { parse as parseYaml } from 'yaml';
import type { SubAgentType, TaskExecutor } from './types.js';
import type {
  AgentDefinition,
  TeamDefinition,
  TeamMember,
  ResolvedTeam,
  ResolvedTeamMember,
} from './agent-config-types.js';
import { isTeamMemberRef } from './agent-config-types.js';
import { BUILTIN_AGENTS, BUILTIN_TEAMS } from './agent-config-presets.js';

// ============================================================================
// Constants
// ============================================================================

const GLOBAL_AGENTS_DIR = path.join(os.homedir(), '.calliope-cli', 'agents');
const GLOBAL_TEAMS_DIR = path.join(GLOBAL_AGENTS_DIR, 'teams');
const CONFIG_EXTENSIONS = ['.yaml', '.yml', '.json'];

// ============================================================================
// Cache
// ============================================================================

interface CacheEntry<T> {
  data: Map<string, T>;
  mtimeMs: number;
}

let agentCache: CacheEntry<AgentDefinition> | null = null;
let teamCache: CacheEntry<TeamDefinition> | null = null;
let lastCwd: string = '';

function invalidateCache(): void {
  agentCache = null;
  teamCache = null;
}

// ============================================================================
// File Discovery
// ============================================================================

function getProjectAgentsDir(cwd: string): string {
  return path.join(cwd, '.calliope', 'agents');
}

function getProjectTeamsDir(cwd: string): string {
  return path.join(cwd, '.calliope', 'agents', 'teams');
}

/**
 * Get the latest mtime from a set of directories
 */
function getLatestMtime(dirs: string[]): number {
  let latest = 0;
  for (const dir of dirs) {
    try {
      const stat = fs.statSync(dir);
      if (stat.mtimeMs > latest) latest = stat.mtimeMs;
      // Also check individual files
      const files = fs.readdirSync(dir);
      for (const file of files) {
        const ext = path.extname(file).toLowerCase();
        if (CONFIG_EXTENSIONS.includes(ext)) {
          const fstat = fs.statSync(path.join(dir, file));
          if (fstat.mtimeMs > latest) latest = fstat.mtimeMs;
        }
      }
    } catch {
      // Directory doesn't exist
    }
  }
  return latest;
}

/**
 * Read all config files from a directory
 */
function readConfigDir<T>(dir: string, source: 'builtin' | 'global' | 'project'): Map<string, T & { _source: string; _filePath: string }> {
  const results = new Map<string, T & { _source: string; _filePath: string }>();

  try {
    if (!fs.existsSync(dir)) return results;
    const files = fs.readdirSync(dir);

    for (const file of files) {
      const ext = path.extname(file).toLowerCase();
      if (!CONFIG_EXTENSIONS.includes(ext)) continue;

      const filePath = path.join(dir, file);
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;

        const content = fs.readFileSync(filePath, 'utf-8');
        let parsed: T;

        if (ext === '.json') {
          parsed = JSON.parse(content);
        } else {
          parsed = parseYaml(content) as T;
        }

        if (parsed && typeof parsed === 'object') {
          const withMeta = { ...parsed, _source: source, _filePath: filePath };
          const name = (parsed as Record<string, unknown>).name as string;
          if (name) {
            results.set(name, withMeta);
          }
        }
      } catch {
        // Skip malformed files silently
      }
    }
  } catch {
    // Directory doesn't exist or isn't readable
  }

  return results;
}

// ============================================================================
// Loading
// ============================================================================

/**
 * Load all agent definitions (built-in + global + project)
 * Project-level definitions override global, which override built-in.
 */
export function loadAgentDefinitions(cwd: string): Map<string, AgentDefinition> {
  const projectDir = getProjectAgentsDir(cwd);
  const dirs = [GLOBAL_AGENTS_DIR, projectDir];
  const currentMtime = getLatestMtime(dirs);

  // Return cache if valid
  if (agentCache && lastCwd === cwd && agentCache.mtimeMs >= currentMtime) {
    return agentCache.data;
  }

  const agents = new Map<string, AgentDefinition>();

  // Layer 1: Built-in presets (lowest priority)
  for (const [name, def] of Object.entries(BUILTIN_AGENTS)) {
    agents.set(name, { ...def });
  }

  // Layer 2: Global user-level
  const globalAgents = readConfigDir<AgentDefinition>(GLOBAL_AGENTS_DIR, 'global');
  for (const [name, def] of globalAgents) {
    agents.set(name, def);
  }

  // Layer 3: Project-level (highest priority)
  const projectAgents = readConfigDir<AgentDefinition>(projectDir, 'project');
  for (const [name, def] of projectAgents) {
    agents.set(name, def);
  }

  // Cache
  agentCache = { data: agents, mtimeMs: currentMtime };
  lastCwd = cwd;

  return agents;
}

/**
 * Load all team definitions (built-in + global + project)
 */
export function loadTeamDefinitions(cwd: string): Map<string, TeamDefinition> {
  const projectDir = getProjectTeamsDir(cwd);
  const dirs = [GLOBAL_TEAMS_DIR, projectDir];
  const currentMtime = getLatestMtime(dirs);

  if (teamCache && lastCwd === cwd && teamCache.mtimeMs >= currentMtime) {
    return teamCache.data;
  }

  const teams = new Map<string, TeamDefinition>();

  // Layer 1: Built-in presets
  for (const [name, def] of Object.entries(BUILTIN_TEAMS)) {
    teams.set(name, { ...def });
  }

  // Layer 2: Global
  const globalTeams = readConfigDir<TeamDefinition>(GLOBAL_TEAMS_DIR, 'global');
  for (const [name, def] of globalTeams) {
    teams.set(name, def);
  }

  // Layer 3: Project
  const projectTeams = readConfigDir<TeamDefinition>(projectDir, 'project');
  for (const [name, def] of projectTeams) {
    teams.set(name, def);
  }

  teamCache = { data: teams, mtimeMs: currentMtime };

  return teams;
}

// ============================================================================
// Resolution
// ============================================================================

/**
 * Map engine + provider to SubAgentType for the orchestrator
 */
export function mapEngineToAgentType(engine?: TaskExecutor, provider?: string): SubAgentType {
  if (!engine || engine === 'cli') {
    // CLI backend: map to specific CLI agent based on provider
    switch (provider) {
      case 'anthropic': return 'claude';
      case 'google': return 'gemini';
      case 'openai': return 'codex';
      default: return 'calliope'; // self with provider/model override
    }
  }
  // SDK backends always run in-process via calliope
  return 'calliope';
}

/**
 * Resolve a team member (ref or inline) to a fully resolved member
 */
function resolveMember(
  member: TeamMember,
  agents: Map<string, AgentDefinition>
): ResolvedTeamMember {
  if (isTeamMemberRef(member)) {
    const def = agents.get(member.agent);
    if (!def) {
      throw new Error(
        `Team references undefined agent '${member.agent}'. Available agents: ${[...agents.keys()].join(', ')}`
      );
    }
    return {
      name: member.nameOverride || def.name,
      agent: mapEngineToAgentType(def.engine, def.provider),
      engine: def.engine,
      provider: def.provider,
      model: def.model,
      instructions: def.instructions,
      role: member.role || def.role,
      weight: member.weight ?? def.weight ?? 1.0,
      limits: def.limits,
    };
  }

  // Inline definition
  return {
    name: member.name,
    agent: mapEngineToAgentType(member.engine, member.provider),
    engine: member.engine || 'cli',
    provider: member.provider,
    model: member.model,
    instructions: member.instructions,
    role: member.role,
    weight: member.weight ?? 1.0,
  };
}

/**
 * Resolve a team definition — dereference all member refs
 */
export function resolveTeam(
  teamDef: TeamDefinition,
  agents: Map<string, AgentDefinition>
): ResolvedTeam {
  const members = teamDef.members.map(m => resolveMember(m, agents));

  return {
    name: teamDef.name,
    description: teamDef.description,
    mode: teamDef.mode,
    members,
    swarm: teamDef.swarm,
    council: teamDef.council,
    promptPrefix: teamDef.promptPrefix,
  };
}

// ============================================================================
// Convenience API
// ============================================================================

/**
 * Get a single agent definition by name
 */
export function getAgent(name: string, cwd: string): AgentDefinition | undefined {
  return loadAgentDefinitions(cwd).get(name);
}

/**
 * Get a resolved team by name
 */
export function getTeam(name: string, cwd: string): ResolvedTeam | undefined {
  const teamDef = loadTeamDefinitions(cwd).get(name);
  if (!teamDef) return undefined;
  const agents = loadAgentDefinitions(cwd);
  return resolveTeam(teamDef, agents);
}

/**
 * List all loaded agent definitions
 */
export function listAgentDefs(cwd: string): AgentDefinition[] {
  return [...loadAgentDefinitions(cwd).values()];
}

/**
 * List all loaded team definitions
 */
export function listTeamDefs(cwd: string): TeamDefinition[] {
  return [...loadTeamDefinitions(cwd).values()];
}

// ============================================================================
// Scaffolding
// ============================================================================

/**
 * Create .calliope/agents/ directory with example files
 */
export function scaffoldAgentsDir(cwd: string): { created: string[] } {
  const agentsDir = getProjectAgentsDir(cwd);
  const teamsDir = getProjectTeamsDir(cwd);
  const created: string[] = [];

  // Create directories
  fs.mkdirSync(agentsDir, { recursive: true });
  fs.mkdirSync(teamsDir, { recursive: true });

  // Example agent
  const exampleAgent = path.join(agentsDir, 'example-agent.yaml');
  if (!fs.existsSync(exampleAgent)) {
    fs.writeFileSync(exampleAgent, `# Example agent definition
# See built-in agents with /agents defs

name: my-agent
description: Custom agent for my project
engine: cli              # cli | claude-sdk | openai-sdk | google-adk
provider: anthropic      # anthropic | openai | google | ollama | etc.
model: claude-sonnet-4-6
instructions: |
  You are a helpful coding assistant specialized in this project.
  Follow the project conventions and style guide.
role: coder
weight: 1.0
limits:
  timeout: 600000        # 10 minutes
  maxIterations: 100
`);
    created.push(exampleAgent);
  }

  // Example team
  const exampleTeam = path.join(teamsDir, 'example-team.yaml');
  if (!fs.existsSync(exampleTeam)) {
    fs.writeFileSync(exampleTeam, `# Example team definition
# See built-in teams with /agents teams

name: my-team
description: Custom team for code review
mode: competitive        # competitive | collaborative | consensus | overseer

members:
  # Reference a named agent definition
  - agent: code-reviewer
    role: security-reviewer
    weight: 1.2

  # Or define inline
  - name: style-checker
    engine: openai-sdk
    provider: openai
    model: gpt-4o
    instructions: |
      Review code style, naming conventions, and readability.
    role: style-reviewer
    weight: 0.8

# Swarm settings (for /swarm --team my-team)
swarm:
  strategy: parallel
  aggregation: structured
  maxWorkers: 3

# Coordination settings (for /coordinate --team my-team)
council:
  maxRounds: 2
  consensusThreshold: 0.67
`);
    created.push(exampleTeam);
  }

  invalidateCache();
  return { created };
}

/**
 * Save an agent definition to the project agents directory
 */
export function saveAgentDef(cwd: string, def: AgentDefinition): string {
  const agentsDir = getProjectAgentsDir(cwd);
  fs.mkdirSync(agentsDir, { recursive: true });

  // Build YAML content (manual to control formatting)
  const lines: string[] = [];
  lines.push(`name: ${def.name}`);
  if (def.description) lines.push(`description: ${def.description}`);
  lines.push(`engine: ${def.engine}`);
  if (def.provider) lines.push(`provider: ${def.provider}`);
  if (def.model) lines.push(`model: ${def.model}`);
  if (def.instructions) {
    lines.push('instructions: |');
    for (const line of def.instructions.split('\n')) {
      lines.push(`  ${line}`);
    }
  }
  if (def.role) lines.push(`role: ${def.role}`);
  if (def.weight !== undefined) lines.push(`weight: ${def.weight}`);
  if (def.limits) {
    lines.push('limits:');
    if (def.limits.timeout) lines.push(`  timeout: ${def.limits.timeout}`);
    if (def.limits.maxIterations) lines.push(`  maxIterations: ${def.limits.maxIterations}`);
  }

  const filePath = path.join(agentsDir, `${def.name}.yaml`);
  fs.writeFileSync(filePath, lines.join('\n') + '\n');
  invalidateCache();
  return filePath;
}

/**
 * Save a team definition to the project teams directory
 */
export function saveTeamDef(cwd: string, def: TeamDefinition): string {
  const teamsDir = getProjectTeamsDir(cwd);
  fs.mkdirSync(teamsDir, { recursive: true });

  // Serialize manually for clean output
  const { _source, _filePath, ...cleanDef } = def as TeamDefinition & { _source?: string; _filePath?: string };

  // Use yaml stringify for complex objects
  const yamlLib = require('yaml');
  const content = yamlLib.stringify(cleanDef);

  const filePath = path.join(teamsDir, `${def.name}.yaml`);
  fs.writeFileSync(filePath, content);
  invalidateCache();
  return filePath;
}
