/**
 * Calliope CLI - Interactive REPL
 *
 * Main interactive command-line interface.
 */

import * as readline from 'readline';
import * as config from './config.js';
import { chat, getAvailableProviders, selectProvider } from './providers.js';
import { TOOLS, executeTool } from './tools.js';
import { getSystemPrompt, DEFAULT_MODELS } from './types.js';
import type { Message, LLMProvider, AgentPersona, ToolCall } from './types.js';

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
  '/help', '/h', '/provider', '/p', '/model', '/m', '/persona',
  '/clear', '/c', '/status', '/s', '/loop', '/cancel-loop',
  '/setup', '/config', '/exit', '/quit', '/q',
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
  };

  // Add system message
  state.messages.push({
    role: 'system',
    content: getSystemPrompt(state.persona),
  });

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

  // Print welcome
  if (config.get('fancyOutput')) {
    console.log(BANNER);
    const actualProvider = selectProvider(state.provider);
    const model = state.model || DEFAULT_MODELS[actualProvider];
    console.log(`  ${color('Provider:', 'dim')} ${color(actualProvider, 'cyan')} (${color(model, 'dim')})`);
    console.log(`  ${color('Persona:', 'dim')} ${color(state.persona, 'cyan')}`);
    console.log(`  ${color('Directory:', 'dim')} ${color(state.cwd, 'dim')}`);
    console.log();
    console.log(color('  ─────────────────────────────────────────────────────────────────', 'dim'));
    console.log(`  ${color('TAB', 'cyan')} ${color('autocomplete', 'dim')} ${color('│', 'dim')} ${color('/help', 'cyan')} ${color('│', 'dim')} ${color('/loop', 'cyan')} ${color('│', 'dim')} ${color('/provider', 'cyan')} ${color('│', 'dim')} ${color('ESC', 'cyan')} ${color('stop', 'dim')}`);
    console.log(color('  ─────────────────────────────────────────────────────────────────', 'dim'));
  } else {
    console.log('Calliope CLI');
    console.log(`Provider: ${selectProvider(state.provider)}`);
    console.log('/help for commands');
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

  promptUser();
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
      } else {
        const actualProvider = selectProvider(state.provider);
        console.log(`Model: ${state.model || DEFAULT_MODELS[actualProvider]}`);
      }
      console.log();
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
 * Print help
 */
function printHelp(): void {
  console.log();
  console.log(color('Commands:', 'bold'));
  console.log('  /help, /h          Show this help');
  console.log('  /provider <name>   Switch AI provider');
  console.log('  /model <name>      Set model');
  console.log('  /persona <name>    Switch persona (calliope, professional, minimal)');
  console.log('  /clear             Clear conversation');
  console.log('  /status            Show current status');
  console.log();
  console.log(color('Ralph Wiggum Loop:', 'bold'));
  console.log('  /loop "<prompt>"   Start autonomous loop');
  console.log('    --max-iterations N');
  console.log('    --completion-promise "text"');
  console.log('  /cancel-loop       Stop active loop');
  console.log();
  console.log(color('Config:', 'bold'));
  console.log('  /setup             Reconfigure');
  console.log('  /config            Show config path');
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
          printToolCall(toolCall);
          const result = await executeTool(toolCall, state.cwd);
          printToolResult(toolCall.name, result.result);

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
