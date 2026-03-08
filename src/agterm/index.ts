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

// Swarm
export type {
  SwarmSession,
  SwarmSubtask,
  SwarmConfig,
  SwarmStatus,
  SwarmSubtaskStatus,
  DecompositionStrategy,
  AggregationStrategy,
} from './swarm-types.js';

export { DEFAULT_SWARM_CONFIG } from './swarm-types.js';

export { swarmManager } from './swarm.js';

// Decomposer
export {
  buildDecompositionPrompt,
  parseDecompositionResponse,
  resolveDependencies,
  getReadySubtasks,
  allSubtasksDone,
  hasFailedSubtasks,
} from './decomposer.js';

// Aggregator
export {
  aggregateResults,
  buildAggregationPrompt,
} from './aggregator.js';

// Council
export type {
  CouncilSession,
  CouncilConfig,
  CouncilMember,
  CouncilMode,
  CouncilStatus,
  CouncilTemplate,
  DeliberationEntry,
  Vote,
  Score,
  TieBreaker,
} from './council-types.js';

export {
  DEFAULT_COUNCIL_CONFIG,
  COUNCIL_TEMPLATES,
} from './council-types.js';

export { councilManager } from './council.js';

// SDK Backend
export type { TaskExecutor } from './types.js';
export {
  isClaudeSdkAvailable,
  isOpenaiSdkAvailable,
  isGoogleAdkAvailable,
  getAvailableExecutors,
  executeSdkAgent,
} from './sdk-backend.js';

// Installer
export {
  getInstallableItems,
  getInstallReport,
  installItem,
  installAllMissing,
} from './installer.js';
export type { InstallableItem } from './installer.js';

// Dynamic Tools
export type { DynamicTool } from './dynamic-tools.js';
export {
  dynamicToolRegistry,
  getDynamicToolDefs,
  isDynamicTool,
  executeDynamicTool,
  executeMetaTool,
  DYNAMIC_TOOL_NAMES,
} from './dynamic-tools.js';

// Agent Config
export type {
  AgentDefinition,
  TeamDefinition,
  TeamMember,
  ResolvedTeam,
  ResolvedTeamMember,
} from './agent-config-types.js';

export {
  getAgent,
  getTeam,
  listAgentDefs,
  listTeamDefs,
  resolveTeam,
  loadAgentDefinitions,
  loadTeamDefinitions,
  scaffoldAgentsDir,
  saveAgentDef,
  saveTeamDef,
  mapEngineToAgentType,
} from './agent-config-loader.js';

export {
  BUILTIN_AGENTS,
  BUILTIN_TEAMS,
} from './agent-config-presets.js';
