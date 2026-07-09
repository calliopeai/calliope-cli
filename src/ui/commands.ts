/**
 * UI Module - Command Handler
 *
 * Handles the slash commands exposed by the TUI. The surface is intentionally
 * small: see COMMAND_NAMES for the canonical list. Legacy/verbose commands have
 * been folded into subcommands of the survivors (e.g. /models -> /model list,
 * /add-dir -> /scope add, /set -> /config set, /breakloop -> /loop stop).
 */

import * as fs from 'fs';
import * as path from 'path';
import React from 'react';
import * as config from '../config.js';
import { selectProvider, getAvailableProviders } from '../providers/index.js';
import { MODE_CONFIG } from '../types.js';
import { getSystemPromptForProvider } from '../local-model.js';
import { getAvailableModels, getModelContextLimit } from '../model-detection.js';
import * as storage from '../storage.js';
import * as mcp from '../mcp.js';
import * as skills from '../skills.js';
import * as summarization from '../summarization.js';
import { addToScope, removeFromScope, getScopeSummary, getScopeDetails, resetScope } from '../scope.js';
import { fleetConfigured, fleetActive, fleetStatus, fleetEnable, fleetDisable, fleetPostMessage } from '../fleet.js';
import { getTerminalImageInfo, getImageModeLabel } from '../terminal-image.js';
import { resetContextWarnings } from './context.js';
import * as memory from '../memory.js';
import { getBudgetCaps, hasBudgetCaps, loadProjectSpend } from '../budget.js';
import type { IterationLedger } from '../iteration-ledger.js';
import {
  resolveIterationLimit,
  formatIterationLimit,
  isFiniteIterationLimit,
} from '../iteration-limit.js';
import type { Message as LLMMessage, LLMProvider, Mode } from '../types.js';
import type { ModelInfo } from '../model-detection.js';
import type { Session } from '../storage.js';
import type { UIMessage, SessionStats, ThinkingState, ConversationSnapshot } from './types.js';

// ============================================================================
// Command registry
// ============================================================================

/**
 * Canonical list of every slash-command label handled by the switch in
 * handleCommand(). Tests assert this stays in lockstep with the switch and a
 * superset of the completion roots. `/quit` is the sole alias (of `/exit`);
 * `/fleet` is flag-gated in completions but always handled here.
 */
export const COMMAND_NAMES = [
  '/help',
  '/status',
  '/clear',
  '/exit',
  '/quit',
  '/model',
  '/provider',
  '/mode',
  '/undo',
  '/export',
  '/resume',
  '/compact',
  '/scope',
  '/memory',
  '/mcp',
  '/skills',
  '/config',
  '/setup',
  '/trust',
  '/cost',
  '/loop',
  '/restore',
  '/debug',
  '/fleet',
] as const;

// ============================================================================
// CommandContext
// ============================================================================

export interface CommandContext {
  // Current state
  actualProvider: LLMProvider;
  actualModel: string;
  model: string | undefined;
  mode: Mode;
  confirmMode: boolean;
  messages: UIMessage[];
  stats: SessionStats;
  loopActive: boolean;
  isProcessing: boolean;
  thinkingState: ThinkingState | null;
  streamingResponse: string;
  queuedMessages: string[];
  debugEnabled: boolean;
  modalMode: string;
  ledger?: IterationLedger;

  // State setters
  setProvider: (p: LLMProvider) => void;
  setModel: (m: string | undefined) => void;
  setMode: (m: Mode | ((prev: Mode) => Mode)) => void;
  setMessages: (msgs: UIMessage[]) => void;
  setStats: (s: SessionStats) => void;
  setModalMode: (m: string) => void;
  setAvailableModels: (m: ModelInfo[]) => void;
  setLoopActive: (v: boolean) => void;
  setLoopPrompt: (v: string) => void;
  setLoopMaxIterations: (v: number) => void;
  setLoopCompletionPromise: (v: string | undefined) => void;
  setLoopIteration: (v: number) => void;
  setContextTokens: (v: number) => void;
  setDebugEnabled: (v: boolean) => void;

  // Refs
  llmMessages: React.MutableRefObject<LLMMessage[]>;
  undoStack: React.MutableRefObject<ConversationSnapshot[]>;
  redoStack: React.MutableRefObject<ConversationSnapshot[]>;
  loopCancelledRef: React.MutableRefObject<boolean>;
  sessionRef: React.MutableRefObject<Session | null>;

  // Callbacks
  addMessage: (type: UIMessage['type'], content: string) => void;
  estimateContextTokens: () => number;
  runLoop: (prompt: string, maxIter: number, completionPromise?: string) => void;
  startFleetPolling: () => void;
  openProviderPicker?: () => void;
}

// Builds the full system prompt including memory context (project + global).
// dir should be the project directory for the active/resumed session; provider
// selects the compact (local) vs full (cloud) base prompt (feature 5).
function buildFullSystemPrompt(dir: string, provider: LLMProvider): string {
  const base = getSystemPromptForProvider(provider);
  const mem = memory.buildMemoryContext(dir);
  return mem.trim() ? base + '\n\n--- Project Context ---\n' + mem : base;
}

function getActiveProjectDir(ctx: Pick<CommandContext, 'sessionRef'>): string {
  return ctx.sessionRef.current?.projectPath ?? process.cwd();
}

function formatSessionLogLimit(limit: number): string {
  return limit > 0 ? String(limit) : 'unlimited';
}

/**
 * Apply a `budget.*` config key. `off`/`none`/empty clears the cap. Throws on an
 * invalid number so the caller's try/catch surfaces the message.
 */
function applyBudgetKey(field: 'maxCostPerRun' | 'maxTokensPerRun' | 'maxCostPerProject', value: string): string {
  const budget = { ...(config.get('budget') ?? {}) } as Record<string, number>;
  if (value === 'off' || value === 'none' || value === '') {
    delete budget[field];
    config.set('budget', budget);
    return `✓ ${field} cleared`;
  }
  const num = Number(value);
  if (isNaN(num) || num < 0) {
    throw new Error(`${field} must be a non-negative number (or 'off' to clear)`);
  }
  budget[field] = field === 'maxTokensPerRun' ? Math.floor(num) : num;
  config.set('budget', budget);
  const unit = field === 'maxTokensPerRun' ? ' tokens' : ' USD';
  return `✓ ${field} set to ${budget[field]}${unit}`;
}

// ============================================================================
// handleCommand
// ============================================================================

export async function handleCommand(cmd: string, ctx: CommandContext): Promise<void> {
  const parts = cmd.split(/\s+/);
  const command = parts[0]!.toLowerCase();

  switch (command) {
    case '/help': {
      let help = `Session
  /help                       Show this help
  /status                     Provider, model, tokens, terminal, fleet
  /clear                      Clear the conversation
  /exit                       Exit Calliope (alias /quit)

Model & Mode
  /model [name|list]          Switch model, or list/pick available models
  /provider [name|list]       Switch provider, or list providers
  /mode [plan|hybrid|work]    Switch mode (Shift+Tab to cycle)

Conversation
  /undo                       Undo the last change (up to 10 steps)
  /export [file.md]           Export conversation to markdown
  /resume [sessionId]         Resume a saved session (restores full context)
  /compact [status]           Compress conversation context; status shows a summary

Workspace
  /scope [add|remove <dir>]   File-access scope (also details|reset)
  /memory [init|add|show]     Project memory (CALLIOPE.md)
  /trust [add|remove|list]    Project trust registry
  /restore [<path> [index]]   List checkpoints, or restore a file

Extend
  /mcp [add|remove|tools]     MCP servers
  /skills [add|remove]        Agent skills

System
  /config [set <key> <value>] Show or change settings (maxIterations, sessionLogLimit, diffStyle, theme)
  /setup                      Reconfigure Calliope
  /cost                       Cost tracking summary
  /loop ["prompt"|stop]       Iterative agent loop
  /debug [on|off]             Debug state/logging`;

      if (fleetConfigured()) {
        help += `

Fleet
  /fleet [message|disable]    Multi-agent fleet coordination`;
      }

      help += `

File references: @filename, ./path, /absolute/path`;
      ctx.addMessage('system', help);
      break;
    }

    case '/provider':
      if (parts[1] && parts[1] !== 'list') {
        const requested = parts[1].toLowerCase() as LLMProvider;
        const available = getAvailableProviders();
        if (!available.includes(requested)) {
          ctx.addMessage('error',
            `Provider "${requested}" is not configured. Run /provider (no args) for an interactive picker with setup.`);
          break;
        }
        ctx.setProvider(requested);
        ctx.addMessage('system', `Provider: ${selectProvider(requested)}`);
      } else if (parts[1] === 'list') {
        ctx.addMessage('system', `Provider: ${ctx.actualProvider} | Available: ${getAvailableProviders().join(', ')}`);
      } else if (ctx.openProviderPicker) {
        ctx.openProviderPicker();
      } else {
        ctx.addMessage('system', `Provider: ${ctx.actualProvider} | Available: ${getAvailableProviders().join(', ')}`);
      }
      break;

    case '/model':
      if (parts[1] && parts[1] !== 'list') {
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
          switchWarning = `\n⚠️  Context at ${newPct}% of new model limit (${Math.round(currentTokens/1000)}K/${Math.round(newLimit/1000)}K). Consider /compact.`;
        } else if (newLimit < oldLimit) {
          switchWarning = `\n📉 Context window: ${Math.round(oldLimit/1000)}K → ${Math.round(newLimit/1000)}K (${newPct}% used)`;
        }
        ctx.addMessage('system', `Model: ${oldModel} → ${newModel}${switchWarning}`);
      } else {
        // No arg or `list`: open the model picker (absorbs the old /models listing)
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
      ctx.setMessages([]);
      ctx.llmMessages.current = [{ role: 'system', content: buildFullSystemPrompt(getActiveProjectDir(ctx), ctx.actualProvider) }];
      ctx.ledger?.reset();
      ctx.setStats({ inputTokens: 0, outputTokens: 0, cost: 0, messageCount: 0 });
      resetContextWarnings(); // Reset context warning state
      break;

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
      ctx.addMessage('system', `✓ Exported to ${filename}`);
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

      ctx.addMessage('system', `✓ Undone (${ctx.undoStack.current.length} more available)`);
      break;
    }

    case '/status': {
      const imgInfo = getTerminalImageInfo();
      let statusMsg = `${ctx.actualProvider}:${ctx.actualModel} | ${ctx.stats.messageCount} msgs | ${ctx.stats.inputTokens + ctx.stats.outputTokens} tokens | terminal: ${getImageModeLabel(imgInfo.mode)}${imgInfo.truecolor ? ' (truecolor)' : ''} ${imgInfo.width}cols`;

      // Add fleet status if active
      const fleetSt = fleetStatus();
      if (fleetSt) {
        statusMsg += `\nFleet: active (${fleetSt.nick}) | irc:${fleetSt.config?.ircAddr} | #${fleetSt.config?.channel}`;
      }

      // Show budget state when any cap is configured.
      const caps = getBudgetCaps();
      if (hasBudgetCaps(caps)) {
        const parts: string[] = [];
        if (typeof caps.maxCostPerRun === 'number') parts.push(`run<=$${caps.maxCostPerRun}`);
        if (typeof caps.maxTokensPerRun === 'number') parts.push(`run<=${caps.maxTokensPerRun}tok`);
        if (typeof caps.maxCostPerProject === 'number') {
          const spent = loadProjectSpend(getActiveProjectDir(ctx)).spentUsd;
          parts.push(`project $${spent.toFixed(4)}/$${caps.maxCostPerProject}`);
        }
        statusMsg += `\nBudget: ${parts.join(' | ')}`;
      }

      ctx.addMessage('system', statusMsg);
      break;
    }

    case '/fleet': {
      const subCmd = parts[1];

      if (subCmd === 'enable') {
        if (fleetActive()) {
          ctx.addMessage('system', 'Fleet mode is already active.');
          break;
        }
        const sessionId = ctx.sessionRef.current?.id || 'default';
        const cwd = getActiveProjectDir(ctx);
        fleetEnable(sessionId, cwd).then((enabled) => {
          if (enabled) {
            const status = fleetStatus();
            let msg = '✓ Fleet mode enabled\n';
            msg += `  Nick:      ${status?.nick}\n`;
            msg += `  IRC:       ${status?.config?.ircAddr}\n`;
            msg += `  Channel:   #${status?.config?.channel}`;
            ctx.addMessage('system', msg);
            ctx.startFleetPolling();
          } else {
            ctx.addMessage('system', 'Failed to enable fleet mode — check relay config (~/.config/scuttlebot-relay.env, .scuttlebot.yaml).');
          }
        }).catch((err: unknown) => {
          ctx.addMessage('system', `Failed to enable fleet mode: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }

      if (subCmd === 'disable') {
        if (!fleetConfigured() && !fleetActive()) {
          ctx.addMessage('system', 'Fleet mode is not enabled.');
          break;
        }
        fleetDisable().then(() => {
          ctx.addMessage('system', 'Fleet mode disabled.');
        }).catch((err: unknown) => {
          ctx.addMessage('system', `Error disabling fleet mode: ${err instanceof Error ? err.message : String(err)}`);
        });
        break;
      }

      if (!fleetActive()) {
        ctx.addMessage('system', 'Fleet mode is off.\n\nRun: /fleet enable\n\nRelay config is read from ~/.config/scuttlebot-relay.env and .scuttlebot.yaml.\nDocs: docs/fleet.md');
        break;
      }

      if (subCmd) {
        const message = parts.slice(1).join(' ');
        fleetPostMessage(message);
        ctx.addMessage('system', 'Message posted to the fleet channel.');
        break;
      }

      const status = fleetStatus();
      let statusText = 'Fleet Status\n────────────────────\n';
      statusText += `Nick:        ${status?.nick}\n`;
      statusText += `IRC:         ${status?.config?.ircAddr}\n`;
      statusText += `Channel:     #${status?.config?.channel}\n`;
      statusText += `Connected:   ${status?.connected ? 'yes' : 'no'}`;
      statusText += '\n\nCommands:\n  /fleet <message>  Post to the fleet channel\n  /fleet disable    Disable fleet mode';
      ctx.addMessage('system', statusText);
      break;
    }

    case '/config': {
      if (parts[1] === 'set') {
        // /config set <key> <value> (absorbs the old /set)
        const key = parts[2];
        const value = parts.slice(3).join(' ');
        if (!key || !value) {
          ctx.addMessage('system', `Usage: /config set <key> <value>
Available keys:
  maxIterations <number>                  - Max agent iterations (current: ${config.get('maxIterations')})
  sessionLogLimit <number>                - Cap retained session log items (current: ${formatSessionLogLimit(config.get('sessionLogLimit'))}, 0 = unlimited)
  collapseTools <bool>                    - Auto-collapse tool output
  toolDisplayLimit <number>               - Tools shown expanded (0 = all)
  diffStyle <inline|unified|side-by-side> - Diff display style
  sandboxMode <auto|native|docker|off>    - Code execution sandbox
  routing.enabled <bool>                  - Smart model routing
  routing.costSensitivity <0-1>           - Cost vs quality (0 = best, 1 = cheapest)
  theme <dark|light|no-color>             - Color theme
  budget.maxCostPerRun <usd|off>          - Halt a run at this spend (0/off = no cap)
  budget.maxTokensPerRun <n|off>          - Halt a run at this token count
  budget.maxCostPerProject <usd|off>      - Halt when project spend reaches this
  audit.enabled <bool>                    - Audit run log (on by default)
  policy.command <path|off>               - Pre-tool policy hook script`);
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
            ctx.addMessage('system', `✓ maxIterations set to ${formatIterationLimit(resolveIterationLimit(num))}`);
          } else if (key === 'sessionLogLimit') {
            const num = parseInt(value, 10);
            if (isNaN(num) || num < 0 || num > 100000) {
              ctx.addMessage('error', 'sessionLogLimit must be 0-100000 (0 = unlimited)');
              break;
            }
            config.set('sessionLogLimit', num);
            ctx.ledger?.setRetentionLimit(num);
            ctx.addMessage('system', `✓ sessionLogLimit set to ${num === 0 ? 'unlimited (set > 0 to cap)' : num}`);
          } else if (key === 'collapseTools') {
            const bool = value === 'true';
            config.set('collapseTools', bool);
            ctx.addMessage('system', `✓ collapseTools set to ${bool}`);
          } else if (key === 'toolDisplayLimit') {
            const num = parseInt(value, 10);
            if (isNaN(num) || num < 0 || num > 100) {
              ctx.addMessage('error', 'toolDisplayLimit must be 0-100 (0 = all expanded)');
              break;
            }
            config.set('toolDisplayLimit', num);
            ctx.addMessage('system', `✓ toolDisplayLimit set to ${num}`);
          } else if (key === 'diffStyle') {
            if (value !== 'inline' && value !== 'unified' && value !== 'side-by-side') {
              ctx.addMessage('error', 'diffStyle must be inline, unified, or side-by-side');
              break;
            }
            config.set('diffStyle', value);
            ctx.addMessage('system', `✓ diffStyle set to ${value}`);
          } else if (key === 'sandboxMode') {
            if (value !== 'auto' && value !== 'native' && value !== 'docker' && value !== 'off') {
              ctx.addMessage('error', 'sandboxMode must be auto, native, docker, or off');
              break;
            }
            config.set('sandboxMode', value);
            ctx.addMessage('system', `✓ sandboxMode set to ${value}`);
          } else if (key === 'routing.enabled') {
            const bool = value === 'true';
            const routing = config.get('routing') ?? { enabled: false, costSensitivity: 0.3 };
            config.set('routing', { ...routing, enabled: bool });
            ctx.addMessage('system', `✓ routing.enabled set to ${bool}`);
          } else if (key === 'routing.costSensitivity') {
            const num = Number(value);
            if (isNaN(num) || num < 0 || num > 1) {
              ctx.addMessage('error', 'routing.costSensitivity must be between 0 and 1');
              break;
            }
            const routing = config.get('routing') ?? { enabled: false, costSensitivity: 0.3 };
            config.set('routing', { ...routing, costSensitivity: num });
            ctx.addMessage('system', `✓ routing.costSensitivity set to ${num}`);
          } else if (key === 'theme') {
            const themes = await import('../themes.js');
            if (themes.setCurrentTheme(value)) {
              themes.clearThemeCache();
              ctx.addMessage('system', `✓ theme set to ${value}`);
            } else {
              ctx.addMessage('error', `Theme not found: ${value}. Options: dark, light, no-color`);
            }
          } else if (key === 'budget.maxCostPerRun') {
            ctx.addMessage('system', applyBudgetKey('maxCostPerRun', value));
          } else if (key === 'budget.maxTokensPerRun') {
            ctx.addMessage('system', applyBudgetKey('maxTokensPerRun', value));
          } else if (key === 'budget.maxCostPerProject') {
            ctx.addMessage('system', applyBudgetKey('maxCostPerProject', value));
          } else if (key === 'audit.enabled') {
            const bool = value === 'true';
            config.set('audit', { ...(config.get('audit') ?? {}), enabled: bool });
            ctx.addMessage('system', `✓ audit.enabled set to ${bool}`);
          } else if (key === 'policy.command') {
            const policy = { ...(config.get('policy') ?? {}) } as Record<string, unknown>;
            if (value === 'off' || value === 'none') {
              delete policy.command;
              config.set('policy', policy);
              ctx.addMessage('system', '✓ policy.command cleared');
            } else {
              config.set('policy', { ...policy, command: value });
              ctx.addMessage('system', '✓ policy.command set');
            }
          } else {
            ctx.addMessage('error', `Unknown config key: ${key}`);
          }
        } catch (err) {
          ctx.addMessage('error', `Failed to set ${key}: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else {
        ctx.addMessage('system', `Config: ${config.getConfigPath()}\nProviders: ${config.getConfiguredProviders().join(', ') || 'none'}\nmaxIterations: ${config.get('maxIterations')}\nsessionLogLimit: ${formatSessionLogLimit(config.get('sessionLogLimit'))} (set > 0 to cap)\n\nChange a setting with /config set <key> <value>`);
      }
      break;
    }

    case '/setup':
      ctx.addMessage('system', 'Run `calliope --setup` to reconfigure.');
      break;

    case '/loop': {
      // /loop stop absorbs the old /cancel-loop, /breakloop, /stop
      if (parts[1] === 'stop') {
        if (ctx.loopActive) {
          ctx.loopCancelledRef.current = true;
          ctx.setLoopActive(false);
          ctx.addMessage('system', '\u{1F6D1} Loop cancelled');
        } else {
          ctx.addMessage('system', 'No active loop to cancel');
        }
        break;
      }

      // Parse /loop "<prompt>" [--max-iterations N] [--completion-promise "text"]
      if (ctx.loopActive) {
        ctx.addMessage('system', 'Loop already running. Use /loop stop to stop it first.');
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
      if (quotedMatch) prompt = quotedMatch[1]!;

      if (!prompt) {
        ctx.addMessage('system', `Usage: /loop "<prompt>" [--max-iterations N] [--completion-promise "text"]
Example: /loop "Build a REST API" --max-iterations 50 --completion-promise "DONE"
Stop a running loop with /loop stop`);
        break;
      }

      const defaultMaxIterations = resolveIterationLimit(config.get('maxIterations'));
      const loopMaxIterations = maxIterMatch
        ? resolveIterationLimit(parseInt(maxIterMatch[1]!, 10))
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
  Use /loop stop to stop`);

      // Start the loop execution (non-blocking)
      ctx.runLoop(prompt, loopMaxIterations, completionMatch?.[1]);
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
            const status = s.status === 'connected' ? '\u{1F7E2}' : s.status === 'error' ? '\u{1F534}' : '⚪';
            return `${status} ${s.name} (${s.tools.length} tools)\n   ${s.url}`;
          }).join('\n\n');
          ctx.addMessage('system', `MCP Servers:\n\n${list}`);
        }
      } else if (subCmd === 'add' && parts[2]) {
        const url = parts[2];
        ctx.addMessage('system', `Registering MCP server: ${url}...`);
        try {
          const server = await mcp.registerServer(url);
          ctx.addMessage('system', `✓ Registered: ${server.name} (${server.tools.length} tools)`);
        } catch (e) {
          ctx.addMessage('error', `Failed to register: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if ((subCmd === 'remove' || subCmd === 'rm') && parts[2]) {
        if (mcp.unregisterServer(parts[2])) {
          ctx.addMessage('system', '✓ Server removed');
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
          const list = tools.map(t => `• ${t.name}\n  ${t.description}`).join('\n\n');
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
        // Show every installed skill with its trust state (#137) — including
        // CHANGED entries that getSkills() withholds from the model.
        const listed = skills.listSkills();
        if (listed.length === 0) {
          ctx.addMessage('system', 'No skills installed.\n\nUsage:\n  /skills add <name>     - Install from agentskills.io\n  /skills add <github-url> - Install from GitHub\n  /skills add <path>     - Install from local directory');
        } else {
          const list = listed.map(s => {
            const src = s.source === 'github' ? '(GitHub)' : s.source === 'registry' ? '(agentskills.io)' : '(local)';
            const trust =
              s.trust === 'pinned' ? (s.fingerprint ?? 'pinned') :
              s.trust === 'changed' ? 'CHANGED — reinstall to re-trust' :
              'UNVERIFIED';
            const desc = s.description ? `${s.description.substring(0, 80)}...` : '';
            return `• ${s.name} ${src} [${trust}]\n  ${desc}`;
          }).join('\n\n');
          ctx.addMessage('system', `Installed Skills:\n\n${list}`);
        }
      } else if (subCmd === 'add' && parts[2]) {
        const source = parts[2];
        ctx.addMessage('system', `Installing skill: ${source}...`);
        // Snapshot pinned fingerprints so a re-install can show old→new rather
        // than re-pinning silently (#137). The remote name is only known after
        // the fetch, so we key the lookup by the returned skill's name.
        const priorFingerprints = new Map(skills.listSkills().map(s => [s.name, s.fingerprint]));
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
            const prev = priorFingerprints.get(skill.metadata.name);
            const now = skill.fingerprint ?? '(unverified)';
            if (prev && prev !== skill.fingerprint) {
              ctx.addMessage('system', `✓ Re-pinned ${skill.metadata.name}: ${prev} → ${now} (content updated)`);
            } else {
              ctx.addMessage('system', `✓ Installed ${skill.metadata.name} — pinned ${now} (trust-on-first-use)`);
            }
          } else {
            ctx.addMessage('error', 'Failed to install skill');
          }
        } catch (e) {
          ctx.addMessage('error', `Failed: ${e instanceof Error ? e.message : String(e)}`);
        }
      } else if ((subCmd === 'remove' || subCmd === 'rm') && parts[2]) {
        if (skills.uninstallSkill(parts[2])) {
          ctx.addMessage('system', '✓ Skill removed');
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
          info += skill.fingerprint ? `Fingerprint: ${skill.fingerprint} (${skill.trust})\n` : 'Fingerprint: none (UNVERIFIED)\n';
          ctx.addMessage('system', info);
        } else {
          // getSkill withholds a tampered skill; surface WHY, not a bare
          // "not found", so the trust state stays visible (#137).
          const changed = skills.listSkills().find(s => s.name === parts[2] && s.trust === 'changed');
          if (changed) {
            ctx.addMessage('error', `Skill "${parts[2]}" CHANGED since install (pinned ${changed.fingerprint}) — content no longer matches. Reinstall to re-trust.`);
          } else {
            ctx.addMessage('error', 'Skill not found');
          }
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

    case '/scope': {
      const subCmd = parts[1];
      if (subCmd === 'add') {
        // Absorbs the old /add-dir
        const dirPath = parts.slice(2).join(' ').replace(/^["']|["']$/g, '');
        if (!dirPath) {
          ctx.addMessage('system', 'Usage: /scope add <path>\n\nAdd a directory to the allowed scope.\nThe agent can only access files within scope.');
        } else {
          const result = addToScope(dirPath);
          if (result.success) {
            ctx.addMessage('system', `✓ ${result.message}`);
          } else {
            ctx.addMessage('error', result.message);
          }
        }
      } else if (subCmd === 'remove') {
        // Absorbs the old /remove-dir
        const dirPath = parts.slice(2).join(' ').replace(/^["']|["']$/g, '');
        if (!dirPath) {
          ctx.addMessage('system', 'Usage: /scope remove <path>\n\nRemove a directory from the allowed scope.');
        } else {
          const result = removeFromScope(dirPath);
          if (result.success) {
            ctx.addMessage('system', `✓ ${result.message}`);
          } else {
            ctx.addMessage('error', result.message);
          }
        }
      } else if (subCmd === 'details' || subCmd === 'full') {
        ctx.addMessage('system', getScopeDetails());
      } else if (subCmd === 'reset') {
        resetScope(process.cwd());
        ctx.addMessage('system', '✓ Scope reset to current directory only');
      } else {
        ctx.addMessage('system', getScopeSummary());
      }
      break;
    }

    case '/trust': {
      const { checkTrust, trustProject, untrustProject, listTrustedProjects, removeFromRegistry } = await import('../trust.js');
      const trustSubCmd = parts[1] || 'status';

      if (trustSubCmd === 'status') {
        const trust = checkTrust(process.cwd());
        ctx.addMessage('system', `Trust: ${trust.trusted ? '✓ Trusted' : '✗ Untrusted'}\n${trust.reason}${trust.changed ? '\n⚠️ CALLIOPE.md has changed since trust was granted' : ''}`);
      } else if (trustSubCmd === 'add' || trustSubCmd === 'yes') {
        const dir = parts[2] || process.cwd();
        trustProject(dir, parts.slice(3).join(' ') || undefined);
        ctx.addMessage('system', `✓ Trusted: ${dir}`);
      } else if (trustSubCmd === 'remove' || trustSubCmd === 'no') {
        // Absorbs the old /untrust
        const dir = parts[2] || process.cwd();
        untrustProject(dir);
        ctx.addMessage('system', `✗ Untrusted: ${dir}`);
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
        ctx.addMessage('system', 'Usage: /trust [status|add|remove|list|clear]\n  /trust add [path]    - trust a project\n  /trust remove [path] - untrust a project');
      }
      break;
    }

    case '/cost': {
      const subCmd = parts[1];
      if (subCmd === 'reset') {
        storage.resetCosts();
        ctx.addMessage('system', '✓ Cost tracking reset');
      } else {
        ctx.addMessage('system', storage.getCostSummary());
      }
      break;
    }

    case '/compact': {
      const subCmd = parts[1];
      if (subCmd === 'status') {
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
      } else {
        // Default: summarize and compact the conversation
        const result = summarization.summarizeConversation(ctx.llmMessages.current, { maxTokens: 50000 });
        if (result.summarizedCount > 0) {
          ctx.llmMessages.current = result.messages;
          ctx.setContextTokens(ctx.estimateContextTokens());
          ctx.addMessage('system', `✓ Compacted ${result.summarizedCount} messages (${result.originalTokens} → ${result.reducedTokens} tokens)`);
        } else {
          ctx.addMessage('system', 'Context already within limits, no compaction needed.');
        }
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
            content: buildFullSystemPrompt(getActiveProjectDir(ctx), ctx.actualProvider),
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

    case '/restore': {
      const { restoreFromCheckpoint, listCheckpoints } = await import('../checkpoint.js');
      const restorePath = parts[1];

      if (!restorePath) {
        // No arg: list available checkpoints (absorbs the old /checkpoint list)
        const checkpoints = listCheckpoints();
        if (checkpoints.length === 0) {
          ctx.addMessage('system', 'No checkpoints found. Checkpoints are created automatically (as git commits) before destructive tool calls, and require a git repository.');
        } else {
          const list = checkpoints.slice(0, 20).map((cp, i) => {
            const time = new Date(cp.timestamp).toLocaleString();
            return `  ${i}. ${cp.hash} ${cp.subject} - ${time}`;
          }).join('\n');
          ctx.addMessage('system', `Checkpoints (newest first):\n${list}${checkpoints.length > 20 ? `\n  ... and ${checkpoints.length - 20} more` : ''}\n\nUse /restore <path> [index] to restore a file.`);
        }
        break;
      }

      const idx = parts[2] ? parseInt(parts[2]) : 0;
      const absRestorePath = path.resolve(restorePath);
      const checkpoints = listCheckpoints(absRestorePath);

      if (checkpoints.length === 0) {
        ctx.addMessage('error', `No checkpoints found for: ${restorePath}`);
        break;
      }

      const restored = restoreFromCheckpoint(absRestorePath, idx);
      if (restored !== undefined) {
        const relPath = path.relative(process.cwd(), absRestorePath);
        const cp = checkpoints[idx]!;
        ctx.addMessage('system', `✓ Restored ${relPath} from checkpoint ${cp.hash} (${new Date(cp.timestamp).toLocaleString()})`);
      } else {
        ctx.addMessage('error', `Failed to restore: checkpoint index ${idx} not found for ${restorePath}`);
      }
      break;
    }

    case '/exit':
    case '/quit':
      process.exit(0);

    default:
      ctx.addMessage('error', `Unknown command: ${command}. Type /help for help.`);
  }
}
