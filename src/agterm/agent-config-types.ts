/**
 * Agent & Team Configuration Types
 *
 * Type definitions for .calliope/agents/ YAML-based agent and team definitions.
 */

import type { TaskExecutor, SubAgentType } from './types.js';
import type { DecompositionStrategy, AggregationStrategy } from './swarm-types.js';
import type { CouncilMode, TieBreaker } from './council-types.js';

// ============================================================================
// Agent Definitions
// ============================================================================

/**
 * An agent definition loaded from YAML or built-in presets.
 * Combines system prompt, executor engine, provider, model, and limits.
 */
export interface AgentDefinition {
  name: string;
  description?: string;

  /** Executor backend: cli, claude-sdk, openai-sdk, google-adk */
  engine: TaskExecutor;
  /** LLM provider: anthropic, openai, google, ollama, etc. */
  provider?: string;
  /** Model name: claude-sonnet-4-20250514, gpt-4o, gemini-2.0-flash, etc. */
  model?: string;

  /** System prompt / instructions for this agent */
  instructions?: string;

  /** Role label for swarm/team contexts */
  role?: string;
  /** Weight for scoring in competitive mode (default: 1.0) */
  weight?: number;

  /** Tool restrictions */
  tools?: {
    enabled?: string[];
    disabled?: string[];
  };

  /** Execution limits */
  limits?: {
    /** Timeout in milliseconds (0 = use global default) */
    timeout?: number;
    /** Maximum LLM turns/iterations */
    maxIterations?: number;
  };

  /** Source location of this definition */
  _source?: 'builtin' | 'global' | 'project';
  _filePath?: string;
}

// ============================================================================
// Team Definitions
// ============================================================================

/**
 * A team member that references a named agent definition
 */
export interface TeamMemberRef {
  /** Name of an AgentDefinition to reference */
  agent: string;
  /** Override the agent's role */
  role?: string;
  /** Override the agent's weight */
  weight?: number;
  /** Override display name */
  nameOverride?: string;
}

/**
 * A team member defined inline (no external reference)
 */
export interface TeamMemberInline {
  /** Display name for this member */
  name: string;
  engine?: TaskExecutor;
  provider?: string;
  model?: string;
  instructions?: string;
  role?: string;
  weight?: number;
}

/**
 * A team member — either a reference to a named agent or an inline definition.
 * Discriminated by presence of 'agent' (ref) vs 'name' (inline) key.
 */
export type TeamMember = TeamMemberRef | TeamMemberInline;

/**
 * Check if a team member is a reference
 */
export function isTeamMemberRef(m: TeamMember): m is TeamMemberRef {
  return 'agent' in m && typeof (m as TeamMemberRef).agent === 'string';
}

/**
 * A team definition loaded from YAML or built-in presets.
 * Composes multiple agents with coordination strategy.
 */
export interface TeamDefinition {
  name: string;
  description?: string;

  /** Coordination mode */
  mode: CouncilMode;

  /** Team members (refs or inline) */
  members: TeamMember[];

  /** Swarm-specific settings (used with /swarm --team) */
  swarm?: {
    strategy?: DecompositionStrategy;
    aggregation?: AggregationStrategy;
    maxWorkers?: number;
  };

  /** Council-specific settings (used with /council --team) */
  council?: {
    tieBreaker?: TieBreaker;
    maxRounds?: number;
    consensusThreshold?: number;
  };

  /** Prompt prefix injected before the user's prompt */
  promptPrefix?: string;

  /** Source location */
  _source?: 'builtin' | 'global' | 'project';
  _filePath?: string;
}

// ============================================================================
// Resolved Types (after reference resolution)
// ============================================================================

/**
 * A fully resolved team member with all fields populated
 */
export interface ResolvedTeamMember {
  name: string;
  agent: SubAgentType;
  engine: TaskExecutor;
  provider?: string;
  model?: string;
  instructions?: string;
  role?: string;
  weight: number;
  limits?: {
    timeout?: number;
    maxIterations?: number;
  };
}

/**
 * A fully resolved team with all member references dereferenced
 */
export interface ResolvedTeam {
  name: string;
  description?: string;
  mode: CouncilMode;
  members: ResolvedTeamMember[];
  swarm?: {
    strategy?: DecompositionStrategy;
    aggregation?: AggregationStrategy;
    maxWorkers?: number;
  };
  council?: {
    tieBreaker?: TieBreaker;
    maxRounds?: number;
    consensusThreshold?: number;
  };
  promptPrefix?: string;
}
