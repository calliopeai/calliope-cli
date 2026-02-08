/**
 * AGTerm Multi-Agent Types
 *
 * Type definitions for sub-agent orchestration.
 */

/**
 * Agent types that can be spawned as sub-agents
 */
export type SubAgentType = 'calliope' | 'claude' | 'gemini' | 'codex';

/**
 * Task status
 */
export type SubAgentTaskStatus =
  | 'pending'
  | 'queued'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

/**
 * Task priority for queue ordering
 */
export type TaskPriority = 'low' | 'normal' | 'high' | 'critical';

/**
 * Sub-agent task representation
 */
export interface SubAgentTask {
  id: string;
  prompt: string;
  agent: SubAgentType;
  status: SubAgentTaskStatus;
  priority: TaskPriority;
  parentId?: string;
  depth: number;
  childIds: string[];
  result?: string;
  error?: string;
  pid?: number;
  swarmId?: string;
  createdAt: Date;
  updatedAt: Date;
  startedAt?: Date;
  completedAt?: Date;
}

/**
 * Orchestrator configuration
 */
export interface OrchestratorConfig {
  /** Maximum concurrent tasks (default: 3) */
  maxConcurrent: number;
  /** Maximum queue size (default: 100) */
  maxQueueSize: number;
  /** Maximum nesting depth (default: 3) */
  maxDepth: number;
  /** Maximum children per task (default: 5) */
  maxChildrenPerTask: number;
  /** Maximum total sub-agents (default: 20) */
  maxTotalSubAgents: number;
  /** Task timeout in milliseconds (default: 5 minutes) */
  taskTimeout: number;
  /** Allow sub-agents to spawn more sub-agents */
  allowNestedSubAgents: boolean;
}

/**
 * Agent CLI information
 */
export interface AgentCLIInfo {
  type: SubAgentType;
  command: string;
  args: string[];
  envVar: string;
  available: boolean;
  reason?: string;
}

/**
 * Agent event types for streaming
 */
export type AgentEventType =
  | 'start'
  | 'text'
  | 'complete'
  | 'error';

/**
 * Agent event emitted during execution
 */
export interface AgentEvent {
  type: AgentEventType;
  taskId: string;
  timestamp: Date;
  content?: string;
  message?: string;
  code?: string;
}

/**
 * Default orchestrator configuration
 */
export const DEFAULT_ORCHESTRATOR_CONFIG: OrchestratorConfig = {
  maxConcurrent: 3,
  maxQueueSize: 100,
  maxDepth: 3,
  maxChildrenPerTask: 5,
  maxTotalSubAgents: 20,
  taskTimeout: 15 * 60 * 1000, // 15 minutes
  allowNestedSubAgents: true,
};

/**
 * Agent CLI command mappings
 */
export const AGENT_CLI_MAP: Record<SubAgentType, { command: string; args: string[]; envVar: string }> = {
  calliope: {
    command: 'calliope',
    args: [],  // sub-agents should respect confirmation prompts
    envVar: 'ANTHROPIC_API_KEY'  // calliope uses anthropic by default
  },
  claude: {
    command: 'claude',
    args: ['--print'],
    envVar: 'ANTHROPIC_API_KEY'
  },
  gemini: {
    command: 'gemini',
    args: [],
    envVar: 'GOOGLE_API_KEY'
  },
  codex: {
    command: 'codex',
    args: [],
    envVar: 'OPENAI_API_KEY'
  },
};
