/**
 * Calliope CLI - Interactive REPL
 *
 * Entry point for the legacy readline-based CLI.
 */

import * as readline from 'readline';
import * as config from '../config.js';
import { selectProvider } from '../providers/index.js';
import { getSystemPrompt, DEFAULT_MODELS } from '../types.js';
import { checkForUpdates, getVersion, performUpgrade } from '../version-check.js';
import * as memory from '../memory.js';
import * as hooks from '../hooks.js';
import { color } from '../styles.js';
import { getCurrentSkin, paletteColorize } from '../hud/api.js';
import { getCurrentCompanion } from '../companions.js';
import type { CLIOptions, CLIState } from './types.js';
import { COMMANDS, debugLog } from './types.js';
import { handleCommand, setStartLoop } from './commands.js';
import { runAgent, startLoop } from './agent.js';
import * as recording from '../terminal-recording.js';
import * as sessionTimeout from '../session-timeout.js';
import * as idleEviction from '../idle-eviction.js';
import { isTmux, getTmuxInfo } from '../tmux.js';

// Wire startLoop into commands (avoids circular import)
setStartLoop(startLoop);

function getBanner(): string {
  const skin = getCurrentSkin();
  if (skin.banner.style === 'none') return '';
  const lines = skin.banner.art.map(line =>
    line.includes('\x1b[') ? line : paletteColorize(line, 'primary')
  );
  if (skin.banner.tagline) {
    lines.push('');
    lines.push(paletteColorize(`        ${skin.banner.tagline}`, 'textDim'));
  }
  return '\n' + lines.join('\n') + '\n';
}

export async function startCLI(options: CLIOptions = {}): Promise<void> {
  const state: CLIState = {
    provider: config.get('defaultProvider'),
    model: config.get('defaultModel'),
    persona: config.get('persona'),
    messages: [],
    cwd: process.cwd(),
    running: true,
    skipPermissions: options.skipPermissions ?? false,
    loopActive: false,
    loopPrompt: '',
    loopIteration: 0,
    loopMaxIterations: 50,
    autoRoute: false,
    currentBranch: 'main',
    mode: 'hybrid',
    confirmMode: true,
    debugEnabled: process.env.CALLIOPE_DEBUG === '1',
    sessionCost: 0,
  };

  // Terminal resize detection
  let termWidth = process.stdout.columns || 80;
  let termHeight = process.stdout.rows || 24;
  const onResize = () => {
    termWidth = process.stdout.columns || 80;
    termHeight = process.stdout.rows || 24;
  };
  process.stdout.on('resize', onResize);

  // Add system message with memory context
  const systemPrompt = getSystemPrompt(state.persona);
  const memoryContext = memory.buildMemoryContext(process.cwd());
  const fullPrompt = memoryContext.trim()
    ? systemPrompt + '\n\n--- Project Context ---\n' + memoryContext
    : systemPrompt;

  state.messages.push({
    role: 'system',
    content: fullPrompt,
  });

  // Execute session start hooks
  hooks.executeHooks('session-start', {}).catch((err) => {
    debugLog('session-start hook failed:', err instanceof Error ? err.message : err);
  });

  // Start session recording
  const actualProvider = selectProvider(state.provider);
  recording.startRecording({
    provider: actualProvider,
    model: state.model || DEFAULT_MODELS[actualProvider],
    cwd: state.cwd,
  });

  // Configure session timeout (opt-in via config)
  const timeoutMs = config.get('sessionTimeoutMs');
  if (timeoutMs) {
    sessionTimeout.configureTimeout({
      enabled: true,
      idleTimeoutMs: typeof timeoutMs === 'number' ? timeoutMs : 2 * 60 * 60 * 1000,
    });
    sessionTimeout.onTimeout((type) => {
      if (type === 'warning') {
        console.log(color(`\u23f1\ufe0f  Session timeout in ${sessionTimeout.formatTimeRemaining()}`, 'yellow'));
      } else {
        console.log(color('\ud83d\udeaa Session timeout. Exiting...', 'red'));
        recording.stopRecording();
        process.exit(0);
      }
    });
  }

  // Start idle eviction monitor
  idleEviction.configureEviction({ enabled: true });

  // Log tmux context
  if (isTmux()) {
    const tmuxInfo = getTmuxInfo();
    if (tmuxInfo) {
      debugLog(`tmux: session=${tmuxInfo.session}, windows=${tmuxInfo.windows}, panes=${tmuxInfo.panes}`);
    }
  }

  // Setup readline
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    terminal: true,
    completer: (line: string) => {
      if (line.startsWith('/')) {
        const hits = COMMANDS.filter(cmd => cmd.startsWith(line));
        return [hits.length ? hits : COMMANDS, line];
      }
      return [[], line];
    },
  });

  // Check for updates (do this early, it's cached)
  let hasUpdate = false;

  // Print welcome
  if (config.get('fancyOutput')) {
    console.log(getBanner());
    const actualProvider = selectProvider(state.provider);
    const model = state.model || DEFAULT_MODELS[actualProvider];
    console.log(`  ${color('v' + getVersion(), 'dim')}`);
    console.log();
    console.log(`  ${color('Provider:', 'dim')} ${color(actualProvider, 'cyan')} (${color(model, 'dim')})`);
    console.log(`  ${color('Persona:', 'dim')} ${color(state.persona, 'cyan')}`);
    console.log(`  ${color('Directory:', 'dim')} ${color(state.cwd, 'dim')}`);

    hasUpdate = await checkForUpdates().catch(() => false);

    console.log(color('  ─────────────────────────────────────────────────────────────────', 'dim'));
    console.log(`  ${color('TAB', 'cyan')} ${color('autocomplete', 'dim')} ${color('│', 'dim')} ${color('/help', 'cyan')} ${color('│', 'dim')} ${color('/loop', 'cyan')} ${color('│', 'dim')} ${color('/provider', 'cyan')} ${color('│', 'dim')} ${color('ESC', 'cyan')} ${color('stop', 'dim')}`);
    console.log(color('  ─────────────────────────────────────────────────────────────────', 'dim'));

  } else {
    console.log('Calliope CLI');
    console.log(`Provider: ${selectProvider(state.provider)}`);
    console.log('/help for commands');
    hasUpdate = await checkForUpdates(true).catch(() => false);
  }
  console.log();

  // Prompt function
  const promptUser = () => {
    const skin = getCurrentSkin();
    const companionName = getCurrentCompanion().name;
    const promptStr = skin.decorations.promptPrefix || `${color(companionName, 'cyan')}${color('>', 'dim')} `;
    rl.question(promptStr, async (input) => {
      input = input.trim();

      if (!input) {
        promptUser();
        return;
      }

      // Record activity for timeout/eviction and audit log
      sessionTimeout.recordActivity();
      idleEviction.recordActivity();
      recording.recordEvent('input', input);

      if (input.startsWith('/')) {
        await handleCommand(input, state, rl);
        if (state.running) promptUser();
        return;
      }

      await runAgent(input, state);
      if (state.running) promptUser();
    });
  };

  // Handle Ctrl+C
  rl.on('close', () => {
    recording.stopRecording();
    sessionTimeout.clearTimers();
    idleEviction.stopMonitor();
    console.log();
    console.log(color(`  ${getCurrentCompanion().farewell}`, 'cyan'));
    console.log();
    process.exit(0);
  });

  // If update available and autoUpgrade enabled, prompt user
  if (hasUpdate && config.get('autoUpgrade')) {
    rl.question(`${color('Upgrade now? (y/N/never)', 'cyan')} `, async (answer) => {
      const a = answer.toLowerCase().trim();
      if (a === 'y' || a === 'yes') {
        const success = await performUpgrade();
        if (success) {
          console.log();
          console.log(color('Upgrade complete! Restarting...', 'green'));
          const { spawn } = await import('child_process');
          const child = spawn(process.argv[0], process.argv.slice(1), {
            stdio: 'inherit',
            detached: true,
          });
          child.unref();
          process.exit(0);
        } else {
          console.log(color('Upgrade failed. Use /upgrade to try again.', 'red'));
        }
      } else if (a === 'never') {
        config.set('autoUpgrade', false);
        console.log(color('Auto-upgrade disabled. Use /upgrade to update manually.', 'dim'));
      }
      console.log();
      promptUser();
    });
  } else {
    promptUser();
  }
}
