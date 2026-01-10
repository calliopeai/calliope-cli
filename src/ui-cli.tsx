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
import * as fs from 'fs';
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
import { renderMarkdown } from './markdown.js';
import * as mcp from './mcp.js';
import * as skills from './skills.js';
import * as memory from './memory.js';
import * as hooks from './hooks.js';
import * as modelRouter from './model-router.js';
import * as summarization from './summarization.js';
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
      // Render markdown with syntax highlighting
      const rendered = renderMarkdown(msg.content);
      const lines = rendered.split('\n');
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
  onEscape,
  onCycleMode,
  disabled,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onEscape: () => void;
  onCycleMode: () => void;
  disabled: boolean;
}) {
  // Handle ALL keyboard input here - single source of input handling
  useInput((input, key) => {
    // ESC to exit (always works)
    if (key.escape) {
      onEscape();
      return;
    }

    // Ctrl+C to exit (always works)
    if (key.ctrl && input === 'c') {
      onEscape();
      return;
    }

    // When disabled, ignore all other input
    if (disabled) return;

    // Shift+Tab to cycle mode
    if (key.shift && key.tab) {
      onCycleMode();
      return;
    }

    // Enter to submit
    if (key.return) {
      if (value.trim()) {
        onSubmit(value);
      }
      return;
    }

    // Backspace/Delete
    if (key.backspace || key.delete) {
      onChange(value.slice(0, -1));
      return;
    }

    // Ctrl+U to clear line
    if (key.ctrl && input === 'u') {
      onChange('');
      return;
    }

    // Ignore control keys, meta, and navigation
    if (key.ctrl || key.meta || key.upArrow || key.downArrow || key.leftArrow || key.rightArrow || key.tab) {
      return;
    }

    // Regular character input - append to value
    if (input) {
      onChange(value + input);
    }
  });

  return (
    <Box flexDirection="column">
      <Separator />
      <Box>
        <Text color={disabled ? 'gray' : 'cyan'}>calliope&gt; </Text>
        <Text>{value}</Text>
        <Text color="cyan">▌</Text>
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
  const [autoRoute, setAutoRoute] = useState<boolean>(false);  // Auto model routing
  const [memoryLoaded, setMemoryLoaded] = useState(false);

  // Initialize session and load memory on mount
  useEffect(() => {
    const session = storage.getOrCreateSession(process.cwd());
    sessionRef.current = session;

    // Load memory context into system prompt
    if (!memoryLoaded) {
      const cwd = process.cwd();
      const memoryContext = memory.buildMemoryContext(cwd);
      if (memoryContext.trim()) {
        // Append memory context to system prompt
        const currentSystem = llmMessages.current[0];
        if (currentSystem && currentSystem.role === 'system') {
          const systemContent = typeof currentSystem.content === 'string'
            ? currentSystem.content
            : '';
          llmMessages.current[0] = {
            role: 'system',
            content: systemContent + '\n\n--- Project Context ---\n' + memoryContext,
          };
        }
      }
      setMemoryLoaded(true);

      // Execute session start hooks
      hooks.executeHooks('session-start', {}).catch(() => {});
    }
  }, [memoryLoaded]);

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
  /route [on|off|test]     - Auto model routing by complexity
  /persona [name]          - Switch personality
  /todo [add|done|list]    - Manage TODOs
  /plans [list|view]       - View plan history
  /session [list|info]     - Session management
  /history [search]        - Chat history
  /context [load|summary]  - Context management
  /summarize [context|compact] - Summarize/compact context
  /clear                   - Clear conversation
  /copy                    - Copy last response to clipboard
  /export [file.md]        - Export conversation to markdown
  /edit                    - Edit and resend last message
  /undo                    - Remove last exchange
  /confirm [on|off]        - Toggle risky op confirmation
  /profile [name|save|del] - Switch/save/delete profiles
  /mcp [add|remove|tools]  - Manage MCP servers
  /skills [add|remove]     - Manage agent skills
  /memory [init|add|show]  - Project memory (CALLIOPE.md)
  /project [init|show|run] - Project config (.calliope)
  /find <pattern>          - Fuzzy file search
  /branch [new|switch]     - Conversation branches
  /theme [name|list]       - Color themes
  /hooks [list|add]        - Pre/post tool hooks
  /search <query>          - Search conversation
  /status                  - Show status
  /config                  - Show config
  /upgrade                 - Check for updates
  /exit                    - Exit

File references: @filename, ./path, /absolute/path
Modes: 📋 Plan | 🔄 Hybrid | 🔧 Work
Auto-route: ${autoRoute ? 'ON' : 'OFF'}`);
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

      case '/profile': {
        const subCmd = parts[1];
        if (subCmd === 'list' || !subCmd) {
          const profiles = config.listProfiles();
          const active = config.getActiveProfile();
          const list = profiles.map(p => {
            const marker = p.name === active ? '→ ' : '  ';
            const tag = p.builtin ? '(built-in)' : '(custom)';
            return `${marker}${p.name}: ${p.profile.provider}/${p.profile.model || 'default'} ${tag}`;
          }).join('\n');
          addMessage('system', `Profiles:\n${list}\n\nUsage: /profile <name> | /profile save <name>`);
        } else if (subCmd === 'save' && parts[2]) {
          const name = parts[2];
          config.saveProfile(name, {
            provider: provider,
            model: model,
            persona: persona,
            confirmMode: confirmMode,
          });
          addMessage('system', `✓ Saved profile: ${name}`);
        } else if (subCmd === 'delete' && parts[2]) {
          const name = parts[2];
          if (config.deleteProfile(name)) {
            addMessage('system', `✓ Deleted profile: ${name}`);
          } else {
            addMessage('error', `Cannot delete profile: ${name} (built-in or not found)`);
          }
        } else {
          // Load profile
          const profile = config.getProfile(subCmd);
          if (profile) {
            setProvider(profile.provider);
            if (profile.model) setModel(profile.model);
            setPersona(profile.persona);
            if (profile.confirmMode !== undefined) setConfirmMode(profile.confirmMode);
            config.setActiveProfile(subCmd);
            addMessage('system', `✓ Loaded profile: ${subCmd} (${profile.provider}/${profile.model || 'default'})`);
          } else {
            addMessage('error', `Profile not found: ${subCmd}\nBuilt-in: fast, smart, cheap, local`);
          }
        }
        break;
      }

      case '/mcp': {
        const subCmd = parts[1];
        if (subCmd === 'list' || !subCmd) {
          const servers = mcp.listServers();
          if (servers.length === 0) {
            addMessage('system', 'No MCP servers registered.\n\nUsage:\n  /mcp add <url>  - Register MCP server\n  /mcp remove <id> - Remove server');
          } else {
            const list = servers.map(s => {
              const status = s.status === 'connected' ? '🟢' : s.status === 'error' ? '🔴' : '⚪';
              return `${status} ${s.name} (${s.tools.length} tools)\n   ${s.url}`;
            }).join('\n\n');
            addMessage('system', `MCP Servers:\n\n${list}`);
          }
        } else if (subCmd === 'add' && parts[2]) {
          const url = parts[2];
          addMessage('system', `Registering MCP server: ${url}...`);
          try {
            const server = await mcp.registerServer(url);
            addMessage('system', `✓ Registered: ${server.name} (${server.tools.length} tools)`);
          } catch (e) {
            addMessage('error', `Failed to register: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if ((subCmd === 'remove' || subCmd === 'rm') && parts[2]) {
          if (mcp.unregisterServer(parts[2])) {
            addMessage('system', '✓ Server removed');
          } else {
            addMessage('error', 'Server not found');
          }
        } else if (subCmd === 'refresh') {
          const servers = mcp.listServers();
          let connected = 0;
          for (const s of servers) {
            const updated = await mcp.refreshServer(s.id);
            if (updated?.status === 'connected') connected++;
          }
          addMessage('system', `Refreshed ${servers.length} servers (${connected} connected)`);
        } else if (subCmd === 'tools') {
          const tools = mcp.getMCPTools();
          if (tools.length === 0) {
            addMessage('system', 'No MCP tools available. Add servers with /mcp add <url>');
          } else {
            const list = tools.map(t => `• ${t.name}\n  ${t.description}`).join('\n\n');
            addMessage('system', `MCP Tools:\n\n${list}`);
          }
        } else {
          addMessage('system', 'Usage: /mcp [list|add <url>|remove <id>|refresh|tools]');
        }
        break;
      }

      case '/skills': {
        const subCmd = parts[1];
        if (subCmd === 'list' || !subCmd) {
          const allSkills = skills.getSkills();
          if (allSkills.length === 0) {
            addMessage('system', 'No skills installed.\n\nUsage:\n  /skills add <name>     - Install from agentskills.io\n  /skills add <github-url> - Install from GitHub\n  /skills add <path>     - Install from local directory');
          } else {
            const list = allSkills.map(s => {
              const src = s.source === 'github' ? '(GitHub)' : s.source === 'registry' ? '(agentskills.io)' : '(local)';
              return `• ${s.metadata.name} ${src}\n  ${s.metadata.description.substring(0, 80)}...`;
            }).join('\n\n');
            addMessage('system', `Installed Skills:\n\n${list}`);
          }
        } else if (subCmd === 'add' && parts[2]) {
          const source = parts[2];
          addMessage('system', `Installing skill: ${source}...`);
          try {
            let skill;
            if (source.startsWith('http')) {
              skill = await skills.installFromGithub(source);
            } else if (fs.existsSync(source)) {
              skill = skills.installLocalSkill(source);
            } else {
              skill = await skills.installFromRegistry(source);
            }
            if (skill) {
              addMessage('system', `✓ Installed: ${skill.metadata.name}`);
            } else {
              addMessage('error', 'Failed to install skill');
            }
          } catch (e) {
            addMessage('error', `Failed: ${e instanceof Error ? e.message : String(e)}`);
          }
        } else if ((subCmd === 'remove' || subCmd === 'rm') && parts[2]) {
          if (skills.uninstallSkill(parts[2])) {
            addMessage('system', '✓ Skill removed');
          } else {
            addMessage('error', 'Skill not found');
          }
        } else if (subCmd === 'info' && parts[2]) {
          const skill = skills.getSkill(parts[2]);
          if (skill) {
            let info = `# ${skill.metadata.name}\n\n`;
            info += `${skill.metadata.description}\n\n`;
            if (skill.metadata.compatibility) info += `Compatibility: ${skill.metadata.compatibility}\n`;
            if (skill.metadata.license) info += `License: ${skill.metadata.license}\n`;
            if (skill.sourceUrl) info += `Source: ${skill.sourceUrl}\n`;
            addMessage('system', info);
          } else {
            addMessage('error', 'Skill not found');
          }
        } else {
          addMessage('system', 'Usage: /skills [list|add <source>|remove <name>|info <name>]');
        }
        break;
      }

      case '/memory': {
        const memory = await import('./memory.js');
        const subCmd = parts[1];
        const cwd = process.cwd();

        if (subCmd === 'init') {
          const memPath = memory.initProjectMemory(cwd);
          addMessage('system', `Created: ${memPath}\nEdit the file to add context and preferences.`);
        } else if (subCmd === 'show' || !subCmd) {
          const memPath = memory.findProjectMemory(cwd);
          if (!memPath) {
            addMessage('system', 'No CALLIOPE.md found.\nRun /memory init to create one.');
          } else {
            const mem = memory.loadMemory(memPath);
            let info = `Memory: ${memPath}\n\n`;
            if (mem.context.length) info += `**Context:**\n${mem.context.map(c => `  - ${c}`).join('\n')}\n\n`;
            if (mem.preferences.length) info += `**Preferences:**\n${mem.preferences.map(p => `  - ${p}`).join('\n')}\n\n`;
            if (mem.history.length) info += `**History:**\n${mem.history.slice(-5).map(h => `  - ${h}`).join('\n')}\n`;
            addMessage('system', info);
          }
        } else if (subCmd === 'add' && parts[2]) {
          const type = parts[2] as 'context' | 'preference' | 'history' | 'note';
          const content = parts.slice(3).join(' ');
          if (!content) {
            addMessage('error', 'Usage: /memory add <type> <content>');
          } else {
            let memPath = memory.findProjectMemory(cwd);
            if (!memPath) {
              memPath = memory.initProjectMemory(cwd);
            }
            memory.addMemoryEntry(memPath, {
              type,
              content,
              timestamp: new Date().toISOString().split('T')[0],
            });
            addMessage('system', `Added ${type}: ${content}`);
          }
        } else if (subCmd === 'remove' && parts[2]) {
          const type = parts[2] as 'context' | 'preference' | 'history' | 'note';
          const content = parts.slice(3).join(' ');
          const memPath = memory.findProjectMemory(cwd);
          if (memPath && memory.removeMemoryEntry(memPath, type, content)) {
            addMessage('system', `Removed matching ${type}`);
          } else {
            addMessage('error', 'Entry not found');
          }
        } else if (subCmd === 'global') {
          const globalMem = memory.getGlobalMemory();
          let info = 'Global Memory:\n\n';
          if (globalMem.preferences.length) info += `**Preferences:**\n${globalMem.preferences.map(p => `  - ${p}`).join('\n')}\n`;
          if (globalMem.notes.length) info += `**Notes:**\n${globalMem.notes.map(n => `  - ${n}`).join('\n')}\n`;
          addMessage('system', info || 'No global memories yet.');
        } else {
          addMessage('system', 'Usage: /memory [init|show|add <type> <text>|remove <type> <text>|global]');
        }
        break;
      }

      case '/find': {
        const fuzzy = await import('./fuzzy-search.js');
        const query = parts.slice(1).join(' ');
        if (!query) {
          addMessage('system', 'Usage: /find <pattern>\nFuzzy search for files');
        } else {
          const results = fuzzy.searchWithHighlight(process.cwd(), query, { maxResults: 20 });
          if (results.length === 0) {
            addMessage('system', 'No files found');
          } else {
            const list = results.map((r, i) => `${i + 1}. ${r.highlighted}`).join('\n');
            addMessage('system', `Found ${results.length} files:\n\n${list}`);
          }
        }
        break;
      }

      case '/branch': {
        const branching = await import('./branching.js');
        const subCmd = parts[1];
        const sessionId = `session_${Date.now()}`;  // Would use actual session ID

        if (subCmd === 'list' || !subCmd) {
          const tree = branching.getBranchTree(sessionId);
          addMessage('system', `Branches:\n${tree}`);
        } else if (subCmd === 'new' && parts[2]) {
          const branch = branching.createBranch(sessionId, parts[2], llmMessages.current, parts.slice(3).join(' '));
          addMessage('system', `Created branch: ${branch.name}`);
        } else if (subCmd === 'switch' && parts[2]) {
          const msgs = branching.switchBranch(sessionId, parts[2], llmMessages.current);
          if (msgs) {
            llmMessages.current = msgs;
            addMessage('system', `Switched to branch: ${parts[2]}`);
          } else {
            addMessage('error', 'Branch not found');
          }
        } else if (subCmd === 'delete' && parts[2]) {
          if (branching.deleteBranch(sessionId, parts[2])) {
            addMessage('system', 'Branch deleted');
          } else {
            addMessage('error', 'Cannot delete branch');
          }
        } else {
          addMessage('system', 'Usage: /branch [list|new <name>|switch <name>|delete <name>]');
        }
        break;
      }

      case '/theme': {
        const themes = await import('./themes.js');
        const subCmd = parts[1];

        if (subCmd === 'list' || !subCmd) {
          const list = themes.listThemes();
          const current = themes.getCurrentThemeName();
          const formatted = list.map(t => {
            const marker = t.name === current ? ' *' : '';
            const custom = t.custom ? ' (custom)' : '';
            return `  ${t.name}${marker}${custom} - ${t.description || 'No description'}`;
          }).join('\n');
          addMessage('system', `Available themes:\n${formatted}`);
        } else if (themes.setCurrentTheme(subCmd)) {
          themes.clearThemeCache();
          addMessage('system', `Theme set to: ${subCmd}`);
        } else {
          addMessage('error', `Theme not found: ${subCmd}`);
        }
        break;
      }

      case '/hooks': {
        const hooks = await import('./hooks.js');
        const subCmd = parts[1];

        if (subCmd === 'list' || !subCmd) {
          addMessage('system', hooks.listHooksFormatted());
        } else if (subCmd === 'add' && parts[2]) {
          const event = parts[2] as import('./hooks.js').HookEvent;
          const command = parts.slice(3).join(' ');
          if (!command) {
            addMessage('system', 'Usage: /hooks add <event> <command>');
          } else {
            hooks.addHook({ event, name: `Hook for ${event}`, command, enabled: true, async: false });
            addMessage('system', 'Hook added');
          }
        } else if (subCmd === 'init') {
          hooks.initDefaultHooks();
          addMessage('system', 'Default hooks initialized');
        } else {
          addMessage('system', 'Usage: /hooks [list|add <event> <command>|init]');
        }
        break;
      }

      case '/search': {
        const query = parts.slice(1).join(' ');
        if (!query) {
          addMessage('system', 'Usage: /search <query>\nSearch conversation history');
        } else {
          const lower = query.toLowerCase();
          const matches = messages.filter(m => m.content.toLowerCase().includes(lower));
          if (matches.length === 0) {
            addMessage('system', 'No matches found');
          } else {
            const results = matches.slice(-10).map(m => {
              const preview = m.content.slice(0, 100).replace(/\n/g, ' ');
              return `[${m.type}] ${preview}...`;
            }).join('\n\n');
            addMessage('system', `Found ${matches.length} matches:\n\n${results}`);
          }
        }
        break;
      }

      case '/project': {
        const projectConfig = await import('./project-config.js');
        const subCmd = parts[1];
        const cwd = process.cwd();

        if (subCmd === 'init') {
          const configPath = projectConfig.createProjectConfig(cwd);
          addMessage('system', `Created project config: ${configPath}\nEdit the file to customize settings.`);
        } else if (subCmd === 'show' || !subCmd) {
          const configPath = projectConfig.findProjectConfig(cwd);
          if (!configPath) {
            addMessage('system', 'No project config found.\nRun /project init to create one.');
          } else {
            const cfg = projectConfig.loadProjectConfig(configPath);
            if (cfg) {
              let info = `Config: ${configPath}\n\n`;
              if (cfg.project) info += `Project: ${cfg.project}\n`;
              if (cfg.provider) info += `Provider: ${cfg.provider}\n`;
              if (cfg.model) info += `Model: ${cfg.model}\n`;
              if (cfg.tech?.length) info += `Tech: ${cfg.tech.join(', ')}\n`;
              if (cfg.conventions?.length) info += `\nConventions:\n${cfg.conventions.map(c => `  - ${c}`).join('\n')}\n`;
              if (cfg.commands) info += `\nCommands: ${Object.keys(cfg.commands).join(', ')}\n`;
              addMessage('system', info);
            } else {
              addMessage('error', 'Failed to parse config');
            }
          }
        } else if (subCmd === 'run' && parts[2]) {
          const configPath = projectConfig.findProjectConfig(cwd);
          const cfg = configPath ? projectConfig.loadProjectConfig(configPath) : null;
          const cmdName = parts[2];
          if (cfg?.commands?.[cmdName]) {
            addMessage('system', `Running: ${cfg.commands[cmdName]}`);
            // Queue the command to run
            const { spawn } = await import('child_process');
            const proc = spawn('sh', ['-c', cfg.commands[cmdName]], { cwd, stdio: 'pipe' });
            let output = '';
            proc.stdout?.on('data', (d) => output += d.toString());
            proc.stderr?.on('data', (d) => output += d.toString());
            proc.on('close', (code) => {
              addMessage('system', `Exit ${code}\n${output}`);
            });
          } else {
            addMessage('error', `Command not found: ${cmdName}`);
          }
        } else {
          addMessage('system', 'Usage: /project [init|show|run <cmd>]');
        }
        break;
      }

      case '/route':
      case '/autoroute': {
        if (parts[1] === 'on') {
          setAutoRoute(true);
          addMessage('system', '✓ Auto-routing ON - model selected based on task complexity');
        } else if (parts[1] === 'off') {
          setAutoRoute(false);
          addMessage('system', '✓ Auto-routing OFF - using fixed model');
        } else if (parts[1] === 'test' && parts[2]) {
          const testMsg = parts.slice(2).join(' ');
          const decision = modelRouter.routeRequest(testMsg, actualProvider);
          addMessage('system', `Route test: ${decision.tier} tier (${decision.complexity})\nModel: ${decision.model.model}\nReason: ${decision.reason}\nConfidence: ${Math.round(decision.confidence * 100)}%`);
        } else {
          const tiers = modelRouter.getAllTiers(actualProvider);
          addMessage('system', `Auto-route: ${autoRoute ? 'ON' : 'OFF'}\n\nModel tiers for ${actualProvider}:\n  fast: ${tiers.fast.model}\n  balanced: ${tiers.balanced.model}\n  smart: ${tiers.smart.model}\n\nUsage: /route [on|off|test <message>]`);
        }
        break;
      }

      case '/summarize': {
        const subCmd = parts[1];
        if (subCmd === 'context' || !subCmd) {
          const msgCount = llmMessages.current.length;
          if (msgCount < 5) {
            addMessage('system', 'Not enough messages to summarize.');
          } else {
            const summary = summarization.extractKeyInfo(llmMessages.current);
            let info = 'Context Summary:\n\n';
            if (summary.topics.length) info += `**Topics:** ${summary.topics.join(', ')}\n`;
            if (summary.decisions.length) info += `**Decisions:**\n${summary.decisions.map(d => `  - ${d}`).join('\n')}\n`;
            if (summary.actions.length) info += `**Actions:**\n${summary.actions.map(a => `  - ${a}`).join('\n')}\n`;
            if (summary.codeChanges.length) info += `**Code Changes:**\n${summary.codeChanges.slice(0, 5).map(c => `  - ${c}`).join('\n')}\n`;
            addMessage('system', info || 'No key information extracted.');
          }
        } else if (subCmd === 'compact') {
          // Summarize and compact the conversation
          const result = summarization.summarizeConversation(llmMessages.current, { maxTokens: 50000 });
          if (result.summarizedCount > 0) {
            llmMessages.current = result.messages;
            setContextTokens(estimateContextTokens());
            addMessage('system', `✓ Compacted ${result.summarizedCount} messages (${result.originalTokens} → ${result.reducedTokens} tokens)`);
          } else {
            addMessage('system', 'Context already within limits, no compaction needed.');
          }
        } else {
          addMessage('system', 'Usage: /summarize [context|compact]');
        }
        break;
      }

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

    // Auto-route to appropriate model based on task complexity
    let effectiveModel = model;
    if (autoRoute && typeof content === 'string') {
      const routeDecision = modelRouter.routeRequest(content, provider, {
        messageCount: stats.messageCount,
        hasCode: content.includes('```') || /\.(ts|js|py|go|rs|java)/.test(content),
      });
      effectiveModel = routeDecision.model.model;
      if (effectiveModel !== model) {
        addMessage('system', `[Auto-route: ${routeDecision.tier} tier - ${routeDecision.reason}]`);
      }
    }

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

        const response = await chat(provider, llmMessages.current, TOOLS, effectiveModel, onToken, onRetry);

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

            // Execute pre-tool hooks
            const preHookResult = await hooks.checkHooksAllow('pre-tool', {
              tool: toolCall.name,
              toolArgs: args,
            });
            if (!preHookResult.allowed) {
              addMessage('tool', `🛑 Blocked by hook: ${preHookResult.reason}`);
              llmMessages.current.push({
                role: 'tool',
                content: `[Blocked by hook: ${preHookResult.reason}]`,
                toolCallId: toolCall.id,
              });
              continue;
            }

            const result = await executeTool(toolCall, process.cwd());

            // Execute post-tool hooks
            hooks.executeHooks('post-tool', {
              tool: toolCall.name,
              toolArgs: args,
              toolResult: result.result,
            }).catch(() => {});

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

        // Auto-continue if response was truncated due to length
        if (response.finishReason === 'length') {
          addMessage('system', '(auto-continuing...)');
          llmMessages.current.push({ role: 'user', content: 'Please continue where you left off.' });
          continue; // Loop again to get continuation
        }
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
        onEscape={exit}
        onCycleMode={cycleMode}
        disabled={isModalActive || isProcessing}
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
