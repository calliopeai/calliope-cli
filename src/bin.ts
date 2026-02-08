#!/usr/bin/env node
/**
 * Calliope CLI - Main Entry Point
 *
 * Multi-model AI agent CLI with autonomous agent loops.
 * Run `calliope` to start an interactive session.
 */

import * as fs from 'fs';
import * as path from 'path';
import { runSetup } from './setup.js';
import * as config from './config.js';
import { getVersion, checkForUpdates, getLatestVersion, performUpgrade } from './version-check.js';
import { colors } from './styles.js';

// Load .env / cli.env files (dotenv-style, no dependency)
function loadEnvFile(filePath: string): void {
  try {
    if (!fs.existsSync(filePath)) return;
    const content = fs.readFileSync(filePath, 'utf-8');
    for (const line of content.split('\n')) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      // Strip optional "export " prefix
      const assignment = trimmed.replace(/^export\s+/, '');
      const eqIndex = assignment.indexOf('=');
      if (eqIndex === -1) continue;
      const key = assignment.slice(0, eqIndex).trim();
      let value = assignment.slice(eqIndex + 1).trim();
      // Strip surrounding quotes
      if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
        value = value.slice(1, -1);
      }
      // Don't overwrite existing env vars
      if (!process.env[key]) {
        process.env[key] = value;
      }
    }
  } catch {
    // Silently ignore unreadable env files
  }
}

// Check for env files in cwd and home directory (cwd takes priority)
loadEnvFile(path.join(process.cwd(), '.env'));
loadEnvFile(path.join(process.cwd(), 'cli.env'));

// Handle CLI flags
const args = process.argv.slice(2);

// Check for god-mode flag (skip all permission prompts)
const skipPermissions = args.includes('--god-mode') ||
                        args.includes('-g');

// Check for legacy UI flag
const useLegacyUI = args.includes('--legacy');

// Check for AGTerm mode (multi-agent orchestration)
const agtermEnabled = args.includes('--agterm') || args.includes('-a');

// Check for headless mode (no-TTY agent orchestration)
const useHeadless = args.includes('--headless') || args.includes('--batch') || args.includes('--pipe') || !process.stdout.isTTY;

// HUD environment variable overrides
const envSkin = process.env.CALLIOPE_SKIN;
const envPalette = process.env.CALLIOPE_PALETTE;
const envCompanion = process.env.CALLIOPE_COMPANION;

// Export for CLI to access
export { skipPermissions, agtermEnabled, useHeadless, envSkin, envPalette, envCompanion };

async function main(): Promise<void> {
  // Handle --help
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Handle --version
  if (args.includes('--version') || args.includes('-v')) {
    console.log(`calliope v${getVersion()}`);
    await checkForUpdates();
    process.exit(0);
  }

  // Handle --upgrade
  if (args.includes('--upgrade') || args.includes('-u')) {
    const current = getVersion();
    console.log(`Current version: v${current}`);
    console.log('Checking for updates...');

    const latest = await getLatestVersion();
    if (!latest) {
      console.log('Could not check for updates.');
      process.exit(1);
    }

    const [cMaj, cMin, cPat] = current.split('.').map(Number);
    const [lMaj, lMin, lPat] = latest.split('.').map(Number);
    const hasUpdate = lMaj > cMaj || (lMaj === cMaj && lMin > cMin) || (lMaj === cMaj && lMin === cMin && lPat > cPat);

    if (!hasUpdate) {
      console.log(`${colors.green}✓${colors.reset} Already on latest version (v${current})`);
      process.exit(0);
    }

    console.log(`${colors.yellow}→${colors.reset} New version available: v${latest}`);
    console.log('Upgrading...');

    const success = await performUpgrade();
    if (success) {
      console.log(`${colors.green}✓${colors.reset} Upgraded to v${latest}`);
      process.exit(0);
    } else {
      console.log(`${colors.red}✗${colors.reset} Upgrade failed. Try: npm install -g @calliopelabs/cli@latest`);
      process.exit(1);
    }
  }

  // Handle --setup (force reconfigure)
  if (args.includes('--setup') || args.includes('--configure')) {
    await runSetup(true);
    return startCLI({ skipPermissions });
  }

  // Handle --reset (clear config)
  if (args.includes('--reset')) {
    config.resetConfig();
    console.log('Configuration reset. Run `calliope` to set up again.');
    process.exit(0);
  }

  // Handle --config (show config path)
  if (args.includes('--config')) {
    console.log(`Config file: ${config.getConfigPath()}`);
    const providers = config.getConfiguredProviders();
    console.log(`Configured providers: ${providers.length > 0 ? providers.join(', ') : 'none'}`);
    console.log(`Default provider: ${config.get('defaultProvider')}`);
    console.log(`Setup complete: ${config.isSetupComplete()}`);
    process.exit(0);
  }

  // Show warning if god-mode enabled
  if (skipPermissions) {
    console.log(`${colors.magenta}⚡ GOD MODE ENABLED${colors.reset}`);
    console.log(`${colors.dim}   Tools execute without confirmation. Use wisely.${colors.reset}`);
    console.log();
  }

  // Show notice if agterm mode enabled
  if (agtermEnabled) {
    console.log(`${colors.cyan}🤖 AGTERM MODE ENABLED${colors.reset}`);
    console.log(`${colors.dim}   Multi-agent orchestration active. Use /agents to see available sub-agents.${colors.reset}`);
    console.log();
  }

  // Check if setup is needed
  if (!config.isSetupComplete()) {
    // Check if we have any API keys from environment
    const hasEnvKeys = process.env.ANTHROPIC_API_KEY ||
                       process.env.GOOGLE_API_KEY ||
                       process.env.OPENAI_API_KEY ||
                       process.env.OPENROUTER_API_KEY ||
                       process.env.TOGETHER_API_KEY ||
                       process.env.GROQ_API_KEY ||
                       process.env.FIREWORKS_API_KEY ||
                       process.env.MISTRAL_API_KEY ||
                       process.env.OLLAMA_BASE_URL ||
                       process.env.AI21_API_KEY ||
                       process.env.HUGGINGFACE_API_KEY ||
                       process.env.LITELLM_BASE_URL ||
                       process.env.BEDROCK_API_KEY ||
                       process.env.BEDROCK_BASE_URL;

    if (hasEnvKeys) {
      // Skip setup if env keys present
      config.markSetupComplete();
    } else {
      // Run interactive setup
      const success = await runSetup();
      if (!success) {
        console.error('Setup cancelled.');
        process.exit(1);
      }
    }
  }

  // Start the CLI
  await startCLI();
}

async function startCLI(options: { skipPermissions?: boolean; agtermEnabled?: boolean } = {}): Promise<void> {
  // Initialize HUD (skin + palette + companion)
  const { applySkin, applyPalette } = await import('./hud/api.js');
  const { populateLegacyRegistries } = await import('./hud/theme-packs/api.js');
  const { applyCompanion } = await import('./companions.js');

  // Populate legacy registries from theme packs
  populateLegacyRegistries();

  const skinName = envSkin || config.get('activeSkin') || 'clean';
  const paletteName = envPalette || config.get('activePalette') || 'default';
  const companionName = envCompanion || config.get('activeCompanion') || 'calliope';

  applySkin(skinName);
  applyPalette(paletteName);
  applyCompanion(companionName);

  // Merge in global flags
  const fullOptions = {
    ...options,
    agtermEnabled: options.agtermEnabled ?? agtermEnabled,
  };

  if (useHeadless) {
    // Use headless renderer (no-TTY, JSON/text output)
    const { runHeadless } = await import('./headless.js');
    // Extract prompt from remaining args (non-flag args)
    const prompt = args.filter(a => !a.startsWith('-')).join(' ');
    const exitCode = await runHeadless({
      prompt: prompt || undefined,
      outputMode: args.includes('--json') ? 'json' : 'text',
    });
    process.exit(exitCode);
  } else if (useLegacyUI) {
    // Use legacy readline-based CLI
    const { startCLI: start } = await import('./cli/index.js');
    await start(fullOptions);
  } else {
    // Use new ink-based UI
    const { startInkCLI } = await import('./ui/index.js');
    await startInkCLI(fullOptions);
  }
}

function printHelp(): void {
  console.log(`
${bold('calliope')} - Multi-model AI agent CLI

${bold('USAGE')}
  calliope [options] [prompt]

${bold('OPTIONS')}
  -h, --help        Show this help message
  -v, --version     Show version
  -u, --upgrade     Upgrade to latest version
  --setup           Run setup wizard (reconfigure)
  --config          Show config file path and status
  --reset           Reset all configuration
  --skip-setup      Skip setup if API keys in environment

  -g, --god-mode    Run tools without confirmation prompts
                    Enables unrestricted autonomous execution
  -a, --agterm      Enable multi-agent orchestration mode
                    Unlock spawn_agent, check_agent tools
  --legacy          Use legacy readline UI instead of ink
  --headless        Headless mode (JSON/text output, no TTY)
  --batch           Alias for --headless
  --json            Output JSON events (with --headless)
  --pipe            Read from stdin, write to stdout (alias)

${bold('ENVIRONMENT VARIABLES')}
  ANTHROPIC_API_KEY     Anthropic Claude API key
  GOOGLE_API_KEY        Google Gemini API key
  OPENAI_API_KEY        OpenAI API key
  OPENROUTER_API_KEY    OpenRouter API key
  TOGETHER_API_KEY      Together AI API key
  GROQ_API_KEY          Groq API key
  MISTRAL_API_KEY       Mistral AI API key
  AI21_API_KEY          AI21 Labs API key
  HUGGINGFACE_API_KEY   HuggingFace API key
  OLLAMA_BASE_URL       Ollama server URL (default: localhost:11434)
  LITELLM_BASE_URL      LiteLLM proxy URL (default: localhost:4000)
  LITELLM_API_KEY       LiteLLM API key (if required)
  BEDROCK_BASE_URL      AWS Bedrock gateway/proxy URL
  BEDROCK_API_KEY       AWS Bedrock gateway API key (if required)

  CALLIOPE_SKIN         Override active skin (e.g. falcon, matrix)
  CALLIOPE_PALETTE      Override active palette (e.g. neon, pastel)
  CALLIOPE_COMPANION    Override active companion (e.g. copilot, wopr)

${bold('INTERACTIVE COMMANDS')}
  /help             Show all commands
  /provider         Switch AI provider
  /model            Change model
  /persona          Change personality
  /loop             Start autonomous agent loop
  /save             Save session
  /exit             Exit

${bold('EXAMPLES')}
  calliope                    Start interactive session
  calliope "explain this"     Start with a prompt
  calliope --setup            Run setup wizard
  calliope --batch "fix lint" Non-interactive batch execution
  echo "review" | calliope    Pipe prompt via stdin
  calliope --headless --json  JSON event stream output

${bold('MORE INFO')}
  https://github.com/calliopeai/calliope-cli
`);
}

function bold(text: string): string {
  return `${colors.bold}${text}${colors.reset}`;
}

// Run
main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
