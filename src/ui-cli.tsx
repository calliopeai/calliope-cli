/**
 * Calliope CLI - Ink UI
 *
 * Component hierarchy inspired by Claude Code:
 * App
 * └── TerminalChat (main hub)
 *     ├── MessageHistory (Static for messages)
 *     │   └── MessageItem (formatted messages)
 *     ├── ProcessingIndicator (animated spinner)
 *     ├── ChatInput (input line)
 *     └── StatusBar (footer)
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { render, Box, Text, useInput, useApp, useStdout, Static } from 'ink';
import TextInput from 'ink-text-input';
import * as config from './config.js';
import { chat, getAvailableProviders, selectProvider } from './providers.js';
import { TOOLS, executeTool } from './tools.js';
import { getSystemPrompt, DEFAULT_MODELS } from './types.js';
import { getVersion, getLatestVersion, performUpgrade } from './version-check.js';
import { getAvailableModels, type ModelInfo } from './model-detection.js';
import type { Message as LLMMessage, LLMProvider, AgentPersona } from './types.js';

// ============================================================================
// Types
// ============================================================================

interface UIMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  content: string;
}

interface SessionStats {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  messageCount: number;
}

// ============================================================================
// Constants
// ============================================================================

const BANNER_LINES = [
  ' ██████╗ █████╗ ██╗     ██╗     ██╗ ██████╗ ██████╗ ███████╗',
  '██╔════╝██╔══██╗██║     ██║     ██║██╔═══██╗██╔══██╗██╔════╝',
  '██║     ███████║██║     ██║     ██║██║   ██║██████╔╝█████╗  ',
  '██║     ██╔══██║██║     ██║     ██║██║   ██║██╔═══╝ ██╔══╝  ',
  '╚██████╗██║  ██║███████╗███████╗██║╚██████╔╝██║     ███████╗',
  ' ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝     ╚══════╝',
];

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

const TOOL_ICONS: Record<string, string> = {
  shell: '⚡',
  read_file: '📄',
  write_file: '✍️',
  list_files: '📁',
  think: '💭',
};

// ============================================================================
// Utility Components
// ============================================================================

function Separator() {
  const { stdout } = useStdout();
  const width = stdout?.columns || 80;
  return <Text dimColor>{'─'.repeat(width)}</Text>;
}

interface ThinkingState {
  status: string;
  detail?: string;
  thinking?: string;  // Output from think tool
  iteration?: number;
  maxIterations?: number;
}

function ThinkingDisplay({ state }: { state: ThinkingState }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box flexDirection="column" marginY={1}>
      {/* Main status line */}
      <Box>
        <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>
        <Text> {state.status}</Text>
        {state.iteration && state.maxIterations && (
          <Text dimColor> ({state.iteration}/{state.maxIterations})</Text>
        )}
      </Box>

      {/* Detail line */}
      {state.detail && (
        <Box marginLeft={2}>
          <Text dimColor>↳ {state.detail}</Text>
        </Box>
      )}

      {/* Thinking output (from think tool) */}
      {state.thinking && (
        <Box flexDirection="column" marginLeft={2} marginTop={1}>
          <Text color="magenta">💭 Thinking:</Text>
          {state.thinking.split('\n').slice(0, 5).map((line, i) => (
            <Text key={i} dimColor>   {line.substring(0, 80)}</Text>
          ))}
          {state.thinking.split('\n').length > 5 && (
            <Text dimColor>   ...</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

// Legacy simple indicator for non-agent operations
function ProcessingIndicator({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % SPINNER_FRAMES.length);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  return (
    <Box marginY={1}>
      <Text color="cyan">{SPINNER_FRAMES[frame]}</Text>
      <Text dimColor> {label}</Text>
    </Box>
  );
}

// ============================================================================
// Message Components
// ============================================================================

function MessageItem({ msg }: { msg: UIMessage }) {
  switch (msg.type) {
    case 'user':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text><Text color="cyan">›</Text> {msg.content}</Text>
        </Box>
      );

    case 'assistant': {
      const lines = msg.content.split('\n');
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Text color="cyan">✧ Calliope:</Text>
          <Text> </Text>
          {lines.map((line, i) => (
            <Text key={i}><Text color="blue">│</Text> {line}</Text>
          ))}
        </Box>
      );
    }

    case 'tool': {
      const isToolCall = msg.content.startsWith('⚡');
      if (isToolCall) {
        const match = msg.content.match(/^⚡ (\w+): (.*)$/);
        if (match) {
          const [, toolName, preview] = match;
          const icon = TOOL_ICONS[toolName] || '⚙️';
          return (
            <Box flexDirection="column">
              <Text><Text dimColor>╭─</Text> {icon} <Text color="yellow">{toolName}</Text></Text>
              <Text><Text dimColor>│</Text>  <Text dimColor>{preview}</Text></Text>
            </Box>
          );
        }
      }

      // Check for diff output from write_file
      const isDiff = msg.content.startsWith('DIFF:');
      if (isDiff) {
        const lines = msg.content.split('\n');
        const header = lines[0];
        const isNewFile = header.includes('NEW_FILE:');
        const filePath = isNewFile
          ? header.replace('DIFF:NEW_FILE:', '')
          : header.replace('DIFF:', '');
        const diffLines = lines.slice(1, 12);
        const hasMore = lines.length > 12;

        return (
          <Box flexDirection="column">
            <Text>
              <Text dimColor>├──</Text>
              <Text color="yellow"> {isNewFile ? '(new file)' : '(modified)'}</Text>
            </Text>
            {diffLines.map((line, i) => {
              let color: string | undefined;
              if (line.startsWith('+ ')) color = 'green';
              else if (line.startsWith('- ')) color = 'red';
              else if (line.startsWith('@@')) color = 'cyan';
              return (
                <Text key={i}>
                  <Text dimColor>│</Text>
                  <Text color={color as 'green' | 'red' | 'cyan' | undefined}>  {line.substring(0, 80)}</Text>
                </Text>
              );
            })}
            {hasMore && <Text><Text dimColor>│</Text>  <Text dimColor>...</Text></Text>}
            <Text><Text dimColor>╰─</Text> <Text color="green">✓</Text> <Text dimColor>{filePath}</Text></Text>
          </Box>
        );
      }

      // Regular tool result
      const lines = msg.content.split('\n').slice(0, 5);
      const hasMore = msg.content.split('\n').length > 5;
      const hasError = msg.content.toLowerCase().includes('error');
      return (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i}><Text dimColor>│</Text>  <Text dimColor>{line.substring(0, 100)}</Text></Text>
          ))}
          {hasMore && <Text><Text dimColor>│</Text>  <Text dimColor>...</Text></Text>}
          <Text><Text dimColor>╰─</Text> {hasError ? <Text color="red">✗</Text> : <Text color="green">✓</Text>}</Text>
        </Box>
      );
    }

    case 'system':
      return <Text color="yellow">{msg.content}</Text>;

    case 'error':
      return <Text color="red">✗ {msg.content}</Text>;

    default:
      return <Text>{msg.content}</Text>;
  }
}

function MessageHistory({ messages }: { messages: UIMessage[] }) {
  return (
    <Static items={messages}>
      {(msg) => (
        <Box key={msg.id}>
          <MessageItem msg={msg} />
        </Box>
      )}
    </Static>
  );
}

// ============================================================================
// Modal Components
// ============================================================================

function ModelSelector({
  models,
  onSelect,
  onCancel
}: {
  models: ModelInfo[];
  onSelect: (model: string) => void;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  const pageSize = 10;
  const start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), models.length - pageSize));
  const visible = models.slice(start, start + pageSize);

  useInput((input, key) => {
    if (key.upArrow) setIndex(i => Math.max(0, i - 1));
    else if (key.downArrow) setIndex(i => Math.min(models.length - 1, i + 1));
    else if (key.return) onSelect(models[index].id);
    else if (key.escape || input === 'q') onCancel();
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="yellow">Select model (↑/↓ navigate, Enter select, Esc cancel):</Text>
      {visible.map((model, i) => {
        const globalIndex = start + i;
        const isSelected = globalIndex === index;
        const name = model.name || model.id;
        const displayName = name.length > 50 ? name.slice(0, 47) + '...' : name;
        return (
          <Text key={model.id} color={isSelected ? 'cyan' : undefined} bold={isSelected}>
            {isSelected ? '❯ ' : '  '}{displayName}
          </Text>
        );
      })}
      {models.length > pageSize && (
        <Text dimColor>  ({index + 1}/{models.length})</Text>
      )}
    </Box>
  );
}

function UpgradePrompt({
  currentVersion,
  latestVersion,
  onConfirm,
  onCancel
}: {
  currentVersion: string;
  latestVersion: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onConfirm();
    else if (input === 'n' || input === 'N' || key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="yellow">
        Update available: v{currentVersion} → <Text color="green">v{latestVersion}</Text>
      </Text>
      <Text>Upgrade now? <Text color="cyan">(y/N)</Text></Text>
    </Box>
  );
}

// ============================================================================
// Input Components
// ============================================================================

function ChatInput({
  value,
  onChange,
  onSubmit,
  disabled
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
}) {
  if (disabled) return null;

  return (
    <Box flexDirection="column">
      <Separator />
      <Box>
        <Text color="cyan">calliope</Text>
        <Text dimColor>&gt; </Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
      </Box>
    </Box>
  );
}

function StatusBar({
  provider,
  model,
  stats
}: {
  provider: string;
  model: string;
  stats: SessionStats;
}) {
  const formatTokens = (n: number) => n >= 1000 ? `${(n/1000).toFixed(1)}K` : String(n);
  const formatCost = (c: number) => c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`;
  const displayModel = model.length > 25 ? model.slice(0, 22) + '...' : model;

  return (
    <Box flexDirection="column">
      <Separator />
      <Text dimColor>
        {provider}:{displayModel}
        {' │ '}
        {formatTokens(stats.inputTokens + stats.outputTokens)} tokens
        {' │ '}
        {formatCost(stats.cost)}
      </Text>
    </Box>
  );
}

// ============================================================================
// Main Chat Component
// ============================================================================

function TerminalChat() {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const width = stdout?.columns || 80;

  // Core state
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [thinkingState, setThinkingState] = useState<ThinkingState | null>(null);
  const [streamingResponse, setStreamingResponse] = useState<string>('');

  // Config state
  const [provider, setProvider] = useState<LLMProvider>(config.get('defaultProvider'));
  const [model, setModel] = useState<string | undefined>(config.get('defaultModel'));
  const [persona, setPersona] = useState<AgentPersona>(config.get('persona'));

  // Modal state
  const [modalMode, setModalMode] = useState<'none' | 'model' | 'upgrade'>('none');
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  // Stats
  const [stats, setStats] = useState<SessionStats>({
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    messageCount: 0,
  });

  // LLM conversation history
  const llmMessages = useRef<LLMMessage[]>([
    { role: 'system', content: getSystemPrompt(persona) }
  ]);

  // Derived values
  const actualProvider = selectProvider(provider);
  const actualModel = model || DEFAULT_MODELS[actualProvider];
  const isModalActive = modalMode !== 'none';

  // Add message helper
  const addMessage = useCallback((type: UIMessage['type'], content: string) => {
    setMessages(prev => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      content
    }]);
  }, []);

  // Handle slash commands
  const handleCommand = useCallback(async (cmd: string): Promise<void> => {
    const parts = cmd.split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case '/help':
      case '/h':
        addMessage('system', 'Commands: /help /provider /model /models /persona /clear /status /config /upgrade /exit\nLoop mode: use --legacy flag');
        break;

      case '/provider':
      case '/p':
        if (parts[1]) {
          const p = parts[1].toLowerCase() as LLMProvider;
          setProvider(p);
          addMessage('system', `Provider: ${selectProvider(p)}`);
        } else {
          addMessage('system', `Provider: ${actualProvider} | Available: ${getAvailableProviders().join(', ')}`);
        }
        break;

      case '/model':
      case '/m':
        if (parts[1]) {
          setModel(parts[1]);
          addMessage('system', `Model: ${parts[1]}`);
        } else {
          addMessage('system', `Discovering models for ${actualProvider}...`);
          try {
            const models = await getAvailableModels(actualProvider);
            if (models.length > 0) {
              setAvailableModels(models);
              setModalMode('model');
            } else {
              addMessage('error', 'No models found');
            }
          } catch (e) {
            addMessage('error', `Failed to fetch models: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
        break;

      case '/models':
        addMessage('system', `Discovering models for ${actualProvider}...`);
        try {
          const models = await getAvailableModels(actualProvider);
          if (models.length > 0) {
            setAvailableModels(models);
            setModalMode('model');
          } else {
            addMessage('error', 'No models found');
          }
        } catch (e) {
          addMessage('error', `Failed to fetch models: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;

      case '/persona':
        if (parts[1] && ['calliope', 'professional', 'minimal'].includes(parts[1])) {
          const p = parts[1] as AgentPersona;
          setPersona(p);
          llmMessages.current = [{ role: 'system', content: getSystemPrompt(p) }];
          addMessage('system', `Persona: ${p}`);
        } else {
          addMessage('system', `Persona: ${persona} | Options: calliope, professional, minimal`);
        }
        break;

      case '/clear':
      case '/c':
        setMessages([]);
        llmMessages.current = [{ role: 'system', content: getSystemPrompt(persona) }];
        setStats({ inputTokens: 0, outputTokens: 0, cost: 0, messageCount: 0 });
        break;

      case '/status':
      case '/s':
        addMessage('system', `${actualProvider}:${actualModel} | ${stats.messageCount} msgs | ${stats.inputTokens + stats.outputTokens} tokens`);
        break;

      case '/config':
        addMessage('system', `Config: ${config.getConfigPath()}\nProviders: ${config.getConfiguredProviders().join(', ') || 'none'}`);
        break;

      case '/setup':
      case '/loop':
        addMessage('system', 'This feature requires legacy CLI. Run: calliope --legacy');
        break;

      case '/upgrade':
        addMessage('system', 'Checking for updates...');
        try {
          const current = getVersion();
          const latest = await getLatestVersion();
          if (!latest) {
            addMessage('error', 'Could not check for updates');
            break;
          }
          const [cMaj, cMin, cPat] = current.split('.').map(Number);
          const [lMaj, lMin, lPat] = latest.split('.').map(Number);
          const hasUpdate = lMaj > cMaj || (lMaj === cMaj && lMin > cMin) || (lMaj === cMaj && lMin === cMin && lPat > cPat);

          if (hasUpdate) {
            setLatestVersion(latest);
            setModalMode('upgrade');
          } else {
            addMessage('system', `You're on the latest version (v${current})`);
          }
        } catch (e) {
          addMessage('error', `Failed to check for updates: ${e instanceof Error ? e.message : String(e)}`);
        }
        break;

      case '/exit':
      case '/quit':
      case '/q':
        exit();
        break;

      default:
        addMessage('error', `Unknown command: ${command}. Type /help for help.`);
    }
  }, [actualProvider, actualModel, persona, stats, addMessage, exit]);

  // Run agent with user prompt
  const runAgent = useCallback(async (prompt: string) => {
    llmMessages.current.push({ role: 'user', content: prompt });
    setStats(s => ({ ...s, messageCount: s.messageCount + 1 }));
    setStreamingResponse('');

    const maxIterations = config.get('maxIterations');

    for (let i = 0; i < maxIterations; i++) {
      try {
        // Update thinking state for LLM call
        setThinkingState({
          status: i === 0 ? 'Analyzing request...' : 'Processing response...',
          detail: `Iteration ${i + 1}/${maxIterations}`,
          iteration: i + 1,
          maxIterations,
        });

        // Streaming callback for final response
        const onToken = (token: string) => {
          setThinkingState(null); // Clear thinking when streaming starts
          setStreamingResponse(prev => prev + token);
        };

        const response = await chat(provider, llmMessages.current, TOOLS, model, onToken);

        // Update token stats
        if (response.usage) {
          setStats(s => ({
            ...s,
            inputTokens: s.inputTokens + response.usage!.inputTokens,
            outputTokens: s.outputTokens + response.usage!.outputTokens,
          }));
        }

        // Handle tool calls
        if (response.toolCalls?.length) {
          llmMessages.current.push({
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
          });

          for (const toolCall of response.toolCalls) {
            const args = toolCall.arguments as Record<string, unknown>;
            const toolPreview = String(args.command || args.path || '...');

            // Special handling for think tool
            if (toolCall.name === 'think') {
              const thought = String(args.thought || '');
              setThinkingState({
                status: 'Reasoning...',
                detail: thought.substring(0, 60) + (thought.length > 60 ? '...' : ''),
                thinking: thought,
                iteration: i + 1,
                maxIterations,
              });
            } else {
              setThinkingState({
                status: `Executing ${toolCall.name}...`,
                detail: toolPreview.substring(0, 60),
                thinking: undefined,
                iteration: i + 1,
                maxIterations,
              });
            }

            addMessage('tool', `⚡ ${toolCall.name}: ${toolPreview}`);
            const result = await executeTool(toolCall, process.cwd());

            const preview = result.result.split('\n').slice(0, 3).join('\n');
            addMessage('tool', preview + (result.result.split('\n').length > 3 ? '\n...' : ''));

            llmMessages.current.push({
              role: 'tool',
              content: result.result,
              toolCallId: toolCall.id,
            });
          }
          continue;
        }

        // Final response - move streaming content to message history
        setThinkingState(null);
        llmMessages.current.push({ role: 'assistant', content: response.content });
        addMessage('assistant', response.content);
        setStreamingResponse('');
        break;

      } catch (error) {
        setThinkingState(null);
        setStreamingResponse('');
        addMessage('error', `Error: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }
  }, [provider, model, addMessage]);

  // Handle input submission
  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isProcessing) return;

    setInput('');

    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed);
      return;
    }

    addMessage('user', trimmed);
    setIsProcessing(true);

    try {
      await runAgent(trimmed);
    } finally {
      setIsProcessing(false);
      setThinkingState(null);
      setStreamingResponse('');
    }
  }, [isProcessing, handleCommand, runAgent, addMessage]);

  // Modal handlers
  const handleModelSelect = useCallback((selectedModel: string) => {
    setModel(selectedModel);
    addMessage('system', `Model: ${selectedModel}`);
    setModalMode('none');
    setAvailableModels([]);
  }, [addMessage]);

  const handleModalCancel = useCallback(() => {
    setModalMode('none');
    setAvailableModels([]);
    setLatestVersion(null);
  }, []);

  const handleUpgradeConfirm = useCallback(async () => {
    setModalMode('none');
    addMessage('system', 'Upgrading...');

    try {
      const success = await performUpgrade();
      if (success) {
        addMessage('system', 'Upgrade complete! Restarting...');
        const { spawn } = await import('child_process');
        const child = spawn(process.argv[0], process.argv.slice(1), {
          stdio: 'inherit',
          detached: true,
        });
        child.unref();
        process.exit(0);
      } else {
        addMessage('error', 'Upgrade failed. Try: npm install -g @calliopelabs/cli@latest');
      }
    } catch (e) {
      addMessage('error', `Upgrade failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    setLatestVersion(null);
  }, [addMessage]);

  // Escape to exit (but not in modal)
  useInput((_, key) => {
    if (key.escape && !isModalActive) exit();
  }, { isActive: !isModalActive });

  // Render
  return (
    <Box flexDirection="column" width={width}>
      {/* Message History */}
      <MessageHistory messages={messages} />

      {/* Streaming Response */}
      {streamingResponse && (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Text color="cyan">✧ Calliope:</Text>
          <Text> </Text>
          {streamingResponse.split('\n').map((line, i) => (
            <Text key={i}><Text color="blue">│</Text> {line}</Text>
          ))}
          <Text color="blue">│</Text>
          <Text color="cyan">▌</Text>
        </Box>
      )}

      {/* Thinking Display / Processing Indicator */}
      {isProcessing && thinkingState && !streamingResponse && <ThinkingDisplay state={thinkingState} />}
      {isProcessing && !thinkingState && !streamingResponse && <ProcessingIndicator label="Processing..." />}

      {/* Modal: Model Selector */}
      {modalMode === 'model' && availableModels.length > 0 && (
        <ModelSelector
          models={availableModels}
          onSelect={handleModelSelect}
          onCancel={handleModalCancel}
        />
      )}

      {/* Modal: Upgrade Prompt */}
      {modalMode === 'upgrade' && latestVersion && (
        <UpgradePrompt
          currentVersion={getVersion()}
          latestVersion={latestVersion}
          onConfirm={handleUpgradeConfirm}
          onCancel={handleModalCancel}
        />
      )}

      {/* Chat Input */}
      <ChatInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        disabled={isModalActive || isProcessing}
      />

      {/* Status Bar */}
      <StatusBar
        provider={actualProvider}
        model={actualModel}
        stats={stats}
      />
    </Box>
  );
}

// ============================================================================
// App Wrapper & Entry Point
// ============================================================================

function App() {
  return <TerminalChat />;
}

// ANSI colors for pre-Ink banner
const ansi = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  brightCyan: '\x1b[96m',
  dim: '\x1b[2m',
};

function printBanner(provider: string, model: string): void {
  console.log();
  console.log(`${ansi.brightCyan}${BANNER_LINES[0]}${ansi.reset}`);
  console.log(`${ansi.brightCyan}${BANNER_LINES[1]}${ansi.reset}`);
  console.log(`${ansi.cyan}${BANNER_LINES[2]}${ansi.reset}`);
  console.log(`${ansi.cyan}${BANNER_LINES[3]}${ansi.reset}`);
  console.log(`${ansi.brightCyan}${BANNER_LINES[4]}${ansi.reset}`);
  console.log(`${ansi.cyan}${BANNER_LINES[5]}${ansi.reset}`);
  console.log();
  console.log(`${ansi.dim}        The Muse of Digital Eloquence${ansi.reset}`);
  console.log();
  console.log(`  ${ansi.dim}v${getVersion()} | ${provider}:${model}${ansi.reset}`);
  console.log(`  ${ansi.dim}/help for commands | ESC to exit${ansi.reset}`);
  console.log();
}

export async function startInkCLI(options: { skipPermissions?: boolean } = {}): Promise<void> {
  const provider = selectProvider(config.get('defaultProvider'));
  const model = config.get('defaultModel') || DEFAULT_MODELS[provider];

  printBanner(provider, model);

  const { waitUntilExit } = render(<App />);
  await waitUntilExit();
}
