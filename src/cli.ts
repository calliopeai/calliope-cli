/**
 * Calliope CLI - Interactive REPL
 *
 * Main interactive command-line interface.
 */

import * as readline from 'readline';
import * as path from 'path';
import * as config from './config.js';
import { chat, getAvailableProviders, selectProvider } from './providers.js';
import { TOOLS, executeTool } from './tools.js';
import { getSystemPrompt, DEFAULT_MODELS } from './types.js';
import { checkForUpdates, getVersion, getLatestVersion, performUpgrade } from './version-check.js';
import { selectModelInteractively } from './model-detection.js';
import * as memory from './memory.js';
import * as hooks from './hooks.js';
import * as modelRouter from './model-router.js';
import * as summarization from './summarization.js';
import * as themes from './themes.js';
import * as branching from './branching.js';
import * as fuzzySearch from './fuzzy-search.js';
import type { Message, LLMProvider, AgentPersona, ToolCall, Mode } from './types.js';
import { MODE_CONFIG } from './types.js';
import * as storage from './storage.js';
import { addToScope, removeFromScope, getScopeSummary, getScopeDetails, resetScope } from './scope.js';

// ANSI colors
const c = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  brightCyan: '\x1b[96m',
};

function color(text: string, style: keyof typeof c): string {
  return `${c[style]}${text}${c.reset}`;
}

// Spinner frames
const SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const BANNER = `
${color(' ██████╗ █████╗ ██╗     ██╗     ██╗ ██████╗ ██████╗ ███████╗', 'brightCyan')}
${color('██╔════╝██╔══██╗██║     ██║     ██║██╔═══██╗██╔══██╗██╔════╝', 'brightCyan')}
${color('██║     ███████║██║     ██║     ██║██║   ██║██████╔╝█████╗  ', 'cyan')}
${color('██║     ██╔══██║██║     ██║     ██║██║   ██║██╔═══╝ ██╔══╝  ', 'cyan')}
${color('╚██████╗██║  ██║███████╗███████╗██║╚██████╔╝██║     ███████╗', 'brightCyan')}
${color(' ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝     ╚══════╝', 'cyan')}

        ${color('The Muse of Digital Eloquence', 'dim')}
`;

// Slash commands
const COMMANDS = [
  '/help', '/h', '/provider', '/p', '/model', '/m', '/models', '/persona',
  '/clear', '/c', '/status', '/s', '/loop', '/cancel-loop',
  '/setup', '/config', '/upgrade', '/exit', '/quit', '/q',
  '/memory', '/hooks', '/route', '/summarize', '/theme', '/branch', '/find', '/search',
  '/mode', '/work', '/plan', '/debug', '/set', '/confirm',
  '/scope', '/add-dir', '/remove-dir', '/cost', '/costs', '/session', '/context',
];

// CLI Options
interface CLIOptions {
  skipPermissions?: boolean;
}

// CLI State
interface CLIState {
  provider: LLMProvider;
  model?: string;
  persona: AgentPersona;
  messages: Message[];
  cwd: string;
  running: boolean;
  skipPermissions: boolean;
  loopActive: boolean;
  loopPrompt: string;
  loopIteration: number;
  loopMaxIterations: number;
  loopCompletionPromise?: string;
  autoRoute: boolean;
  currentBranch: string;
  mode: Mode;
  confirmMode: boolean;
  debugEnabled: boolean;
  sessionCost: number;
}

/**
 * Start the CLI
 */
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
  hooks.executeHooks('session-start', {}).catch(() => {});

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
    console.log(BANNER);
    const actualProvider = selectProvider(state.provider);
    const model = state.model || DEFAULT_MODELS[actualProvider];
    console.log(`  ${color('v' + getVersion(), 'dim')}`);
    console.log();
    console.log(`  ${color('Provider:', 'dim')} ${color(actualProvider, 'cyan')} (${color(model, 'dim')})`);
    console.log(`  ${color('Persona:', 'dim')} ${color(state.persona, 'cyan')}`);
    console.log(`  ${color('Directory:', 'dim')} ${color(state.cwd, 'dim')}`);

    // Check for updates
    hasUpdate = await checkForUpdates().catch(() => false);

    console.log(color('  ─────────────────────────────────────────────────────────────────', 'dim'));
    console.log(`  ${color('TAB', 'cyan')} ${color('autocomplete', 'dim')} ${color('│', 'dim')} ${color('/help', 'cyan')} ${color('│', 'dim')} ${color('/loop', 'cyan')} ${color('│', 'dim')} ${color('/provider', 'cyan')} ${color('│', 'dim')} ${color('ESC', 'cyan')} ${color('stop', 'dim')}`);
    console.log(color('  ─────────────────────────────────────────────────────────────────', 'dim'));

  } else {
    console.log('Calliope CLI');
    console.log(`Provider: ${selectProvider(state.provider)}`);
    console.log('/help for commands');
    hasUpdate = await checkForUpdates(true).catch(() => false); // silent in non-fancy mode
  }
  console.log();

  // Prompt function
  const promptUser = () => {
    const promptStr = `${color('calliope', 'cyan')}${color('>', 'dim')} `;
    rl.question(promptStr, async (input) => {
      input = input.trim();

      if (!input) {
        promptUser();
        return;
      }

      // Handle commands
      if (input.startsWith('/')) {
        await handleCommand(input, state, rl);
        if (state.running) promptUser();
        return;
      }

      // Run agent
      await runAgent(input, state);
      if (state.running) promptUser();
    });
  };

  // Handle Ctrl+C
  rl.on('close', () => {
    console.log();
    console.log(color('  Farewell...', 'cyan'));
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

/**
 * Handle slash commands
 */
async function handleCommand(input: string, state: CLIState, rl: readline.Interface): Promise<void> {
  const parts = input.split(/\s+/);
  const cmd = parts[0].toLowerCase();

  switch (cmd) {
    case '/help':
    case '/h':
      printHelp();
      break;

    case '/provider':
    case '/p':
      if (parts[1]) {
        const validProviders: LLMProvider[] = ['anthropic', 'google', 'openai', 'together', 'openrouter', 'groq', 'fireworks', 'mistral', 'ollama', 'ai21', 'huggingface', 'litellm', 'auto'];
        const requested = parts[1].toLowerCase() as LLMProvider;
        if (validProviders.includes(requested)) {
          state.provider = requested;
          console.log(color(`Provider set to: ${requested}`, 'green'));
        } else {
          console.log(color(`Invalid provider: ${parts[1]}`, 'red'));
          console.log(`Available: ${validProviders.join(', ')}`);
        }
      } else {
        const available = getAvailableProviders();
        console.log(`Current: ${color(selectProvider(state.provider), 'green')}`);
        console.log(`Available: ${available.join(', ')}`);
      }
      console.log();
      break;

    case '/model':
    case '/m':
      if (parts[1]) {
        state.model = parts[1];
        console.log(color(`Model set to: ${parts[1]}`, 'green'));
        console.log();
      } else {
        // Interactive model selection
        const actualProvider = selectProvider(state.provider);
        console.log(`Current model: ${color(state.model || DEFAULT_MODELS[actualProvider], 'cyan')}`);
        console.log();
        const selectedModel = await selectModelInteractively(actualProvider);
        if (selectedModel) {
          state.model = selectedModel;
          console.log();
          console.log(color(`Model set to: ${selectedModel}`, 'green'));
        }
        console.log();
      }
      break;

    case '/models':
      {
        const provider = selectProvider(state.provider);
        const selectedModel = await selectModelInteractively(provider);
        if (selectedModel) {
          state.model = selectedModel;
          console.log();
          console.log(color(`Model set to: ${selectedModel}`, 'green'));
        }
        console.log();
      }
      break;

    case '/persona':
      if (parts[1] && ['calliope', 'professional', 'minimal'].includes(parts[1])) {
        state.persona = parts[1] as AgentPersona;
        state.messages = [{ role: 'system', content: getSystemPrompt(state.persona) }];
        console.log(color(`Persona set to: ${parts[1]}`, 'green'));
      } else {
        console.log(`Current: ${color(state.persona, 'magenta')}`);
        console.log('Options: calliope, professional, minimal');
      }
      console.log();
      break;

    case '/clear':
    case '/c':
      state.messages = [{ role: 'system', content: getSystemPrompt(state.persona) }];
      console.log(color('Conversation cleared.', 'green'));
      console.log();
      break;

    case '/status':
    case '/s':
      console.log(`Provider: ${color(selectProvider(state.provider), 'green')}`);
      console.log(`Model: ${state.model || DEFAULT_MODELS[selectProvider(state.provider)]}`);
      console.log(`Persona: ${color(state.persona, 'magenta')}`);
      console.log(`Messages: ${state.messages.length}`);
      console.log(`Directory: ${state.cwd}`);
      console.log();
      break;

    case '/loop':
      await startLoop(parts.slice(1).join(' '), state);
      break;

    case '/cancel-loop':
      if (state.loopActive) {
        state.loopActive = false;
        console.log(color('Loop cancelled.', 'yellow'));
      } else {
        console.log(color('No active loop.', 'dim'));
      }
      console.log();
      break;

    case '/setup':
      const { reconfigure } = await import('./setup.js');
      await reconfigure();
      break;

    case '/config':
      console.log(`Config: ${config.getConfigPath()}`);
      console.log(`Providers: ${config.getConfiguredProviders().join(', ') || 'none'}`);
      console.log();
      break;

    case '/memory':
      if (parts[1] === 'init') {
        const memPath = memory.initProjectMemory(state.cwd);
        console.log(color(`Created: ${memPath}`, 'green'));
      } else if (parts[1] === 'show') {
        const mem = memory.getProjectMemory(state.cwd);
        console.log(color('Project Memory:', 'bold'));
        if (mem.context.length) console.log(`Context: ${mem.context.join(', ')}`);
        if (mem.preferences.length) console.log(`Preferences: ${mem.preferences.join(', ')}`);
        if (mem.history.length) console.log(`History: ${mem.history.slice(-3).join(', ')}`);
      } else if (parts[1] === 'add' && parts[2] && parts[3]) {
        const type = parts[2] as 'context' | 'preference' | 'history' | 'note';
        const content = parts.slice(3).join(' ');
        const memPath = memory.findProjectMemory(state.cwd) || path.join(state.cwd, 'CALLIOPE.md');
        memory.addMemoryEntry(memPath, { type, content });
        console.log(color(`Added ${type}: ${content}`, 'green'));
      } else if (parts[1] === 'global') {
        const globalMem = memory.getGlobalMemory();
        console.log(color('Global Memory:', 'bold'));
        if (globalMem.preferences.length) console.log(`Preferences: ${globalMem.preferences.join(', ')}`);
      } else {
        console.log('Usage: /memory [init|show|add <type> <content>|global]');
      }
      console.log();
      break;

    case '/hooks':
      if (parts[1] === 'init') {
        hooks.initDefaultHooks();
        console.log(color('Initialized default hooks', 'green'));
      } else if (parts[1] === 'list') {
        console.log(hooks.listHooksFormatted());
      } else {
        console.log('Usage: /hooks [init|list]');
      }
      console.log();
      break;

    case '/route':
    case '/autoroute':
      if (parts[1] === 'on') {
        state.autoRoute = true;
        console.log(color('Auto-routing ON', 'green'));
      } else if (parts[1] === 'off') {
        state.autoRoute = false;
        console.log(color('Auto-routing OFF', 'green'));
      } else if (parts[1] === 'test' && parts[2]) {
        const testMsg = parts.slice(2).join(' ');
        const decision = modelRouter.routeRequest(testMsg, state.provider);
        console.log(`Tier: ${color(decision.tier, 'cyan')} (${decision.complexity})`);
        console.log(`Model: ${decision.model.model}`);
        console.log(`Reason: ${decision.reason}`);
      } else {
        const tiers = modelRouter.getAllTiers(state.provider);
        console.log(`Auto-route: ${state.autoRoute ? 'ON' : 'OFF'}`);
        console.log(`Tiers: fast=${tiers.fast.model}, balanced=${tiers.balanced.model}, smart=${tiers.smart.model}`);
      }
      console.log();
      break;

    case '/summarize':
      if (parts[1] === 'context' || !parts[1]) {
        const summary = summarization.extractKeyInfo(state.messages);
        console.log(color('Context Summary:', 'bold'));
        if (summary.topics.length) console.log(`Topics: ${summary.topics.join(', ')}`);
        if (summary.decisions.length) console.log(`Decisions: ${summary.decisions.join(', ')}`);
        if (summary.actions.length) console.log(`Actions: ${summary.actions.slice(0, 5).join(', ')}`);
      } else if (parts[1] === 'compact') {
        const result = summarization.summarizeConversation(state.messages, { maxTokens: 50000 });
        if (result.summarizedCount > 0) {
          state.messages = result.messages;
          console.log(color(`Compacted ${result.summarizedCount} messages`, 'green'));
        } else {
          console.log(color('Context already within limits', 'dim'));
        }
      }
      console.log();
      break;

    case '/theme':
      if (parts[1] === 'list') {
        const themeList = themes.listThemes();
        const current = themes.getCurrentThemeName();
        console.log(`Themes: ${themeList.map(t => t.name === current ? color(t.name, 'green') : t.name).join(', ')}`);
      } else if (parts[1]) {
        if (themes.setCurrentTheme(parts[1])) {
          console.log(color(`Theme set to: ${parts[1]}`, 'green'));
        } else {
          console.log(color(`Theme not found: ${parts[1]}`, 'red'));
        }
      } else {
        console.log(`Current: ${themes.getCurrentThemeName()}`);
        console.log(`Available: ${themes.listThemes().map(t => t.name).join(', ')}`);
      }
      console.log();
      break;

    case '/branch':
      {
        // Use a simple session ID for the legacy CLI
        const sessionId = 'default-session';
        if (parts[1] === 'list') {
          const branches = branching.listBranches(sessionId);
          console.log(`Branches: ${branches.map(b => b.id === state.currentBranch ? color(b.id, 'green') : b.id).join(', ')}`);
        } else if (parts[1] === 'new' && parts[2]) {
          const description = parts.slice(3).join(' ') || undefined;
          const branch = branching.createBranch(sessionId, parts[2], state.messages, description);
          state.currentBranch = branch.id;
          console.log(color(`Created branch: ${parts[2]}`, 'green'));
        } else if (parts[1] === 'switch' && parts[2]) {
          const result = branching.switchBranch(sessionId, parts[2], state.messages);
          if (result) {
            state.messages = result;
            state.currentBranch = parts[2];
            console.log(color(`Switched to branch: ${parts[2]}`, 'green'));
          } else {
            console.log(color(`Branch not found: ${parts[2]}`, 'red'));
          }
        } else {
          console.log(`Current: ${state.currentBranch}`);
          console.log('Usage: /branch [list|new <name>|switch <name>]');
        }
      }
      console.log();
      break;

    case '/find':
      if (parts[1]) {
        const results = fuzzySearch.searchFiles(parts[1], state.cwd, { maxResults: 10 });
        if (results.length) {
          console.log(color('Matches:', 'bold'));
          for (const r of results) {
            console.log(`  ${r.relativePath} (${Math.round(r.score * 100)}%)`);
          }
        } else {
          console.log(color('No matches found', 'dim'));
        }
      } else {
        console.log('Usage: /find <pattern>');
      }
      console.log();
      break;

    case '/search':
      if (parts[1]) {
        const query = parts.slice(1).join(' ').toLowerCase();
        const matches = state.messages.filter(m => {
          const content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
          return content.toLowerCase().includes(query);
        });
        console.log(`Found ${matches.length} messages containing "${query}"`);
        for (const m of matches.slice(0, 5)) {
          const preview = (typeof m.content === 'string' ? m.content : JSON.stringify(m.content)).slice(0, 80);
          console.log(`  [${m.role}] ${preview}...`);
        }
      } else {
        console.log('Usage: /search <query>');
      }
      console.log();
      break;

    case '/upgrade':
      await handleUpgrade(rl);
      break;

    case '/mode':
      if (parts[1] && ['plan', 'hybrid', 'work'].includes(parts[1])) {
        state.mode = parts[1] as Mode;
        const cfg = MODE_CONFIG[state.mode];
        console.log(color(`Mode: ${cfg.icon} ${cfg.label} - ${cfg.description}`, 'green'));
      } else {
        const cfg = MODE_CONFIG[state.mode];
        console.log(`Current: ${cfg.icon} ${cfg.label}`);
        console.log('Options: plan, hybrid, work');
      }
      console.log();
      break;

    case '/work':
      state.mode = 'work';
      console.log(color(`Mode: ${MODE_CONFIG['work'].icon} ${MODE_CONFIG['work'].label}`, 'green'));
      console.log();
      break;

    case '/plan':
      state.mode = 'plan';
      console.log(color(`Mode: ${MODE_CONFIG['plan'].icon} ${MODE_CONFIG['plan'].label}`, 'green'));
      console.log();
      break;

    case '/debug':
      if (parts[1] === 'on') {
        state.debugEnabled = true;
        console.log(color('Debug logging ON', 'green'));
      } else if (parts[1] === 'off') {
        state.debugEnabled = false;
        console.log(color('Debug logging OFF', 'yellow'));
      } else {
        console.log(`Debug: ${state.debugEnabled ? 'ON' : 'OFF'}`);
        console.log(`Mode: ${state.mode}`);
        console.log(`Confirm: ${state.confirmMode ? 'ON' : 'OFF'}`);
        console.log(`Messages: ${state.messages.length}`);
        console.log(`Loop: ${state.loopActive ? 'active' : 'inactive'}`);
        console.log('\nUse /debug on|off to toggle.');
      }
      console.log();
      break;

    case '/set':
      if (parts[1] === 'maxIterations' && parts[2]) {
        const val = parseInt(parts[2]);
        if (!isNaN(val) && val > 0) {
          state.loopMaxIterations = val;
          console.log(color(`maxIterations set to ${val}`, 'green'));
        }
      } else {
        console.log('Usage: /set maxIterations <number>');
      }
      console.log();
      break;

    case '/confirm':
      if (parts[1] === 'on') {
        state.confirmMode = true;
        console.log(color('Confirmation mode ON', 'green'));
      } else if (parts[1] === 'off') {
        state.confirmMode = false;
        console.log(color('Confirmation mode OFF', 'yellow'));
      } else {
        console.log(`Confirm mode: ${state.confirmMode ? 'ON' : 'OFF'}`);
        console.log('Use /confirm on|off to toggle.');
      }
      console.log();
      break;

    case '/scope':
    case '/dirs':
      if (parts[1] === 'details') {
        console.log(color('Scope Details:', 'cyan'));
        console.log(getScopeDetails());
      } else if (parts[1] === 'reset') {
        resetScope();
        console.log(color('Scope reset to defaults', 'green'));
      } else {
        console.log(getScopeSummary());
      }
      console.log();
      break;

    case '/add-dir':
      if (parts[1]) {
        addToScope(parts[1]);
        console.log(color(`Added to scope: ${parts[1]}`, 'green'));
      } else {
        console.log('Usage: /add-dir <path>');
      }
      console.log();
      break;

    case '/remove-dir':
      if (parts[1]) {
        removeFromScope(parts[1]);
        console.log(color(`Removed from scope: ${parts[1]}`, 'green'));
      } else {
        console.log('Usage: /remove-dir <path>');
      }
      console.log();
      break;

    case '/cost':
    case '/costs':
      if (parts[1] === 'reset') {
        state.sessionCost = 0;
        storage.resetCosts();
        console.log(color('Costs reset', 'green'));
      } else {
        console.log(color('Cost Tracking:', 'cyan'));
        console.log(`  Session: $${state.sessionCost.toFixed(4)}`);
        console.log(storage.getCostSummary());
      }
      console.log();
      break;

    case '/session':
      console.log(color('Session Info:', 'cyan'));
      console.log(`  Messages: ${state.messages.length}`);
      console.log(`  Provider: ${selectProvider(state.provider)}`);
      console.log(`  Model: ${state.model || DEFAULT_MODELS[selectProvider(state.provider)]}`);
      console.log(`  Mode: ${MODE_CONFIG[state.mode].icon} ${state.mode}`);
      console.log(`  Cost: $${state.sessionCost.toFixed(4)}`);
      console.log();
      break;

    case '/context':
      const memCtx = memory.buildMemoryContext(state.cwd);
      if (memCtx) {
        console.log(color('Context:', 'cyan'));
        console.log(memCtx.substring(0, 500) + (memCtx.length > 500 ? '...' : ''));
      } else {
        console.log('No context loaded. Use /memory init to create CALLIOPE.md');
      }
      console.log();
      break;

    case '/exit':
    case '/quit':
    case '/q':
      console.log();
      console.log(color('  Until we meet again...', 'cyan'));
      console.log();
      state.running = false;
      rl.close();
      process.exit(0);
      break;

    default:
      console.log(color(`Unknown command: ${cmd}. Type /help for help.`, 'red'));
      console.log();
  }
}

/**
 * Handle upgrade command
 */
async function handleUpgrade(rl: readline.Interface): Promise<void> {
  console.log();
  console.log(color('Checking for updates...', 'cyan'));

  const currentVersion = getVersion();
  const latestVersion = await getLatestVersion();

  if (!latestVersion) {
    console.log(color('Could not check for updates. Try again later.', 'red'));
    console.log();
    return;
  }

  const current = currentVersion.split('.').map(Number);
  const latest = latestVersion.split('.').map(Number);
  let hasUpdate = false;

  for (let i = 0; i < 3; i++) {
    if ((latest[i] || 0) > (current[i] || 0)) {
      hasUpdate = true;
      break;
    }
    if ((latest[i] || 0) < (current[i] || 0)) break;
  }

  if (!hasUpdate) {
    console.log(color(`You're on the latest version (v${currentVersion})`, 'green'));
    console.log();
    return;
  }

  console.log();
  console.log(`${color('Update available:', 'yellow')} v${currentVersion} → ${color('v' + latestVersion, 'green')}`);
  console.log();

  // Prompt for confirmation
  rl.question(`${color('Upgrade now? (y/N)', 'cyan')} `, async (answer) => {
    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      console.log();
      const success = await performUpgrade();

      if (success) {
        console.log();
        console.log(color('Upgrade complete!', 'green'));
        console.log(color('Restarting Calliope...', 'dim'));
        console.log();

        // Restart the CLI
        const { spawn } = await import('child_process');
        const child = spawn(process.argv[0], process.argv.slice(1), {
          stdio: 'inherit',
          detached: true,
        });
        child.unref();
        process.exit(0);
      } else {
        console.log();
        console.log(color('Upgrade failed. Try manually:', 'red'));
        console.log(color('  npm install -g @calliopelabs/cli@latest', 'dim'));
        console.log();
      }
    } else {
      console.log(color('Upgrade cancelled.', 'dim'));
      console.log();
    }
  });
}

/**
 * Print help
 */
function printHelp(): void {
  console.log();
  console.log(color('Commands:', 'bold'));
  console.log('  /help, /h          Show this help');
  console.log('  /provider <name>   Switch AI provider');
  console.log('  /model [name]      Set model (interactive if no name)');
  console.log('  /models            Browse and select available models');
  console.log('  /route [on|off]    Auto model routing by complexity');
  console.log('  /persona <name>    Switch persona (calliope, professional, minimal)');
  console.log('  /clear             Clear conversation');
  console.log('  /status            Show current status');
  console.log();
  console.log(color('Mode & Settings:', 'bold'));
  console.log('  /mode [plan|hybrid|work]  Switch modes');
  console.log('  /work              Quick switch to work mode');
  console.log('  /plan              Quick switch to plan mode');
  console.log('  /set <key> <val>   Change settings (maxIterations)');
  console.log('  /confirm [on|off]  Toggle confirmation for risky ops');
  console.log('  /debug [on|off]    Show state / toggle debug logging');
  console.log();
  console.log(color('Memory & Context:', 'bold'));
  console.log('  /memory [init|show|add|global]  Project memory');
  console.log('  /context           Show loaded context');
  console.log('  /summarize [context|compact]    Summarize conversation');
  console.log('  /search <query>    Search conversation');
  console.log();
  console.log(color('Scope & Security:', 'bold'));
  console.log('  /scope [details|reset]  Show/manage file access scope');
  console.log('  /add-dir <path>    Add directory to scope');
  console.log('  /remove-dir <path> Remove directory from scope');
  console.log();
  console.log(color('Navigation:', 'bold'));
  console.log('  /find <pattern>    Fuzzy file search');
  console.log('  /branch [list|new|switch]  Conversation branches');
  console.log();
  console.log(color('Extensions:', 'bold'));
  console.log('  /hooks [init|list] Pre/post tool hooks');
  console.log('  /theme [name|list] Color themes');
  console.log();
  console.log(color('Ralph Wiggum Loop:', 'bold'));
  console.log('  /loop "<prompt>"   Start autonomous loop');
  console.log('    --max-iterations N');
  console.log('    --completion-promise "text"');
  console.log('  /cancel-loop       Stop active loop');
  console.log();
  console.log(color('Info & Config:', 'bold'));
  console.log('  /session           Show session info');
  console.log('  /cost [reset]      Show cost tracking');
  console.log('  /setup             Reconfigure');
  console.log('  /config            Show config path');
  console.log('  /upgrade           Check for and install updates');
  console.log('  /exit              Exit');
  console.log();
}

/**
 * Run the agent with a prompt
 */
async function runAgent(prompt: string, state: CLIState): Promise<string> {
  // Add user message
  state.messages.push({ role: 'user', content: prompt });

  // Spinner setup
  let spinnerIdx = 0;
  const spinnerInterval = setInterval(() => {
    process.stdout.write(`\r${color(SPINNER[spinnerIdx], 'cyan')} ${color('Thinking...', 'dim')}`);
    spinnerIdx = (spinnerIdx + 1) % SPINNER.length;
  }, 80);

  // Helper to clean up spinner
  const clearSpinner = () => {
    clearInterval(spinnerInterval);
    process.stdout.write('\r\x1b[K'); // Clear line
  };

  try {
    const maxIterations = config.get('maxIterations');
    let iteration = 0;
    let finalResponse = '';

    while (iteration < maxIterations) {
      iteration++;

      // Call LLM
      const response = await chat(
        state.provider,
        state.messages,
        TOOLS,
        state.model
      );

      // Handle tool calls
      if (response.toolCalls && response.toolCalls.length > 0) {
        clearSpinner();

        // Add assistant message with tool calls
        state.messages.push({
          role: 'assistant',
          content: response.content,
          toolCalls: response.toolCalls,
        });

        // Execute tools
        for (const toolCall of response.toolCalls) {
          // Execute pre-tool hooks
          const preHookResult = await hooks.checkHooksAllow('pre-tool', {
            tool: toolCall.name,
            toolArgs: toolCall.arguments as Record<string, unknown>,
          });
          if (!preHookResult.allowed) {
            console.log(`${color('│', 'dim')}  ${color(`Blocked by hook: ${preHookResult.reason}`, 'red')}`);
            state.messages.push({
              role: 'tool',
              content: `[Blocked by hook: ${preHookResult.reason}]`,
              toolCallId: toolCall.id,
            });
            continue;
          }

          printToolCall(toolCall);
          const result = await executeTool(toolCall, state.cwd);
          printToolResult(toolCall.name, result.result);

          // Execute post-tool hooks
          hooks.executeHooks('post-tool', {
            tool: toolCall.name,
            toolArgs: toolCall.arguments as Record<string, unknown>,
            toolResult: result.result,
          }).catch(() => {});

          state.messages.push({
            role: 'tool',
            content: result.result,
            toolCallId: toolCall.id,
          });
        }

        // Continue loop for next response
        continue;
      }

      // No tool calls - final response
      clearSpinner();

      state.messages.push({
        role: 'assistant',
        content: response.content,
      });

      finalResponse = response.content;
      console.log();
      console.log(`${color('✧', 'cyan')} ${color('Calliope:', 'dim')}`);
      console.log();
      printOutput(response.content);
      console.log();

      break;
    }

    return finalResponse;
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.log();
    console.log(`${color('✗', 'red')} ${color(`Error: ${msg}`, 'red')}`);
    console.log();

    return '';
  } finally {
    // Ensure spinner is always cleaned up
    clearInterval(spinnerInterval);
  }
}

/**
 * Start an autonomous loop
 */
async function startLoop(args: string, state: CLIState): Promise<void> {
  // Parse args
  const maxIterMatch = args.match(/--max-iterations\s+(\d+)/);
  const completionMatch = args.match(/--completion-promise\s+"([^"]+)"/);

  let prompt = args
    .replace(/--max-iterations\s+\d+/, '')
    .replace(/--completion-promise\s+"[^"]+"/, '')
    .trim();

  const quotedMatch = prompt.match(/^"([^"]+)"$/);
  if (quotedMatch) prompt = quotedMatch[1];

  if (!prompt) {
    console.log(color('Usage: /loop "<prompt>" [--max-iterations N] [--completion-promise "text"]', 'red'));
    console.log();
    return;
  }

  state.loopActive = true;
  state.loopPrompt = prompt;
  state.loopIteration = 0;
  state.loopMaxIterations = maxIterMatch ? parseInt(maxIterMatch[1], 10) : 50;
  state.loopCompletionPromise = completionMatch ? completionMatch[1] : undefined;

  console.log();
  console.log(`${color('╭─', 'dim')} ${color('🔄 Ralph Loop Started', 'bold')}`);
  console.log(`${color('│', 'dim')}  ${color('Max:', 'dim')} ${color(String(state.loopMaxIterations), 'cyan')}`);
  if (state.loopCompletionPromise) {
    console.log(`${color('│', 'dim')}  ${color('Promise:', 'dim')} ${color(state.loopCompletionPromise, 'green')}`);
  }
  console.log(`${color('╰─', 'dim')} ${color('/cancel-loop to stop', 'dim')}`);
  console.log();

  // Run loop
  while (state.loopActive && state.loopIteration < state.loopMaxIterations) {
    state.loopIteration++;

    console.log(`${color('╭─', 'cyan')} ${color(`Iteration ${state.loopIteration}/${state.loopMaxIterations}`, 'bold')}`);

    const result = await runAgent(state.loopPrompt, state);

    // Check completion promise
    if (state.loopCompletionPromise && result.includes(state.loopCompletionPromise)) {
      console.log(`${color('🎉 Completion promise detected!', 'green')}`);
      state.loopActive = false;
      break;
    }

    if (!state.loopActive) break;

    // Delay between iterations
    await new Promise(r => setTimeout(r, 1000));
  }

  if (state.loopIteration >= state.loopMaxIterations) {
    console.log(`${color('⚠️ Max iterations reached', 'yellow')}`);
  }

  state.loopActive = false;
  console.log();
}

/**
 * Print tool call
 */
function printToolCall(toolCall: ToolCall): void {
  const icons: Record<string, string> = {
    shell: '⚡',
    read_file: '📄',
    write_file: '✍️',
    list_files: '📁',
    think: '💭',
  };

  console.log();
  console.log(`${color('╭─', 'dim')} ${icons[toolCall.name] || '⚙️'} ${color(toolCall.name, 'yellow')}`);

  if (toolCall.name === 'shell' && toolCall.arguments.command) {
    console.log(`${color('│', 'dim')}  ${color('$', 'green')} ${toolCall.arguments.command}`);
  } else if (toolCall.name === 'think' && toolCall.arguments.thought) {
    const thought = String(toolCall.arguments.thought);
    const preview = thought.length > 80 ? thought.substring(0, 80) + '...' : thought;
    console.log(`${color('│', 'dim')}  ${color(preview, 'dim')}`);
  }
}

/**
 * Print tool result
 */
function printToolResult(name: string, result: string): void {
  if (name === 'think') {
    console.log(`${color('╰─', 'dim')} ${color('✓', 'green')}`);
    return;
  }

  const lines = result.split('\n').slice(0, 10);
  for (const line of lines) {
    console.log(`${color('│', 'dim')}  ${color(line.substring(0, 100), 'dim')}`);
  }
  if (result.split('\n').length > 10) {
    console.log(`${color('│', 'dim')}  ${color(`... (${result.split('\n').length - 10} more lines)`, 'dim')}`);
  }

  const success = !result.toLowerCase().includes('error');
  console.log(`${color('╰─', 'dim')} ${success ? color('✓', 'green') : color('✗', 'red')}`);
}

/**
 * Print output with indentation
 */
function printOutput(text: string): void {
  const lines = text.split('\n');
  for (const line of lines) {
    console.log(`${color('│', 'blue')} ${line}`);
  }
}
