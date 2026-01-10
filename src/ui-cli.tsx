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
import { getSystemPrompt, DEFAULT_MODELS, MODE_CONFIG, RISK_CONFIG, supportsVision, calculateCost } from './types.js';
import { getVersion, getLatestVersion, performUpgrade } from './version-check.js';
import { getAvailableModels, type ModelInfo } from './model-detection.js';
import { assessToolRisk, detectComplexity } from './risk.js';
import { formatError, classifyError } from './errors.js';
import * as storage from './storage.js';
import { parseFileReferences, processFilesForMessage, formatFileInfo } from './files.js';
import type { Message as LLMMessage, LLMProvider, AgentPersona, Mode, RiskLevel, MessageContent, ToolCall } from './types.js';
import { requiresConfirmation } from './risk.js';

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
  execute_code: '▶️',
  web_search: '🔍',
  git: '🔀',
  mermaid: '📊',
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

function ToolConfirmation({
  toolCall,
  riskLevel,
  reason,
  onConfirm,
  onDeny
}: {
  toolCall: ToolCall;
  riskLevel: RiskLevel;
  reason: string;
  onConfirm: () => void;
  onDeny: () => void;
}) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onConfirm();
    else if (input === 'n' || input === 'N' || key.escape) onDeny();
  });

  const args = toolCall.arguments as Record<string, unknown>;
  const preview = String(args.command || args.path || args.operation || '...');
  const riskColor = riskLevel === 'critical' ? 'red' : 'yellow';
  const riskIcon = riskLevel === 'critical' ? '⚠️' : '⚡';

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={riskColor} paddingX={1}>
      <Text color={riskColor} bold>{riskIcon} {riskLevel.toUpperCase()} RISK OPERATION</Text>
      <Text> </Text>
      <Text>Tool: <Text color="cyan">{toolCall.name}</Text></Text>
      <Text>Command: <Text dimColor>{preview.substring(0, 60)}</Text></Text>
      <Text>Reason: <Text dimColor>{reason}</Text></Text>
      <Text> </Text>
      <Text>Execute this operation? <Text color="cyan">(y/N)</Text></Text>
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
  disabled,
  mode
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  disabled: boolean;
  mode: Mode;
}) {
  if (disabled) return null;

  const modeConfig = MODE_CONFIG[mode];

  return (
    <Box flexDirection="column">
      <Separator />
      <Box>
        <Text color="cyan">calliope </Text>
        <Text>{modeConfig.icon}</Text>
        <Text dimColor>&gt; </Text>
        <TextInput value={value} onChange={onChange} onSubmit={onSubmit} />
      </Box>
    </Box>
  );
}

// Context window limits by model (approximate)
const CONTEXT_LIMITS: Record<string, number> = {
  'claude-sonnet-4': 200000,
  'claude-opus-4': 200000,
  'claude-3': 200000,
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gemini-2': 1000000,
  'gemini-1.5-pro': 1000000,
  'gemini-1.5-flash': 1000000,
  'llama-3.3': 128000,
  'llama-3.1': 128000,
  'mistral-large': 128000,
  'default': 32000,
};

function getContextLimit(model: string): number {
  for (const [key, limit] of Object.entries(CONTEXT_LIMITS)) {
    if (model.toLowerCase().includes(key.toLowerCase())) {
      return limit;
    }
  }
  return CONTEXT_LIMITS.default;
}

function StatusBar({
  provider,
  model,
  stats,
  mode,
  contextTokens,
}: {
  provider: string;
  model: string;
  stats: SessionStats;
  mode: Mode;
  contextTokens: number;
}) {
  const formatTokens = (n: number) => n >= 1000 ? `${(n/1000).toFixed(1)}K` : String(n);
  const formatCost = (c: number) => c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`;
  const displayModel = model.length > 25 ? model.slice(0, 22) + '...' : model;
  const modeConfig = MODE_CONFIG[mode];

  // Context usage indicator
  const contextLimit = getContextLimit(model);
  const contextPct = Math.min(100, Math.round((contextTokens / contextLimit) * 100));
  const contextColor = contextPct > 80 ? 'red' : contextPct > 50 ? 'yellow' : 'green';

  return (
    <Box flexDirection="column">
      <Separator />
      <Text dimColor>
        {modeConfig.icon} {modeConfig.label}
        {' │ '}
        {provider}:{displayModel}
        {' │ '}
        <Text color={contextColor}>{formatTokens(contextTokens)}/{formatTokens(contextLimit)}</Text>
        {' │ '}
        {formatTokens(stats.inputTokens + stats.outputTokens)} used
        {' │ '}
        {formatCost(stats.cost)}
        {' │ '}
        <Text dimColor>Esc: exit</Text>
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
  const [mode, setMode] = useState<Mode>('hybrid'); // Default to hybrid mode
  const [confirmMode, setConfirmMode] = useState<boolean>(true); // Require confirmation for risky ops

  // Modal state
  const [modalMode, setModalMode] = useState<'none' | 'model' | 'upgrade' | 'confirm'>('none');
  const [pendingToolCall, setPendingToolCall] = useState<{ toolCall: ToolCall; resolve: (approved: boolean) => void } | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  // Stats
  const [stats, setStats] = useState<SessionStats>({
    inputTokens: 0,
    outputTokens: 0,
    cost: 0,
    messageCount: 0,
  });
  const [contextTokens, setContextTokens] = useState(0);

  // LLM conversation history
  const llmMessages = useRef<LLMMessage[]>([
    { role: 'system', content: getSystemPrompt(persona) }
  ]);

  // Estimate context tokens (rough: ~4 chars per token)
  const estimateContextTokens = useCallback(() => {
    let chars = 0;
    for (const msg of llmMessages.current) {
      if (typeof msg.content === 'string') {
        chars += msg.content.length;
      } else if (Array.isArray(msg.content)) {
        for (const block of msg.content) {
          if (block.type === 'text') {
            chars += block.text.length;
          } else if (block.type === 'image') {
            chars += 1000; // Images count as ~250 tokens
          }
        }
      }
    }
    return Math.round(chars / 4);
  }, []);

  // Session state
  const sessionRef = useRef<storage.Session | null>(null);

  // Initialize session on mount
  useEffect(() => {
    const session = storage.getOrCreateSession(process.cwd());
    sessionRef.current = session;
  }, []);

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
        addMessage('system', `Commands:
  /mode [plan|hybrid|work] - Switch modes (Shift+Tab to cycle)
  /provider [name]         - Switch AI provider
  /model [name]            - Switch model
  /persona [name]          - Switch personality
  /todo [add|done|list]    - Manage TODOs
  /plans [list|view]       - View plan history
  /session [list|info]     - Session management
  /history [search]        - Chat history
  /context [load|summary]  - Context management
  /clear                   - Clear conversation
  /copy                    - Copy last response to clipboard
  /export [file.md]        - Export conversation to markdown
  /edit                    - Edit and resend last message
  /undo                    - Remove last exchange
  /confirm [on|off]        - Toggle risky op confirmation
  /status                  - Show status
  /config                  - Show config
  /upgrade                 - Check for updates
  /exit                    - Exit

File references: @filename, ./path, /absolute/path
Modes: 📋 Plan | 🔄 Hybrid | 🔧 Work`);
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

      case '/mode':
        if (parts[1] && ['plan', 'hybrid', 'work'].includes(parts[1])) {
          const m = parts[1] as Mode;
          setMode(m);
          addMessage('system', `Mode: ${MODE_CONFIG[m].icon} ${MODE_CONFIG[m].label} - ${MODE_CONFIG[m].description}`);
        } else {
          const currentConfig = MODE_CONFIG[mode];
          addMessage('system', `Mode: ${currentConfig.icon} ${currentConfig.label}\nOptions: plan (📋), hybrid (🔄), work (🔧)\nUse Shift+Tab to cycle`);
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

      case '/copy': {
        // Copy last assistant response to clipboard
        const lastAssistant = [...messages].reverse().find(m => m.type === 'assistant');
        if (lastAssistant) {
          try {
            const { execSync } = await import('child_process');
            // Try different clipboard commands based on platform
            const content = lastAssistant.content;
            if (process.platform === 'darwin') {
              execSync('pbcopy', { input: content });
            } else if (process.platform === 'win32') {
              execSync('clip', { input: content });
            } else {
              // Linux - try xclip, xsel, or wl-copy
              try {
                execSync('xclip -selection clipboard', { input: content });
              } catch {
                try {
                  execSync('xsel --clipboard --input', { input: content });
                } catch {
                  execSync('wl-copy', { input: content });
                }
              }
            }
            addMessage('system', '✓ Copied to clipboard');
          } catch (e) {
            addMessage('error', `Clipboard not available: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else {
          addMessage('system', 'No assistant message to copy');
        }
        break;
      }

      case '/export': {
        // Export conversation to markdown
        const filename = parts[1] || `calliope-export-${Date.now()}.md`;
        const fs = await import('fs');
        const path = await import('path');

        let markdown = `# Calliope Conversation Export\n\n`;
        markdown += `**Date:** ${new Date().toLocaleString()}\n`;
        markdown += `**Provider:** ${actualProvider}\n`;
        markdown += `**Model:** ${actualModel}\n\n---\n\n`;

        for (const msg of messages) {
          if (msg.type === 'user') {
            markdown += `## 👤 User\n\n${msg.content}\n\n`;
          } else if (msg.type === 'assistant') {
            markdown += `## 🤖 Assistant\n\n${msg.content}\n\n`;
          } else if (msg.type === 'tool') {
            markdown += `> 🔧 Tool: ${msg.content}\n\n`;
          } else if (msg.type === 'system') {
            markdown += `> ℹ️ ${msg.content}\n\n`;
          } else if (msg.type === 'error') {
            markdown += `> ⚠️ Error: ${msg.content}\n\n`;
          }
        }

        const filepath = path.resolve(process.cwd(), filename);
        fs.writeFileSync(filepath, markdown);
        addMessage('system', `✓ Exported to ${filename}`);
        break;
      }

      case '/edit': {
        // Edit last user message
        const lastUserIdx = [...messages].reverse().findIndex(m => m.type === 'user');
        if (lastUserIdx >= 0) {
          const lastUser = messages[messages.length - 1 - lastUserIdx];
          setInput(lastUser.content);
          addMessage('system', 'Edit the message above and press Enter to resend');
        } else {
          addMessage('system', 'No user message to edit');
        }
        break;
      }

      case '/undo': {
        // Remove last exchange (user message + assistant response)
        let removed = 0;
        const newMessages = [...messages];
        // Remove from the end until we've removed a user message
        while (newMessages.length > 0 && removed < 10) {
          const last = newMessages.pop();
          removed++;
          if (last?.type === 'user') break;
        }

        // Also remove from LLM context
        while (llmMessages.current.length > 1) {
          const last = llmMessages.current[llmMessages.current.length - 1];
          if (last.role === 'user') {
            llmMessages.current.pop();
            break;
          }
          llmMessages.current.pop();
        }

        setMessages(newMessages);
        addMessage('system', `✓ Removed last ${removed} message(s)`);
        break;
      }

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

      case '/confirm':
        if (parts[1] === 'on') {
          setConfirmMode(true);
          addMessage('system', '✓ Confirmation mode ON - will ask before risky operations');
        } else if (parts[1] === 'off') {
          setConfirmMode(false);
          addMessage('system', '⚠️ Confirmation mode OFF - risky operations will auto-execute');
        } else {
          addMessage('system', `Confirm mode: ${confirmMode ? 'ON' : 'OFF'}\nUsage: /confirm [on|off]`);
        }
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

      case '/session':
        if (parts[1] === 'list') {
          const sessions = storage.listSessions(5);
          if (sessions.length === 0) {
            addMessage('system', 'No previous sessions found.');
          } else {
            const list = sessions.map(s =>
              `${s.projectName} (${new Date(s.lastAccessedAt).toLocaleDateString()}) - ${s.messageCount} msgs`
            ).join('\n');
            addMessage('system', `Recent sessions:\n${list}`);
          }
        } else if (parts[1] === 'info') {
          const session = sessionRef.current;
          if (session) {
            addMessage('system', `Session: ${session.projectName}\nCreated: ${new Date(session.createdAt).toLocaleString()}\nMessages: ${session.messageCount}`);
          } else {
            addMessage('system', 'No active session.');
          }
        } else {
          addMessage('system', 'Usage: /session [list|info]');
        }
        break;

      case '/todo': {
        const subCommand = parts[1];
        if (subCommand === 'add' && parts.length > 2) {
          const content = parts.slice(2).join(' ');
          const isGlobal = content.includes('--global');
          const isHigh = content.includes('--priority') && content.includes('high');
          const cleanContent = content.replace(/--global|--priority\s*\w+/g, '').trim();
          const todo = storage.addTodo(cleanContent, {
            global: isGlobal,
            priority: isHigh ? 'high' : 'normal',
          });
          addMessage('system', `✓ TODO added (#${todo.id.slice(-4)}${isGlobal ? ', global' : ''})`);
        } else if (subCommand === 'done' && parts[2]) {
          const id = parts[2];
          const todos = [...storage.getSessionTodos(), ...storage.getGlobalTodos()];
          const todo = todos.find(t => t.id.endsWith(id) || t.id === id);
          if (todo) {
            storage.updateTodo(todo.id, { status: 'completed' });
            addMessage('system', `✓ TODO #${id} marked done`);
          } else {
            addMessage('error', `TODO #${id} not found`);
          }
        } else if (subCommand === 'list' || !subCommand) {
          const sessionTodos = storage.getSessionTodos();
          const globalTodos = storage.getGlobalTodos();
          const pending = [...sessionTodos, ...globalTodos].filter(t => t.status !== 'completed');
          const completed = [...sessionTodos, ...globalTodos].filter(t => t.status === 'completed').slice(-3);

          if (pending.length === 0 && completed.length === 0) {
            addMessage('system', 'No TODOs. Use /todo add <task> to create one.');
          } else {
            let output = '📋 TODOs:\n';
            if (pending.length > 0) {
              output += pending.map(t =>
                `  ${t.priority === 'high' ? '!' : '□'} #${t.id.slice(-4)} ${t.content}`
              ).join('\n');
            }
            if (completed.length > 0) {
              output += '\n\nCompleted:\n' + completed.map(t =>
                `  ✓ #${t.id.slice(-4)} ${t.content}`
              ).join('\n');
            }
            addMessage('system', output);
          }
        } else {
          addMessage('system', 'Usage: /todo [add <task>|done <id>|list]');
        }
        break;
      }

      case '/plans': {
        const subCommand = parts[1];
        if (subCommand === 'list' || !subCommand) {
          const plans = storage.getPlans();
          if (plans.length === 0) {
            addMessage('system', 'No plans yet. Plans are created in hybrid mode.');
          } else {
            const list = plans.slice(0, 5).map(p =>
              `${p.status === 'completed' ? '✓' : '○'} ${p.id.slice(-4)}: ${p.title}`
            ).join('\n');
            addMessage('system', `📋 Plans:\n${list}`);
          }
        } else if (subCommand === 'view' && parts[2]) {
          const plans = storage.getPlans();
          const plan = plans.find(p => p.id.endsWith(parts[2]) || p.id === parts[2]);
          if (plan) {
            const phases = plan.phases.map(ph =>
              `  ${ph.status === 'completed' ? '✓' : '○'} ${ph.name} (${ph.risk} risk)`
            ).join('\n');
            addMessage('system', `Plan: ${plan.title}\nStatus: ${plan.status}\n\nPhases:\n${phases}`);
          } else {
            addMessage('error', `Plan #${parts[2]} not found`);
          }
        } else {
          addMessage('system', 'Usage: /plans [list|view <id>]');
        }
        break;
      }

      case '/history': {
        const subCommand = parts[1];
        if (subCommand === 'search' && parts[2]) {
          const query = parts.slice(2).join(' ');
          const results = storage.searchChatHistory(query);
          if (results.length === 0) {
            addMessage('system', `No matches for "${query}"`);
          } else {
            const list = results.slice(-5).map(m =>
              `${new Date(m.timestamp).toLocaleTimeString()}: ${m.content.substring(0, 60)}...`
            ).join('\n');
            addMessage('system', `🔍 Found ${results.length} matches:\n${list}`);
          }
        } else if (subCommand === 'clear') {
          addMessage('system', 'History is preserved per session. Start a new session for fresh history.');
        } else {
          const history = storage.getChatHistory(5);
          if (history.length === 0) {
            addMessage('system', 'No chat history yet.');
          } else {
            const list = history.map(m =>
              `${m.role}: ${m.content.substring(0, 50)}...`
            ).join('\n');
            addMessage('system', `Recent history:\n${list}\n\nUse /history search <query> to search.`);
          }
        }
        break;
      }

      case '/context': {
        const subCommand = parts[1];
        if (subCommand === 'load') {
          const limit = parseInt(parts[2]) || 20;
          const history = storage.getChatHistory(limit);
          if (history.length > 0) {
            // Load history into LLM context
            for (const msg of history) {
              if (msg.role === 'user' || msg.role === 'assistant') {
                llmMessages.current.push({
                  role: msg.role,
                  content: msg.content,
                });
              }
            }
            addMessage('system', `✓ Loaded ${history.length} messages into context`);
          } else {
            addMessage('system', 'No history to load.');
          }
        } else if (subCommand === 'summary') {
          const msgCount = llmMessages.current.length;
          const estTokens = llmMessages.current.reduce((sum, m) => sum + (m.content?.length || 0) / 4, 0);
          addMessage('system', `Context: ${msgCount} messages (~${Math.round(estTokens)} tokens)`);
        } else {
          addMessage('system', 'Usage: /context [load [n]|summary]');
        }
        break;
      }

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
  const runAgent = useCallback(async (content: MessageContent) => {
    llmMessages.current.push({ role: 'user', content });
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

        // Retry callback for error recovery
        const onRetry = (attempt: number, error: Error, delayMs: number) => {
          setThinkingState({
            status: `Retrying... (attempt ${attempt + 1})`,
            detail: `${error.message.substring(0, 40)}... Waiting ${Math.round(delayMs / 1000)}s`,
            iteration: i + 1,
            maxIterations,
          });
        };

        const response = await chat(provider, llmMessages.current, TOOLS, model, onToken, onRetry);

        // Update token stats and cost
        if (response.usage) {
          const usageCost = calculateCost(model || DEFAULT_MODELS[provider], response.usage.inputTokens, response.usage.outputTokens);
          setStats(s => ({
            ...s,
            inputTokens: s.inputTokens + response.usage!.inputTokens,
            outputTokens: s.outputTokens + response.usage!.outputTokens,
            cost: s.cost + usageCost,
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

            // Assess risk
            const risk = assessToolRisk(toolCall);
            const riskConfig = RISK_CONFIG[risk.level];
            const riskDisplay = risk.level !== 'none' ? ` [${riskConfig.bar}]` : '';

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

            // In plan mode, don't execute tools (except think)
            if (mode === 'plan' && toolCall.name !== 'think') {
              addMessage('tool', `📋 ${toolCall.name}: ${toolPreview}${riskDisplay} (plan mode - not executed)`);
              llmMessages.current.push({
                role: 'tool',
                content: '[Plan mode: Tool not executed. Describe what this would do.]',
                toolCallId: toolCall.id,
              });
              continue;
            }

            // Check if confirmation is required for risky operations
            if (confirmMode && requiresConfirmation(risk, false) && toolCall.name !== 'think') {
              // Show warning and skip execution
              const riskIcon = risk.level === 'critical' ? '🛑' : '⚠️';
              addMessage('tool', `${riskIcon} ${toolCall.name}: ${toolPreview}${riskDisplay}\n  → Requires confirmation (use /confirm off to disable)`);
              llmMessages.current.push({
                role: 'tool',
                content: `[Operation blocked - ${risk.level} risk: ${risk.reason}. User confirmation required.]`,
                toolCallId: toolCall.id,
              });
              continue;
            }

            addMessage('tool', `⚡ ${toolCall.name}: ${toolPreview}${riskDisplay}`);
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
        setContextTokens(estimateContextTokens());
        break;

      } catch (error) {
        setThinkingState(null);
        setStreamingResponse('');
        addMessage('error', formatError(error));
        break;
      }
    }
    // Update context tokens after agent run
    setContextTokens(estimateContextTokens());
  }, [provider, model, addMessage, mode, estimateContextTokens]);

  // Handle input submission
  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isProcessing) return;

    setInput('');

    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed);
      return;
    }

    // Parse file references from input
    const { text: cleanText, files } = parseFileReferences(trimmed, process.cwd());

    // Show user message (with file info if any)
    if (files.length > 0) {
      const fileInfo = formatFileInfo(files);
      addMessage('user', `${cleanText}\n📎 ${fileInfo}`);
    } else {
      addMessage('user', trimmed);
    }

    setIsProcessing(true);

    try {
      // Build message content (with file/image support)
      let messageContent: MessageContent;

      if (files.length > 0) {
        const visionSupported = supportsVision(provider, model);
        const { content, warnings } = processFilesForMessage(cleanText || trimmed, files, visionSupported);

        // Show any warnings about files
        for (const warning of warnings) {
          addMessage('system', warning);
        }

        messageContent = content;
      } else {
        messageContent = trimmed;
      }

      await runAgent(messageContent);
    } finally {
      setIsProcessing(false);
      setThinkingState(null);
      setStreamingResponse('');
    }
  }, [isProcessing, handleCommand, runAgent, addMessage, provider, model]);

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

  // Cycle through modes
  const cycleMode = useCallback(() => {
    setMode(current => {
      const modes: Mode[] = ['plan', 'hybrid', 'work'];
      const idx = modes.indexOf(current);
      const next = modes[(idx + 1) % modes.length];
      return next;
    });
  }, []);

  // Keyboard shortcuts (Escape to exit, Shift+Tab to cycle mode)
  useInput((input, key) => {
    if (key.escape && !isModalActive) exit();
    // Shift+Tab to cycle mode (key.shift && key.tab)
    if (key.shift && key.tab && !isProcessing) {
      cycleMode();
    }
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
        mode={mode}
      />

      {/* Status Bar */}
      <StatusBar
        provider={actualProvider}
        model={actualModel}
        mode={mode}
        stats={stats}
        contextTokens={contextTokens}
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
