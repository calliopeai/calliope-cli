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
import { TOOLS, executeTool, getTools } from './tools.js';
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
import { executeParallel, analyzeDependencies, getParallelizationStats, canParallelize } from './parallel-tools.js';
import { addToScope, removeFromScope, getScopeSummary, getScopeDetails, resetScope } from './scope.js';
import { getAgentStatusReport } from './agterm/index.js';

// Module-level state for agterm mode
let moduleAgtermEnabled = false;

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
// Error Boundary
// ============================================================================

interface ErrorBoundaryProps {
  children: React.ReactNode;
  onReset?: () => void;
}

interface ErrorBoundaryState {
  hasError: boolean;
  error: Error | null;
  errorInfo: string;
}

class ErrorBoundary extends React.Component<ErrorBoundaryProps, ErrorBoundaryState> {
  constructor(props: ErrorBoundaryProps) {
    super(props);
    this.state = { hasError: false, error: null, errorInfo: '' };
  }

  static getDerivedStateFromError(error: Error): Partial<ErrorBoundaryState> {
    return { hasError: true, error };
  }

  componentDidCatch(error: Error, errorInfo: React.ErrorInfo): void {
    // Log error details
    const info = errorInfo.componentStack || '';
    this.setState({ errorInfo: info });
    
    // Could also log to file or external service
    console.error('Calliope Error:', error);
    console.error('Component Stack:', info);
  }

  handleRetry = (): void => {
    this.setState({ hasError: false, error: null, errorInfo: '' });
    this.props.onReset?.();
  };

  render(): React.ReactNode {
    if (this.state.hasError) {
      return <ErrorFallback 
        error={this.state.error} 
        errorInfo={this.state.errorInfo}
        onRetry={this.handleRetry}
      />;
    }
    return this.props.children;
  }
}

function ErrorFallback({ 
  error, 
  errorInfo,
  onRetry 
}: { 
  error: Error | null; 
  errorInfo: string;
  onRetry: () => void;
}) {
  const { exit } = useApp();

  useInput((input, key) => {
    if (input === 'r' || input === 'R') {
      onRetry();
    } else if (input === 'q' || input === 'Q' || key.escape) {
      exit();
    }
  });

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text color="red" bold>⚠️  Calliope encountered an error</Text>
      </Box>
      
      <Box flexDirection="column" marginBottom={1} borderStyle="round" borderColor="red" padding={1}>
        <Text color="red">{error?.message || 'Unknown error'}</Text>
        {error?.name && error.name !== 'Error' && (
          <Text dimColor>Type: {error.name}</Text>
        )}
      </Box>

      {errorInfo && (
        <Box flexDirection="column" marginBottom={1}>
          <Text dimColor>Component trace:</Text>
          <Text dimColor>{errorInfo.split('\n').slice(0, 5).join('\n')}</Text>
        </Box>
      )}

      <Box marginTop={1}>
        <Text>
          <Text color="cyan">[R]</Text>
          <Text>etry  </Text>
          <Text color="cyan">[Q]</Text>
          <Text>uit</Text>
        </Text>
      </Box>

      <Box marginTop={1}>
        <Text dimColor>If this persists, try: calliope --legacy</Text>
      </Box>
    </Box>
  );
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
  // AGTerm tools
  spawn_agent: '🤖',
  check_agent: '📋',
  list_agents: '📊',
  cancel_agent: '🛑',
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

      // Regular tool result with enhanced status detection
      const allLines = msg.content.split('\n');
      const lines = allLines.slice(0, 5);
      const totalLines = allLines.length;
      const hasMore = totalLines > 5;
      
      // Enhanced status detection
      const lowerContent = msg.content.toLowerCase();
      const hasError = lowerContent.includes('error') || 
                       lowerContent.includes('failed') ||
                       lowerContent.includes('permission denied') ||
                       lowerContent.includes('not found') ||
                       lowerContent.includes('exception');
      const hasWarning = lowerContent.includes('warning') || 
                         lowerContent.includes('deprecated') ||
                         lowerContent.includes('caution');
      
      // Determine status icon and color
      let statusIcon = '✓';
      let statusColor: 'green' | 'red' | 'yellow' = 'green';
      if (hasError) {
        statusIcon = '✗';
        statusColor = 'red';
      } else if (hasWarning) {
        statusIcon = '⚠';
        statusColor = 'yellow';
      }
      
      return (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i}><Text dimColor>│</Text>  <Text dimColor>{line.substring(0, 100)}</Text></Text>
          ))}
          {hasMore && <Text><Text dimColor>│</Text>  <Text dimColor>... ({totalLines - 5} more lines)</Text></Text>}
          <Text><Text dimColor>╰─</Text> <Text color={statusColor}>{statusIcon}</Text></Text>
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

function SessionResumePrompt({
  session,
  onResume,
  onNew,
}: {
  session: { projectName: string; lastAccessedAt: string; messageCount: number };
  onResume: () => void;
  onNew: () => void;
}) {
  useInput((input, key) => {
    if (input === 'r' || input === 'R') onResume();
    else if (input === 'n' || input === 'N' || key.escape) onNew();
  });

  const timeAgo = (() => {
    const diff = Date.now() - new Date(session.lastAccessedAt).getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    const minutes = Math.floor(diff / (1000 * 60));
    return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  })();

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>📂 Previous Session Found</Text>
      <Text> </Text>
      <Text>Project: <Text color="yellow">{session.projectName}</Text></Text>
      <Text>Last active: <Text dimColor>{timeAgo}</Text></Text>
      <Text>Messages: <Text dimColor>{session.messageCount}</Text></Text>
      <Text> </Text>
      <Text><Text color="cyan">[R]</Text>esume session  <Text color="cyan">[N]</Text>ew session</Text>
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
  isProcessing,
  queuedCount,
  onQueueMessage,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onEscape: () => void;
  onCycleMode: () => void;
  disabled: boolean;
  isProcessing?: boolean;
  queuedCount?: number;
  onQueueMessage?: (msg: string) => void;
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

    // When fully disabled (modal), ignore all input
    if (disabled) return;

    // When processing, queue messages instead of submitting directly
    if (isProcessing) {
      // Allow typing
      if (key.backspace || key.delete) {
        onChange(value.slice(0, -1));
        return;
      }
      if (key.ctrl && input === 'u') {
        onChange('');
        return;
      }
      // Enter queues the message
      if (key.return && value.trim() && onQueueMessage) {
        onQueueMessage(value.trim());
        onChange('');
        return;
      }
      // Regular input
      if (input && !key.ctrl && !key.meta && !key.tab) {
        onChange(value + input);
      }
      return;
    }

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

  // Determine prompt style based on state
  const promptColor = disabled ? 'gray' : isProcessing ? 'yellow' : 'cyan';
  const promptText = isProcessing ? 'queue>' : 'calliope>';
  
  return (
    <Box flexDirection="column">
      <Separator />
      {/* Queue indicator */}
      {queuedCount && queuedCount > 0 && (
        <Box>
          <Text color="yellow">📨 {queuedCount} message{queuedCount > 1 ? 's' : ''} queued (will be sent after current task)</Text>
        </Box>
      )}
      <Box>
        <Text color={promptColor}>{promptText} </Text>
        <Text>{value}</Text>
        <Text color={promptColor}>▌</Text>
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
  const [modalMode, setModalMode] = useState<'none' | 'model' | 'upgrade' | 'confirm' | 'session-resume'>('none');
  const [previousSession, setPreviousSession] = useState<{ projectName: string; lastAccessedAt: string; messageCount: number } | null>(null);
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

  // Message queue for human-in-the-loop feedback during processing
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const [queueInput, setQueueInput] = useState('');

  // Undo/Redo history - stores snapshots of conversation state
  interface ConversationSnapshot {
    messages: UIMessage[];
    llmMessages: LLMMessage[];
    timestamp: Date;
  }
  const undoStack = useRef<ConversationSnapshot[]>([]);
  const redoStack = useRef<ConversationSnapshot[]>([]);
  const MAX_UNDO_HISTORY = 10;

  // Conversation bookmarks
  interface Bookmark {
    id: string;
    name: string;
    messageIndex: number;
    llmMessageIndex: number;
    timestamp: Date;
  }
  const [bookmarks, setBookmarks] = useState<Bookmark[]>([]);

  // Prompt templates
  interface PromptTemplate {
    name: string;
    prompt: string;
    createdAt: Date;
  }
  const [templates, setTemplates] = useState<PromptTemplate[]>([]);

  // Save state before changes (call before modifying messages)
  const saveUndoState = useCallback(() => {
    undoStack.current.push({
      messages: [...messages],
      llmMessages: [...llmMessages.current],
      timestamp: new Date(),
    });
    // Limit stack size
    if (undoStack.current.length > MAX_UNDO_HISTORY) {
      undoStack.current.shift();
    }
    // Clear redo stack on new action
    redoStack.current = [];
  }, [messages]);

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

  // Ralph Wiggum loop state
  const [loopActive, setLoopActive] = useState(false);
  const [loopPrompt, setLoopPrompt] = useState<string>('');
  const [loopMaxIterations, setLoopMaxIterations] = useState(100);
  const [loopCompletionPromise, setLoopCompletionPromise] = useState<string | undefined>();
  const [loopIteration, setLoopIteration] = useState(0);
  const loopCancelledRef = useRef(false);

  // Initialize session and load memory on mount
  useEffect(() => {
    const cwd = process.cwd();
    
    // Check for existing session with messages
    const existingSessions = storage.listSessions(5);
    const recentSession = existingSessions.find(s => 
      s.projectPath === cwd && 
      s.messageCount > 0 &&
      Date.now() - new Date(s.lastAccessedAt).getTime() < 24 * 60 * 60 * 1000 // Within 24 hours
    );
    
    if (recentSession && !sessionRef.current) {
      // Offer to resume
      setPreviousSession({
        projectName: recentSession.projectName,
        lastAccessedAt: recentSession.lastAccessedAt,
        messageCount: recentSession.messageCount,
      });
      setModalMode('session-resume');
    }
    
    const session = storage.getOrCreateSession(cwd);
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
  /undo                    - Undo last action (up to 10 steps)
  /redo                    - Redo undone action
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
  /agents                  - Show sub-agent status (--agterm mode)
  /scope [details|reset]   - Show/manage file access scope
  /add-dir <path>          - Add directory to allowed scope
  /remove-dir <path>       - Remove directory from scope
  /template [save|use|del] - Manage prompt templates
  /cost                    - Show cost tracking summary
  /bookmark [name]         - Create bookmark at current point
  /bookmark list           - List all bookmarks
  /bookmark goto <n>       - Jump to bookmark
  /queue [show|clear]      - Manage queued messages
  /resume [n]              - Resume previous session (load n messages)
  /exit                    - Exit

File references: @filename, ./path, /absolute/path
Modes: 📋 Plan | 🔄 Hybrid | 🔧 Work
Auto-route: ${autoRoute ? 'ON' : 'OFF'}${moduleAgtermEnabled ? '\nAGTerm: ON (spawn_agent, check_agent tools available)' : ''}`);
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
        if (undoStack.current.length === 0) {
          addMessage('system', 'Nothing to undo.');
          break;
        }
        
        // Save current state to redo stack
        redoStack.current.push({
          messages: [...messages],
          llmMessages: [...llmMessages.current],
          timestamp: new Date(),
        });
        
        // Restore previous state
        const prevState = undoStack.current.pop()!;
        setMessages(prevState.messages);
        llmMessages.current = prevState.llmMessages;
        setContextTokens(estimateContextTokens());
        
        addMessage('system', `✓ Undone (${undoStack.current.length} more available)`);
        break;
      }

      case '/redo': {
        if (redoStack.current.length === 0) {
          addMessage('system', 'Nothing to redo.');
          break;
        }
        
        // Save current state to undo stack
        undoStack.current.push({
          messages: [...messages],
          llmMessages: [...llmMessages.current],
          timestamp: new Date(),
        });
        
        // Restore redo state
        const redoState = redoStack.current.pop()!;
        setMessages(redoState.messages);
        llmMessages.current = redoState.llmMessages;
        setContextTokens(estimateContextTokens());
        
        addMessage('system', `✓ Redone (${redoStack.current.length} more available)`);
        break;
      }

      case '/status':
      case '/s':
        addMessage('system', `${actualProvider}:${actualModel} | ${stats.messageCount} msgs | ${stats.inputTokens + stats.outputTokens} tokens`);
        break;

      case '/config':
        addMessage('system', `Config: ${config.getConfigPath()}\nProviders: ${config.getConfiguredProviders().join(', ') || 'none'}\nmaxIterations: ${config.get('maxIterations')}`);
        break;

      case '/agents':
        if (!moduleAgtermEnabled) {
          addMessage('system', 'AGTerm mode not enabled. Start with --agterm flag to unlock multi-agent features.');
        } else {
          addMessage('system', getAgentStatusReport());
        }
        break;

      case '/set': {
        // /set <key> <value>
        const key = parts[1];
        const value = parts.slice(2).join(' ');
        if (!key || !value) {
          addMessage('system', `Usage: /set <key> <value>
Available keys:
  maxIterations <number>  - Max agent iterations (current: ${config.get('maxIterations')})
  persona <name>          - calliope, professional, minimal
  fancyOutput <bool>      - true/false`);
          break;
        }

        try {
          if (key === 'maxIterations') {
            const num = parseInt(value, 10);
            if (isNaN(num) || num < 1 || num > 10000) {
              addMessage('error', 'maxIterations must be 1-10000');
              break;
            }
            config.set('maxIterations', num);
            addMessage('system', `✓ maxIterations set to ${num}`);
          } else if (key === 'persona') {
            if (!['calliope', 'professional', 'minimal'].includes(value)) {
              addMessage('error', 'persona must be: calliope, professional, or minimal');
              break;
            }
            config.set('persona', value as 'calliope' | 'professional' | 'minimal');
            setPersona(value as AgentPersona);
            addMessage('system', `✓ persona set to ${value}`);
          } else if (key === 'fancyOutput') {
            const bool = value === 'true';
            config.set('fancyOutput', bool);
            addMessage('system', `✓ fancyOutput set to ${bool}`);
          } else {
            addMessage('error', `Unknown config key: ${key}`);
          }
        } catch (err) {
          addMessage('error', `Failed to set ${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
        break;
      }

      case '/setup':
        addMessage('system', 'Run `calliope --setup` to reconfigure.');
        break;

      case '/loop': {
        // Parse /loop "<prompt>" [--max-iterations N] [--completion-promise "text"]
        const loopArgs = parts.slice(1).join(' ');
        const maxIterMatch = loopArgs.match(/--max-iterations\s+(\d+)/);
        const completionMatch = loopArgs.match(/--completion-promise\s+"([^"]+)"/);

        let prompt = loopArgs
          .replace(/--max-iterations\s+\d+/, '')
          .replace(/--completion-promise\s+"[^"]+"/, '')
          .trim();

        // Handle quoted prompt
        const quotedMatch = prompt.match(/^"([^"]+)"$/);
        if (quotedMatch) prompt = quotedMatch[1];

        if (!prompt) {
          addMessage('system', `Usage: /loop "<prompt>" [--max-iterations N] [--completion-promise "text"]
Example: /loop "Build a REST API" --max-iterations 50 --completion-promise "DONE"`);
          break;
        }

        // Start the loop
        setLoopActive(true);
        setLoopPrompt(prompt);
        setLoopMaxIterations(maxIterMatch ? parseInt(maxIterMatch[1], 10) : 100);
        setLoopCompletionPromise(completionMatch ? completionMatch[1] : undefined);
        setLoopIteration(0);
        loopCancelledRef.current = false;

        addMessage('system', `🔄 Ralph Wiggum Loop Started
  Prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"
  Max iterations: ${maxIterMatch ? maxIterMatch[1] : '100'}
  ${completionMatch ? `Completion promise: "${completionMatch[1]}"` : 'No completion promise (runs until max iterations)'}
  Use /cancel-loop to stop`);

        // Start the loop execution (non-blocking)
        runLoop(prompt, maxIterMatch ? parseInt(maxIterMatch[1], 10) : 100, completionMatch?.[1]);
        break;
      }

      case '/cancel-loop':
      case '/stop':
        if (loopActive) {
          loopCancelledRef.current = true;
          setLoopActive(false);
          addMessage('system', '🛑 Loop cancelled');
        } else {
          addMessage('system', 'No active loop to cancel');
        }
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

      case '/scope':
      case '/dirs': {
        const subCmd = parts[1];
        if (subCmd === 'details' || subCmd === 'full') {
          addMessage('system', getScopeDetails());
        } else if (subCmd === 'reset') {
          resetScope(process.cwd());
          addMessage('system', '✓ Scope reset to current directory only');
        } else {
          addMessage('system', getScopeSummary());
        }
        break;
      }

      case '/add-dir': {
        const dirPath = parts.slice(1).join(' ').replace(/^["']|["']$/g, '');
        if (!dirPath) {
          addMessage('system', 'Usage: /add-dir <path>\n\nAdd a directory to the allowed scope.\nThe agent can only access files within scope.');
        } else {
          const result = addToScope(dirPath);
          if (result.success) {
            addMessage('system', `✓ ${result.message}`);
          } else {
            addMessage('error', result.message);
          }
        }
        break;
      }

      case '/remove-dir': {
        const dirPath = parts.slice(1).join(' ').replace(/^["']|["']$/g, '');
        if (!dirPath) {
          addMessage('system', 'Usage: /remove-dir <path>\n\nRemove a directory from the allowed scope.');
        } else {
          const result = removeFromScope(dirPath);
          if (result.success) {
            addMessage('system', `✓ ${result.message}`);
          } else {
            addMessage('error', result.message);
          }
        }
        break;
      }

      case '/template':
      case '/t': {
        const subCmd = parts[1];
        if (subCmd === 'list' || !subCmd) {
          if (templates.length === 0) {
            addMessage('system', 'No templates saved.\n\nUsage:\n  /template save <name> <prompt>\n  /template use <name>\n  /template delete <name>');
          } else {
            const list = templates.map((t, i) => 
              `  ${i + 1}. ${t.name}: "${t.prompt.substring(0, 50)}${t.prompt.length > 50 ? '...' : ''}"`
            ).join('\n');
            addMessage('system', `Templates:\n${list}`);
          }
        } else if (subCmd === 'save' && parts[2]) {
          const name = parts[2];
          const prompt = parts.slice(3).join(' ').replace(/^["']|["']$/g, '');
          if (!prompt) {
            addMessage('error', 'Usage: /template save <name> "<prompt>"');
          } else {
            setTemplates(prev => {
              const filtered = prev.filter(t => t.name !== name);
              return [...filtered, { name, prompt, createdAt: new Date() }];
            });
            addMessage('system', `✓ Template saved: ${name}`);
          }
        } else if (subCmd === 'use' && parts[2]) {
          const name = parts[2];
          const template = templates.find(t => t.name === name);
          if (template) {
            setInput(template.prompt);
            addMessage('system', `✓ Template loaded: ${name} (press Enter to send)`);
          } else {
            addMessage('error', `Template not found: ${name}`);
          }
        } else if (subCmd === 'delete' && parts[2]) {
          const name = parts[2];
          const found = templates.find(t => t.name === name);
          if (found) {
            setTemplates(prev => prev.filter(t => t.name !== name));
            addMessage('system', `✓ Template deleted: ${name}`);
          } else {
            addMessage('error', `Template not found: ${name}`);
          }
        } else {
          addMessage('system', 'Usage: /template [list|save <name> <prompt>|use <name>|delete <name>]');
        }
        break;
      }

      case '/cost':
      case '/costs': {
        const subCmd = parts[1];
        if (subCmd === 'reset') {
          storage.resetCosts();
          addMessage('system', '✓ Cost tracking reset');
        } else {
          addMessage('system', storage.getCostSummary());
        }
        break;
      }

      case '/bookmark':
      case '/bm': {
        const subCmd = parts[1];
        if (!subCmd || subCmd === 'list') {
          // List bookmarks
          if (bookmarks.length === 0) {
            addMessage('system', 'No bookmarks. Use /bookmark "name" to create one.');
          } else {
            const list = bookmarks.map((b, i) => 
              `  ${i + 1}. 🔖 ${b.name} (message #${b.messageIndex})`
            ).join('\n');
            addMessage('system', `Bookmarks:\n${list}\n\nUse /bookmark goto <number> to jump.`);
          }
        } else if (subCmd === 'goto' && parts[2]) {
          const idx = parseInt(parts[2]) - 1;
          if (idx >= 0 && idx < bookmarks.length) {
            const bm = bookmarks[idx];
            // Save current state for undo
            saveUndoState();
            // Restore to bookmark point
            setMessages(messages.slice(0, bm.messageIndex + 1));
            llmMessages.current = llmMessages.current.slice(0, bm.llmMessageIndex + 1);
            setContextTokens(estimateContextTokens());
            addMessage('system', `✓ Jumped to bookmark: ${bm.name}`);
          } else {
            addMessage('error', `Invalid bookmark number. Use /bookmark list to see available.`);
          }
        } else if (subCmd === 'delete' && parts[2]) {
          const idx = parseInt(parts[2]) - 1;
          if (idx >= 0 && idx < bookmarks.length) {
            const removed = bookmarks[idx];
            setBookmarks(prev => prev.filter((_, i) => i !== idx));
            addMessage('system', `✓ Deleted bookmark: ${removed.name}`);
          } else {
            addMessage('error', 'Invalid bookmark number.');
          }
        } else {
          // Create bookmark with given name
          const name = parts.slice(1).join(' ').replace(/^["']|["']$/g, '');
          const bm: Bookmark = {
            id: `bm_${Date.now()}`,
            name,
            messageIndex: messages.length - 1,
            llmMessageIndex: llmMessages.current.length - 1,
            timestamp: new Date(),
          };
          setBookmarks(prev => [...prev, bm]);
          addMessage('system', `🔖 Bookmark created: "${name}"`);
        }
        break;
      }

      case '/queue':
      case '/q': {
        // /q is now queue, use /exit to quit
        if (command === '/q' && !parts[1]) {
          // Just /q with no args shows queue
          if (queuedMessages.length === 0) {
            addMessage('system', 'No messages queued. Type while agent is processing to queue feedback.');
          } else {
            const list = queuedMessages.map((m, i) => `  ${i + 1}. ${m.substring(0, 60)}${m.length > 60 ? '...' : ''}`).join('\n');
            addMessage('system', `📨 Queued messages (${queuedMessages.length}):\n${list}\n\nUse /queue clear to remove all.`);
          }
          break;
        }
        const subCmd = parts[1];
        if (subCmd === 'clear') {
          const count = queuedMessages.length;
          setQueuedMessages([]);
          addMessage('system', `✓ Cleared ${count} queued message${count !== 1 ? 's' : ''}`);
        } else if (subCmd === 'show' || !subCmd) {
          if (queuedMessages.length === 0) {
            addMessage('system', 'No messages queued.');
          } else {
            const list = queuedMessages.map((m, i) => `  ${i + 1}. ${m}`).join('\n');
            addMessage('system', `📨 Queued messages:\n${list}`);
          }
        } else {
          addMessage('system', 'Usage: /queue [show|clear]\n\nTip: Type while agent is processing to queue follow-up messages.');
        }
        break;
      }

      case '/resume': {
        // Resume previous session manually
        const history = storage.getChatHistory(parseInt(parts[1]) || 20);
        if (history.length === 0) {
          addMessage('system', 'No previous messages to resume.');
        } else {
          for (const msg of history) {
            if (msg.role === 'user' || msg.role === 'assistant') {
              llmMessages.current.push({
                role: msg.role,
                content: msg.content,
              });
            }
          }
          addMessage('system', `✓ Loaded ${history.length} messages from previous session`);
          setContextTokens(estimateContextTokens());
        }
        break;
      }

      case '/exit':
      case '/quit':
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
    let completedNaturally = false;

    // Check context limit and warn if approaching capacity
    const currentContextTokens = estimateContextTokens();
    const modelLimit = getContextLimit(effectiveModel || actualModel);
    const contextPercentage = (currentContextTokens / modelLimit) * 100;
    
    if (contextPercentage > 90) {
      addMessage('system', `🔴 Context at ${Math.round(contextPercentage)}% capacity (${Math.round(currentContextTokens/1000)}K/${Math.round(modelLimit/1000)}K tokens)
   Consider: /summarize compact | /clear | shorter messages`);
    } else if (contextPercentage > 80) {
      addMessage('system', `⚠️  Context at ${Math.round(contextPercentage)}% capacity - consider /summarize compact soon`);
    }

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

        const response = await chat(provider, llmMessages.current, getTools(moduleAgtermEnabled), effectiveModel, onToken, onRetry);

        // Update token stats and cost
        if (response.usage) {
          const usageCost = calculateCost(model || DEFAULT_MODELS[provider], response.usage.inputTokens, response.usage.outputTokens);
          setStats(s => ({
            ...s,
            inputTokens: s.inputTokens + response.usage!.inputTokens,
            outputTokens: s.outputTokens + response.usage!.outputTokens,
            cost: s.cost + usageCost,
          }));
          // Persist cost to storage
          storage.recordCost(usageCost, actualProvider, sessionRef.current?.id);
        }

        // Handle tool calls with parallel execution support
        if (response.toolCalls?.length) {
          llmMessages.current.push({
            role: 'assistant',
            content: response.content,
            toolCalls: response.toolCalls,
          });

          // ============================================================
          // Phase 1: Pre-check all tools, categorize into blocked vs executable
          // ============================================================
          interface ToolPreCheck {
            toolCall: ToolCall;
            args: Record<string, unknown>;
            preview: string;
            risk: ReturnType<typeof assessToolRisk>;
            riskDisplay: string;
            blocked: boolean;
            blockReason?: string;
            blockContent?: string;
          }
          
          const preChecks: ToolPreCheck[] = [];
          const executableTools: ToolCall[] = [];
          
          for (const toolCall of response.toolCalls) {
            const args = toolCall.arguments as Record<string, unknown>;
            const toolPreview = String(args.command || args.path || '...');
            const risk = assessToolRisk(toolCall);
            const riskConfig = RISK_CONFIG[risk.level];
            const riskDisplay = risk.level !== 'none' ? ` [${riskConfig.bar}]` : '';
            
            const preCheck: ToolPreCheck = {
              toolCall,
              args,
              preview: toolPreview,
              risk,
              riskDisplay,
              blocked: false,
            };
            
            // Check blocking conditions
            if (mode === 'plan' && toolCall.name !== 'think') {
              preCheck.blocked = true;
              preCheck.blockReason = 'plan mode';
              preCheck.blockContent = '[Plan mode: Tool not executed. Describe what this would do.]';
              addMessage('tool', `📋 ${toolCall.name}: ${toolPreview}${riskDisplay} (plan mode - not executed)`);
            } else if (confirmMode && requiresConfirmation(risk, false) && toolCall.name !== 'think') {
              preCheck.blocked = true;
              preCheck.blockReason = 'confirmation required';
              preCheck.blockContent = `[Operation blocked - ${risk.level} risk: ${risk.reason}. User confirmation required.]`;
              const riskIcon = risk.level === 'critical' ? '🛑' : '⚠️';
              addMessage('tool', `${riskIcon} ${toolCall.name}: ${toolPreview}${riskDisplay}\n  → Requires confirmation (use /confirm off to disable)`);
            } else {
              // Check pre-tool hooks
              const preHookResult = await hooks.checkHooksAllow('pre-tool', {
                tool: toolCall.name,
                toolArgs: args,
              });
              if (!preHookResult.allowed) {
                preCheck.blocked = true;
                preCheck.blockReason = 'blocked by hook';
                preCheck.blockContent = `[Blocked by hook: ${preHookResult.reason}]`;
                addMessage('tool', `⚡ ${toolCall.name}: ${toolPreview}${riskDisplay}`);
                addMessage('tool', `🛑 Blocked by hook: ${preHookResult.reason}`);
              } else {
                // Tool can be executed
                executableTools.push(toolCall);
                addMessage('tool', `⚡ ${toolCall.name}: ${toolPreview}${riskDisplay}`);
              }
            }
            
            preChecks.push(preCheck);
            
            // Add blocked tool results to LLM messages
            if (preCheck.blocked) {
              llmMessages.current.push({
                role: 'tool',
                content: preCheck.blockContent!,
                toolCallId: toolCall.id,
              });
            }
          }
          
          // ============================================================
          // Phase 2: Execute tools (parallel when beneficial)
          // ============================================================
          if (executableTools.length > 0) {
            const parallelStats = getParallelizationStats(executableTools);
            const useParallel = parallelStats.maxParallel > 1 && executableTools.length > 1;
            
            if (useParallel) {
              // Show parallelization info
              setThinkingState({
                status: `Executing ${executableTools.length} tools in parallel...`,
                detail: `${parallelStats.stages} stages, up to ${parallelStats.maxParallel}x speedup`,
                iteration: i + 1,
                maxIterations,
              });
              
              // Execute in parallel using dependency-aware staging
              const results = await executeParallel(
                executableTools,
                async (call) => {
                  const result = await executeTool(call, process.cwd());
                  return result.result;
                },
                (completed, total, current) => {
                  setThinkingState({
                    status: `Executing tools... (${completed + 1}/${total})`,
                    detail: current.name,
                    iteration: i + 1,
                    maxIterations,
                  });
                }
              );
              
              // Process results sequentially for UI and LLM messages
              for (const result of results) {
                const toolCall = result.toolCall;
                const args = toolCall.arguments as Record<string, unknown>;
                
                // Execute post-tool hooks
                hooks.executeHooks('post-tool', {
                  tool: toolCall.name,
                  toolArgs: args,
                  toolResult: result.result,
                }).catch(() => {});
                
                // Display result
                if (toolCall.name === 'think') {
                  const thought = String(args.thought || '');
                  addMessage('tool', thought);
                } else if (result.error) {
                  addMessage('tool', `Error: ${result.error}`);
                } else {
                  const preview = result.result.split('\n').slice(0, 3).join('\n');
                  addMessage('tool', preview + (result.result.split('\n').length > 3 ? '\n...' : ''));
                }
                
                llmMessages.current.push({
                  role: 'tool',
                  content: result.error ? `Error: ${result.error}` : result.result,
                  toolCallId: toolCall.id,
                });
              }
            } else {
              // Sequential execution (single tool or dependencies prevent parallelization)
              for (const toolCall of executableTools) {
                const args = toolCall.arguments as Record<string, unknown>;
                const toolPreview = String(args.command || args.path || '...');
                
                // Special handling for think tool UI
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
                
                const result = await executeTool(toolCall, process.cwd());
                
                // Execute post-tool hooks
                hooks.executeHooks('post-tool', {
                  tool: toolCall.name,
                  toolArgs: args,
                  toolResult: result.result,
                }).catch(() => {});
                
                // Display result
                if (toolCall.name === 'think') {
                  const thought = String(args.thought || '');
                  addMessage('tool', thought);
                } else {
                  const preview = result.result.split('\n').slice(0, 3).join('\n');
                  addMessage('tool', preview + (result.result.split('\n').length > 3 ? '\n...' : ''));
                }
                
                llmMessages.current.push({
                  role: 'tool',
                  content: result.result,
                  toolCallId: toolCall.id,
                });
              }
            }
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
        completedNaturally = true;
        break;

      } catch (error) {
        setThinkingState(null);
        setStreamingResponse('');
        addMessage('error', formatError(error));
        break;
      }
    }

    // Only show warning if we hit the limit without completing naturally
    if (!completedNaturally) {
      addMessage('system', `⚠️ Reached ${maxIterations} iterations limit. Task may be incomplete. Adjust with /config.`);
    }

    // Update context tokens after agent run
    setContextTokens(estimateContextTokens());

    // Process any queued messages (human-in-the-loop feedback)
    if (queuedMessages.length > 0) {
      const queued = [...queuedMessages];
      setQueuedMessages([]); // Clear the queue
      
      // Combine queued messages into a single follow-up
      const followUp = queued.length === 1 
        ? queued[0]
        : `[Multiple follow-up messages from user:]\n${queued.map((m, i) => `${i + 1}. ${m}`).join('\n')}`;
      
      addMessage('system', `📨 Processing ${queued.length} queued message${queued.length > 1 ? 's' : ''}...`);
      
      // Recursively run agent with follow-up
      // Use setTimeout to avoid stack overflow and allow UI to update
      setTimeout(() => {
        runAgent(followUp);
      }, 100);
    }
  }, [provider, model, addMessage, mode, estimateContextTokens, queuedMessages]);

  // Ralph Wiggum loop - runs prompt repeatedly until completion promise or max iterations
  const runLoop = useCallback(async (prompt: string, maxIter: number, completionPromise?: string) => {
    setIsProcessing(true);

    for (let i = 0; i < maxIter; i++) {
      // Check if cancelled
      if (loopCancelledRef.current) {
        addMessage('system', '🛑 Loop cancelled by user');
        break;
      }

      setLoopIteration(i + 1);
      addMessage('system', `🔄 Loop iteration ${i + 1}/${maxIter}`);

      // Add the loop prompt as user message
      llmMessages.current.push({ role: 'user', content: prompt });

      try {
        // Run the agent
        await runAgent(prompt);

        // Check for completion promise in the last assistant message
        if (completionPromise) {
          const lastMessage = llmMessages.current[llmMessages.current.length - 1];
          if (lastMessage?.role === 'assistant') {
            const content = typeof lastMessage.content === 'string'
              ? lastMessage.content
              : JSON.stringify(lastMessage.content);
            if (content.includes(completionPromise)) {
              addMessage('system', `🎉 Completion promise "${completionPromise}" detected! Loop finished.`);
              break;
            }
          }
        }

        // Check cancelled again after agent run
        if (loopCancelledRef.current) {
          addMessage('system', '🛑 Loop cancelled by user');
          break;
        }

        // Small delay between iterations
        await new Promise(r => setTimeout(r, 500));

      } catch (error) {
        addMessage('error', `Loop error: ${error instanceof Error ? error.message : String(error)}`);
        break;
      }
    }

    // If we completed all iterations without hitting completion promise
    if (!loopCancelledRef.current && !completionPromise) {
      addMessage('system', `✅ Loop completed ${maxIter} iterations`);
    }

    setLoopActive(false);
    setIsProcessing(false);
  }, [runAgent, addMessage]);

  // Handle input submission
  const handleSubmit = useCallback(async (value: string) => {
    const trimmed = value.trim();
    if (!trimmed || isProcessing) return;

    setInput('');

    if (trimmed.startsWith('/')) {
      await handleCommand(trimmed);
      return;
    }

    // Save state for undo before modifying conversation
    saveUndoState();

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
  }, [isProcessing, handleCommand, runAgent, addMessage, provider, model, saveUndoState]);

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

      {/* Modal: Session Resume */}
      {modalMode === 'session-resume' && previousSession && (
        <SessionResumePrompt
          session={previousSession}
          onResume={() => {
            // Load chat history into context
            const history = storage.getChatHistory(20);
            if (history.length > 0) {
              for (const msg of history) {
                if (msg.role === 'user' || msg.role === 'assistant') {
                  llmMessages.current.push({
                    role: msg.role,
                    content: msg.content,
                  });
                }
              }
              addMessage('system', `✓ Resumed session with ${history.length} messages loaded`);
              setContextTokens(estimateContextTokens());
            }
            setModalMode('none');
            setPreviousSession(null);
          }}
          onNew={() => {
            addMessage('system', '✓ Starting fresh session');
            setModalMode('none');
            setPreviousSession(null);
          }}
        />
      )}

      {/* Chat Input */}
      <ChatInput
        value={input}
        onChange={setInput}
        onSubmit={handleSubmit}
        onEscape={exit}
        onCycleMode={cycleMode}
        disabled={isModalActive}
        isProcessing={isProcessing}
        queuedCount={queuedMessages.length}
        onQueueMessage={(msg) => {
          setQueuedMessages(prev => [...prev, msg]);
          addMessage('system', `📨 Queued: "${msg.substring(0, 50)}${msg.length > 50 ? '...' : ''}"`);
        }}
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
  const [resetKey, setResetKey] = React.useState(0);
  
  const handleReset = React.useCallback(() => {
    setResetKey(k => k + 1);
  }, []);

  return (
    <ErrorBoundary onReset={handleReset}>
      <TerminalChat key={resetKey} />
    </ErrorBoundary>
  );
}


// Print banner before Ink takes over (stays fixed at top)
function printBanner(): void {
  const provider = selectProvider(config.get('defaultProvider'));
  const model = config.get('defaultModel') || DEFAULT_MODELS[provider];

  const cyan = '\x1b[36m';
  const cyanBright = '\x1b[96m';
  const dim = '\x1b[2m';
  const reset = '\x1b[0m';

  console.log();
  console.log(`${cyanBright}${BANNER_LINES[0]}${reset}`);
  console.log(`${cyanBright}${BANNER_LINES[1]}${reset}`);
  console.log(`${cyan}${BANNER_LINES[2]}${reset}`);
  console.log(`${cyan}${BANNER_LINES[3]}${reset}`);
  console.log(`${cyanBright}${BANNER_LINES[4]}${reset}`);
  console.log(`${cyan}${BANNER_LINES[5]}${reset}`);
  console.log();
  console.log(`${dim}        The Muse of Digital Eloquence${reset}`);
  console.log();
  console.log(`${dim}  v${getVersion()} | ${provider}:${model}${reset}`);
  console.log(`${dim}  /help for commands | ESC to exit${reset}`);
  console.log();
}

export async function startInkCLI(options: { skipPermissions?: boolean; agtermEnabled?: boolean } = {}): Promise<void> {
  // Set module-level agterm state
  moduleAgtermEnabled = options.agtermEnabled ?? false;

  // Print banner BEFORE Ink starts - it stays fixed at the top
  printBanner();

  const { waitUntilExit } = render(<App />, {
    patchConsole: true,  // Prevent console.log during session from mixing with Ink
  });
  await waitUntilExit();
}
