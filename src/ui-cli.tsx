/**
 * Calliope CLI - Ink UI Integration
 *
 * Connects the ink-based UI to the existing agent/provider logic.
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
import type { Message as LLMMessage, LLMProvider, AgentPersona, ToolCall } from './types.js';

// ASCII Banner
const BANNER_LINES = [
  ' ██████╗ █████╗ ██╗     ██╗     ██╗ ██████╗ ██████╗ ███████╗',
  '██╔════╝██╔══██╗██║     ██║     ██║██╔═══██╗██╔══██╗██╔════╝',
  '██║     ███████║██║     ██║     ██║██║   ██║██████╔╝█████╗  ',
  '██║     ██╔══██║██║     ██║     ██║██║   ██║██╔═══╝ ██╔══╝  ',
  '╚██████╗██║  ██║███████╗███████╗██║╚██████╔╝██║     ███████╗',
  ' ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝     ╚══════╝',
];

// UI Message type
interface UIMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  content: string;
}

// Session stats
interface Stats {
  provider: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cost: number;
  messages: number;
  startTime: Date;
}

// Format helpers
const formatTokens = (n: number) => n >= 1000 ? `${(n/1000).toFixed(1)}K` : String(n);
const formatCost = (c: number) => c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`;
const formatTime = (d: Date) => {
  const s = Math.floor((Date.now() - d.getTime()) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m` : `${Math.floor(m/60)}h${m%60}m`;
};

// Separator
function Sep() {
  const { stdout } = useStdout();
  return <Text dimColor>{'─'.repeat(stdout?.columns || 80)}</Text>;
}

// Model Selector Component (Ink-native, replaces inquirer)
interface ModelSelectorProps {
  models: ModelInfo[];
  selectedIndex: number;
  onSelect: (model: string) => void;
  onCancel: () => void;
}

function ModelSelector({ models, selectedIndex, onSelect, onCancel }: ModelSelectorProps) {
  const [index, setIndex] = useState(selectedIndex);
  const pageSize = 10;
  const start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), models.length - pageSize));
  const visible = models.slice(start, start + pageSize);

  useInput((input, key) => {
    if (key.upArrow) {
      setIndex(i => Math.max(0, i - 1));
    } else if (key.downArrow) {
      setIndex(i => Math.min(models.length - 1, i + 1));
    } else if (key.return) {
      onSelect(models[index].id);
    } else if (key.escape || input === 'q') {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="yellow">Select model (↑/↓ navigate, Enter select, Esc cancel):</Text>
      {visible.map((model, i) => {
        const globalIndex = start + i;
        const isSelected = globalIndex === index;
        const name = model.name || model.id;
        const displayName = name.length > 50 ? name.slice(0, 47) + '...' : name;
        return (
          <Box key={model.id}>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {isSelected ? '❯ ' : '  '}{displayName}
            </Text>
          </Box>
        );
      })}
      {models.length > pageSize && (
        <Text dimColor>  ({index + 1}/{models.length})</Text>
      )}
    </Box>
  );
}

// Upgrade Prompt Component
interface UpgradePromptProps {
  currentVersion: string;
  latestVersion: string;
  onConfirm: () => void;
  onCancel: () => void;
}

function UpgradePrompt({ currentVersion, latestVersion, onConfirm, onCancel }: UpgradePromptProps) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') {
      onConfirm();
    } else if (input === 'n' || input === 'N' || key.escape) {
      onCancel();
    }
  });

  return (
    <Box flexDirection="column">
      <Text color="yellow">Update available: v{currentVersion} → <Text color="green">v{latestVersion}</Text></Text>
      <Text>Upgrade now? <Text color="cyan">(y/N)</Text></Text>
    </Box>
  );
}

// Main App
function App({ skipPermissions = false }: { skipPermissions?: boolean }) {
  const { exit } = useApp();
  const { stdout } = useStdout();

  // State
  const [input, setInput] = useState('');
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [isProcessing, setIsProcessing] = useState(false);
  const [provider, setProvider] = useState<LLMProvider>(config.get('defaultProvider'));
  const [model, setModel] = useState<string | undefined>(config.get('defaultModel'));
  const [persona, setPersona] = useState<AgentPersona>(config.get('persona'));

  // Model selection state
  const [modelSelectMode, setModelSelectMode] = useState(false);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [modelLoading, setModelLoading] = useState(false);

  // Upgrade state
  const [upgradeMode, setUpgradeMode] = useState(false);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);
  const [upgrading, setUpgrading] = useState(false);

  const [stats, setStats] = useState<Stats>({
    provider: selectProvider(config.get('defaultProvider')),
    model: config.get('defaultModel') || DEFAULT_MODELS[selectProvider(config.get('defaultProvider'))],
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    messages: 0,
    startTime: new Date(),
  });

  // Conversation history for LLM
  const llmMessages = useRef<LLMMessage[]>([
    { role: 'system', content: getSystemPrompt(persona) }
  ]);

  // Add UI message
  const addMessage = useCallback((type: UIMessage['type'], content: string) => {
    setMessages(prev => [...prev, { id: `${Date.now()}-${Math.random()}`, type, content }]);
  }, []);

  // Handle commands
  const handleCommand = useCallback(async (cmd: string): Promise<boolean> => {
    const parts = cmd.split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case '/help':
      case '/h':
        addMessage('system', `Commands: /help /provider /model /models /persona /clear /status /config /upgrade /exit\nLoop mode: use --legacy flag`);
        return true;

      case '/provider':
      case '/p':
        if (parts[1]) {
          const p = parts[1].toLowerCase() as LLMProvider;
          setProvider(p);
          setStats(s => ({ ...s, provider: selectProvider(p) }));
          addMessage('system', `Provider: ${selectProvider(p)}`);
        } else {
          addMessage('system', `Provider: ${selectProvider(provider)} | Available: ${getAvailableProviders().join(', ')}`);
        }
        return true;

      case '/model':
      case '/m':
        if (parts[1]) {
          setModel(parts[1]);
          setStats(s => ({ ...s, model: parts[1] }));
          addMessage('system', `Model: ${parts[1]}`);
        } else {
          // Trigger inline model selection
          setModelLoading(true);
          addMessage('system', `Discovering models for ${selectProvider(provider)}...`);
          try {
            const models = await getAvailableModels(selectProvider(provider));
            if (models.length > 0) {
              setAvailableModels(models);
              setModelSelectMode(true);
            } else {
              addMessage('error', 'No models found');
            }
          } catch (e) {
            addMessage('error', `Failed to fetch models: ${e instanceof Error ? e.message : String(e)}`);
          } finally {
            setModelLoading(false);
          }
        }
        return true;

      case '/models':
        // Trigger inline model selection
        setModelLoading(true);
        addMessage('system', `Discovering models for ${selectProvider(provider)}...`);
        try {
          const models = await getAvailableModels(selectProvider(provider));
          if (models.length > 0) {
            setAvailableModels(models);
            setModelSelectMode(true);
          } else {
            addMessage('error', 'No models found');
          }
        } catch (e) {
          addMessage('error', `Failed to fetch models: ${e instanceof Error ? e.message : String(e)}`);
        } finally {
          setModelLoading(false);
        }
        return true;

      case '/persona':
        if (parts[1] && ['calliope', 'professional', 'minimal'].includes(parts[1])) {
          const p = parts[1] as AgentPersona;
          setPersona(p);
          llmMessages.current = [{ role: 'system', content: getSystemPrompt(p) }];
          addMessage('system', `Persona: ${p}`);
        } else {
          addMessage('system', `Persona: ${persona} | Options: calliope, professional, minimal`);
        }
        return true;

      case '/clear':
      case '/c':
        setMessages([]);
        llmMessages.current = [{ role: 'system', content: getSystemPrompt(persona) }];
        setStats(s => ({ ...s, messages: 0, inputTokens: 0, outputTokens: 0, cost: 0 }));
        return true;

      case '/status':
      case '/s':
        addMessage('system', `${selectProvider(provider)}:${model || DEFAULT_MODELS[selectProvider(provider)]} | ${stats.messages} msgs | ${formatTokens(stats.inputTokens + stats.outputTokens)} tokens | ${formatCost(stats.cost)}`);
        return true;

      case '/config':
        addMessage('system', `Config: ${config.getConfigPath()}\nProviders: ${config.getConfiguredProviders().join(', ') || 'none'}`);
        return true;

      case '/setup':
        addMessage('system', 'Setup requires legacy CLI mode. Run: calliope --legacy then /setup');
        return true;

      case '/loop':
        addMessage('system', 'Loop mode requires legacy CLI. Run: calliope --legacy');
        return true;

      case '/cancel-loop':
        addMessage('system', 'No active loop');
        return true;

      case '/upgrade':
        addMessage('system', 'Checking for updates...');
        try {
          const current = getVersion();
          const latest = await getLatestVersion();
          if (!latest) {
            addMessage('error', 'Could not check for updates');
            return true;
          }
          const currentParts = current.split('.').map(Number);
          const latestParts = latest.split('.').map(Number);
          let hasUpdate = false;
          for (let i = 0; i < 3; i++) {
            if ((latestParts[i] || 0) > (currentParts[i] || 0)) {
              hasUpdate = true;
              break;
            }
            if ((latestParts[i] || 0) < (currentParts[i] || 0)) break;
          }
          if (!hasUpdate) {
            addMessage('system', `You're on the latest version (v${current})`);
          } else {
            setLatestVersion(latest);
            setUpgradeMode(true);
          }
        } catch (e) {
          addMessage('error', `Failed to check for updates: ${e instanceof Error ? e.message : String(e)}`);
        }
        return true;

      case '/exit':
      case '/quit':
      case '/q':
        exit();
        return true;

      default:
        addMessage('error', `Unknown command: ${command}`);
        return true;
    }
  }, [provider, model, persona, stats, addMessage, exit]);

  // Run agent
  const runAgent = useCallback(async (prompt: string) => {
    llmMessages.current.push({ role: 'user', content: prompt });
    setStats(s => ({ ...s, messages: s.messages + 1 }));

    const maxIterations = config.get('maxIterations');
    let iteration = 0;

    while (iteration < maxIterations) {
      iteration++;

      try {
        const response = await chat(provider, llmMessages.current, TOOLS, model);

        // Update token stats
        if (response.usage) {
          setStats(s => ({
            ...s,
            inputTokens: s.inputTokens + response.usage!.inputTokens,
            outputTokens: s.outputTokens + response.usage!.outputTokens,
          }));
        }

        // Handle tool calls
        if (response.toolCalls && response.toolCalls.length > 0) {
          llmMessages.current.push({
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
          });

          for (const toolCall of response.toolCalls) {
            addMessage('tool', `⚡ ${toolCall.name}: ${toolCall.arguments.command || toolCall.arguments.path || '...'}`);
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

        // Final response
        llmMessages.current.push({ role: 'assistant', content: response.content });
        addMessage('assistant', response.content);
        break;

      } catch (error) {
        const msg = error instanceof Error ? error.message : String(error);
        addMessage('error', `Error: ${msg}`);
        break;
      }
    }
  }, [provider, model, addMessage]);

  // Handle submit
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
    }
  }, [isProcessing, handleCommand, runAgent, addMessage]);

  // Track terminal width for resize
  const [width, setWidth] = useState(stdout?.columns || 80);

  useEffect(() => {
    const handleResize = () => {
      setWidth(stdout?.columns || 80);
    };
    process.stdout.on('resize', handleResize);
    return () => {
      process.stdout.off('resize', handleResize);
    };
  }, [stdout]);

  // Escape to exit (but not when in model select mode)
  useInput((_, key) => {
    if (key.escape && !modelSelectMode) exit();
  }, { isActive: !modelSelectMode });

  // Model selection handlers
  const handleModelSelect = useCallback((selectedModel: string) => {
    setModel(selectedModel);
    setStats(s => ({ ...s, model: selectedModel }));
    addMessage('system', `Model: ${selectedModel}`);
    setModelSelectMode(false);
    setAvailableModels([]);
  }, [addMessage]);

  const handleModelCancel = useCallback(() => {
    setModelSelectMode(false);
    setAvailableModels([]);
    addMessage('system', 'Model selection cancelled');
  }, [addMessage]);

  // Upgrade handlers
  const handleUpgradeConfirm = useCallback(async () => {
    setUpgradeMode(false);
    setUpgrading(true);
    addMessage('system', 'Upgrading...');
    try {
      const success = await performUpgrade();
      if (success) {
        addMessage('system', 'Upgrade complete! Restarting...');
        // Restart the CLI
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
    } finally {
      setUpgrading(false);
      setLatestVersion(null);
    }
  }, [addMessage]);

  const handleUpgradeCancel = useCallback(() => {
    setUpgradeMode(false);
    setLatestVersion(null);
    addMessage('system', 'Upgrade cancelled');
  }, [addMessage]);

  const actualModel = model || DEFAULT_MODELS[selectProvider(provider)];

  return (
    <Box flexDirection="column" width={width}>

      {/* Messages - Static for history */}
      <Static items={messages}>
        {(msg) => (
          <Box key={msg.id}>
            <Text
              color={
                msg.type === 'user' ? 'cyan' :
                msg.type === 'assistant' ? 'white' :
                msg.type === 'tool' ? 'green' :
                msg.type === 'system' ? 'yellow' :
                'red'
              }
            >
              {msg.type === 'user' ? '› ' : msg.type === 'assistant' ? '│ ' : msg.type === 'tool' ? '  ' : ''}
              {msg.content}
            </Text>
          </Box>
        )}
      </Static>

      {/* Processing indicator */}
      {isProcessing && <Text color="cyan">⠋ Thinking...</Text>}
      {modelLoading && <Text color="yellow">⠋ Loading models...</Text>}

      {/* Model Selector (when active) */}
      {modelSelectMode && availableModels.length > 0 && (
        <ModelSelector
          models={availableModels}
          selectedIndex={0}
          onSelect={handleModelSelect}
          onCancel={handleModelCancel}
        />
      )}

      {/* Upgrade Confirmation */}
      {upgradeMode && latestVersion && (
        <UpgradePrompt
          currentVersion={getVersion()}
          latestVersion={latestVersion}
          onConfirm={handleUpgradeConfirm}
          onCancel={handleUpgradeCancel}
        />
      )}
      {upgrading && <Text color="yellow">⠋ Upgrading...</Text>}

      {/* Input (hidden when in modal mode) */}
      {!modelSelectMode && !upgradeMode && !upgrading && (
        <Box>
          <Text color="cyan">calliope</Text>
          <Text dimColor>&gt; </Text>
          <TextInput value={input} onChange={setInput} onSubmit={handleSubmit} />
        </Box>
      )}

      {/* Status bar */}
      <Box marginTop={1}>
        <Text dimColor>
          {selectProvider(provider)}:{actualModel.length > 25 ? actualModel.slice(0, 22) + '...' : actualModel}
          {' │ '}
          {formatTokens(stats.inputTokens + stats.outputTokens)} tokens
          {' │ '}
          {formatCost(stats.cost)}
        </Text>
      </Box>
    </Box>
  );
}

// ANSI colors for banner
const c = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  brightCyan: '\x1b[96m',
  dim: '\x1b[2m',
};

// Print banner before Ink starts
function printBanner(provider: string, model: string): void {
  console.log();
  console.log(`${c.brightCyan}${BANNER_LINES[0]}${c.reset}`);
  console.log(`${c.brightCyan}${BANNER_LINES[1]}${c.reset}`);
  console.log(`${c.cyan}${BANNER_LINES[2]}${c.reset}`);
  console.log(`${c.cyan}${BANNER_LINES[3]}${c.reset}`);
  console.log(`${c.brightCyan}${BANNER_LINES[4]}${c.reset}`);
  console.log(`${c.cyan}${BANNER_LINES[5]}${c.reset}`);
  console.log();
  console.log(`${c.dim}        The Muse of Digital Eloquence${c.reset}`);
  console.log();
  console.log(`  ${c.dim}v${getVersion()} | ${provider}:${model}${c.reset}`);
  console.log(`  ${c.dim}/help for commands | ESC to exit${c.reset}`);
  console.log();
}

// Export start function
export async function startInkCLI(options: { skipPermissions?: boolean } = {}): Promise<void> {
  // Print banner before Ink takes over
  const provider = selectProvider(config.get('defaultProvider'));
  const model = config.get('defaultModel') || DEFAULT_MODELS[provider];
  printBanner(provider, model);

  const { waitUntilExit } = render(<App skipPermissions={options.skipPermissions} />);
  await waitUntilExit();
}
