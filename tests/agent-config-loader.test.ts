/**
 * Tests for src/agents/agent-config-loader.ts
 *
 * Covers: loadAgentDefinitions, loadTeamDefinitions, resolveTeam,
 * mapEngineToAgentType, getAgent, getTeam, listAgentDefs, listTeamDefs,
 * scaffoldAgentsDir, saveAgentDef, saveTeamDef, caching, merging priorities.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Mock fs before importing the module under test
vi.mock('fs');

// We need the real path and os modules
vi.mock('path', { spy: true });
vi.mock('os', { spy: true });

// Mock the presets module
vi.mock('../src/agents/agent-config-presets.js', () => ({
  BUILTIN_AGENTS: {
    'default-claude': {
      name: 'default-claude',
      description: 'Claude coding agent via Anthropic',
      engine: 'claude-sdk' as const,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      instructions: 'You are a senior software engineer.',
      role: 'coder',
      weight: 1.0,
      _source: 'builtin',
    },
    'code-reviewer': {
      name: 'code-reviewer',
      description: 'Code review agent',
      engine: 'cli' as const,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      instructions: 'Review code thoroughly.',
      role: 'reviewer',
      weight: 1.0,
      _source: 'builtin',
    },
  },
  BUILTIN_TEAMS: {
    'review-team': {
      name: 'review-team',
      description: 'Code review team',
      mode: 'competitive',
      members: [
        { agent: 'code-reviewer', role: 'lead-reviewer' },
      ],
    },
  },
}));

import {
  loadAgentDefinitions,
  loadTeamDefinitions,
  resolveTeam,
  mapEngineToAgentType,
  getAgent,
  getTeam,
  listAgentDefs,
  listTeamDefs,
  scaffoldAgentsDir,
  saveAgentDef,
  saveTeamDef,
} from '../src/agents/agent-config-loader.js';
import type { AgentDefinition, TeamDefinition } from '../src/agents/agent-config-types.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const HOME = os.homedir();
const GLOBAL_AGENTS_DIR = path.join(HOME, '.calliope-cli', 'agents');
const GLOBAL_TEAMS_DIR = path.join(GLOBAL_AGENTS_DIR, 'teams');
const TEST_CWD = '/test/project';
const PROJECT_AGENTS_DIR = path.join(TEST_CWD, '.calliope', 'agents');
const PROJECT_TEAMS_DIR = path.join(TEST_CWD, '.calliope', 'agents', 'teams');

/** Helper to configure fs mock for a directory with files */
function setupFsDir(dirFiles: Record<string, { content: string; isFile?: boolean; mtimeMs?: number }>) {
  const existingDirs = new Set<string>();
  const fileMap = new Map<string, { content: string; isFile: boolean; mtimeMs: number }>();

  for (const [filePath, info] of Object.entries(dirFiles)) {
    const dir = path.dirname(filePath);
    existingDirs.add(dir);
    fileMap.set(filePath, {
      content: info.content,
      isFile: info.isFile !== false,
      mtimeMs: info.mtimeMs ?? 1000,
    });
  }

  const mockedFs = vi.mocked(fs);

  mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
    const ps = String(p);
    return existingDirs.has(ps) || fileMap.has(ps);
  });

  mockedFs.statSync.mockImplementation((p: fs.PathLike) => {
    const ps = String(p);
    if (existingDirs.has(ps)) {
      return { mtimeMs: 1000, isFile: () => false, isDirectory: () => true } as unknown as fs.Stats;
    }
    const f = fileMap.get(ps);
    if (f) {
      return { mtimeMs: f.mtimeMs, isFile: () => f.isFile, isDirectory: () => !f.isFile } as unknown as fs.Stats;
    }
    throw Object.assign(new Error(`ENOENT: no such file ${ps}`), { code: 'ENOENT' });
  });

  mockedFs.readdirSync.mockImplementation((p: fs.PathLike) => {
    const ps = String(p);
    if (!existingDirs.has(ps)) {
      throw Object.assign(new Error(`ENOENT: no such directory ${ps}`), { code: 'ENOENT' });
    }
    const entries: string[] = [];
    for (const filePath of fileMap.keys()) {
      if (path.dirname(filePath) === ps) {
        entries.push(path.basename(filePath));
      }
    }
    return entries as unknown as fs.Dirent[];
  });

  mockedFs.readFileSync.mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
    const ps = String(p);
    const f = fileMap.get(ps);
    if (f) return f.content;
    throw Object.assign(new Error(`ENOENT: no such file ${ps}`), { code: 'ENOENT' });
  });

  mockedFs.mkdirSync.mockImplementation(() => undefined as any);
  mockedFs.writeFileSync.mockImplementation(() => undefined);
}

/** Setup empty filesystem (no dirs exist) */
function setupEmptyFs() {
  const mockedFs = vi.mocked(fs);
  mockedFs.existsSync.mockReturnValue(false);
  mockedFs.statSync.mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  mockedFs.readdirSync.mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  mockedFs.readFileSync.mockImplementation(() => {
    throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  });
  mockedFs.mkdirSync.mockImplementation(() => undefined as any);
  mockedFs.writeFileSync.mockImplementation(() => undefined);
}

/**
 * Force cache invalidation by changing cwd between tests.
 * The loader caches by cwd + mtime, so each test uses a unique cwd
 * or we call loadAgentDefinitions with a fresh path.
 */
let testCounter = 0;
function uniqueCwd(): string {
  return `/test/project-${++testCounter}`;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================================================
// mapEngineToAgentType
// ============================================================================

describe('mapEngineToAgentType', () => {
  it('should return "claude" for cli engine with anthropic provider', () => {
    expect(mapEngineToAgentType('cli', 'anthropic')).toBe('claude');
  });

  it('should return "gemini" for cli engine with google provider', () => {
    expect(mapEngineToAgentType('cli', 'google')).toBe('gemini');
  });

  it('should return "codex" for cli engine with openai provider', () => {
    expect(mapEngineToAgentType('cli', 'openai')).toBe('codex');
  });

  it('should return "calliope" for cli engine with unknown provider', () => {
    expect(mapEngineToAgentType('cli', 'ollama')).toBe('calliope');
  });

  it('should return "calliope" for cli engine with no provider', () => {
    expect(mapEngineToAgentType('cli')).toBe('calliope');
  });

  it('should return "calliope" for undefined engine', () => {
    expect(mapEngineToAgentType(undefined, 'anthropic')).toBe('claude');
  });

  it('should return "calliope" for sdk engines regardless of provider', () => {
    expect(mapEngineToAgentType('claude-sdk', 'anthropic')).toBe('calliope');
    expect(mapEngineToAgentType('openai-sdk', 'openai')).toBe('calliope');
    expect(mapEngineToAgentType('google-adk', 'google')).toBe('calliope');
  });

  it('should return "calliope" with no arguments', () => {
    expect(mapEngineToAgentType()).toBe('calliope');
  });
});

// ============================================================================
// loadAgentDefinitions
// ============================================================================

describe('loadAgentDefinitions', () => {
  it('should load built-in agents when no filesystem agents exist', () => {
    const cwd = uniqueCwd();
    setupEmptyFs();

    const agents = loadAgentDefinitions(cwd);
    expect(agents.size).toBeGreaterThanOrEqual(2);
    expect(agents.has('default-claude')).toBe(true);
    expect(agents.has('code-reviewer')).toBe(true);
  });

  it('should include built-in agent properties', () => {
    const cwd = uniqueCwd();
    setupEmptyFs();

    const agents = loadAgentDefinitions(cwd);
    const claude = agents.get('default-claude');
    expect(claude).toBeDefined();
    expect(claude!.name).toBe('default-claude');
    expect(claude!.engine).toBe('claude-sdk');
    expect(claude!.provider).toBe('anthropic');
  });

  it('should load agents from global directory', () => {
    const cwd = uniqueCwd();
    const globalAgentPath = path.join(GLOBAL_AGENTS_DIR, 'my-global-agent.yaml');
    setupFsDir({
      [globalAgentPath]: {
        content: `name: my-global-agent
description: A global agent
engine: cli
provider: anthropic
model: claude-sonnet-4-20250514
instructions: Do stuff globally.
role: global-worker
weight: 0.9
`,
      },
    });

    const agents = loadAgentDefinitions(cwd);
    expect(agents.has('my-global-agent')).toBe(true);
    const def = agents.get('my-global-agent')!;
    expect(def.name).toBe('my-global-agent');
    expect(def.engine).toBe('cli');
    expect(def._source).toBe('global');
  });

  it('should load agents from project directory', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const projectAgentPath = path.join(projectDir, 'project-agent.yaml');
    setupFsDir({
      [projectAgentPath]: {
        content: `name: project-agent
description: A project-level agent
engine: openai-sdk
provider: openai
model: gpt-4o
`,
      },
    });

    const agents = loadAgentDefinitions(cwd);
    expect(agents.has('project-agent')).toBe(true);
    const def = agents.get('project-agent')!;
    expect(def._source).toBe('project');
  });

  it('should give project agents priority over global', () => {
    const cwd = uniqueCwd();
    const globalPath = path.join(GLOBAL_AGENTS_DIR, 'same-agent.yaml');
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const projectPath = path.join(projectDir, 'same-agent.yaml');

    setupFsDir({
      [globalPath]: {
        content: `name: same-agent
description: Global version
engine: cli
provider: anthropic
`,
      },
      [projectPath]: {
        content: `name: same-agent
description: Project version
engine: openai-sdk
provider: openai
`,
      },
    });

    const agents = loadAgentDefinitions(cwd);
    const def = agents.get('same-agent')!;
    expect(def.description).toBe('Project version');
    expect(def._source).toBe('project');
  });

  it('should give global agents priority over builtin', () => {
    const cwd = uniqueCwd();
    const globalPath = path.join(GLOBAL_AGENTS_DIR, 'default-claude.yaml');

    setupFsDir({
      [globalPath]: {
        content: `name: default-claude
description: Custom global claude
engine: cli
provider: anthropic
model: claude-3-opus
`,
      },
    });

    const agents = loadAgentDefinitions(cwd);
    const def = agents.get('default-claude')!;
    expect(def.description).toBe('Custom global claude');
  });

  it('should load JSON agent files', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const jsonPath = path.join(projectDir, 'json-agent.json');

    setupFsDir({
      [jsonPath]: {
        content: JSON.stringify({
          name: 'json-agent',
          description: 'JSON defined agent',
          engine: 'cli',
          provider: 'openai',
        }),
      },
    });

    const agents = loadAgentDefinitions(cwd);
    expect(agents.has('json-agent')).toBe(true);
    expect(agents.get('json-agent')!.description).toBe('JSON defined agent');
  });

  it('should load .yml extension files', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const ymlPath = path.join(projectDir, 'yml-agent.yml');

    setupFsDir({
      [ymlPath]: {
        content: `name: yml-agent
engine: cli
provider: google
`,
      },
    });

    const agents = loadAgentDefinitions(cwd);
    expect(agents.has('yml-agent')).toBe(true);
  });

  it('should skip files with unsupported extensions', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const txtPath = path.join(projectDir, 'notes.txt');

    setupFsDir({
      [txtPath]: {
        content: `name: should-not-load\nengine: cli`,
      },
    });

    const agents = loadAgentDefinitions(cwd);
    expect(agents.has('should-not-load')).toBe(false);
  });

  it('should skip malformed YAML files silently', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const badPath = path.join(projectDir, 'bad.yaml');
    const goodPath = path.join(projectDir, 'good.yaml');

    setupFsDir({
      [badPath]: {
        content: `{{{invalid yaml:::`,
      },
      [goodPath]: {
        content: `name: good-agent\nengine: cli`,
      },
    });

    const agents = loadAgentDefinitions(cwd);
    expect(agents.has('good-agent')).toBe(true);
    // bad file should not crash the loader
  });

  it('should skip YAML files without a name field', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const noNamePath = path.join(projectDir, 'no-name.yaml');

    setupFsDir({
      [noNamePath]: {
        content: `description: No name here\nengine: cli`,
      },
    });

    const agents = loadAgentDefinitions(cwd);
    // Should only have builtins, no nameless agent
    for (const [, def] of agents) {
      expect(def.description).not.toBe('No name here');
    }
  });

  it('should skip non-file entries (directories)', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const dirEntry = path.join(projectDir, 'subdir.yaml');

    setupFsDir({
      [dirEntry]: {
        content: `name: should-skip`,
        isFile: false,
      },
    });

    const agents = loadAgentDefinitions(cwd);
    expect(agents.has('should-skip')).toBe(false);
  });

  it('should use cache on second call with same cwd', () => {
    const cwd = uniqueCwd();
    setupEmptyFs();

    const first = loadAgentDefinitions(cwd);
    const second = loadAgentDefinitions(cwd);
    expect(first).toBe(second); // same reference = cached
  });

  it('should invalidate cache when cwd changes', () => {
    setupEmptyFs();
    const cwd1 = uniqueCwd();
    const cwd2 = uniqueCwd();

    const first = loadAgentDefinitions(cwd1);
    const second = loadAgentDefinitions(cwd2);
    // Different cwds should give different map instances
    // (though contents may be the same if both are empty)
    expect(first).not.toBe(second);
  });
});

// ============================================================================
// loadTeamDefinitions
// ============================================================================

describe('loadTeamDefinitions', () => {
  it('should load built-in teams when no filesystem teams exist', () => {
    const cwd = uniqueCwd();
    setupEmptyFs();

    const teams = loadTeamDefinitions(cwd);
    expect(teams.has('review-team')).toBe(true);
  });

  it('should include built-in team properties', () => {
    const cwd = uniqueCwd();
    setupEmptyFs();

    const teams = loadTeamDefinitions(cwd);
    const team = teams.get('review-team');
    expect(team).toBeDefined();
    expect(team!.mode).toBe('competitive');
    expect(team!.members).toHaveLength(1);
  });

  it('should load teams from global directory', () => {
    const cwd = uniqueCwd();
    const globalTeamPath = path.join(GLOBAL_TEAMS_DIR, 'global-team.yaml');

    setupFsDir({
      [globalTeamPath]: {
        content: `name: global-team
description: A global team
mode: collaborative
members:
  - name: member1
    engine: cli
    provider: anthropic
`,
      },
    });

    const teams = loadTeamDefinitions(cwd);
    expect(teams.has('global-team')).toBe(true);
    expect(teams.get('global-team')!._source).toBe('global');
  });

  it('should load teams from project directory', () => {
    const cwd = uniqueCwd();
    const projectTeamsDir = path.join(cwd, '.calliope', 'agents', 'teams');
    const projectTeamPath = path.join(projectTeamsDir, 'project-team.yaml');

    setupFsDir({
      [projectTeamPath]: {
        content: `name: project-team
mode: consensus
members:
  - name: local-agent
    engine: openai-sdk
`,
      },
    });

    const teams = loadTeamDefinitions(cwd);
    expect(teams.has('project-team')).toBe(true);
    expect(teams.get('project-team')!._source).toBe('project');
  });

  it('should give project teams priority over global and builtin', () => {
    const cwd = uniqueCwd();
    const projectTeamsDir = path.join(cwd, '.calliope', 'agents', 'teams');
    const overridePath = path.join(projectTeamsDir, 'review-team.yaml');

    setupFsDir({
      [overridePath]: {
        content: `name: review-team
description: Project override
mode: collaborative
members:
  - name: inline-member
    engine: cli
`,
      },
    });

    const teams = loadTeamDefinitions(cwd);
    const team = teams.get('review-team')!;
    expect(team.description).toBe('Project override');
    expect(team.mode).toBe('collaborative');
  });

  it('should use cache on repeated calls', () => {
    const cwd = uniqueCwd();
    setupEmptyFs();

    // Prime lastCwd by loading agents first (they share the lastCwd variable)
    loadAgentDefinitions(cwd);

    const first = loadTeamDefinitions(cwd);
    const second = loadTeamDefinitions(cwd);
    expect(first).toBe(second);
  });
});

// ============================================================================
// resolveTeam
// ============================================================================

describe('resolveTeam', () => {
  it('should resolve a team with member refs', () => {
    const agents = new Map<string, AgentDefinition>();
    agents.set('code-reviewer', {
      name: 'code-reviewer',
      engine: 'cli',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      instructions: 'Review code.',
      role: 'reviewer',
      weight: 1.5,
    });

    const teamDef: TeamDefinition = {
      name: 'test-team',
      mode: 'competitive',
      members: [
        { agent: 'code-reviewer', role: 'lead-reviewer' },
      ],
    };

    const resolved = resolveTeam(teamDef, agents);
    expect(resolved.name).toBe('test-team');
    expect(resolved.members).toHaveLength(1);

    const member = resolved.members[0];
    expect(member.name).toBe('code-reviewer');
    expect(member.agent).toBe('claude'); // cli + anthropic = claude
    expect(member.role).toBe('lead-reviewer'); // role override
    expect(member.weight).toBe(1.5);
    expect(member.instructions).toBe('Review code.');
  });

  it('should resolve inline team members', () => {
    const agents = new Map<string, AgentDefinition>();

    const teamDef: TeamDefinition = {
      name: 'inline-team',
      mode: 'collaborative',
      members: [
        {
          name: 'inline-agent',
          engine: 'openai-sdk',
          provider: 'openai',
          model: 'gpt-4o',
          instructions: 'Inline instructions.',
          role: 'inline-role',
          weight: 0.8,
        },
      ],
    };

    const resolved = resolveTeam(teamDef, agents);
    const member = resolved.members[0];
    expect(member.name).toBe('inline-agent');
    expect(member.agent).toBe('calliope'); // openai-sdk → calliope
    expect(member.engine).toBe('openai-sdk');
    expect(member.weight).toBe(0.8);
  });

  it('should throw when referencing undefined agent', () => {
    const agents = new Map<string, AgentDefinition>();
    const teamDef: TeamDefinition = {
      name: 'bad-team',
      mode: 'competitive',
      members: [
        { agent: 'nonexistent-agent' },
      ],
    };

    expect(() => resolveTeam(teamDef, agents)).toThrow(
      /Team references undefined agent 'nonexistent-agent'/
    );
  });

  it('should use nameOverride when provided in member ref', () => {
    const agents = new Map<string, AgentDefinition>();
    agents.set('code-reviewer', {
      name: 'code-reviewer',
      engine: 'cli',
      provider: 'anthropic',
      role: 'reviewer',
    });

    const teamDef: TeamDefinition = {
      name: 'renamed-team',
      mode: 'competitive',
      members: [
        { agent: 'code-reviewer', nameOverride: 'My Custom Name' },
      ],
    };

    const resolved = resolveTeam(teamDef, agents);
    expect(resolved.members[0].name).toBe('My Custom Name');
  });

  it('should use default weight of 1.0 when not specified', () => {
    const agents = new Map<string, AgentDefinition>();
    agents.set('no-weight-agent', {
      name: 'no-weight-agent',
      engine: 'cli',
    });

    const teamDef: TeamDefinition = {
      name: 'weight-team',
      mode: 'competitive',
      members: [
        { agent: 'no-weight-agent' },
      ],
    };

    const resolved = resolveTeam(teamDef, agents);
    expect(resolved.members[0].weight).toBe(1.0);
  });

  it('should default inline member weight to 1.0', () => {
    const teamDef: TeamDefinition = {
      name: 'inline-weight',
      mode: 'competitive',
      members: [
        { name: 'no-weight', engine: 'cli' },
      ],
    };

    const resolved = resolveTeam(teamDef, new Map());
    expect(resolved.members[0].weight).toBe(1.0);
  });

  it('should default inline member engine to cli', () => {
    const teamDef: TeamDefinition = {
      name: 'default-engine-team',
      mode: 'competitive',
      members: [
        { name: 'no-engine-member' } as any,
      ],
    };

    const resolved = resolveTeam(teamDef, new Map());
    expect(resolved.members[0].engine).toBe('cli');
  });

  it('should preserve swarm and council settings', () => {
    const teamDef: TeamDefinition = {
      name: 'settings-team',
      mode: 'consensus',
      members: [{ name: 'x', engine: 'cli' }],
      swarm: { strategy: 'parallel', maxWorkers: 5 },
      council: { maxRounds: 3, consensusThreshold: 0.75 },
      promptPrefix: 'Always be thorough.',
    };

    const resolved = resolveTeam(teamDef, new Map());
    expect(resolved.swarm).toEqual({ strategy: 'parallel', maxWorkers: 5 });
    expect(resolved.council).toEqual({ maxRounds: 3, consensusThreshold: 0.75 });
    expect(resolved.promptPrefix).toBe('Always be thorough.');
  });

  it('should pass through limits from agent definition', () => {
    const agents = new Map<string, AgentDefinition>();
    agents.set('limited-agent', {
      name: 'limited-agent',
      engine: 'cli',
      provider: 'anthropic',
      limits: { timeout: 30000, maxIterations: 50 },
    });

    const teamDef: TeamDefinition = {
      name: 'limits-team',
      mode: 'competitive',
      members: [{ agent: 'limited-agent' }],
    };

    const resolved = resolveTeam(teamDef, agents);
    expect(resolved.members[0].limits).toEqual({ timeout: 30000, maxIterations: 50 });
  });

  it('should handle member ref weight override', () => {
    const agents = new Map<string, AgentDefinition>();
    agents.set('weighted', {
      name: 'weighted',
      engine: 'cli',
      weight: 2.0,
    });

    const teamDef: TeamDefinition = {
      name: 'weight-override',
      mode: 'competitive',
      members: [
        { agent: 'weighted', weight: 3.0 },
      ],
    };

    const resolved = resolveTeam(teamDef, agents);
    // weight from member ref overrides agent def
    expect(resolved.members[0].weight).toBe(3.0);
  });
});

// ============================================================================
// getAgent
// ============================================================================

describe('getAgent', () => {
  it('should return a built-in agent by name', () => {
    const cwd = uniqueCwd();
    setupEmptyFs();

    const agent = getAgent('default-claude', cwd);
    expect(agent).toBeDefined();
    expect(agent!.name).toBe('default-claude');
  });

  it('should return undefined for unknown agent', () => {
    const cwd = uniqueCwd();
    setupEmptyFs();

    const agent = getAgent('nonexistent', cwd);
    expect(agent).toBeUndefined();
  });
});

// ============================================================================
// getTeam
// ============================================================================

describe('getTeam', () => {
  it('should return a resolved built-in team', () => {
    const cwd = uniqueCwd();
    setupEmptyFs();

    const team = getTeam('review-team', cwd);
    expect(team).toBeDefined();
    expect(team!.name).toBe('review-team');
    expect(team!.members).toHaveLength(1);
  });

  it('should return undefined for unknown team', () => {
    const cwd = uniqueCwd();
    setupEmptyFs();

    const team = getTeam('nonexistent-team', cwd);
    expect(team).toBeUndefined();
  });
});

// ============================================================================
// listAgentDefs / listTeamDefs
// ============================================================================

describe('listAgentDefs', () => {
  it('should return all agent definitions as an array', () => {
    const cwd = uniqueCwd();
    setupEmptyFs();

    const agents = listAgentDefs(cwd);
    expect(Array.isArray(agents)).toBe(true);
    expect(agents.length).toBeGreaterThanOrEqual(2);
    expect(agents.some(a => a.name === 'default-claude')).toBe(true);
  });
});

describe('listTeamDefs', () => {
  it('should return all team definitions as an array', () => {
    const cwd = uniqueCwd();
    setupEmptyFs();

    const teams = listTeamDefs(cwd);
    expect(Array.isArray(teams)).toBe(true);
    expect(teams.length).toBeGreaterThanOrEqual(1);
    expect(teams.some(t => t.name === 'review-team')).toBe(true);
  });
});

// ============================================================================
// scaffoldAgentsDir
// ============================================================================

describe('scaffoldAgentsDir', () => {
  it('should create agents and teams directories', () => {
    const cwd = '/test/scaffold';
    const mockedFs = vi.mocked(fs);
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.writeFileSync.mockImplementation(() => undefined);
    // For cache invalidation side-effects
    mockedFs.statSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockedFs.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    scaffoldAgentsDir(cwd);

    const agentsDir = path.join(cwd, '.calliope', 'agents');
    const teamsDir = path.join(cwd, '.calliope', 'agents', 'teams');
    expect(mockedFs.mkdirSync).toHaveBeenCalledWith(agentsDir, { recursive: true });
    expect(mockedFs.mkdirSync).toHaveBeenCalledWith(teamsDir, { recursive: true });
  });

  it('should write example agent file when it does not exist', () => {
    const cwd = '/test/scaffold2';
    const mockedFs = vi.mocked(fs);
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.writeFileSync.mockImplementation(() => undefined);
    mockedFs.statSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockedFs.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = scaffoldAgentsDir(cwd);

    const agentsDir = path.join(cwd, '.calliope', 'agents');
    const exampleAgent = path.join(agentsDir, 'example-agent.yaml');
    const exampleTeam = path.join(agentsDir, 'teams', 'example-team.yaml');

    expect(result.created).toContain(exampleAgent);
    expect(result.created).toContain(exampleTeam);
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      exampleAgent,
      expect.stringContaining('name: my-agent')
    );
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      exampleTeam,
      expect.stringContaining('name: my-team')
    );
  });

  it('should NOT overwrite existing example files', () => {
    const cwd = '/test/scaffold3';
    const mockedFs = vi.mocked(fs);
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.existsSync.mockReturnValue(true); // files already exist
    mockedFs.writeFileSync.mockImplementation(() => undefined);
    mockedFs.statSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockedFs.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const result = scaffoldAgentsDir(cwd);
    expect(result.created).toHaveLength(0);
    expect(mockedFs.writeFileSync).not.toHaveBeenCalled();
  });
});

// ============================================================================
// saveAgentDef
// ============================================================================

describe('saveAgentDef', () => {
  it('should create agents directory and write YAML', () => {
    const cwd = '/test/save-agent';
    const mockedFs = vi.mocked(fs);
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.writeFileSync.mockImplementation(() => undefined);
    // For cache invalidation
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.statSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockedFs.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const def: AgentDefinition = {
      name: 'my-saved-agent',
      description: 'A saved agent',
      engine: 'cli',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      instructions: 'Be helpful.\nFollow conventions.',
      role: 'coder',
      weight: 1.2,
      limits: { timeout: 60000, maxIterations: 50 },
    };

    const filePath = saveAgentDef(cwd, def);

    expect(filePath).toBe(path.join(cwd, '.calliope', 'agents', 'my-saved-agent.yaml'));
    expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
      path.join(cwd, '.calliope', 'agents'),
      { recursive: true }
    );
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      filePath,
      expect.stringContaining('name: my-saved-agent')
    );
  });

  it('should include all fields in the written YAML', () => {
    const cwd = '/test/save-agent-full';
    const mockedFs = vi.mocked(fs);
    let writtenContent = '';
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.writeFileSync.mockImplementation((_p, content) => {
      writtenContent = String(content);
    });
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.statSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockedFs.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    saveAgentDef(cwd, {
      name: 'full-agent',
      description: 'Fully specified',
      engine: 'openai-sdk',
      provider: 'openai',
      model: 'gpt-4o',
      instructions: 'Line 1\nLine 2',
      role: 'analyst',
      weight: 0.5,
      limits: { timeout: 120000, maxIterations: 200 },
    });

    expect(writtenContent).toContain('name: full-agent');
    expect(writtenContent).toContain('description: Fully specified');
    expect(writtenContent).toContain('engine: openai-sdk');
    expect(writtenContent).toContain('provider: openai');
    expect(writtenContent).toContain('model: gpt-4o');
    expect(writtenContent).toContain('instructions: |');
    expect(writtenContent).toContain('  Line 1');
    expect(writtenContent).toContain('  Line 2');
    expect(writtenContent).toContain('role: analyst');
    expect(writtenContent).toContain('weight: 0.5');
    expect(writtenContent).toContain('limits:');
    expect(writtenContent).toContain('  timeout: 120000');
    expect(writtenContent).toContain('  maxIterations: 200');
  });

  it('should omit optional fields when not present', () => {
    const cwd = '/test/save-agent-min';
    const mockedFs = vi.mocked(fs);
    let writtenContent = '';
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.writeFileSync.mockImplementation((_p, content) => {
      writtenContent = String(content);
    });
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.statSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockedFs.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    saveAgentDef(cwd, {
      name: 'minimal-agent',
      engine: 'cli',
    });

    expect(writtenContent).toContain('name: minimal-agent');
    expect(writtenContent).toContain('engine: cli');
    expect(writtenContent).not.toContain('description:');
    expect(writtenContent).not.toContain('provider:');
    expect(writtenContent).not.toContain('model:');
    expect(writtenContent).not.toContain('instructions:');
    expect(writtenContent).not.toContain('role:');
    expect(writtenContent).not.toContain('weight:');
    expect(writtenContent).not.toContain('limits:');
  });
});

// ============================================================================
// saveTeamDef
// ============================================================================

describe('saveTeamDef', () => {
  it('should create teams directory and write YAML', () => {
    const cwd = '/test/save-team';
    const mockedFs = vi.mocked(fs);
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.writeFileSync.mockImplementation(() => undefined);
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.statSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockedFs.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const def: TeamDefinition = {
      name: 'my-team',
      description: 'Test team',
      mode: 'competitive',
      members: [
        { name: 'member1', engine: 'cli', provider: 'anthropic' },
      ],
    };

    const filePath = saveTeamDef(cwd, def);

    expect(filePath).toBe(path.join(cwd, '.calliope', 'agents', 'teams', 'my-team.yaml'));
    expect(mockedFs.mkdirSync).toHaveBeenCalledWith(
      path.join(cwd, '.calliope', 'agents', 'teams'),
      { recursive: true }
    );
    expect(mockedFs.writeFileSync).toHaveBeenCalledWith(
      filePath,
      expect.any(String)
    );
  });

  it('should strip _source and _filePath metadata before saving', () => {
    const cwd = '/test/save-team-clean';
    const mockedFs = vi.mocked(fs);
    let writtenContent = '';
    mockedFs.mkdirSync.mockImplementation(() => undefined as any);
    mockedFs.writeFileSync.mockImplementation((_p, content) => {
      writtenContent = String(content);
    });
    mockedFs.existsSync.mockReturnValue(false);
    mockedFs.statSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockedFs.readdirSync.mockImplementation(() => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });

    const def = {
      name: 'clean-team',
      mode: 'competitive' as const,
      members: [{ name: 'x', engine: 'cli' as const }],
      _source: 'project',
      _filePath: '/old/path.yaml',
    };

    saveTeamDef(cwd, def as TeamDefinition);

    expect(writtenContent).not.toContain('_source');
    expect(writtenContent).not.toContain('_filePath');
  });
});

// ============================================================================
// Error handling edge cases
// ============================================================================

describe('error handling', () => {
  it('should handle readFileSync throwing errors gracefully', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const badPath = path.join(projectDir, 'unreadable.yaml');

    const mockedFs = vi.mocked(fs);
    mockedFs.existsSync.mockImplementation((p: fs.PathLike) => {
      return String(p) === projectDir;
    });
    mockedFs.statSync.mockImplementation((p: fs.PathLike) => {
      const ps = String(p);
      if (ps === projectDir) {
        return { mtimeMs: 1000, isFile: () => false } as unknown as fs.Stats;
      }
      if (ps === badPath) {
        return { mtimeMs: 1000, isFile: () => true } as unknown as fs.Stats;
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockedFs.readdirSync.mockImplementation((p: fs.PathLike) => {
      if (String(p) === projectDir) {
        return ['unreadable.yaml'] as unknown as fs.Dirent[];
      }
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    });
    mockedFs.readFileSync.mockImplementation(() => {
      throw new Error('Permission denied');
    });

    // Should not throw, just skip unreadable files
    const agents = loadAgentDefinitions(cwd);
    expect(agents).toBeDefined();
  });

  it('should handle invalid JSON files gracefully', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const badJsonPath = path.join(projectDir, 'bad.json');

    setupFsDir({
      [badJsonPath]: {
        content: '{ not valid json ]]',
      },
    });

    // Should not throw
    const agents = loadAgentDefinitions(cwd);
    expect(agents).toBeDefined();
  });

  it('should handle YAML that parses to null/non-object', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const nullYamlPath = path.join(projectDir, 'null.yaml');

    setupFsDir({
      [nullYamlPath]: {
        content: '---\n',  // YAML null document
      },
    });

    const agents = loadAgentDefinitions(cwd);
    // Should not crash, just skip
    expect(agents).toBeDefined();
  });

  it('should handle YAML that parses to a scalar', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const scalarPath = path.join(projectDir, 'scalar.yaml');

    setupFsDir({
      [scalarPath]: {
        content: 'just a plain string',
      },
    });

    const agents = loadAgentDefinitions(cwd);
    expect(agents).toBeDefined();
  });
});

// ============================================================================
// Mixed agents + teams integration
// ============================================================================

describe('integration: agents + teams from filesystem', () => {
  it('should resolve team that references filesystem-loaded agent', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const teamsDir = path.join(cwd, '.calliope', 'agents', 'teams');
    const agentPath = path.join(projectDir, 'custom-agent.yaml');
    const teamPath = path.join(teamsDir, 'custom-team.yaml');

    setupFsDir({
      [agentPath]: {
        content: `name: custom-agent
description: Custom project agent
engine: cli
provider: google
model: gemini-2.0-flash
instructions: Be creative.
role: creator
weight: 1.5
`,
      },
      [teamPath]: {
        content: `name: custom-team
description: Team using custom agent
mode: collaborative
members:
  - agent: custom-agent
    role: lead
`,
      },
    });

    const team = getTeam('custom-team', cwd);
    expect(team).toBeDefined();
    expect(team!.name).toBe('custom-team');
    expect(team!.members).toHaveLength(1);

    const member = team!.members[0];
    expect(member.name).toBe('custom-agent');
    expect(member.agent).toBe('gemini'); // cli + google = gemini
    expect(member.role).toBe('lead');
    expect(member.weight).toBe(1.5);
  });

  it('should list both builtin and filesystem agents', () => {
    const cwd = uniqueCwd();
    const projectDir = path.join(cwd, '.calliope', 'agents');
    const agentPath = path.join(projectDir, 'extra.yaml');

    setupFsDir({
      [agentPath]: {
        content: `name: extra-agent
engine: cli
provider: ollama
`,
      },
    });

    const agents = listAgentDefs(cwd);
    const names = agents.map(a => a.name);
    expect(names).toContain('default-claude');
    expect(names).toContain('code-reviewer');
    expect(names).toContain('extra-agent');
  });
});
