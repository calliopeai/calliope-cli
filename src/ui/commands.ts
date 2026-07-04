/**
 * UI Module - Command Handler
 *
 * Handles all slash commands (/help, /mode, /provider, etc.)
 * Extracted from TerminalChat using a CommandContext state bag.
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import * as config from '../config.js';
import { selectProvider, getAvailableProviders } from '../providers/index.js';
import { getSystemPrompt, DEFAULT_MODELS, MODE_CONFIG } from '../types.js';
import { getVersion, getLatestVersion, performUpgrade } from '../version-check.js';
import { getAvailableModels } from '../model-detection.js';
import * as storage from '../storage.js';
import * as mcp from '../mcp.js';
import * as skills from '../skills.js';
import * as modelRouter from '../model-router.js';
import * as summarization from '../summarization.js';
import { addToScope, removeFromScope, getScopeSummary, getScopeDetails, resetScope } from '../scope.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import type { BreakerType } from '../circuit-breaker.js';
import { smartRoute, getDefaultSmartRoutingConfig, detectTaskType } from '../smart-router.js';
import type { SmartRoutingConfig } from '../smart-router.js';
import { scuttlebotClient } from '../scuttlebot/index.js';
import { getTerminalImageInfo, getImageModeLabel, renderAsciiArt, colorFg, renderTransition } from '../terminal-image.js';
import { getModelContextLimit } from '../model-detection.js';
import { resetContextWarnings } from './context.js';
import * as memory from '../memory.js';
import type { IterationLedger, LedgerRun } from '../iteration-ledger.js';
import {
  resolveIterationLimit,
  formatIterationLimit,
  isFiniteIterationLimit,
} from '../iteration-limit.js';
import type { Message as LLMMessage, LLMProvider, Mode, MessageContent, ToolCall } from '../types.js';
import type { ModelInfo } from '../model-detection.js';
import type { Session } from '../storage.js';
import type { UIMessage, SessionStats, CollapseSettings, ThinkingState, ConversationSnapshot, Bookmark, PromptTemplate, SessionInfo } from './types.js';

// ============================================================================
// CommandContext
// ============================================================================

export interface CommandContext {
  // Current state
  actualProvider: LLMProvider;
  actualModel: string;
  provider: LLMProvider;
  model: string | undefined;
  mode: Mode;
  confirmMode: boolean;
  autoRoute: boolean;
  layout: string;
  density: string;
  collapseSettings: CollapseSettings;
  messages: UIMessage[];
  stats: SessionStats;
  loopActive: boolean;
  isProcessing: boolean;
  thinkingState: ThinkingState | null;
  streamingResponse: string;
  queuedMessages: string[];
  bookmarks: Bookmark[];
  templates: PromptTemplate[];
  debugEnabled: boolean;
  modalMode: string;
  circuitBreaker?: CircuitBreaker;
  smartRouteActive: boolean;
  smartRoutingConfig?: SmartRoutingConfig;
  ledger?: IterationLedger;

  // State setters
  setProvider: (p: LLMProvider) => void;
  setModel: (m: string | undefined) => void;
  setMode: (m: Mode | ((prev: Mode) => Mode)) => void;
  setConfirmMode: (v: boolean) => void;
  setAutoRoute: (v: boolean) => void;
  setLayout: (l: string) => void;
  setDensity: (d: string) => void;
  setCollapseSettings: (fn: (prev: CollapseSettings) => CollapseSettings) => void;
  setMessages: (msgs: UIMessage[]) => void;
  setStats: (s: SessionStats) => void;
  setModalMode: (m: string) => void;
  setPendingComplexPrompt: (p: { prompt: MessageContent; complexity: { isComplex: boolean; reason?: string } } | null) => void;
  setAvailableModels: (m: ModelInfo[]) => void;
  setAvailableSessions: (s: SessionInfo[]) => void;
  setLatestVersion: (v: string | null) => void;
  setLoopActive: (v: boolean) => void;
  setLoopPrompt: (v: string) => void;
  setLoopMaxIterations: (v: number) => void;
  setLoopCompletionPromise: (v: string | undefined) => void;
  setLoopIteration: (v: number) => void;
  setIsProcessing: (v: boolean) => void;
  setThinkingState: (v: ThinkingState | null) => void;
  setStreamingResponse: (v: string) => void;
  setQueuedMessages: (fn: string[] | ((prev: string[]) => string[])) => void;
  setInput: (v: string) => void;
  setBookmarks: (fn: Bookmark[] | ((prev: Bookmark[]) => Bookmark[])) => void;
  setTemplates: (fn: PromptTemplate[] | ((prev: PromptTemplate[]) => PromptTemplate[])) => void;
  setContextTokens: (v: number) => void;
  setDebugEnabled: (v: boolean) => void;
  setSmartRouteActive: (v: boolean) => void;
  setBreakerHealth: (v: 'ok' | 'warning' | 'tripped') => void;

  // Refs
  llmMessages: React.MutableRefObject<LLMMessage[]>;
  undoStack: React.MutableRefObject<ConversationSnapshot[]>;
  redoStack: React.MutableRefObject<ConversationSnapshot[]>;
  loopCancelledRef: React.MutableRefObject<boolean>;
  sessionRef: React.MutableRefObject<Session | null>;

  // Callbacks
  addMessage: (type: UIMessage['type'], content: string) => void;
  estimateContextTokens: () => number;
  saveUndoState: () => void;
  runAgent: (content: MessageContent) => Promise<void>;
  runLoop: (prompt: string, maxIter: number, completionPromise?: string) => void;
  exit: () => void;
  startScuttlebotPolling: () => void;
  openProviderPicker?: () => void;
}

// Builds the full system prompt including memory context (project + global).
// dir should be the project directory for the active/resumed session.
function buildFullSystemPrompt(dir: string): string {
  const base = getSystemPrompt();
  const mem = memory.buildMemoryContext(dir);
  return mem.trim() ? base + '\n\n--- Project Context ---\n' + mem : base;
}

function getActiveProjectDir(ctx: Pick<CommandContext, 'sessionRef'>): string {
  return ctx.sessionRef.current?.projectPath ?? process.cwd();
}

function formatLedgerDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${(durationMs / 60_000).toFixed(1)}m`;
}

function formatSessionLogLimit(limit: number): string {
  return limit > 0 ? String(limit) : 'unlimited';
}

function formatLedgerRun(run: LedgerRun): string {
  const iterationCount = Math.max(0, (run.entryCountAtEnd ?? run.entryCountAtStart) - run.entryCountAtStart);
  const parts = [`${run.kind}`, `[${run.status}]`];

  if (iterationCount > 0) {
    parts.push(`${iterationCount} iteration${iterationCount === 1 ? '' : 's'}`);
  }
  if (run.maxIterations != null && Number.isFinite(run.maxIterations)) {
    parts.push(`max ${run.maxIterations}`);
  } else if (run.maxIterations === null) {
    parts.push('unlimited');
  }

  const prompt = run.prompt.length > 90 ? `${run.prompt.slice(0, 90)}...` : run.prompt;
  let line = `${parts.join(' ')} — ${prompt}`;
  if (run.errorSummary) {
    line += ` (${run.errorSummary})`;
  }
  return line;
}

function watchAsyncLedgerRun(
  ledger: IterationLedger | undefined,
  kind: 'swarm' | 'council' | 'workflow',
  prompt: string,
  getStatus: () => { status: string; error?: string } | undefined
): void {
  if (!ledger) return;

  const runId = ledger.startRun(kind, prompt);

  void (async () => {
    for (;;) {
      const current = getStatus();
      if (!current) {
        ledger.finishRun(runId, 'failed', { errorSummary: 'Run state no longer available' });
        return;
      }

      if (current.status === 'completed') {
        ledger.finishRun(runId, 'completed');
        return;
      }
      if (current.status === 'failed') {
        ledger.finishRun(runId, 'failed', { errorSummary: current.error });
        return;
      }
      if (current.status === 'cancelled') {
        ledger.finishRun(runId, 'cancelled', { errorSummary: current.error || 'Cancelled' });
        return;
      }

      await new Promise(resolve => setTimeout(resolve, 500));
    }
  })();
}

// ============================================================================
// handleCommand
// ============================================================================

export async function handleCommand(cmd: string, ctx: CommandContext): Promise<void> {
  const parts = cmd.split(/\s+/);
  const command = parts[0].toLowerCase();

  switch (command) {
    case '/help':
    case '/h':
      ctx.addMessage('system', `--- Model & Routing ---
  /provider [name]           - Switch AI provider (/p)
  /model [name]              - Switch model (/m)
  /models                    - List available models
  /mode [plan|hybrid|work]   - Switch modes (Shift+Tab to cycle)
  /route [on|off]            - Auto model routing (/autoroute)
  /smart [on|off|cost|test]  - Cross-provider smart routing
  /breaker [status|adjust]   - Circuit breaker control (/cb)

--- Conversation ---
  /edit                      - Edit and resend last message
  /undo / /redo              - Undo/redo (up to 10 steps)
  /copy                      - Copy last response to clipboard
  /export [file.md]          - Export conversation to markdown
  /clear                     - Clear conversation (/c)

--- Session & State ---
  /session [list|info|fork|save] - Session management (/sessions)
  /log [summary|tail|failures|reset] - Iteration/run log
  /resume [sessionId]        - Resume session (restores full context)
  /checkpoint [list|clear]   - File checkpoints (/cp)
  /restore <path> [index]    - Restore file from checkpoint
  /bookmark [name|list|goto] - Bookmarks (/bm)
  /queue [show|clear|flush]  - Message queue (/q)

--- Context & Scope ---
  /scope [details|reset]     - File access scope (/dirs)
  /add-dir / /remove-dir     - Manage scope directories
  /context [load|summary]    - Context management
  /summarize                 - Compact context to save tokens
  /trust [add|remove|list]   - Project trust registry
  /find <pattern>            - Fuzzy file search
  /search <query>            - Search conversation

--- Tasks & Planning ---
  /todo [add|done|list]      - Manage TODOs
  /plans [list|view]         - View plan history
  /template [save|use|del]   - Prompt templates (/t)
  /plan / /work              - Quick mode switch
  /approve [notes]           - Approve pending plan & execute

--- Appearance ---
  /theme [name]              - Color themes
  /layout [name]             - UI layout (classic/split/etc)
  /density [normal|compact]  - Display density
  /collapse [tools|all|off]  - Tool output visibility
  /emoji [on|off]            - Toggle emoji

--- Tools & Integration ---
  /mcp [add|remove|tools]    - MCP servers
  /skills [add|remove]       - Agent skills
  /memory [init|add|show]    - Project memory (CALLIOPE.md)
  /project [init|show|run]   - Project config (.calliope)
  /hooks [list|add]          - Pre/post tool hooks
  /profile [name|save|del]   - Switch/save/delete profiles

--- Multi-Agent ---
  /loop [prompt]             - Iterative agent loop (default: unlimited)
  /cancel-loop               - Stop running loop (/stop, /breakloop)

--- System ---
  /status                    - Show status (/s)
  /config                    - Show config
  /set <key> <value>         - Set config variable
  /cost                      - Cost tracking summary
  /confirm [on|off]          - Toggle risky op confirmation
  /debug [on|off]            - Debug state/logging
  /unstick                   - Emergency reset
  /upgrade                   - Check for updates
  /keys or /?                - Keyboard shortcuts
  /exit                      - Exit (/quit)

File references: @filename, ./path, /absolute/path
Modes: Plan | Hybrid | Work | Auto-route: ${ctx.autoRoute ? 'ON' : 'OFF'}`);
      break;

    case '/provider':
    case '/providers':
    case '/p':
      if (parts[1]) {
        const requested = parts[1].toLowerCase() as LLMProvider;
        const available = getAvailableProviders();
        if (!available.includes(requested)) {
          ctx.addMessage('error',
            `Provider "${requested}" is not configured. Run /provider (no args) for an interactive picker with setup.`);
          break;
        }
        ctx.setProvider(requested);
        ctx.addMessage('system', `Provider: ${selectProvider(requested)}`);
      } else if (ctx.openProviderPicker) {
        ctx.openProviderPicker();
      } else {
        ctx.addMessage('system', `Provider: ${ctx.actualProvider} | Available: ${getAvailableProviders().join(', ')}`);
      }
      break;

    case '/model':
    case '/m':
      if (parts[1]) {
        const newModel = parts[1];
        const oldModel = ctx.model || ctx.actualModel;

        // Check context compatibility before switching (#26)
        const oldLimit = getModelContextLimit(ctx.actualProvider as LLMProvider, oldModel);
        const newLimit = getModelContextLimit(ctx.actualProvider as LLMProvider, newModel);
        const currentTokens = ctx.estimateContextTokens();
        const newPct = Math.round((currentTokens / newLimit) * 100);

        ctx.setModel(newModel);
        ctx.setContextTokens(currentTokens);

        let switchWarning = '';
        if (newPct > 80) {
          switchWarning = `\n⚠️  Context at ${newPct}% of new model limit (${Math.round(currentTokens/1000)}K/${Math.round(newLimit/1000)}K). Consider /summarize compact.`;
        } else if (newLimit < oldLimit) {
          switchWarning = `\n📉 Context window: ${Math.round(oldLimit/1000)}K → ${Math.round(newLimit/1000)}K (${newPct}% used)`;
        }
        ctx.addMessage('system', `Model: ${oldModel} → ${newModel}${switchWarning}`);
      } else {
        ctx.addMessage('system', `Fetching models for ${ctx.actualProvider}...`);
        try {
          const models = await getAvailableModels(ctx.actualProvider, { throwOnError: true });
          if (models.length > 0) {
            ctx.setAvailableModels(models);
            ctx.setModalMode('model');
          } else {
            ctx.addMessage('error', `No models found for ${ctx.actualProvider} — API key may be invalid`);
          }
        } catch (e) {
          ctx.addMessage('error', `Failed to fetch models for ${ctx.actualProvider}: ${e instanceof Error ? e.message : String(e)}. Check your API key.`);
        }
      }
      break;

    case '/models':
      ctx.addMessage('system', `Fetching models for ${ctx.actualProvider}...`);
      try {
        const models = await getAvailableModels(ctx.actualProvider, { throwOnError: true });
        if (models.length > 0) {
          ctx.setAvailableModels(models);
          ctx.setModalMode('model');
        } else {
          ctx.addMessage('error', `No models found for ${ctx.actualProvider} — API key may be invalid`);
        }
      } catch (e) {
        ctx.addMessage('error', `Failed to fetch models for ${ctx.actualProvider}: ${e instanceof Error ? e.message : String(e)}. Check your API key.`);
      }
      break;

    case '/mode':
      if (parts[1] && ['plan', 'hybrid', 'work'].includes(parts[1])) {
        const m = parts[1] as Mode;
        ctx.setMode(m);
        ctx.addMessage('system', `Mode: ${MODE_CONFIG[m].icon} ${MODE_CONFIG[m].label} - ${MODE_CONFIG[m].description}`);
      } else {
        const currentConfig = MODE_CONFIG[ctx.mode];
        ctx.addMessage('system', `Mode: ${currentConfig.icon} ${currentConfig.label}\nOptions: plan (\u{1F4CB}), hybrid (\u{1F504}), work (\u{1F527})\nUse Shift+Tab to cycle`);
      }
      break;

    case '/clear':
    case '/c':
      ctx.setMessages([]);
      ctx.llmMessages.current = [{ role: 'system', content: buildFullSystemPrompt(getActiveProjectDir(ctx)) }];
      ctx.ledger?.reset();
      ctx.setStats({ inputTokens: 0, outputTokens: 0, cost: 0, messageCount: 0 });
      resetContextWarnings(); // Reset context warning state
      break;

    case '/copy': {
      // Copy last assistant response to clipboard
      const lastAssistant = [...ctx.messages].reverse().find(m => m.type === 'assistant');
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
          ctx.addMessage('system', '\u2713 Copied to clipboard');
        } catch (e) {
          ctx.addMessage('error', `Clipboard not available: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else {
        ctx.addMessage('system', 'No assistant message to copy');
      }
      break;
    }

    case '/export': {
      // Export conversation to markdown
      const filename = parts[1] || `calliope-export-${Date.now()}.md`;
      const fsModule = await import('fs');
      const path = await import('path');

      let markdown = `# Calliope Conversation Export\n\n`;
      markdown += `**Date:** ${new Date().toLocaleString()}\n`;
      markdown += `**Provider:** ${ctx.actualProvider}\n`;
      markdown += `**Model:** ${ctx.actualModel}\n\n---\n\n`;

      for (const msg of ctx.messages) {
        if (msg.type === 'user') {
          markdown += `## \u{1F464} User\n\n${msg.content}\n\n`;
        } else if (msg.type === 'assistant') {
          markdown += `## \u{1F916} Assistant\n\n${msg.content}\n\n`;
        } else if (msg.type === 'tool') {
          markdown += `> \u{1F527} Tool: ${msg.content}\n\n`;
        } else if (msg.type === 'system') {
          markdown += `> \u{2139}\u{FE0F} ${msg.content}\n\n`;
        } else if (msg.type === 'error') {
          markdown += `> \u{26A0}\u{FE0F} Error: ${msg.content}\n\n`;
        }
      }

      const filepath = path.resolve(process.cwd(), filename);
      fsModule.writeFileSync(filepath, markdown);
      ctx.addMessage('system', `\u2713 Exported to ${filename}`);
      break;
    }

    case '/edit': {
      // Edit last user message
      const lastUserIdx = [...ctx.messages].reverse().findIndex(m => m.type === 'user');
      if (lastUserIdx >= 0) {
        const lastUser = ctx.messages[ctx.messages.length - 1 - lastUserIdx];
        ctx.setInput(lastUser.content);
        ctx.addMessage('system', 'Edit the message above and press Enter to resend');
      } else {
        ctx.addMessage('system', 'No user message to edit');
      }
      break;
    }

    case '/undo': {
      if (ctx.undoStack.current.length === 0) {
        ctx.addMessage('system', 'Nothing to undo.');
        break;
      }

      // Save current state to redo stack
      ctx.redoStack.current.push({
        messages: [...ctx.messages],
        llmMessages: [...ctx.llmMessages.current],
        timestamp: new Date(),
      });

      // Restore previous state
      const prevState = ctx.undoStack.current.pop()!;
      ctx.setMessages(prevState.messages);
      ctx.llmMessages.current = prevState.llmMessages;
      ctx.setContextTokens(ctx.estimateContextTokens());

      ctx.addMessage('system', `\u2713 Undone (${ctx.undoStack.current.length} more available)`);
      break;
    }

    case '/redo': {
      if (ctx.redoStack.current.length === 0) {
        ctx.addMessage('system', 'Nothing to redo.');
        break;
      }

      // Save current state to undo stack
      ctx.undoStack.current.push({
        messages: [...ctx.messages],
        llmMessages: [...ctx.llmMessages.current],
        timestamp: new Date(),
      });

      // Restore redo state
      const redoState = ctx.redoStack.current.pop()!;
      ctx.setMessages(redoState.messages);
      ctx.llmMessages.current = redoState.llmMessages;
      ctx.setContextTokens(ctx.estimateContextTokens());

      ctx.addMessage('system', `\u2713 Redone (${ctx.redoStack.current.length} more available)`);
      break;
    }

    case '/status':
    case '/s': {
      const imgInfo = getTerminalImageInfo();
      let statusMsg = `${ctx.actualProvider}:${ctx.actualModel} | ${ctx.stats.messageCount} msgs | ${ctx.stats.inputTokens + ctx.stats.outputTokens} tokens | terminal: ${getImageModeLabel(imgInfo.mode)}${imgInfo.truecolor ? ' (truecolor)' : ''} ${imgInfo.width}cols`;
      
      // Add scuttlebot status if enabled
      if (scuttlebotClient.isEnabled()) {
        const sbStatus = scuttlebotClient.getStatus();
        statusMsg += `\nScuttlebot: enabled (${sbStatus.nick}) | irc:${sbStatus.config?.ircAddr} | #${sbStatus.config?.channel}`;
      }
      
      ctx.addMessage('system', statusMsg);
      break;
    }

    case '/scuttlebot': {
      const subCmd = parts[1];
      const sbStatus = scuttlebotClient.getStatus();
      
      // /scuttlebot enable - enable mid-session
      if (subCmd === 'enable') {
        if (sbStatus.enabled) {
          ctx.addMessage('system', 'Scuttlebot is already enabled.');
          break;
        }
        
        // Initialize scuttlebot — config is loaded from ~/.config/scuttlebot-relay.env,
        // process.env, and .scuttlebot.yaml inside initialize()
        const sessionId = ctx.sessionRef.current?.id || 'default';
        const cwd = getActiveProjectDir(ctx);
        scuttlebotClient.initialize(sessionId, cwd).then(async (enabled) => {
          if (enabled) {
            const status = scuttlebotClient.getStatus();
            let msg = '✓ Scuttlebot enabled!\n';
            msg += `  Nick:      ${status.nick}\n`;
            msg += `  IRC:       ${status.config?.ircAddr}\n`;
            msg += `  Channel:   #${status.config?.channel}`;
            if (status.config?.channels && status.config.channels.length > 1) {
              msg += `\n  Channels:  ${status.config.channels.map((c: string) => '#' + c).join(', ')}`;
            }
            ctx.addMessage('system', msg);

            // Post online status and start routing IRC instructions
            await scuttlebotClient.postOnline();
            ctx.startScuttlebotPolling();
          } else {
            ctx.addMessage('system', 'Failed to enable scuttlebot');
          }
        }).catch((err: unknown) => {
          ctx.addMessage('system', `Failed to enable scuttlebot: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }
      
      // /scuttlebot disable - disable mid-session
      if (subCmd === 'disable') {
        if (!sbStatus.enabled) {
          ctx.addMessage('system', 'Scuttlebot is not enabled.');
          break;
        }
        
        scuttlebotClient.postOffline().then(() => {
          return scuttlebotClient.disconnect();
        }).then(() => {
          ctx.addMessage('system', 'Scuttlebot disabled');
        }).catch((err: unknown) => {
          ctx.addMessage('system', `Error disabling scuttlebot: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }
      
      // Show status
      if (!sbStatus.enabled) {
        ctx.addMessage('system', 'Scuttlebot not enabled.\n\nRun: /scuttlebot enable\n\nConfig is loaded automatically from ~/.config/scuttlebot-relay.env\nChannel is read from .scuttlebot.yaml');
        break;
      }
      
      let statusText = 'Scuttlebot Status\n────────────────────────────────────────\n';
      statusText += `Enabled:     yes\n`;
      statusText += `Nick:        ${sbStatus.nick}\n`;
      statusText += `IRC:         ${sbStatus.config?.ircAddr}\n`;
      statusText += `Channel:     #${sbStatus.config?.channel}\n`;
      statusText += `Connected:   ${sbStatus.connected ? 'yes' : 'no'}`;
      if (sbStatus.config?.channels && sbStatus.config.channels.length > 1) {
        statusText += `\nChannels:    ${sbStatus.config.channels.map((c: string) => '#' + c).join(', ')}`;
      }
      statusText += '\n\nCommands:\n  /scuttlebot <message>  Post a message\n  /scuttlebot disable    Disable integration';
      
      ctx.addMessage('system', statusText);
      
      // Allow manual message posting
      if (subCmd && subCmd !== 'enable' && subCmd !== 'disable') {
        const message = parts.slice(1).join(' ');
        scuttlebotClient.postMessage(message).then(() => {
          ctx.addMessage('system', 'Message posted to scuttlebot.');
        }).catch((err: unknown) => {
          ctx.addMessage('system', `Failed to post message: ${err instanceof Error ? err.message : String(err)}`);
        });
      }
      break;
    }

    case '/config':
      ctx.addMessage('system', `Config: ${config.getConfigPath()}\nProviders: ${config.getConfiguredProviders().join(', ') || 'none'}\nmaxIterations: ${config.get('maxIterations')}\nsessionLogLimit: ${formatSessionLogLimit(config.get('sessionLogLimit'))} (set > 0 to cap)`);
      break;

    case '/set': {
      // /set <key> <value>
      const key = parts[1];
      const value = parts.slice(2).join(' ');
      if (!key || !value) {
        ctx.addMessage('system', `Usage: /set <key> <value>
Available keys:
  maxIterations <number>  - Max agent iterations (current: ${config.get('maxIterations')})
  sessionLogLimit <number> - Cap retained session log items (current: ${formatSessionLogLimit(config.get('sessionLogLimit'))}, 0 = unlimited)
  fancyOutput <bool>      - true/false`);
        break;
      }

      try {
        if (key === 'maxIterations') {
          const num = parseInt(value, 10);
          if (isNaN(num) || num < 0 || num > 1000000) {
            ctx.addMessage('error', 'maxIterations must be 0-1000000 (0 = unlimited)');
            break;
          }
          config.set('maxIterations', num);
          ctx.addMessage('system', `\u2713 maxIterations set to ${formatIterationLimit(resolveIterationLimit(num))}`);
        } else if (key === 'sessionLogLimit') {
          const num = parseInt(value, 10);
          if (isNaN(num) || num < 0 || num > 100000) {
            ctx.addMessage('error', 'sessionLogLimit must be 0-100000 (0 = unlimited)');
            break;
          }
          config.set('sessionLogLimit', num);
          ctx.ledger?.setRetentionLimit(num);
          ctx.addMessage('system', `\u2713 sessionLogLimit set to ${num === 0 ? 'unlimited (set > 0 to cap)' : num}`);
        } else if (key === 'fancyOutput') {
          const bool = value === 'true';
          config.set('fancyOutput', bool);
          ctx.addMessage('system', `\u2713 fancyOutput set to ${bool}`);
        } else {
          ctx.addMessage('error', `Unknown config key: ${key}`);
        }
      } catch (err) {
        ctx.addMessage('error', `Failed to set ${key}: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case '/setup':
      ctx.addMessage('system', 'Run `calliope --setup` to reconfigure.');
      break;

    case '/layout': {
      // /layout [classic|response-top|response-bottom|split|zen|focus|dashboard|minimal]
      const layoutArg = parts[1] as string | undefined;

      if (!layoutArg) {
        ctx.addMessage('system', `Current layout: ${ctx.layout}

Available layouts:
  classic         - Everything in chronological order
  response-top    - Calliope response at top, tools below
  response-bottom - Tools at top, response at bottom (default)
  split           - Side by side: tools left, response right
  zen             - Response only, tools hidden — distraction-free
  focus           - Latest response pinned top, compact tool log
  dashboard       - Three-panel: stats, response, tools
  minimal         - No decorations, raw text output

Usage: /layout <name>`);
        break;
      }

      const validLayouts = ['classic', 'response-top', 'response-bottom', 'split', 'zen', 'focus', 'dashboard', 'minimal'];
      if (!validLayouts.includes(layoutArg)) {
        ctx.addMessage('error', `Invalid layout. Choose: ${validLayouts.join(', ')}`);
        break;
      }

      config.set('layout', layoutArg as any);
      ctx.setLayout(layoutArg as any);
      ctx.addMessage('system', `\u2713 Layout set to: ${layoutArg}`);
      break;
    }

    case '/density': {
      // /density [normal|compact]
      const densityArg = parts[1] as 'normal' | 'compact' | undefined;

      if (!densityArg) {
        ctx.addMessage('system', `Current density: ${ctx.density}

Available densities:
  normal  - Standard spacing
  compact - Reduced whitespace for more info

Usage: /density <normal|compact>`);
        break;
      }

      const validDensities = ['normal', 'compact'];
      if (!validDensities.includes(densityArg)) {
        ctx.addMessage('error', `Invalid density. Choose: normal, compact`);
        break;
      }

      config.set('density', densityArg);
      ctx.setDensity(densityArg);
      ctx.addMessage('system', `\u2713 Density set to: ${densityArg}`);
      break;
    }

    case '/collapse': {
      // /collapse [tools|thinking|all|off] [limit N]
      const subCmd = parts[1];

      if (!subCmd) {
        ctx.addMessage('system', `Collapse settings:
  collapseTools: ${ctx.collapseSettings.collapseTools}
  collapseThinking: ${ctx.collapseSettings.collapseThinking}
  toolDisplayLimit: ${ctx.collapseSettings.toolDisplayLimit} (0 = all expanded)

Usage:
  /collapse tools      - Toggle tool output collapsing
  /collapse thinking   - Toggle thinking block collapsing
  /collapse all        - Collapse both tools and thinking
  /collapse off        - Expand everything
  /collapse limit <N>  - Show last N tools expanded (0 = all)`);
        break;
      }

      if (subCmd === 'tools') {
        const newVal = !ctx.collapseSettings.collapseTools;
        config.set('collapseTools', newVal);
        ctx.setCollapseSettings(prev => ({ ...prev, collapseTools: newVal }));
        ctx.addMessage('system', `\u2713 collapseTools set to ${newVal}`);
      } else if (subCmd === 'thinking') {
        const newVal = !ctx.collapseSettings.collapseThinking;
        config.set('collapseThinking', newVal);
        ctx.setCollapseSettings(prev => ({ ...prev, collapseThinking: newVal }));
        ctx.addMessage('system', `\u2713 collapseThinking set to ${newVal}`);
      } else if (subCmd === 'all') {
        config.set('collapseTools', true);
        config.set('collapseThinking', true);
        ctx.setCollapseSettings(prev => ({ ...prev, collapseTools: true, collapseThinking: true }));
        ctx.addMessage('system', '\u2713 Collapsing tools and thinking');
      } else if (subCmd === 'off') {
        config.set('collapseTools', false);
        config.set('collapseThinking', false);
        ctx.setCollapseSettings(prev => ({ ...prev, collapseTools: false, collapseThinking: false }));
        ctx.addMessage('system', '\u2713 Expanding all output');
      } else if (subCmd === 'limit') {
        const limit = parseInt(parts[2], 10);
        if (isNaN(limit) || limit < 0 || limit > 100) {
          ctx.addMessage('error', 'Limit must be 0-100');
          break;
        }
        config.set('toolDisplayLimit', limit);
        ctx.setCollapseSettings(prev => ({ ...prev, toolDisplayLimit: limit }));
        ctx.addMessage('system', `\u2713 toolDisplayLimit set to ${limit}`);
      } else {
        ctx.addMessage('error', 'Unknown collapse option. Use: tools, thinking, all, off, or limit <N>');
      }
      break;
    }

    case '/loop': {
      // Parse /loop "<prompt>" [--max-iterations N] [--completion-promise "text"]
      if (ctx.loopActive) {
        ctx.addMessage('system', 'Loop already running. Use /breakloop to stop it first.');
        break;
      }

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
        ctx.addMessage('system', `Usage: /loop "<prompt>" [--max-iterations N] [--completion-promise "text"]
Example: /loop "Build a REST API" --max-iterations 50 --completion-promise "DONE"`);
        break;
      }

      const defaultMaxIterations = resolveIterationLimit(config.get('maxIterations'));
      const loopMaxIterations = maxIterMatch
        ? resolveIterationLimit(parseInt(maxIterMatch[1], 10))
        : defaultMaxIterations;

      // Start the loop
      ctx.setLoopActive(true);
      ctx.setLoopPrompt(prompt);
      ctx.setLoopMaxIterations(loopMaxIterations);
      ctx.setLoopCompletionPromise(completionMatch ? completionMatch[1] : undefined);
      ctx.setLoopIteration(0);
      ctx.loopCancelledRef.current = false;

      ctx.addMessage('system', `\u{1F504} Agent Loop Started
  Prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"
  Max iterations: ${formatIterationLimit(loopMaxIterations)}
  ${completionMatch ? `Completion promise: "${completionMatch[1]}"` : isFiniteIterationLimit(loopMaxIterations) ? 'No completion promise (runs until max iterations)' : 'No completion promise (runs until stopped)'}
  Use /breakloop to stop`);

      // Start the loop execution (non-blocking)
      ctx.runLoop(prompt, loopMaxIterations, completionMatch?.[1]);
      break;
    }

    case '/cancel-loop':
    case '/breakloop':
    case '/stop':
      if (ctx.loopActive) {
        ctx.loopCancelledRef.current = true;
        ctx.setLoopActive(false);
        ctx.addMessage('system', '\u{1F6D1} Loop cancelled');
      } else {
        ctx.addMessage('system', 'No active loop to cancel');
      }
      break;

    case '/confirm':
      if (parts[1] === 'on') {
        ctx.setConfirmMode(true);
        ctx.addMessage('system', '\u2713 Confirmation mode ON - will ask before risky operations');
      } else if (parts[1] === 'off') {
        ctx.setConfirmMode(false);
        ctx.addMessage('system', '\u26A0\uFE0F Confirmation mode OFF - risky operations will auto-execute');
      } else {
        ctx.addMessage('system', `Confirm mode: ${ctx.confirmMode ? 'ON' : 'OFF'}\nUsage: /confirm [on|off]`);
      }
      break;

    case '/profile': {
      const subCmd = parts[1];
      if (subCmd === 'list' || !subCmd) {
        const profiles = config.listProfiles();
        const active = config.getActiveProfile();
        const list = profiles.map(p => {
          const marker = p.name === active ? '\u2192 ' : '  ';
          const tag = p.builtin ? '(built-in)' : '(custom)';
          return `${marker}${p.name}: ${p.profile.provider}/${p.profile.model || 'default'} ${tag}`;
        }).join('\n');
        ctx.addMessage('system', `Profiles:\n${list}\n\nUsage: /profile <name> | /profile save <name>`);
      } else if (subCmd === 'save' && parts[2]) {
        const name = parts[2];
        config.saveProfile(name, {
          provider: ctx.provider,
          model: ctx.model,
          confirmMode: ctx.confirmMode,
        });
        ctx.addMessage('system', `\u2713 Saved profile: ${name}`);
      } else if (subCmd === 'delete' && parts[2]) {
        const name = parts[2];
        if (config.deleteProfile(name)) {
          ctx.addMessage('system', `\u2713 Deleted profile: ${name}`);
        } else {
          ctx.addMessage('error', `Cannot delete profile: ${name} (built-in or not found)`);
        }
      } else {
        // Load profile
        const profile = config.getProfile(subCmd);
        if (profile) {
          ctx.setProvider(profile.provider);
          if (profile.model) ctx.setModel(profile.model);
          if (profile.confirmMode !== undefined) ctx.setConfirmMode(profile.confirmMode);
          config.setActiveProfile(subCmd);
          ctx.addMessage('system', `\u2713 Loaded profile: ${subCmd} (${profile.provider}/${profile.model || 'default'})`);
        } else {
          ctx.addMessage('error', `Profile not found: ${subCmd}\nBuilt-in: fast, smart, cheap, local`);
        }
      }
      break;
    }

    case '/mcp': {
      const subCmd = parts[1];
      if (subCmd === 'list' || !subCmd) {
        const servers = mcp.listServers();
        if (servers.length === 0) {
          ctx.addMessage('system', 'No MCP servers registered.\n\nUsage:\n  /mcp add <url>  - Register MCP server\n  /mcp remove <id> - Remove server');
        } else {
          const list = servers.map(s => {
            const status = s.status === 'connected' ? '\u{1F7E2}' : s.status === 'error' ? '\u{1F534}' : '\u26AA';
            return `${status} ${s.name} (${s.tools.length} tools)\n   ${s.url}`;
          }).join('\n\n');
          ctx.addMessage('system', `MCP Servers:\n\n${list}`);
        }
      } else if (subCmd === 'add' && parts[2]) {
        const url = parts[2];
        ctx.addMessage('system', `Registering MCP server: ${url}...`);
        try {
          const server = await mcp.registerServer(url);
          ctx.addMessage('system', `\u2713 Registered: ${server.name} (${server.tools.length} tools)`);
        } catch (e) {
          ctx.addMessage('error', `Failed to register: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if ((subCmd === 'remove' || subCmd === 'rm') && parts[2]) {
        if (mcp.unregisterServer(parts[2])) {
          ctx.addMessage('system', '\u2713 Server removed');
        } else {
          ctx.addMessage('error', 'Server not found');
        }
      } else if (subCmd === 'refresh') {
        const servers = mcp.listServers();
        let connected = 0;
        for (const s of servers) {
          const updated = await mcp.refreshServer(s.id);
          if (updated?.status === 'connected') connected++;
        }
        ctx.addMessage('system', `Refreshed ${servers.length} servers (${connected} connected)`);
      } else if (subCmd === 'tools') {
        const tools = mcp.getMCPTools();
        if (tools.length === 0) {
          ctx.addMessage('system', 'No MCP tools available. Add servers with /mcp add <url>');
        } else {
          const list = tools.map(t => `\u2022 ${t.name}\n  ${t.description}`).join('\n\n');
          ctx.addMessage('system', `MCP Tools:\n\n${list}`);
        }
      } else {
        ctx.addMessage('system', 'Usage: /mcp [list|add <url>|remove <id>|refresh|tools]');
      }
      break;
    }

    case '/skills': {
      const subCmd = parts[1];
      if (subCmd === 'list' || !subCmd) {
        const allSkills = skills.getSkills();
        if (allSkills.length === 0) {
          ctx.addMessage('system', 'No skills installed.\n\nUsage:\n  /skills add <name>     - Install from agentskills.io\n  /skills add <github-url> - Install from GitHub\n  /skills add <path>     - Install from local directory');
        } else {
          const list = allSkills.map(s => {
            const src = s.source === 'github' ? '(GitHub)' : s.source === 'registry' ? '(agentskills.io)' : '(local)';
            return `\u2022 ${s.metadata.name} ${src}\n  ${s.metadata.description.substring(0, 80)}...`;
          }).join('\n\n');
          ctx.addMessage('system', `Installed Skills:\n\n${list}`);
        }
      } else if (subCmd === 'add' && parts[2]) {
        const source = parts[2];
        ctx.addMessage('system', `Installing skill: ${source}...`);
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
            ctx.addMessage('system', `\u2713 Installed: ${skill.metadata.name}`);
          } else {
            ctx.addMessage('error', 'Failed to install skill');
          }
        } catch (e) {
          ctx.addMessage('error', `Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if ((subCmd === 'remove' || subCmd === 'rm') && parts[2]) {
        if (skills.uninstallSkill(parts[2])) {
          ctx.addMessage('system', '\u2713 Skill removed');
        } else {
          ctx.addMessage('error', 'Skill not found');
        }
      } else if (subCmd === 'info' && parts[2]) {
        const skill = skills.getSkill(parts[2]);
        if (skill) {
          let info = `# ${skill.metadata.name}\n\n`;
          info += `${skill.metadata.description}\n\n`;
          if (skill.metadata.compatibility) info += `Compatibility: ${skill.metadata.compatibility}\n`;
          if (skill.metadata.license) info += `License: ${skill.metadata.license}\n`;
          if (skill.sourceUrl) info += `Source: ${skill.sourceUrl}\n`;
          ctx.addMessage('system', info);
        } else {
          ctx.addMessage('error', 'Skill not found');
        }
      } else {
        ctx.addMessage('system', 'Usage: /skills [list|add <source>|remove <name>|info <name>]');
      }
      break;
    }

    case '/memory': {
      const memoryModule = await import('../memory.js');
      const subCmd = parts[1];
      const cwd = process.cwd();

      if (subCmd === 'init') {
        const memPath = memoryModule.initProjectMemory(cwd);
        ctx.addMessage('system', `Created: ${memPath}\nEdit the file to add context and preferences.`);
      } else if (subCmd === 'show' || !subCmd) {
        const memPath = memoryModule.findProjectMemory(cwd);
        if (!memPath) {
          ctx.addMessage('system', 'No CALLIOPE.md found.\nRun /memory init to create one.');
        } else {
          const mem = memoryModule.loadMemory(memPath);
          let info = `Memory: ${memPath}\n\n`;
          if (mem.context.length) info += `**Context:**\n${mem.context.map((c: string) => `  - ${c}`).join('\n')}\n\n`;
          if (mem.preferences.length) info += `**Preferences:**\n${mem.preferences.map((p: string) => `  - ${p}`).join('\n')}\n\n`;
          if (mem.history.length) info += `**History:**\n${mem.history.slice(-5).map((h: string) => `  - ${h}`).join('\n')}\n`;
          ctx.addMessage('system', info);
        }
      } else if (subCmd === 'add' && parts[2]) {
        const type = parts[2] as 'context' | 'preference' | 'history' | 'note';
        const content = parts.slice(3).join(' ');
        if (!content) {
          ctx.addMessage('error', 'Usage: /memory add <type> <content>');
        } else {
          let memPath = memoryModule.findProjectMemory(cwd);
          if (!memPath) {
            memPath = memoryModule.initProjectMemory(cwd);
          }
          memoryModule.addMemoryEntry(memPath, {
            type,
            content,
            timestamp: new Date().toISOString().split('T')[0],
          });
          ctx.addMessage('system', `Added ${type}: ${content}`);
        }
      } else if (subCmd === 'remove' && parts[2]) {
        const type = parts[2] as 'context' | 'preference' | 'history' | 'note';
        const content = parts.slice(3).join(' ');
        const memPath = memoryModule.findProjectMemory(cwd);
        if (memPath && memoryModule.removeMemoryEntry(memPath, type, content)) {
          ctx.addMessage('system', `Removed matching ${type}`);
        } else {
          ctx.addMessage('error', 'Entry not found');
        }
      } else if (subCmd === 'global') {
        const globalMem = memoryModule.getGlobalMemory();
        let info = 'Global Memory:\n\n';
        if (globalMem.preferences.length) info += `**Preferences:**\n${globalMem.preferences.map((p: string) => `  - ${p}`).join('\n')}\n`;
        if (globalMem.notes.length) info += `**Notes:**\n${globalMem.notes.map((n: string) => `  - ${n}`).join('\n')}\n`;
        ctx.addMessage('system', info || 'No global memories yet.');
      } else {
        ctx.addMessage('system', 'Usage: /memory [init|show|add <type> <text>|remove <type> <text>|global]');
      }
      break;
    }

    case '/find': {
      const fuzzy = await import('../fuzzy-search.js');
      const query = parts.slice(1).join(' ');
      if (!query) {
        ctx.addMessage('system', 'Usage: /find <pattern>\nFuzzy search for files');
      } else {
        const results = fuzzy.searchWithHighlight(process.cwd(), query, { maxResults: 20 });
        if (results.length === 0) {
          ctx.addMessage('system', 'No files found');
        } else {
          const list = results.map((r: { highlighted: string }, i: number) => `${i + 1}. ${r.highlighted}`).join('\n');
          ctx.addMessage('system', `Found ${results.length} files:\n\n${list}`);
        }
      }
      break;
    }

    case '/theme': {
      const subCmd = parts[1];

      if (!subCmd || subCmd === 'list') {
        const themes = await import('../themes.js');
        const list = themes.listThemes();
        const current = themes.getCurrentThemeName();
        const formatted = list.map((t: { name: string; custom?: boolean; description?: string }) => {
          const marker = t.name === current ? ' *' : '';
          const custom = t.custom ? ' (custom)' : '';
          return `  ${t.name}${marker}${custom} - ${t.description || 'No description'}`;
        }).join('\n');
        ctx.addMessage('system', `Available themes:\n${formatted}`);
      } else {
        const themes = await import('../themes.js');
        if (themes.setCurrentTheme(subCmd)) {
          themes.clearThemeCache();
          ctx.addMessage('system', `Theme set to: ${subCmd}`);
        } else {
          ctx.addMessage('error', `Theme not found: ${subCmd}`);
        }
      }
      break;
    }

    case '/emoji': {
      const emojiArg = parts[1];
      const current = config.get('useEmojis') !== false;
      if (emojiArg === 'on') {
        config.set('useEmojis', true);
        ctx.addMessage('system', '\u2713 Emojis enabled');
      } else if (emojiArg === 'off') {
        config.set('useEmojis', false);
        ctx.addMessage('system', '\u2713 Emojis disabled — text fallbacks will be used');
      } else if (emojiArg === 'toggle') {
        config.set('useEmojis', !current);
        ctx.addMessage('system', `\u2713 Emojis ${!current ? 'enabled' : 'disabled'}`);
      } else {
        ctx.addMessage('system', `Emojis: ${current ? 'ON' : 'OFF'}\nUsage: /emoji [on|off|toggle]`);
      }
      break;
    }

    case '/hooks': {
      const hooksModule = await import('../hooks.js');
      const subCmd = parts[1];

      if (subCmd === 'list' || !subCmd) {
        ctx.addMessage('system', hooksModule.listHooksFormatted());
      } else if (subCmd === 'add' && parts[2]) {
        const event = parts[2] as import('../hooks.js').HookEvent;
        const hookCommand = parts.slice(3).join(' ');
        if (!hookCommand) {
          ctx.addMessage('system', 'Usage: /hooks add <event> <command>');
        } else {
          hooksModule.addHook({ event, name: `Hook for ${event}`, command: hookCommand, enabled: true, async: false });
          ctx.addMessage('system', 'Hook added');
        }
      } else if (subCmd === 'init') {
        hooksModule.initDefaultHooks();
        ctx.addMessage('system', 'Default hooks initialized');
      } else {
        ctx.addMessage('system', 'Usage: /hooks [list|add <event> <command>|init]');
      }
      break;
    }

    case '/search': {
      const query = parts.slice(1).join(' ');
      if (!query) {
        ctx.addMessage('system', 'Usage: /search <query>\nSearch conversation history');
      } else {
        const lower = query.toLowerCase();
        const matches = ctx.messages.filter(m => m.content.toLowerCase().includes(lower));
        if (matches.length === 0) {
          ctx.addMessage('system', 'No matches found');
        } else {
          const results = matches.slice(-10).map(m => {
            const preview = m.content.slice(0, 100).replace(/\n/g, ' ');
            return `[${m.type}] ${preview}...`;
          }).join('\n\n');
          ctx.addMessage('system', `Found ${matches.length} matches:\n\n${results}`);
        }
      }
      break;
    }

    case '/project': {
      const projectConfig = await import('../project-config.js');
      const subCmd = parts[1];
      const cwd = process.cwd();

      if (subCmd === 'init') {
        const configPath = projectConfig.createProjectConfig(cwd);
        ctx.addMessage('system', `Created project config: ${configPath}\nEdit the file to customize settings.`);
      } else if (subCmd === 'show' || !subCmd) {
        const configPath = projectConfig.findProjectConfig(cwd);
        if (!configPath) {
          ctx.addMessage('system', 'No project config found.\nRun /project init to create one.');
        } else {
          const cfg = projectConfig.loadProjectConfig(configPath);
          if (cfg) {
            let info = `Config: ${configPath}\n\n`;
            if (cfg.project) info += `Project: ${cfg.project}\n`;
            if (cfg.provider) info += `Provider: ${cfg.provider}\n`;
            if (cfg.model) info += `Model: ${cfg.model}\n`;
            if (cfg.tech?.length) info += `Tech: ${cfg.tech.join(', ')}\n`;
            if (cfg.conventions?.length) info += `\nConventions:\n${cfg.conventions.map((c: string) => `  - ${c}`).join('\n')}\n`;
            if (cfg.commands) info += `\nCommands: ${Object.keys(cfg.commands).join(', ')}\n`;
            ctx.addMessage('system', info);
          } else {
            ctx.addMessage('error', 'Failed to parse config');
          }
        }
      } else if (subCmd === 'run' && parts[2]) {
        const configPath = projectConfig.findProjectConfig(cwd);
        const cfg = configPath ? projectConfig.loadProjectConfig(configPath) : null;
        const cmdName = parts[2];
        if (cfg?.commands?.[cmdName]) {
          const commandToRun = cfg.commands[cmdName];
          // Show the command and source for user awareness
          ctx.addMessage('system',
            `Project command "${cmdName}" from ${configPath}:\n` +
            `  $ ${commandToRun}\n\n` +
            `Type "/project run-confirm ${cmdName}" to execute, or review the .calliope config first.`
          );
        } else {
          ctx.addMessage('error', `Command not found: ${cmdName}`);
        }
      } else if (subCmd === 'run-confirm' && parts[2]) {
        const configPath = projectConfig.findProjectConfig(cwd);
        const cfg = configPath ? projectConfig.loadProjectConfig(configPath) : null;
        const cmdName = parts[2];
        if (cfg?.commands?.[cmdName]) {
          const commandToRun = cfg.commands[cmdName];
          ctx.addMessage('system', `Running: ${commandToRun}`);
          const { spawn } = await import('child_process');
          const proc = spawn('sh', ['-c', commandToRun], { cwd, stdio: 'pipe' });
          let output = '';
          proc.stdout?.on('data', (d: Buffer) => output += d.toString());
          proc.stderr?.on('data', (d: Buffer) => output += d.toString());
          proc.on('close', (code: number | null) => {
            ctx.addMessage('system', `Exit ${code}\n${output}`);
          });
        } else {
          ctx.addMessage('error', `Command not found: ${cmdName}`);
        }
      } else {
        ctx.addMessage('system', 'Usage: /project [init|show|run <cmd>|run-confirm <cmd>]');
      }
      break;
    }

    case '/route':
    case '/autoroute': {
      if (parts[1] === 'on') {
        ctx.setAutoRoute(true);
        ctx.addMessage('system', '\u2713 Auto-routing ON - model selected based on task complexity');
      } else if (parts[1] === 'off') {
        ctx.setAutoRoute(false);
        ctx.addMessage('system', '\u2713 Auto-routing OFF - using fixed model');
      } else if (parts[1] === 'test' && parts[2]) {
        const testMsg = parts.slice(2).join(' ');
        const decision = modelRouter.routeRequest(testMsg, ctx.actualProvider);
        ctx.addMessage('system', `Route test: ${decision.tier} tier (${decision.complexity})\nModel: ${decision.model.model}\nReason: ${decision.reason}\nConfidence: ${Math.round(decision.confidence * 100)}%`);
      } else {
        const tiers = modelRouter.getAllTiers(ctx.actualProvider);
        ctx.addMessage('system', `Auto-route: ${ctx.autoRoute ? 'ON' : 'OFF'}\n\nModel tiers for ${ctx.actualProvider}:\n  fast: ${tiers.fast.model}\n  balanced: ${tiers.balanced.model}\n  smart: ${tiers.smart.model}\n\nUsage: /route [on|off|test <message>]`);
      }
      break;
    }

    case '/summarize': {
      const subCmd = parts[1];
      if (subCmd === 'context' || !subCmd) {
        const msgCount = ctx.llmMessages.current.length;
        if (msgCount < 5) {
          ctx.addMessage('system', 'Not enough messages to summarize.');
        } else {
          const summary = summarization.extractKeyInfo(ctx.llmMessages.current);
          let info = 'Context Summary:\n\n';
          if (summary.topics.length) info += `**Topics:** ${summary.topics.join(', ')}\n`;
          if (summary.decisions.length) info += `**Decisions:**\n${summary.decisions.map((d: string) => `  - ${d}`).join('\n')}\n`;
          if (summary.actions.length) info += `**Actions:**\n${summary.actions.map((a: string) => `  - ${a}`).join('\n')}\n`;
          if (summary.codeChanges.length) info += `**Code Changes:**\n${summary.codeChanges.slice(0, 5).map((c: string) => `  - ${c}`).join('\n')}\n`;
          ctx.addMessage('system', info || 'No key information extracted.');
        }
      } else if (subCmd === 'compact') {
        // Summarize and compact the conversation
        const result = summarization.summarizeConversation(ctx.llmMessages.current, { maxTokens: 50000 });
        if (result.summarizedCount > 0) {
          ctx.llmMessages.current = result.messages;
          ctx.setContextTokens(ctx.estimateContextTokens());
          ctx.addMessage('system', `\u2713 Compacted ${result.summarizedCount} messages (${result.originalTokens} \u2192 ${result.reducedTokens} tokens)`);
        } else {
          ctx.addMessage('system', 'Context already within limits, no compaction needed.');
        }
      } else {
        ctx.addMessage('system', 'Usage: /summarize [context|compact]');
      }
      break;
    }

    case '/upgrade':
      ctx.addMessage('system', 'Checking for updates...');
      try {
        const current = getVersion();
        const latest = await getLatestVersion();
        if (!latest) {
          ctx.addMessage('error', 'Could not check for updates');
          break;
        }
        const [cMaj, cMin, cPat] = current.split('.').map(Number);
        const [lMaj, lMin, lPat] = latest.split('.').map(Number);
        const hasUpdate = lMaj > cMaj || (lMaj === cMaj && lMin > cMin) || (lMaj === cMaj && lMin === cMin && lPat > cPat);

        if (hasUpdate) {
          ctx.setLatestVersion(latest);
          ctx.setModalMode('upgrade');
        } else {
          ctx.addMessage('system', `You're on the latest version (v${current})`);
        }
      } catch (e) {
        ctx.addMessage('error', `Failed to check for updates: ${e instanceof Error ? e.message : String(e)}`);
      }
      break;

    case '/session':
    case '/sessions':
      if (parts[1] === 'list' || !parts[1]) {
        const sessions = storage.listSessions(20);
        if (sessions.length === 0) {
          ctx.addMessage('system', 'No previous sessions found.');
        } else {
          ctx.setAvailableSessions(sessions);
          ctx.setModalMode('sessions');
        }
      } else if (parts[1] === 'info') {
        const session = ctx.sessionRef.current;
        if (session) {
          const savedMessages = storage.loadMessageHistory();
          const savedCount = savedMessages ? savedMessages.length : 0;
          const ledgerTotals = ctx.ledger?.getTotals();
          const latestRun = ctx.ledger?.getLatestRun();
          const lines = [
            `Session: ${session.projectName}`,
            `ID: ${session.id}`,
            `Created: ${new Date(session.createdAt).toLocaleString()}`,
            `Messages: ${session.messageCount}`,
            `Saved LLM messages: ${savedCount}`,
          ];
          if (ledgerTotals) {
            lines.push(
              `Iterations logged: ${ledgerTotals.iterations}`,
              `Failed approaches: ${ctx.ledger?.getFailedApproachCount() ?? 0}`,
            );
          }
          if (latestRun) {
            lines.push(`Latest run: ${formatLedgerRun(latestRun)}`);
          }
          ctx.addMessage('system', lines.join('\n'));
        } else {
          ctx.addMessage('system', 'No active session.');
        }
      } else if (parts[1] === 'fork') {
        const session = ctx.sessionRef.current;
        if (!session) {
          ctx.addMessage('error', 'No active session to fork.');
        } else {
          // Save current messages before forking
          storage.saveMessageHistory(ctx.llmMessages.current);
          if (ctx.ledger) {
            storage.saveIterationLedger(ctx.ledger);
          }
          const forked = storage.forkSession(session.projectPath);
          if (forked) {
            ctx.sessionRef.current = forked;
            ctx.addMessage('system', `Forked session: ${forked.id}\nMessages carried over: ${ctx.llmMessages.current.length}\n\nYou are now on the forked session. The original session is preserved.`);
          } else {
            ctx.addMessage('error', 'Failed to fork session. No saved messages found.');
          }
        }
      } else if (parts[1] === 'save') {
        storage.saveMessageHistory(ctx.llmMessages.current);
        if (ctx.ledger) {
          storage.saveIterationLedger(ctx.ledger);
        }
        ctx.addMessage('system', `Saved ${ctx.llmMessages.current.length} LLM messages and current log state to session.`);
      } else {
        ctx.addMessage('system', 'Usage: /session [list|info|fork|save] or just /sessions');
      }
      break;

    case '/log': {
      if (!ctx.ledger) {
        ctx.addMessage('system', 'No session log available.');
        break;
      }

      const subCmd = parts[1] || 'summary';

      if (subCmd === 'summary') {
        const totals = ctx.ledger.getTotals();
        const runs = ctx.ledger.getRuns(5);
        const allFailures = ctx.ledger.getFailedApproaches();
        const failures = allFailures.slice(-5);
        const lines = [
          'Session Log',
          `Iterations: ${totals.iterations}`,
          `Failed approaches: ${ctx.ledger.getFailedApproachCount()}`,
          `Tokens: ${totals.totalTokens}`,
          `Cost: $${totals.totalCost.toFixed(4)}`,
          `Duration: ${formatLedgerDuration(totals.totalDurationMs)}`,
        ];

        if (runs.length > 0) {
          lines.push('', 'Recent runs:');
          for (const run of runs) {
            lines.push(`  - ${formatLedgerRun(run)}`);
          }
        }

        if (failures.length > 0) {
          lines.push('', 'Recent failures:');
          for (const failure of failures) {
            lines.push(`  - #${failure.iteration} ${failure.description} — ${failure.reason}`);
          }
        }

        ctx.addMessage('system', lines.join('\n'));
      } else if (subCmd === 'tail') {
        const limit = parts[2] ? parseInt(parts[2], 10) : 10;
        if (isNaN(limit) || limit <= 0 || limit > 100) {
          ctx.addMessage('error', 'Usage: /log tail [1-100]');
          break;
        }

        const entries = ctx.ledger.getEntries().slice(-limit);
        if (entries.length === 0) {
          ctx.addMessage('system', 'No logged iterations yet.');
          break;
        }

        const lines = ['Recent iterations:'];
        for (const entry of entries) {
          const actions = entry.actions.length > 0
            ? entry.actions.map(action => `${action.tool}(${action.args})${action.result === 'error' ? ' FAILED' : action.result === 'blocked' ? ' BLOCKED' : ''}`).join(', ')
            : 'no tool actions';
          lines.push(`  #${entry.iteration} [${entry.outcome}] ${formatLedgerDuration(entry.durationMs)} — ${actions}`);
        }
        ctx.addMessage('system', lines.join('\n'));
      } else if (subCmd === 'failures') {
        const failures = ctx.ledger.getFailedApproaches();
        if (failures.length === 0) {
          ctx.addMessage('system', 'No failed approaches recorded.');
          break;
        }

        const lines = ['Failed approaches:'];
        for (const failure of failures.slice(-10)) {
          lines.push(`  - #${failure.iteration} ${failure.description} — ${failure.reason}`);
        }
        ctx.addMessage('system', lines.join('\n'));
      } else if (subCmd === 'reset') {
        ctx.ledger.reset();
        ctx.addMessage('system', 'Session log reset.');
      } else {
        ctx.addMessage('system', 'Usage: /log [summary|tail [N]|failures|reset]');
      }
      break;
    }

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
        ctx.addMessage('system', `\u2713 TODO added (#${todo.id.slice(-4)}${isGlobal ? ', global' : ''})`);
      } else if (subCommand === 'done' && parts[2]) {
        const id = parts[2];
        const todos = [...storage.getSessionTodos(), ...storage.getGlobalTodos()];
        const todo = todos.find(t => t.id.endsWith(id) || t.id === id);
        if (todo) {
          storage.updateTodo(todo.id, { status: 'completed' });
          ctx.addMessage('system', `\u2713 TODO #${id} marked done`);
        } else {
          ctx.addMessage('error', `TODO #${id} not found`);
        }
      } else if (subCommand === 'list' || !subCommand) {
        const sessionTodos = storage.getSessionTodos();
        const globalTodos = storage.getGlobalTodos();
        const pending = [...sessionTodos, ...globalTodos].filter(t => t.status !== 'completed');
        const completed = [...sessionTodos, ...globalTodos].filter(t => t.status === 'completed').slice(-3);

        if (pending.length === 0 && completed.length === 0) {
          ctx.addMessage('system', 'No TODOs. Use /todo add <task> to create one.');
        } else {
          let output = '\u{1F4CB} TODOs:\n';
          if (pending.length > 0) {
            output += pending.map(t =>
              `  ${t.priority === 'high' ? '!' : '\u25A1'} #${t.id.slice(-4)} ${t.content}`
            ).join('\n');
          }
          if (completed.length > 0) {
            output += '\n\nCompleted:\n' + completed.map(t =>
              `  \u2713 #${t.id.slice(-4)} ${t.content}`
            ).join('\n');
          }
          ctx.addMessage('system', output);
        }
      } else if (subCommand === 'work' && parts[2]) {
        const id = parts[2];
        const todos = [...storage.getSessionTodos(), ...storage.getGlobalTodos()];
        const todo = todos.find(t => t.id.endsWith(id) || t.id === id);
        if (todo) {
          storage.setActiveTodo(todo.id);
          storage.updateTodo(todo.id, { status: 'in_progress' });
          ctx.addMessage('system', `\u2713 Working on: ${todo.content}\n\nTip: I'll help you complete this task. Describe what you need.`);
        } else {
          ctx.addMessage('error', `TODO #${id} not found`);
        }
      } else if (subCommand === 'clear') {
        storage.setActiveTodo(null);
        ctx.addMessage('system', '\u2713 Active TODO cleared');
      } else {
        ctx.addMessage('system', 'Usage: /todo [add <task>|done <id>|work <id>|clear|list]');
      }
      break;
    }

    case '/plans': {
      const subCommand = parts[1];
      if (subCommand === 'list' || !subCommand) {
        const plans = storage.getPlans();
        if (plans.length === 0) {
          ctx.addMessage('system', 'No plans yet. Plans are created in hybrid mode.');
        } else {
          const list = plans.slice(0, 5).map((p: { status: string; id: string; title: string }) =>
            `${p.status === 'completed' ? '\u2713' : '\u25CB'} ${p.id.slice(-4)}: ${p.title}`
          ).join('\n');
          ctx.addMessage('system', `\u{1F4CB} Plans:\n${list}`);
        }
      } else if (subCommand === 'view' && parts[2]) {
        const plans = storage.getPlans();
        const plan = plans.find((p: { id: string }) => p.id.endsWith(parts[2]) || p.id === parts[2]);
        if (plan) {
          const phases = plan.phases.map((ph: { status: string; name: string; risk: string }) =>
            `  ${ph.status === 'completed' ? '\u2713' : '\u25CB'} ${ph.name} (${ph.risk} risk)`
          ).join('\n');
          ctx.addMessage('system', `Plan: ${plan.title}\nStatus: ${plan.status}\n\nPhases:\n${phases}`);
        } else {
          ctx.addMessage('error', `Plan #${parts[2]} not found`);
        }
      } else if (subCommand === 'rerun' && parts[2]) {
        const plans = storage.getPlans();
        const plan = plans.find((p: { id: string }) => p.id.endsWith(parts[2]) || p.id === parts[2]);
        if (plan) {
          // Reset plan status and activate
          plan.status = 'in_progress';
          plan.phases.forEach((ph: { status: string }) => ph.status = 'pending');
          storage.savePlan(plan);
          storage.setActivePlan(plan);

          // Generate prompt for re-execution
          const phaseList = plan.phases.map((ph: { name: string }) => `- ${ph.name}`).join('\n');
          const prompt = `Please help me execute this plan:\n\n**${plan.title}**\n\nPhases:\n${phaseList}\n\nStart with the first phase.`;
          ctx.setInput(prompt);
          ctx.addMessage('system', `\u2713 Plan loaded: ${plan.title}\nPress Enter to start execution.`);
        } else {
          ctx.addMessage('error', `Plan #${parts[2]} not found`);
        }
      } else {
        ctx.addMessage('system', 'Usage: /plans [list|view <id>|rerun <id>]');
      }
      break;
    }

    case '/history': {
      const subCommand = parts[1];
      if (subCommand === 'search' && parts[2]) {
        const query = parts.slice(2).join(' ');
        const results = storage.searchChatHistory(query);
        if (results.length === 0) {
          ctx.addMessage('system', `No matches for "${query}"`);
        } else {
          const list = results.slice(-5).map((m: { timestamp: string; content: string }) =>
            `${new Date(m.timestamp).toLocaleTimeString()}: ${m.content.substring(0, 60)}...`
          ).join('\n');
          ctx.addMessage('system', `\u{1F50D} Found ${results.length} matches:\n${list}`);
        }
      } else if (subCommand === 'clear') {
        ctx.addMessage('system', 'History is preserved per session. Start a new session for fresh history.');
      } else {
        const history = storage.getChatHistory(5);
        if (history.length === 0) {
          ctx.addMessage('system', 'No chat history yet.');
        } else {
          const list = history.map((m: { role: string; content: string }) =>
            `${m.role}: ${m.content.substring(0, 50)}...`
          ).join('\n');
          ctx.addMessage('system', `Recent history:\n${list}\n\nUse /history search <query> to search.`);
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
              ctx.llmMessages.current.push({
                role: msg.role,
                content: msg.content,
              });
            }
          }
          ctx.addMessage('system', `\u2713 Loaded ${history.length} messages into context`);
        } else {
          ctx.addMessage('system', 'No history to load.');
        }
      } else if (subCommand === 'summary' || !subCommand) {
        // Enhanced context summary with model limits
        const msgCount = ctx.llmMessages.current.length;
        const estTokens = ctx.estimateContextTokens();
        const modelLimit = getModelContextLimit(ctx.actualProvider, ctx.actualModel);
        const percentage = Math.round((estTokens / modelLimit) * 100);
        const formatK = (n: number) => n >= 1000 ? `${Math.round(n / 1000)}K` : String(n);

        let status = '\u{1F7E2} Healthy';
        if (percentage > 90) status = '\u{1F534} Critical';
        else if (percentage > 80) status = '\u{1F7E1} Warning';
        else if (percentage > 60) status = '\u{1F7E0} Caution';

        ctx.addMessage('system', `**Context Status: ${status}**

**Usage:** ${formatK(estTokens)} / ${formatK(modelLimit)} tokens (${percentage}%)
**Messages:** ${msgCount}
**Provider:** ${ctx.actualProvider}
**Model:** ${ctx.actualModel}

**Commands:**
  /summarize compact - Auto-compress context
  /context load [n]  - Load n messages from history
  /clear             - Start fresh`);
      } else {
        ctx.addMessage('system', 'Usage: /context [load [n]|summary]\n\nShow context status or load history.');
      }
      break;
    }

    case '/scope':
    case '/dirs': {
      const subCmd = parts[1];
      if (subCmd === 'details' || subCmd === 'full') {
        ctx.addMessage('system', getScopeDetails());
      } else if (subCmd === 'reset') {
        resetScope(process.cwd());
        ctx.addMessage('system', '\u2713 Scope reset to current directory only');
      } else {
        ctx.addMessage('system', getScopeSummary());
      }
      break;
    }

    case '/add-dir': {
      const dirPath = parts.slice(1).join(' ').replace(/^["']|["']$/g, '');
      if (!dirPath) {
        ctx.addMessage('system', 'Usage: /add-dir <path>\n\nAdd a directory to the allowed scope.\nThe agent can only access files within scope.');
      } else {
        const result = addToScope(dirPath);
        if (result.success) {
          ctx.addMessage('system', `\u2713 ${result.message}`);
        } else {
          ctx.addMessage('error', result.message);
        }
      }
      break;
    }

    case '/remove-dir': {
      const dirPath = parts.slice(1).join(' ').replace(/^["']|["']$/g, '');
      if (!dirPath) {
        ctx.addMessage('system', 'Usage: /remove-dir <path>\n\nRemove a directory from the allowed scope.');
      } else {
        const result = removeFromScope(dirPath);
        if (result.success) {
          ctx.addMessage('system', `\u2713 ${result.message}`);
        } else {
          ctx.addMessage('error', result.message);
        }
      }
      break;
    }

    case '/trust':
    case '/untrust': {
      const { checkTrust, trustProject, untrustProject, listTrustedProjects, removeFromRegistry } = await import('../trust.js');
      const trustSubCmd = command === '/untrust' ? 'remove' : (parts[1] || 'status');

      if (trustSubCmd === 'status') {
        const trust = checkTrust(process.cwd());
        ctx.addMessage('system', `Trust: ${trust.trusted ? '✓ Trusted' : '✗ Untrusted'}\n${trust.reason}${trust.changed ? '\n⚠️ CALLIOPE.md has changed since trust was granted' : ''}`);
      } else if (trustSubCmd === 'add' || trustSubCmd === 'yes') {
        const dir = parts[2] || process.cwd();
        trustProject(dir, parts.slice(3).join(' ') || undefined);
        ctx.addMessage('system', `✓ Trusted: ${dir}`);
      } else if (trustSubCmd === 'remove' || trustSubCmd === 'no') {
        const dir = parts[2] || process.cwd();
        if (command === '/untrust') {
          untrustProject(parts[1] || process.cwd());
        } else {
          untrustProject(dir);
        }
        ctx.addMessage('system', `✗ Untrusted: ${command === '/untrust' ? (parts[1] || process.cwd()) : dir}`);
      } else if (trustSubCmd === 'list') {
        const projects = listTrustedProjects();
        if (projects.length === 0) {
          ctx.addMessage('system', 'No projects in trust registry.');
        } else {
          const list = projects.map(p =>
            `  ${p.entry.trusted ? '✓' : '✗'} ${p.path}${p.entry.note ? ` (${p.entry.note})` : ''}`
          ).join('\n');
          ctx.addMessage('system', `Trust registry:\n${list}`);
        }
      } else if (trustSubCmd === 'clear') {
        const dir = parts[2] || process.cwd();
        removeFromRegistry(dir);
        ctx.addMessage('system', `Removed from trust registry: ${dir}`);
      } else {
        ctx.addMessage('system', 'Usage: /trust [status|add|remove|list|clear]\n  /trust add [path] - trust a project\n  /trust remove [path] - untrust a project\n  /untrust [path] - shortcut for /trust remove');
      }
      break;
    }

    case '/template':
    case '/t': {
      const subCmd = parts[1];
      if (subCmd === 'list' || !subCmd) {
        if (ctx.templates.length === 0) {
          ctx.addMessage('system', 'No templates saved.\n\nUsage:\n  /template save <name> <prompt>\n  /template use <name>\n  /template delete <name>');
        } else {
          const list = ctx.templates.map((t, i) =>
            `  ${i + 1}. ${t.name}: "${t.prompt.substring(0, 50)}${t.prompt.length > 50 ? '...' : ''}"`
          ).join('\n');
          ctx.addMessage('system', `Templates:\n${list}`);
        }
      } else if (subCmd === 'save' && parts[2]) {
        const name = parts[2];
        const prompt = parts.slice(3).join(' ').replace(/^["']|["']$/g, '');
        if (!prompt) {
          ctx.addMessage('error', 'Usage: /template save <name> "<prompt>"');
        } else {
          storage.saveTemplate(name, prompt);
          ctx.setTemplates(prev => {
            const filtered = (prev as PromptTemplate[]).filter(t => t.name !== name);
            return [...filtered, { name, prompt, createdAt: new Date() }];
          });
          ctx.addMessage('system', `\u2713 Template saved: ${name}`);
        }
      } else if (subCmd === 'use' && parts[2]) {
        const name = parts[2];
        const template = ctx.templates.find(t => t.name === name);
        if (template) {
          ctx.setInput(template.prompt);
          ctx.addMessage('system', `\u2713 Template loaded: ${name} (press Enter to send)`);
        } else {
          ctx.addMessage('error', `Template not found: ${name}`);
        }
      } else if (subCmd === 'delete' && parts[2]) {
        const name = parts[2];
        const found = ctx.templates.find(t => t.name === name);
        if (found) {
          storage.deleteTemplate(name);
          ctx.setTemplates(prev => (prev as PromptTemplate[]).filter(t => t.name !== name));
          ctx.addMessage('system', `\u2713 Template deleted: ${name}`);
        } else {
          ctx.addMessage('error', `Template not found: ${name}`);
        }
      } else {
        ctx.addMessage('system', 'Usage: /template [list|save <name> <prompt>|use <name>|delete <name>]');
      }
      break;
    }

    case '/cost':
    case '/costs': {
      const subCmd = parts[1];
      if (subCmd === 'reset') {
        storage.resetCosts();
        ctx.addMessage('system', '\u2713 Cost tracking reset');
      } else {
        ctx.addMessage('system', storage.getCostSummary());
      }
      break;
    }

    case '/bookmark':
    case '/bm': {
      const subCmd = parts[1];
      if (!subCmd || subCmd === 'list') {
        // List bookmarks
        if (ctx.bookmarks.length === 0) {
          ctx.addMessage('system', 'No bookmarks. Use /bookmark "name" to create one.');
        } else {
          const list = ctx.bookmarks.map((b, i) =>
            `  ${i + 1}. \u{1F516} ${b.name} (message #${b.messageIndex})`
          ).join('\n');
          ctx.addMessage('system', `Bookmarks:\n${list}\n\nUse /bookmark goto <number> to jump.`);
        }
      } else if (subCmd === 'goto' && parts[2]) {
        const idx = parseInt(parts[2]) - 1;
        if (idx >= 0 && idx < ctx.bookmarks.length) {
          const bm = ctx.bookmarks[idx];
          // Save current state for undo
          ctx.saveUndoState();
          // Restore to bookmark point
          ctx.setMessages(ctx.messages.slice(0, bm.messageIndex + 1));
          ctx.llmMessages.current = ctx.llmMessages.current.slice(0, bm.llmMessageIndex + 1);
          ctx.setContextTokens(ctx.estimateContextTokens());
          ctx.addMessage('system', `\u2713 Jumped to bookmark: ${bm.name}`);
        } else {
          ctx.addMessage('error', `Invalid bookmark number. Use /bookmark list to see available.`);
        }
      } else if (subCmd === 'delete' && parts[2]) {
        const idx = parseInt(parts[2]) - 1;
        if (idx >= 0 && idx < ctx.bookmarks.length) {
          const removed = ctx.bookmarks[idx];
          ctx.setBookmarks(prev => (prev as Bookmark[]).filter((_, i) => i !== idx));
          ctx.addMessage('system', `\u2713 Deleted bookmark: ${removed.name}`);
        } else {
          ctx.addMessage('error', 'Invalid bookmark number.');
        }
      } else {
        // Create bookmark with given name
        const name = parts.slice(1).join(' ').replace(/^["']|["']$/g, '');
        const bm: Bookmark = {
          id: `bm_${Date.now()}`,
          name,
          messageIndex: ctx.messages.length - 1,
          llmMessageIndex: ctx.llmMessages.current.length - 1,
          timestamp: new Date(),
        };
        ctx.setBookmarks(prev => [...(prev as Bookmark[]), bm]);
        ctx.addMessage('system', `\u{1F516} Bookmark created: "${name}"`);
      }
      break;
    }

    case '/queue':
    case '/q': {
      // /q is now queue, use /exit to quit
      if (command === '/q' && !parts[1]) {
        // Just /q with no args shows queue
        if (ctx.queuedMessages.length === 0) {
          ctx.addMessage('system', 'No messages queued. Type while agent is processing to queue feedback.');
        } else {
          const list = ctx.queuedMessages.map((m, i) => `  ${i + 1}. ${m.substring(0, 60)}${m.length > 60 ? '...' : ''}`).join('\n');
          ctx.addMessage('system', `\u{1F4E8} Queued messages (${ctx.queuedMessages.length}):\n${list}\n\nUse /queue clear to remove all.`);
        }
        break;
      }
      const subCmd = parts[1];
      if (subCmd === 'clear') {
        const count = ctx.queuedMessages.length;
        ctx.setQueuedMessages([]);
        ctx.addMessage('system', `\u2713 Cleared ${count} queued message${count !== 1 ? 's' : ''}`);
      } else if (subCmd === 'show' || !subCmd) {
        if (ctx.queuedMessages.length === 0) {
          ctx.addMessage('system', 'No messages queued.');
        } else {
          const list = ctx.queuedMessages.map((m, i) => `  ${i + 1}. ${m}`).join('\n');
          ctx.addMessage('system', `\u{1F4E8} Queued messages:\n${list}`);
        }
      } else if (subCmd === 'flush') {
        // Force-process queued messages even if stuck
        if (ctx.queuedMessages.length === 0) {
          ctx.addMessage('system', 'No messages to flush.');
        } else {
          const queued = [...ctx.queuedMessages];
          ctx.setQueuedMessages([]);
          ctx.setIsProcessing(false); // Force reset processing state
          ctx.setThinkingState(null);
          ctx.setStreamingResponse('');
          ctx.addMessage('system', `\u{1F504} Flushing ${queued.length} queued message(s)...`);
          const followUp = queued.length === 1
            ? queued[0]
            : `[Multiple follow-up messages:]\n${queued.map((m, i) => `${i + 1}. ${m}`).join('\n')}`;
          setTimeout(() => {
            ctx.setIsProcessing(true);
            ctx.runAgent(followUp).finally(() => {
              ctx.setIsProcessing(false);
              ctx.setThinkingState(null);
              ctx.setStreamingResponse('');
            });
          }, 50);
        }
      } else {
        ctx.addMessage('system', 'Usage: /queue [show|clear|flush]\n\nTip: Type while agent is processing to queue follow-up messages.');
      }
      break;
    }

    case '/flush': {
      // Shortcut for /queue flush - force-process queued messages
      if (ctx.queuedMessages.length === 0) {
        ctx.addMessage('system', 'No messages to flush. Use /debug to see current state.');
      } else {
        const queued = [...ctx.queuedMessages];
        ctx.setQueuedMessages([]);
        ctx.setIsProcessing(false); // Force reset processing state
        ctx.setThinkingState(null);
        ctx.setStreamingResponse('');
        ctx.addMessage('system', `\u{1F504} Flushing ${queued.length} queued message(s)...`);
        const followUp = queued.length === 1
          ? queued[0]
          : `[Multiple follow-up messages:]\n${queued.map((m, i) => `${i + 1}. ${m}`).join('\n')}`;
        setTimeout(() => {
          ctx.setIsProcessing(true);
          ctx.runAgent(followUp).finally(() => {
            ctx.setIsProcessing(false);
            ctx.setThinkingState(null);
            ctx.setStreamingResponse('');
          });
        }, 50);
      }
      break;
    }

    case '/debug': {
      const subCmd = parts[1];
      if (subCmd === 'on') {
        ctx.setDebugEnabled(true);
        ctx.addMessage('system', '\u{1F50D} Debug logging ON (output to stderr). Use /debug off to disable.');
      } else if (subCmd === 'off') {
        ctx.setDebugEnabled(false);
        ctx.addMessage('system', '\u{1F50D} Debug logging OFF');
      } else {
        // Show internal state for debugging stuck issues
        const debugInfo = [
          `isProcessing: ${ctx.isProcessing}`,
          `queuedMessages: ${ctx.queuedMessages.length}`,
          `modalMode: ${ctx.modalMode}`,
          `confirmMode: ${ctx.confirmMode}`,
          `loopActive: ${ctx.loopActive}`,
          `thinkingState: ${ctx.thinkingState ? JSON.stringify(ctx.thinkingState) : 'null'}`,
          `streamingResponse length: ${ctx.streamingResponse.length}`,
          `llmMessages count: ${ctx.llmMessages.current.length}`,
          `mode: ${ctx.mode}`,
          `debugEnabled: ${ctx.debugEnabled}`,
        ];
        ctx.addMessage('system', `\u{1F50D} Debug State:\n${debugInfo.join('\n')}\n\nUse /debug on|off to toggle logging.`);
      }
      break;
    }

    case '/unstick': {
      // Emergency reset of processing state
      ctx.setIsProcessing(false);
      ctx.setThinkingState(null);
      ctx.setStreamingResponse('');
      ctx.setLoopActive(false);
      ctx.setModalMode('none');
      ctx.setPendingComplexPrompt(null);
      // Also reset to hybrid mode if stuck in plan mode
      if (ctx.mode === 'plan') {
        ctx.setMode('hybrid');
        ctx.addMessage('system', '\u{1F527} Reset processing state + switched from plan to hybrid mode.');
      } else {
        ctx.addMessage('system', '\u{1F527} Reset processing state. You can now submit new messages.');
      }
      break;
    }

    case '/keys':
    case '/?': {
      // Show keybindings modal
      ctx.setModalMode('keys');
      break;
    }

    case '/work': {
      // Quick shortcut to enter work mode
      ctx.setMode('work');
      ctx.addMessage('system', `Mode: ${MODE_CONFIG['work'].icon} ${MODE_CONFIG['work'].label} - ${MODE_CONFIG['work'].description}`);
      break;
    }

    case '/plan': {
      // Quick shortcut to enter plan mode
      ctx.setMode('plan');
      ctx.addMessage('system', `Mode: ${MODE_CONFIG['plan'].icon} ${MODE_CONFIG['plan'].label} - ${MODE_CONFIG['plan'].description}`);
      break;
    }

    case '/approve': {
      // Approve a pending plan and start execution (#19)
      const approveMsg = parts.length > 1
        ? `Plan approved with notes: ${parts.slice(1).join(' ')}. Execute it step by step, updating progress as you complete each step.`
        : 'Plan approved. Execute it step by step, updating progress as you complete each step.';
      // Switch to work mode for execution
      ctx.setMode('work');
      ctx.addMessage('system', `${MODE_CONFIG['work'].icon} Switched to work mode for plan execution`);
      // Send approval as user message to the agent
      ctx.addMessage('user', approveMsg);
      await ctx.runAgent(approveMsg);
      break;
    }

    case '/resume': {
      // Resume a session by loading saved LLM message history
      // Usage: /resume [sessionId] - resume a specific session, or current session if no ID
      const targetSessionId = parts[1];
      if (targetSessionId) {
        const resumedSession = storage.setCurrentSessionById(targetSessionId);
        if (!resumedSession) {
          ctx.addMessage('system', `Session not found: ${targetSessionId}`);
          break;
        }
        ctx.sessionRef.current = resumedSession;
      }

      if (ctx.ledger) {
        ctx.ledger.loadSnapshot(storage.loadIterationLedger(targetSessionId || ctx.sessionRef.current?.id));
        if (ctx.sessionRef.current?.id) {
          storage.saveIterationLedger(ctx.ledger, ctx.sessionRef.current.id);
        }
      }

      // Try loading full message history first (preferred - preserves tool calls etc.)
      const savedMessages = storage.loadMessageHistory(targetSessionId);

      if (savedMessages && savedMessages.length > 0) {
        // Replace current LLM messages with saved ones
        ctx.llmMessages.current.length = 0;
        for (const msg of savedMessages) {
          ctx.llmMessages.current.push(msg as LLMMessage);
        }
        ctx.addMessage('system', `Restored ${savedMessages.length} messages from saved session${targetSessionId ? ` (${targetSessionId})` : ''}`);
        ctx.setContextTokens(ctx.estimateContextTokens());
      } else {
        // Fall back to chat.log history (legacy format, user/assistant only)
        const history = storage.getChatHistory(20, targetSessionId);
        if (history.length === 0) {
          ctx.addMessage('system', 'No previous messages to resume. Start a conversation first, messages are auto-saved.');
        } else {
          ctx.llmMessages.current.length = 0;
          ctx.llmMessages.current.push({
            role: 'system',
            content: buildFullSystemPrompt(getActiveProjectDir(ctx)),
          });
          for (const msg of history) {
            if (msg.role === 'user' || msg.role === 'assistant') {
              ctx.llmMessages.current.push({
                role: msg.role,
                content: msg.content,
              });
            }
          }
          ctx.addMessage('system', `Loaded ${history.length} messages from chat log (legacy format, tool context not preserved)`);
          ctx.setContextTokens(ctx.estimateContextTokens());
        }
      }
      break;
    }

    // ================================================================
    // Circuit Breaker
    // ================================================================

    case '/breaker':
    case '/cb': {
      const subCmd = parts[1];
      if (!ctx.circuitBreaker) {
        ctx.addMessage('system', 'Circuit breakers not initialized. They activate automatically during agent runs.');
        break;
      }

      if (subCmd === 'status' || !subCmd) {
        const statuses = ctx.circuitBreaker.getStatus();
        const stats = ctx.circuitBreaker.getTrackingStats();
        const health = ctx.circuitBreaker.getHealth();
        let msg = `Circuit Breaker Health: ${health.toUpperCase()}\n\n`;
        for (const s of statuses) {
          const icon = s.state === 'open' ? '\u{1f534}' : s.state === 'half-open' ? '\u{1f7e1}' : '\u{1f7e2}';
          msg += `${icon} ${s.type}: ${s.state} (tripped ${s.tripCount}x)`;
          if (s.lastEvent) msg += ` - ${s.lastEvent.message}`;
          msg += '\n';
        }
        msg += `\nTracking: ${stats.consecutiveErrors} consecutive errors, ${stats.totalTokens.toLocaleString()} total tokens, $${stats.totalCost.toFixed(2)} cost, ${stats.idleCount} idle`;
        ctx.addMessage('system', msg);
      } else if (subCmd === 'resume') {
        const breakerType = parts[2] as BreakerType | undefined;
        ctx.circuitBreaker.resume(breakerType);
        ctx.setBreakerHealth(ctx.circuitBreaker.getHealth());
        ctx.addMessage('system', `\u2713 Circuit breaker${breakerType ? ` "${breakerType}"` : 's'} resumed (half-open mode, 50% more generous thresholds)`);
      } else if (subCmd === 'reset') {
        const breakerType = parts[2] as BreakerType | undefined;
        ctx.circuitBreaker.reset(breakerType);
        ctx.setBreakerHealth(ctx.circuitBreaker.getHealth());
        ctx.addMessage('system', `\u2713 Circuit breaker${breakerType ? ` "${breakerType}"` : 's'} reset to closed`);
      } else if (subCmd === 'off') {
        config.set('circuitBreakersEnabled', false);
        // Also disable the current circuit breaker instance if it exists
        if (ctx.circuitBreaker) {
          ctx.circuitBreaker = undefined;
          ctx.setBreakerHealth?.('ok');
        }
        ctx.addMessage('system', '\u2713 Circuit breakers disabled');
      } else if (subCmd === 'on') {
        config.set('circuitBreakersEnabled', true);
        ctx.addMessage('system', '\u2713 Circuit breakers enabled');
      } else if (subCmd === 'adjust') {
        const breakerTypeString = parts[2];
        const param = parts[3];
        const rawValue = parts[4];
        
        // Handle special 'list' command to show detailed parameter info
        if (breakerTypeString === 'list') {
          ctx.addMessage('system', `Circuit Breaker Configuration Reference:

📊 REPEATED-FAILURE (Consecutive Errors)
  • maxConsecutiveErrors: Number of consecutive errors before tripping (default: 3)
  Example: /breaker adjust repeated-failure maxConsecutiveErrors 5

💰 COST-RUNAWAY (Spending Control)
  • maxSessionCost: Maximum total cost per session in USD (default: $5.0)
  • maxCostPerMinute: Maximum spending rate per minute in USD (default: $1.0)
  • windowSizeMs: Sliding window size for rate calculation in milliseconds (default: 60000)
  Examples:
    /breaker adjust cost-runaway maxSessionCost 10.0
    /breaker adjust cost-runaway maxCostPerMinute 2.0

🔄 INFINITE-LOOP (Repetitive Behavior)
  • maxIdenticalInWindow: Max identical tool calls in window before tripping (default: 3)
  • windowSize: Number of recent tool calls to analyze (default: 6)
  • detectOscillation: Detect A-B-A-B oscillation patterns (default: true)
  Examples:
    /breaker adjust infinite-loop maxIdenticalInWindow 5
    /breaker adjust infinite-loop detectOscillation false

🔥 TOKEN-BURN (Token Usage Limits)
  • maxTokensPerIteration: Max tokens per single iteration (default: 200,000)
  • maxTotalTokens: Max total tokens per session (default: 5,000,000)
  Examples:
    /breaker adjust token-burn maxTokensPerIteration 100000
    /breaker adjust token-burn maxTotalTokens 1000000

⏸️  STALL (Progress Detection)
  • maxIdleIterations: Max iterations with no tool calls/content (default: 5)
  Example: /breaker adjust stall maxIdleIterations 3

⏰ WALL-CLOCK (Time Limits)
  • maxSessionDurationMs: Max session duration in milliseconds (0 = unlimited, default: 0)
  • maxIterationDurationMs: Max single iteration duration in milliseconds (default: 600000 = 10 min)
  Examples:
    /breaker adjust wall-clock maxSessionDurationMs 3600000  # 1 hour
    /breaker adjust wall-clock maxIterationDurationMs 300000  # 5 minutes

Quick Commands:
  /breaker adjust <type>              - Show current settings for that type
  /breaker adjust                     - Show types overview
  /breaker status                     - Show current breaker states`);
          break;
        }

        // Show basic types overview if no type specified
        if (!breakerTypeString) {
          ctx.addMessage('system', `Circuit Breaker Types Available for Configuration:

  repeated-failure  - Consecutive errors before tripping
  cost-runaway      - Spending rate and total cost limits  
  infinite-loop     - Identical tool calls and oscillation detection
  token-burn        - Token usage per iteration and total limits
  stall             - Idle iterations without progress
  wall-clock        - Time-based session and iteration limits

Usage: /breaker adjust <type> [param] [value]
       /breaker adjust list                   - Show detailed parameter reference

Examples:
  /breaker adjust repeated-failure          - Show current settings
  /breaker adjust cost-runaway maxSessionCost 10.0
  /breaker adjust infinite-loop detectOscillation true`);
          break;
        }

        // Cast to BreakerType and validate
        const breakerType = breakerTypeString as BreakerType;
        const validTypes: BreakerType[] = ['repeated-failure', 'cost-runaway', 'infinite-loop', 'token-burn', 'stall', 'wall-clock'];
        if (!validTypes.includes(breakerType)) {
          ctx.addMessage('error', `Invalid breaker type "${breakerType}". Valid types: ${validTypes.join(', ')}`);
          break;
        }

        const currentConfig = ctx.circuitBreaker.getConfig();
        const breakerConfig = currentConfig.breakers[breakerType];

        // Show current configuration if no param specified
        if (!param) {
          let configDisplay = `${breakerType} Circuit Breaker Settings:\n`;
          
          switch (breakerType) {
            case 'repeated-failure':
              configDisplay += `  maxConsecutiveErrors: ${(breakerConfig as any).maxConsecutiveErrors} errors\n\nUsage: /breaker adjust repeated-failure <param> <value>\n  /breaker adjust repeated-failure maxConsecutiveErrors <number>`;
              break;
            case 'cost-runaway':
              configDisplay += `  maxSessionCost: ${(breakerConfig as any).maxSessionCost} per session\n  maxCostPerMinute: ${(breakerConfig as any).maxCostPerMinute} per minute\n  windowSizeMs: ${(breakerConfig as any).windowSizeMs}ms\n\nUsage: /breaker adjust cost-runaway <param> <value>\n  /breaker adjust cost-runaway maxSessionCost <dollars>\n  /breaker adjust cost-runaway maxCostPerMinute <dollars>\n  /breaker adjust cost-runaway windowSizeMs <milliseconds>`;
              break;
            case 'infinite-loop':
              configDisplay += `  maxIdenticalInWindow: ${(breakerConfig as any).maxIdenticalInWindow} calls\n  windowSize: ${(breakerConfig as any).windowSize} recent calls\n  detectOscillation: ${(breakerConfig as any).detectOscillation}\n\nUsage: /breaker adjust infinite-loop <param> <value>\n  /breaker adjust infinite-loop maxIdenticalInWindow <number>\n  /breaker adjust infinite-loop windowSize <number>\n  /breaker adjust infinite-loop detectOscillation <true|false>`;
              break;
            case 'token-burn':
              configDisplay += `  maxTokensPerIteration: ${(breakerConfig as any).maxTokensPerIteration.toLocaleString()} tokens\n  maxTotalTokens: ${(breakerConfig as any).maxTotalTokens.toLocaleString()} tokens\n\nUsage: /breaker adjust token-burn <param> <value>\n  /breaker adjust token-burn maxTokensPerIteration <number>\n  /breaker adjust token-burn maxTotalTokens <number>`;
              break;
            case 'stall':
              configDisplay += `  maxIdleIterations: ${(breakerConfig as any).maxIdleIterations} iterations\n\nUsage: /breaker adjust stall <param> <value>\n  /breaker adjust stall maxIdleIterations <number>`;
              break;
            case 'wall-clock':
              const sessionDuration = (breakerConfig as any).maxSessionDurationMs;
              const iterationDuration = (breakerConfig as any).maxIterationDurationMs;
              configDisplay += `  maxSessionDurationMs: ${sessionDuration === 0 ? 'unlimited' : sessionDuration + 'ms'}\n  maxIterationDurationMs: ${iterationDuration}ms (${Math.round(iterationDuration/60000)} minutes)\n\nUsage: /breaker adjust wall-clock <param> <value>\n  /breaker adjust wall-clock maxSessionDurationMs <milliseconds>\n  /breaker adjust wall-clock maxIterationDurationMs <milliseconds>`;
              break;
          }
          
          ctx.addMessage('system', configDisplay);
          break;
        }

        // Parse and validate the value
        let parsedValue: any;
        
        // Handle boolean parameters
        if (param === 'detectOscillation') {
          if (rawValue === 'true') parsedValue = true;
          else if (rawValue === 'false') parsedValue = false;
          else {
            ctx.addMessage('error', 'detectOscillation must be "true" or "false"');
            break;
          }
        } else {
          // Handle numeric parameters
          parsedValue = parseFloat(rawValue);
          if (isNaN(parsedValue) || parsedValue < 0) {
            ctx.addMessage('error', 'Value must be a non-negative number');
            break;
          }
        }

        // Validate parameter names for each breaker type
        const paramValidations: Record<BreakerType, { params: string[], validate?: (param: string, value: any) => string | null }> = {
          'repeated-failure': { 
            params: ['maxConsecutiveErrors'],
            validate: (param, value) => value <= 0 ? 'maxConsecutiveErrors must be > 0' : null
          },
          'cost-runaway': { 
            params: ['maxSessionCost', 'maxCostPerMinute', 'windowSizeMs'],
            validate: (param, value) => value <= 0 ? `${param} must be > 0` : null
          },
          'infinite-loop': { 
            params: ['maxIdenticalInWindow', 'windowSize', 'detectOscillation'],
            validate: (param, value) => {
              if (param === 'detectOscillation') return null; // boolean is already validated above
              return value <= 0 ? `${param} must be > 0` : null;
            }
          },
          'token-burn': { 
            params: ['maxTokensPerIteration', 'maxTotalTokens'],
            validate: (param, value) => value <= 0 ? `${param} must be > 0` : null
          },
          'stall': { 
            params: ['maxIdleIterations'],
            validate: (param, value) => value <= 0 ? 'maxIdleIterations must be > 0' : null
          },
          'wall-clock': { 
            params: ['maxSessionDurationMs', 'maxIterationDurationMs'],
            validate: (param, value) => {
              if (param === 'maxSessionDurationMs' && value === 0) return null; // 0 = unlimited is valid
              return value < 0 ? `${param} cannot be negative` : null;
            }
          }
        };

        const validation = paramValidations[breakerType];
        if (!validation.params.includes(param)) {
          ctx.addMessage('error', `Invalid parameter "${param}" for ${breakerType}. Valid parameters: ${validation.params.join(', ')}`);
          break;
        }

        // Run custom validation if provided
        if (validation.validate) {
          const error = validation.validate(param, parsedValue);
          if (error) {
            ctx.addMessage('error', error);
            break;
          }
        }

        // Update the configuration
        const oldValue = (breakerConfig as any)[param];
        ctx.circuitBreaker.adjust(breakerType, { [param]: parsedValue });

        // Format the success message based on parameter type
        let formattedOld: string, formattedNew: string;
        
        if (param === 'detectOscillation') {
          formattedOld = String(oldValue);
          formattedNew = String(parsedValue);
        } else if (param.includes('Cost')) {
          formattedOld = `${oldValue}`;
          formattedNew = `${parsedValue}`;
        } else if (param.includes('Ms')) {
          formattedOld = oldValue === 0 ? 'unlimited' : `${oldValue}ms`;
          formattedNew = parsedValue === 0 ? 'unlimited' : `${parsedValue}ms`;
        } else if (param.includes('Tokens')) {
          formattedOld = oldValue.toLocaleString();
          formattedNew = parsedValue.toLocaleString();
        } else {
          formattedOld = String(oldValue);
          formattedNew = String(parsedValue);
        }

        ctx.addMessage('system', `✅ ${breakerType} ${param}: ${formattedOld} → ${formattedNew}`)
      } else {
        ctx.addMessage('system', `Usage: /breaker [status|resume|reset|adjust|on|off]
  /breaker resume [type]  - Resume tripped breaker (half-open)
  /breaker reset [type]   - Reset breaker to closed
  /breaker adjust [type] [param] [value] - Configure breaker thresholds
  /breaker on|off         - Enable/disable circuit breakers

Breaker types: repeated-failure, cost-runaway, infinite-loop, token-burn, stall, wall-clock

Quick help:
  /breaker adjust         - Show types overview
  /breaker adjust list    - Show detailed parameter reference`);
      }
      break;
    }

    // ================================================================
    // Smart Routing
    // ================================================================

    case '/smart': {
      const subCmd = parts[1];
      if (subCmd === 'on') {
        ctx.setSmartRouteActive(true);
        config.set('smartRoutingEnabled', true);
        ctx.addMessage('system', '\u2713 Smart routing ON - best model selected across all providers');
      } else if (subCmd === 'off') {
        ctx.setSmartRouteActive(false);
        config.set('smartRoutingEnabled', false);
        ctx.addMessage('system', '\u2713 Smart routing OFF - using fixed provider/model');
      } else if (subCmd === 'cost' && parts[2]) {
        const sensitivity = parseFloat(parts[2]);
        if (isNaN(sensitivity) || sensitivity < 0 || sensitivity > 1) {
          ctx.addMessage('error', 'Cost sensitivity must be between 0 (best quality) and 1 (cheapest)');
        } else {
          config.set('smartRoutingCostSensitivity', sensitivity);
          ctx.addMessage('system', `\u2713 Smart routing cost sensitivity set to ${sensitivity} (0=quality, 1=cost)`);
        }
      } else if (subCmd === 'test' && parts[2]) {
        const testMsg = parts.slice(2).join(' ');
        const routingConfig: SmartRoutingConfig = ctx.smartRoutingConfig || {
          ...getDefaultSmartRoutingConfig(),
          enabled: true,
          costSensitivity: config.get('smartRoutingCostSensitivity') ?? 0.3,
        };
        const decision = smartRoute(testMsg, routingConfig);
        const taskInfo = detectTaskType(testMsg);
        let msg = `Smart Route Test:\n`;
        msg += `  Task type: ${taskInfo.taskType} (${Math.round(taskInfo.confidence * 100)}% confidence)\n`;
        msg += `  Complexity: ${decision.complexity}\n`;
        msg += `  Selected: ${decision.selected.provider}/${decision.selected.model} (${decision.selected.tier} tier)\n`;
        msg += `  Score: ${(decision.selected.score * 100).toFixed(1)}\n`;
        if (decision.alternatives.length > 0) {
          msg += `  Alternatives:\n`;
          for (const alt of decision.alternatives.slice(0, 3)) {
            msg += `    - ${alt.provider}/${alt.model} (score: ${(alt.score * 100).toFixed(1)})\n`;
          }
        }
        ctx.addMessage('system', msg);
      } else {
        ctx.addMessage('system', `Smart routing: ${ctx.smartRouteActive ? 'ON' : 'OFF'}
Cost sensitivity: ${config.get('smartRoutingCostSensitivity') ?? 0.3}

Usage: /smart [on|off|cost <0-1>|test <message>]
  /smart on            - Enable cross-provider routing
  /smart off           - Disable, use fixed provider
  /smart cost <0-1>    - Set cost sensitivity (0=quality, 1=cheapest)
  /smart test <msg>    - Test routing decision for a message`);
      }
      break;
    }

    // ================================================================
    // Swarm Mode
    // ================================================================

    case '/checkpoint':
    case '/cp': {
      const { listCheckpoints, clearCheckpoints } = await import('../checkpoint.js');
      const cpSubCmd = parts[1] || 'list';

      if (cpSubCmd === 'list') {
        const filterPath = parts[2];
        const checkpoints = listCheckpoints(filterPath);
        if (checkpoints.length === 0) {
          ctx.addMessage('system', filterPath
            ? `No checkpoints found for: ${filterPath}`
            : 'No checkpoints found. Checkpoints are created automatically when files are overwritten.');
        } else {
          const list = checkpoints.slice(0, 20).map((cp, i) => {
            const relPath = path.relative(process.cwd(), cp.filePath);
            const time = new Date(cp.timestamp).toLocaleString();
            const size = cp.size > 1024 ? `${(cp.size / 1024).toFixed(1)}KB` : `${cp.size}B`;
            return `  ${i}. ${relPath} (${size}) - ${time}`;
          }).join('\n');
          ctx.addMessage('system', `Checkpoints (newest first):\n${list}${checkpoints.length > 20 ? `\n  ... and ${checkpoints.length - 20} more` : ''}`);
        }
      } else if (cpSubCmd === 'clear') {
        const days = parts[2] ? parseInt(parts[2]) : undefined;
        const removed = clearCheckpoints(days);
        ctx.addMessage('system', `Cleared ${removed} checkpoint${removed !== 1 ? 's' : ''}${days ? ` older than ${days} days` : ''}.`);
      } else {
        ctx.addMessage('system', 'Usage: /checkpoint [list|clear]\n  /checkpoint list [path] - list checkpoints\n  /checkpoint clear [days] - clear old checkpoints\n  /restore <path> [index] - restore a file');
      }
      break;
    }

    case '/restore': {
      const { restoreCheckpoint, listCheckpoints } = await import('../checkpoint.js');
      const restorePath = parts[1];

      if (!restorePath) {
        ctx.addMessage('error', 'Usage: /restore <path> [index]\n  Restores a file from its most recent checkpoint.\n  Use /checkpoint list to see available checkpoints.');
        break;
      }

      const idx = parts[2] ? parseInt(parts[2]) : 0;
      const absRestorePath = path.resolve(restorePath);
      const checkpoints = listCheckpoints(absRestorePath);

      if (checkpoints.length === 0) {
        ctx.addMessage('error', `No checkpoints found for: ${restorePath}`);
        break;
      }

      const restored = restoreCheckpoint(absRestorePath, idx);
      if (restored !== undefined) {
        const relPath = path.relative(process.cwd(), absRestorePath);
        const cp = checkpoints[idx];
        ctx.addMessage('system', `✓ Restored ${relPath} from checkpoint (${new Date(cp.timestamp).toLocaleString()})`);
      } else {
        ctx.addMessage('error', `Failed to restore: checkpoint index ${idx} not found for ${restorePath}`);
      }
      break;
    }

    // ================================================================
    case '/exit':
    case '/quit':
      process.exit(0);

    default:
      ctx.addMessage('error', `Unknown command: ${command}. Type /help for help.`);
  }
}
