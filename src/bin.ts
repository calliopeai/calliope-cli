#!/usr/bin/env node
/**
 * Calliope CLI - Main Entry Point
 *
 * Multi-model AI agent CLI with Ralph Wiggum autonomous loops.
 * Run `calliope` to start an interactive session.
 */

import { runSetup } from './setup.js';
import * as config from './config.js';

// Handle CLI flags
const args = process.argv.slice(2);

// Check for god-mode flag (skip all permission prompts)
const skipPermissions = args.includes('--god-mode') ||
                        args.includes('-g');

// Export for CLI to access
export { skipPermissions };

async function main(): Promise<void> {
  // Handle --help
  if (args.includes('--help') || args.includes('-h')) {
    printHelp();
    process.exit(0);
  }

  // Handle --version
  if (args.includes('--version') || args.includes('-v')) {
    console.log('calliope v0.1.0');
    process.exit(0);
  }

  // Handle --setup (force reconfigure)
  if (args.includes('--setup') || args.includes('--configure')) {
    await runSetup(true);
    return startCLI();
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

  // Check if setup is needed
  if (!config.isSetupComplete()) {
    // Check if we have any API keys from environment
    const hasEnvKeys = process.env.ANTHROPIC_API_KEY ||
                       process.env.GOOGLE_API_KEY ||
                       process.env.OPENAI_API_KEY ||
                       process.env.OPENROUTER_API_KEY;

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

async function startCLI(): Promise<void> {
  // Dynamically import the CLI to avoid loading everything upfront
  const { startCLI: start } = await import('./cli.js');
  await start({ skipPermissions });
}

function printHelp(): void {
  console.log(`
${bold('calliope')} - Multi-model AI agent CLI

${bold('USAGE')}
  calliope [options] [prompt]

${bold('OPTIONS')}
  -h, --help        Show this help message
  -v, --version     Show version
  --setup           Run setup wizard (reconfigure)
  --config          Show config file path and status
  --reset           Reset all configuration
  --skip-setup      Skip setup if API keys in environment

  -g, --god-mode    Run tools without confirmation prompts
                    Enables unrestricted autonomous execution

${bold('ENVIRONMENT VARIABLES')}
  ANTHROPIC_API_KEY     Anthropic Claude API key
  GOOGLE_API_KEY        Google Gemini API key
  OPENAI_API_KEY        OpenAI API key
  OPENROUTER_API_KEY    OpenRouter API key
  TOGETHER_API_KEY      Together AI API key
  GROQ_API_KEY          Groq API key

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
