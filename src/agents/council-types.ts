/**
 * Calliope Agents — Council Types
 *
 * Type definitions for agent councils: groups of agents deliberating
 * on a shared goal with multiple coordination modes.
 */

import type { SubAgentType, TaskPriority } from './types.js';

/**
 * Council coordination modes
 */
export type CouncilMode = 'consensus' | 'competitive' | 'collaborative' | 'overseer';

/**
 * Council session status
 */
export type CouncilStatus =
  | 'deliberating'
  | 'voting'
  | 'scoring'
  | 'building'
  | 'reviewing'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Tie-breaking strategies
 */
export type TieBreaker = 'voting' | 'scoring' | 'designated' | 'user';

/**
 * A council member (agent)
 */
export interface CouncilMember {
  id: string;
  name: string;
  agent: SubAgentType;
  role?: string;          // e.g., 'security-expert', 'performance-reviewer'
  weight: number;         // Vote/score weight (default: 1.0)
}

/**
 * A deliberation entry from a council member
 */
export interface DeliberationEntry {
  memberId: string;
  memberName: string;
  response: string;
  timestamp: Date;
  score?: number;         // 0-100 score from cross-scoring
  votes?: number;         // Votes received in consensus mode
}

/**
 * Vote in consensus mode
 */
export interface Vote {
  voterId: string;
  candidateId: string;    // ID of the deliberation entry being voted for
  weight: number;
}

/**
 * Score in competitive mode
 */
export interface Score {
  scorerId: string;
  targetId: string;       // ID of the deliberation entry being scored
  score: number;          // 0-100
  weight: number;
}

/**
 * Council session configuration
 */
export interface CouncilConfig {
  /** Coordination mode */
  mode: CouncilMode;
  /** Council members */
  members: CouncilMember[];
  /** Tie-breaking strategy */
  tieBreaker: TieBreaker;
  /** Maximum rounds in consensus mode (default: 3) */
  maxRounds: number;
  /** Supermajority threshold for consensus (default: 0.67) */
  consensusThreshold: number;
  /** Designated tie-breaker member ID */
  designatedBreaker?: string;
}

/**
 * Default council configuration
 */
export const DEFAULT_COUNCIL_CONFIG: Omit<CouncilConfig, 'members'> = {
  mode: 'competitive',
  tieBreaker: 'scoring',
  maxRounds: 3,
  consensusThreshold: 0.67,
};

/**
 * A council session
 */
export interface CouncilSession {
  id: string;
  prompt: string;
  status: CouncilStatus;
  config: CouncilConfig;
  deliberations: DeliberationEntry[];
  votes: Vote[];
  scores: Score[];
  round: number;
  activeTaskIds: string[];
  linkedSwarmId?: string;
  result?: string;
  winnerId?: string;      // ID of winning deliberation entry
  error?: string;
  createdAt: Date;
  updatedAt: Date;
  completedAt?: Date;
}

/**
 * Pre-built council templates
 */
export interface CouncilTemplate {
  name: string;
  description: string;
  mode: CouncilMode;
  members: Omit<CouncilMember, 'id'>[];
  tieBreaker: TieBreaker;
  promptPrefix?: string;
}

/**
 * Built-in council templates
 */
export const COUNCIL_TEMPLATES: Record<string, CouncilTemplate> = {
  'code-review': {
    name: 'code-review',
    description: 'Multi-perspective code review council',
    mode: 'competitive',
    members: [
      { name: 'Reviewer A', agent: 'claude', role: 'correctness-reviewer', weight: 1.0 },
      { name: 'Reviewer B', agent: 'gemini', role: 'performance-reviewer', weight: 1.0 },
      { name: 'Reviewer C', agent: 'claude', role: 'security-reviewer', weight: 1.2 },
    ],
    tieBreaker: 'scoring',
    promptPrefix: 'Review the following code. Focus on correctness, performance, security, and maintainability:\n\n',
  },
  'architecture': {
    name: 'architecture',
    description: 'Architecture decision council',
    mode: 'collaborative',
    members: [
      { name: 'Architect', agent: 'claude', role: 'lead-architect', weight: 1.5 },
      { name: 'Engineer', agent: 'gemini', role: 'implementation-expert', weight: 1.0 },
      { name: 'Ops', agent: 'claude', role: 'devops-expert', weight: 1.0 },
    ],
    tieBreaker: 'designated',
    promptPrefix: 'Evaluate the following architecture decision. Consider scalability, maintainability, and operational concerns:\n\n',
  },
  'security-audit': {
    name: 'security-audit',
    description: 'Security audit council',
    mode: 'competitive',
    members: [
      { name: 'AppSec', agent: 'claude', role: 'application-security', weight: 1.0 },
      { name: 'NetSec', agent: 'gemini', role: 'network-security', weight: 1.0 },
      { name: 'Compliance', agent: 'claude', role: 'compliance-auditor', weight: 0.8 },
    ],
    tieBreaker: 'scoring',
    promptPrefix: 'Conduct a security audit of the following. Identify vulnerabilities, risks, and remediation steps:\n\n',
  },
  'brainstorm': {
    name: 'brainstorm',
    description: 'Creative brainstorming council',
    mode: 'collaborative',
    members: [
      { name: 'Ideator', agent: 'claude', role: 'creative-thinker', weight: 1.0 },
      { name: 'Analyst', agent: 'gemini', role: 'feasibility-analyst', weight: 1.0 },
      { name: 'Builder', agent: 'claude', role: 'implementation-planner', weight: 1.0 },
    ],
    tieBreaker: 'voting',
    promptPrefix: 'Brainstorm solutions for the following challenge. Think creatively and consider multiple approaches:\n\n',
  },
  'debate': {
    name: 'debate',
    description: 'Structured debate council',
    mode: 'competitive',
    members: [
      { name: 'Proponent', agent: 'claude', role: 'advocate-for', weight: 1.0 },
      { name: 'Opponent', agent: 'gemini', role: 'advocate-against', weight: 1.0 },
      { name: 'Judge', agent: 'claude', role: 'impartial-judge', weight: 1.5 },
    ],
    tieBreaker: 'designated',
    promptPrefix: 'Debate the following proposition. Present arguments for and against:\n\n',
  },
};
