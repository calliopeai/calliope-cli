#!/usr/bin/env node
/**
 * Calliope CLI - Main Entry Point
 *
 * Multi-model AI agent CLI with Ralph Wiggum autonomous loops.
 * Run `calliope` to start an interactive session.
 */

import { runSetup } from './setup.js';
import * as config from './config.js';
import { getVersion, checkForUpdates, getLatestVersion, performUpgrade } from './version-check.js';

// Handle CLI flags
const args = process.argv.slice(2);

// Check for god-mode flag (skip all permission prompts)
const skipPermissions = args.includes('--god-mode') ||
                        args.includes('-g');

// Check for legacy UI flag
const useLegacyUI = args.includes('--legacy');

// Check for AGTerm mode (multi-agent orchestration)
const agtermEnabled = args.includes('--agterm') || args.includes('-a');

// Export for CLI to access
export { skipPermissions, agtermEnabled };

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
      console.log(`\x1b[32m✓\x1b[0m Already on latest version (v${current})`);
      process.exit(0);
    }

    console.log(`\x1b[33m→\x1b[0m New version available: v${latest}`);
    console.log('Upgrading...');

    const success = await performUpgrade();
    if (success) {
      console.log(`\x1b[32m✓\x1b[0m Upgraded to v${latest}`);
      process.exit(0);
    } else {
      console.log('\x1b[31m✗\x1b[0m Upgrade failed. Try: npm install -g @calliopelabs/cli@latest');
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
    console.log('\x1b[35m⚡ GOD MODE ENABLED\x1b[0m');
    console.log('\x1b[2m   Tools execute without confirmation. Use wisely.\x1b[0m');
    console.log();
  }

  // Show notice if agterm mode enabled
  if (agtermEnabled) {
    console.log('\x1b[36m🤖 AGTERM MODE ENABLED\x1b[0m');
    console.log('\x1b[2m   Multi-agent orchestration active. Use /agents to see available sub-agents.\x1b[0m');
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
                       process.env.LITELLM_BASE_URL;

    if (hasEnvKeys && (args.includes('--skip-setup') || skipPermissions)) {
      // Skip setup if env keys present and flag set
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
  // Merge in global flags
  const fullOptions = {
    ...options,
    agtermEnabled: options.agtermEnabled ?? agtermEnabled,
  };

  if (useLegacyUI) {
    // Use legacy readline-based CLI
    const { startCLI: start } = await import('./cli.js');
    await start(fullOptions);
  } else {
    // Use new ink-based UI
    const { startInkCLI } = await import('./ui-cli.js');
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

${bold('INTERACTIVE COMMANDS')}
  /help             Show all commands
  /provider         Switch AI provider
  /model            Change model
  /persona          Change personality
  /loop             Start autonomous loop (Ralph Wiggum)
  /save             Save session
  /exit             Exit

${bold('EXAMPLES')}
  calliope                    Start interactive session
  calliope --setup            Run setup wizard
  calliope "explain this"     Start with a prompt

${bold('MORE INFO')}
  https://github.com/calliopeai/calliope-cli
`);
}

function bold(text: string): string {
  return `\x1b[1m${text}\x1b[0m`;
}

// Run
main().catch((err) => {
  console.error('Error:', err.message);
  process.exit(1);
});
