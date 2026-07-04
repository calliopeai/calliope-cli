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

// Suppress OpenAI/third-party SDK verbose debug output triggered by DEBUG=true
// (JupyterHub sets DEBUG=true in the container environment which causes OpenAI SDK
// to dump full HTTP request/response bodies to stdout)
if (process.env.DEBUG === 'true' && !process.env.CALLIOPE_DEBUG) {
  delete process.env.DEBUG;
}

// Handle CLI flags
const args = process.argv.slice(2);

// Check for god-mode flag (skip all permission prompts)
const skipPermissions = args.includes('--god-mode') ||
                        args.includes('-g');

// Check for multi-agent orchestration mode

// Check for headless mode (no-TTY agent orchestration)
const useHeadless = args.includes('--headless') || args.includes('--batch') || args.includes('--pipe') || !process.stdout.isTTY;

// --debug enables verbose file logging to /tmp/calliope-debug.log
// (console output would corrupt Ink rendering, so we log to file).
if (args.includes('--debug')) {
  process.env.CALLIOPE_DEBUG = '1';
}

// Check for API server flag
const useApiServer = args.includes('--serve') || args.includes('--api');

// Parse --max-retries <N> flag (default 3), also honour CALLIOPE_MAX_RETRIES env var
function parseMaxRetries(): number {
  const envVal = process.env.CALLIOPE_MAX_RETRIES;
  if (envVal !== undefined) {
    const parsed = parseInt(envVal, 10);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  const flagIdx = args.indexOf('--max-retries');
  if (flagIdx !== -1 && args[flagIdx + 1] !== undefined) {
    const parsed = parseInt(args[flagIdx + 1], 10);
    if (!isNaN(parsed) && parsed >= 0) return parsed;
  }
  return 3;
}
const maxRetries = parseMaxRetries();

// HUD environment variable overrides
const envSkin = process.env.CALLIOPE_SKIN;
const envPalette = process.env.CALLIOPE_PALETTE;
const envCompanion = process.env.CALLIOPE_COMPANION;

// Export for CLI to access
export { skipPermissions, useHeadless, envSkin, envPalette, envCompanion, maxRetries };

// ---------------------------------------------------------------------------
// Graceful shutdown + top-level error handling
//
// In --serve/--api mode the process blocks forever, so without signal handlers
// Ctrl-C (SIGINT) or SIGTERM would drop the HTTP listener, open WebSocket
// sockets, and the caffeinate sleep guard without cleanup. We install a single
// idempotent shutdown path and wire it to process signals and to top-level
// async error handlers (which main().catch() does not cover post-startup).
// ---------------------------------------------------------------------------

let shuttingDown = false;

/**
 * Run cleanup exactly once, then exit. Re-entrant calls (e.g. a second Ctrl-C
 * mid-shutdown) are ignored so cleanup never double-runs. stopApiServer() and
 * stopPreventSleep() are both safe no-ops when nothing was started.
 */
export async function shutdown(exitCode = 0): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;
  try {
    const { stopApiServer } = await import('./api-server.js');
    const { stopPreventSleep } = await import('./prevent-sleep.js');
    await stopApiServer();
    stopPreventSleep();
  } catch {
    // Best-effort cleanup — never let a teardown error block exit.
  }
  process.exit(exitCode);
}

/** Register signal + top-level error handlers. Idempotent. */
export function registerProcessHandlers(): void {
  process.on('SIGINT', () => { void shutdown(0); });
  process.on('SIGTERM', () => { void shutdown(0); });
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection:', reason instanceof Error ? reason.message : reason);
    void shutdown(1);
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception:', err instanceof Error ? err.message : err);
    void shutdown(1);
  });
}

async function main(): Promise<void> {
  // Check Node.js version — ink requires Node >=20 (uses /v regex flag in string-width)
  const [nodeMaj] = process.versions.node.split('.').map(Number);
  if (nodeMaj < 20) {
    console.error(`calliope requires Node.js 20 or later (you have ${process.versions.node})`);
    console.error('Upgrade: https://nodejs.org/en/download  or  nvm install 20');
    process.exit(1);
  }

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
                       process.env.BEDROCK_BASE_URL ||
                       process.env.OPENAI_COMPAT_BASE_URL;

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

async function startCLI(options: { skipPermissions?: boolean } = {}): Promise<void> {
  // Initialize HUD (skin + palette + companion)
  const { applySkin, applyPalette } = await import('./hud/api.js');
  const { populateLegacyRegistries } = await import('./hud/theme-packs/api.js');
  const { applyCompanion } = await import('./companions.js');

  // Populate legacy registries from theme packs (optional @calliopelabs/cli-themes)
  await populateLegacyRegistries();

  const skinName = envSkin || config.get('activeSkin') || 'clean';
  const paletteName = envPalette || config.get('activePalette') || 'default';
  const companionName = envCompanion || config.get('activeCompanion') || 'calliope';

  applySkin(skinName);
  applyPalette(paletteName);
  applyCompanion(companionName);

  // Merge in global flags
  const fullOptions = {
    ...options,
  };

  // Start API server if --serve/--api flag is set
  if (useApiServer) {
    const { startApiServer } = await import('./api-server.js');
    const port = 3100;
    try {
      const info = await startApiServer({ port, host: '127.0.0.1' });
      console.log(`${colors.dim}  API server: http://${info.host}:${info.port}${colors.reset}`);
      console.log(`${colors.dim}  API token:  ${info.token}${colors.reset}`);
      console.log(`${colors.dim}  Use: Authorization: Bearer ${info.token}${colors.reset}`);
    } catch (err) {
      console.error(`API server failed to start: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(1);
    }
    // Block until the process is killed — server is the sole purpose of this invocation
    await new Promise<void>(() => {});
    return;
  }

  if (useHeadless) {
    // Use headless renderer (no-TTY, JSON/text output)
    const { runHeadless } = await import('./headless.js');
    // Extract prompt from remaining args (non-flag args, skip --max-retries value)
    const prompt = args.filter((a, i) => {
      if (a.startsWith('-')) return false;
      if (i > 0 && args[i - 1] === '--max-retries') return false;
      return true;
    }).join(' ');
    const exitCode = await runHeadless({
      prompt: prompt || undefined,
      outputMode: args.includes('--json') ? 'json' : 'text',
      maxRetries,
    });
    process.exit(exitCode);
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
  --serve, --api    Start API server on port 3100 (localhost)
  --headless        Headless mode (JSON/text output, no TTY)
  --batch           Alias for --headless
  --json            Output JSON events (with --headless)
  --pipe            Read from stdin, write to stdout (alias)
  --max-retries N   Retry failed tool calls N times in headless mode (default 3)
  --debug           Verbose logging to /tmp/calliope-debug.log (input, provider, modals)

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
  OPENAI_COMPAT_BASE_URL   Generic OpenAI-compatible server URL (e.g. http://localhost:1234/v1)
  OPENAI_COMPAT_API_KEY    API key for the OpenAI-compatible server (if required)

  CALLIOPE_SKIN         Override active skin (e.g. falcon, matrix)
  CALLIOPE_PALETTE      Override active palette (e.g. neon, pastel)
  CALLIOPE_COMPANION    Override active companion (e.g. copilot, wopr)
  CALLIOPE_MAX_RETRIES  Override --max-retries default (headless mode)

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
// CALLIOPE_NO_AUTORUN lets tests import this module to exercise the exported
// shutdown/handler logic without launching the CLI or registering signal
// handlers. It is never set in normal use.
if (!process.env.CALLIOPE_NO_AUTORUN) {
  registerProcessHandlers();
  main().catch((err) => {
    console.error('Error:', err.message);
    void shutdown(1);
  });
}
