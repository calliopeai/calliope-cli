/**
 * Calliope Agents — Agent Detection
 *
 * Detect which agent CLIs are installed and available.
 */

import { execFileSync } from 'child_process';
import type { SubAgentType, AgentCLIInfo } from './types.js';
import { AGENT_CLI_MAP } from './types.js';

/**
 * Check if a command exists in PATH
 */
function commandExists(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Check if an environment variable is set
 */
function hasEnvVar(name: string): boolean {
  return !!process.env[name];
}

/**
 * Detect available agent CLIs
 * Returns info about each agent including availability status
 */
export function detectAgents(): AgentCLIInfo[] {
  const agents: AgentCLIInfo[] = [];

  for (const [type, config] of Object.entries(AGENT_CLI_MAP)) {
    const agentType = type as SubAgentType;
    const exists = commandExists(config.command);

    // Calliope works with any provider, not just Anthropic
    let hasKey: boolean;
    if (agentType === 'calliope') {
      hasKey = hasEnvVar('ANTHROPIC_API_KEY') ||
        hasEnvVar('OPENAI_API_KEY') ||
        hasEnvVar('GOOGLE_API_KEY') ||
        hasEnvVar('OLLAMA_BASE_URL') ||
        hasEnvVar('OPENROUTER_API_KEY') ||
        hasEnvVar('TOGETHER_API_KEY') ||
        hasEnvVar('GROQ_API_KEY') ||
        hasEnvVar('MISTRAL_API_KEY');
    } else {
      hasKey = hasEnvVar(config.envVar);
    }

    let available = exists && hasKey;
    let reason: string | undefined;

    if (!exists) {
      reason = `${config.command} not found in PATH`;
    } else if (!hasKey) {
      reason = agentType === 'calliope'
        ? 'No API keys or Ollama configured'
        : `${config.envVar} not set`;
    }

    agents.push({
      type: agentType,
      command: config.command,
      args: config.args,
      envVar: config.envVar,
      available,
      reason,
    });
  }

  return agents;
}

/**
 * Get available agent types (ready to spawn)
 */
export function getAvailableAgents(): SubAgentType[] {
  return detectAgents()
    .filter(a => a.available)
    .map(a => a.type);
}

/**
 * Check if a specific agent is available
 */
export function isAgentAvailable(agent: SubAgentType): boolean {
  const info = detectAgents().find(a => a.type === agent);
  return info?.available ?? false;
}

/**
 * Get CLI command and args for an agent
 */
export function getAgentCLI(agent: SubAgentType): { command: string; args: string[] } {
  const config = AGENT_CLI_MAP[agent];
  return { command: config.command, args: [...config.args] };
}

/**
 * Get environment variable name for an agent's API key
 */
export function getAgentEnvVar(agent: SubAgentType): string {
  return AGENT_CLI_MAP[agent].envVar;
}

/**
 * Print agent availability status (for debugging/display)
 */
export function getAgentStatusReport(): string {
  const agents = detectAgents();
  const lines = agents.map(a => {
    const status = a.available ? '✓ Ready' : `✗ ${a.reason}`;
    return `  ${a.type}: ${status}`;
  });
  return `Sub-Agents:\n${lines.join('\n')}`;
}
