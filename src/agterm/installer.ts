/**
 * AGTerm Agent & SDK Installer
 *
 * Detects missing agent CLIs and SDK backends, provides install commands,
 * and can run installations directly.
 */

import { execFileSync, execSync } from 'child_process';
import { detectAgents } from './agent-detection.js';
import { isClaudeSdkAvailable, isOpenaiSdkAvailable, isGoogleAdkAvailable } from './sdk-backend.js';

// ============================================================================
// Install definitions
// ============================================================================

export interface InstallableItem {
  name: string;
  description: string;
  category: 'cli' | 'sdk';
  installCommand: string;
  checkCommand?: string;
  installed: boolean;
  reason?: string;
}

/**
 * CLI agent install commands
 */
const CLI_AGENTS: Record<string, { description: string; install: string; altInstall?: string; check: string }> = {
  calliope: {
    description: 'Calliope CLI — multi-model AI agent (self)',
    install: 'npm install -g @calliopelabs/cli',
    check: 'calliope',
  },
  claude: {
    description: 'Claude Code CLI — Anthropic coding agent',
    install: 'npm install -g @anthropic-ai/claude-code',
    altInstall: 'brew install --cask claude-code',
    check: 'claude',
  },
  gemini: {
    description: 'Gemini CLI — Google AI coding agent',
    install: 'npm install -g @google/gemini-cli',
    check: 'gemini',
  },
  codex: {
    description: 'Codex CLI — OpenAI coding agent',
    install: 'npm install -g @openai/codex',
    altInstall: 'brew install --cask codex',
    check: 'codex',
  },
};

/**
 * SDK backend install commands
 */
const SDK_BACKENDS: Record<string, { description: string; install: string }> = {
  'claude-sdk': {
    description: 'Claude Agent SDK — in-process Claude agent (supports Anthropic, Bedrock, Vertex)',
    install: 'npm install -g @anthropic-ai/claude-agent-sdk',
  },
  'openai-sdk': {
    description: 'OpenAI Agents JS — in-process agent framework (supports OpenAI, Azure, Ollama, OpenRouter, Groq, etc.)',
    install: 'npm install -g @openai/agents',
  },
  'google-adk': {
    description: 'Google ADK — in-process agent framework (supports Gemini, Vertex AI)',
    install: 'npm install -g @google/adk',
  },
};

// ============================================================================
// Detection
// ============================================================================

function commandExists(command: string): boolean {
  try {
    execFileSync('which', [command], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Get full status of all installable items
 */
export async function getInstallableItems(): Promise<InstallableItem[]> {
  const items: InstallableItem[] = [];

  // CLI agents
  const agents = detectAgents();
  for (const agent of agents) {
    const cliInfo = CLI_AGENTS[agent.type];
    if (!cliInfo) continue;

    const cliInstalled = commandExists(agent.command);
    items.push({
      name: agent.type,
      description: cliInfo.description,
      category: 'cli',
      installCommand: cliInfo.install,
      checkCommand: agent.command,
      installed: cliInstalled,
      reason: cliInstalled ? undefined : `${agent.command} not found in PATH`,
    });
  }

  // SDK backends
  const claudeSdk = await isClaudeSdkAvailable();
  items.push({
    name: 'claude-sdk',
    description: SDK_BACKENDS['claude-sdk'].description,
    category: 'sdk',
    installCommand: SDK_BACKENDS['claude-sdk'].install,
    installed: claudeSdk,
    reason: claudeSdk ? undefined : 'Package not installed',
  });

  const openaiSdk = await isOpenaiSdkAvailable();
  items.push({
    name: 'openai-sdk',
    description: SDK_BACKENDS['openai-sdk'].description,
    category: 'sdk',
    installCommand: SDK_BACKENDS['openai-sdk'].install,
    installed: openaiSdk,
    reason: openaiSdk ? undefined : 'Package not installed',
  });

  const googleAdk = await isGoogleAdkAvailable();
  items.push({
    name: 'google-adk',
    description: SDK_BACKENDS['google-adk'].description,
    category: 'sdk',
    installCommand: SDK_BACKENDS['google-adk'].install,
    installed: googleAdk,
    reason: googleAdk ? undefined : 'Package not installed',
  });

  return items;
}

/**
 * Format install status report for display
 */
export async function getInstallReport(): Promise<string> {
  const items = await getInstallableItems();

  const cliItems = items.filter(i => i.category === 'cli');
  const sdkItems = items.filter(i => i.category === 'sdk');

  const lines: string[] = [];

  lines.push('Agent CLIs:');
  for (const item of cliItems) {
    const status = item.installed ? '  ✓' : '  ✗';
    const label = item.installed ? 'installed' : 'not installed';
    lines.push(`${status} ${item.name} — ${label}`);
    if (!item.installed) {
      lines.push(`    Install: ${item.installCommand}`);
      const cliDef = CLI_AGENTS[item.name];
      if (cliDef?.altInstall) {
        lines.push(`        or: ${cliDef.altInstall}`);
      }
    }
  }

  lines.push('');
  lines.push('SDK Backends (optional, for in-process execution):');
  for (const item of sdkItems) {
    const status = item.installed ? '  ✓' : '  ✗';
    const label = item.installed ? 'installed' : 'not installed';
    lines.push(`${status} ${item.name} — ${label}`);
    if (!item.installed) {
      lines.push(`    ${item.description}`);
      lines.push(`    Install: ${item.installCommand}`);
    }
  }

  const missing = items.filter(i => !i.installed);
  if (missing.length === 0) {
    lines.push('');
    lines.push('All agents and SDK backends are installed!');
  } else {
    lines.push('');
    lines.push(`Install all missing: ${missing.map(i => i.installCommand).join(' && ')}`);
  }

  return lines.join('\n');
}

/**
 * Install a specific item by name
 * Returns { success, output } with install result
 */
export function installItem(name: string): { success: boolean; output: string } {
  // Find the install command
  const cliInfo = CLI_AGENTS[name];
  const sdkInfo = SDK_BACKENDS[name];
  const installCmd = cliInfo?.install || sdkInfo?.install;

  if (!installCmd) {
    return { success: false, output: `Unknown item: ${name}. Available: ${[...Object.keys(CLI_AGENTS), ...Object.keys(SDK_BACKENDS)].join(', ')}` };
  }

  try {
    const output = execSync(installCmd, {
      encoding: 'utf-8',
      timeout: 120_000, // 2 minute timeout
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { success: true, output: output.trim() || `${name} installed successfully.` };
  } catch (error) {
    const msg = error instanceof Error ? (error as Error & { stderr?: string }).stderr || error.message : String(error);
    return { success: false, output: `Failed to install ${name}: ${msg}` };
  }
}

/**
 * Install all missing items
 */
export async function installAllMissing(): Promise<{ installed: string[]; failed: string[] }> {
  const items = await getInstallableItems();
  const missing = items.filter(i => !i.installed);

  const installed: string[] = [];
  const failed: string[] = [];

  for (const item of missing) {
    const result = installItem(item.name);
    if (result.success) {
      installed.push(item.name);
    } else {
      failed.push(`${item.name}: ${result.output}`);
    }
  }

  return { installed, failed };
}
