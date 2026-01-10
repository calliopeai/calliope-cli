/**
 * AGTerm Multi-Agent Module
 *
 * Provides sub-agent orchestration capabilities.
 */

// Types
export type {
  SubAgentType,
  SubAgentTaskStatus,
  TaskPriority,
  SubAgentTask,
  OrchestratorConfig,
  AgentCLIInfo,
  AgentEventType,
  AgentEvent,
} from './types.js';

export {
  DEFAULT_ORCHESTRATOR_CONFIG,
  AGENT_CLI_MAP,
} from './types.js';

// Agent Detection
export {
  detectAgents,
  getAvailableAgents,
  isAgentAvailable,
  getAgentCLI,
  getAgentEnvVar,
  getAgentStatusReport,
} from './agent-detection.js';

// CLI Backend
export {
  executeAgent,
  cancelTask,
  getTaskOutput,
  isTaskRunning,
  getRunningTaskCount,
  killAllTasks,
} from './cli-backend.js';

// Orchestrator
export { orchestrator } from './orchestrator.js';

// Tools
export {
  getAgtermTools,
  AGTERM_TOOL_NAMES,
  isAgtermTool,
  executeAgtermTool,
} from './tools.js';
