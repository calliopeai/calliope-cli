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
import { getAgentStatusReport, swarmManager, councilManager, COUNCIL_TEMPLATES, getInstallReport, installItem, installAllMissing, listAgentDefs, listTeamDefs, getAgent, getTeam, scaffoldAgentsDir, saveAgentDef, getAvailableExecutors } from '../agents/index.js';
import type { AgentDefinition } from '../agents/index.js';
import type { DecompositionStrategy, AggregationStrategy, CouncilMode } from '../agents/index.js';
import { CircuitBreaker } from '../circuit-breaker.js';
import type { BreakerType } from '../circuit-breaker.js';
import { smartRoute, getDefaultSmartRoutingConfig, detectTaskType } from '../smart-router.js';
import type { SmartRoutingConfig } from '../smart-router.js';
import { getCurrentSkin, getCurrentPalette, applySkin, applyPalette, listSkins, listPalettes } from '../hud/api.js';
import { getCurrentCompanion, applyCompanion, listCompanions, getMoodText } from '../companions.js';
import { createJob, runJob, cancelJob, listJobs, getJob, formatJob, formatJobsList, clearFinishedJobs } from '../background-jobs.js';
import { listRecordings, loadRecording, formatRecording, deleteRecording } from '../terminal-recording.js';
import { startApiServer, stopApiServer, isApiServerRunning } from '../api-server.js';
import { getTerminalImageInfo, getImageModeLabel, renderSkinBanner, renderAsciiArt, colorFg, renderTransition } from '../terminal-image.js';
import { applyThemePack, listThemePacks, getCurrentPack, getCompanionMode, setCompanionMode, getThemePack } from '../hud/theme-packs/api.js';
import { getModelContextLimit } from '../model-detection.js';
import { resetContextWarnings } from './context.js';
import type { Message as LLMMessage, LLMProvider, AgentPersona, Mode, MessageContent, ToolCall } from '../types.js';
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
  persona: AgentPersona;
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
  agtermEnabled: boolean;
  debugEnabled: boolean;
  modalMode: string;
  circuitBreaker?: CircuitBreaker;
  smartRouteActive: boolean;
  smartRoutingConfig?: SmartRoutingConfig;

  // State setters
  setProvider: (p: LLMProvider) => void;
  setModel: (m: string | undefined) => void;
  setPersona: (p: AgentPersona) => void;
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
  /persona [name]            - Switch personality
  /route [on|off]            - Auto model routing (/autoroute)
  /smart [on|off|cost|test]  - Cross-provider smart routing
  /breaker [status|resume]   - Circuit breaker control (/cb)

--- Conversation ---
  /edit                      - Edit and resend last message
  /undo / /redo              - Undo/redo (up to 10 steps)
  /copy                      - Copy last response to clipboard
  /export [file.md]          - Export conversation to markdown
  /branch [new|switch]       - Conversation branches
  /clear                     - Clear conversation (/c)

--- Session & State ---
  /session [list|info|fork|save] - Session management (/sessions)
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
  /skin [name]               - Switch HUD skin (${(await import('../hud/api.js')).listSkins().length}+ available)
  /palette [name]            - Switch color palette
  /companion [name]          - Switch companion personality
  /pack [name]               - Apply theme pack (skin+palette+companion)
  /theme [name]              - Color themes
  /layout [name]             - UI layout (classic/split/etc)
  /density [normal|compact]  - Display density
  /collapse [tools|all|off]  - Tool output visibility
  /intensity [1-5]           - Immersion level
  /emoji [on|off]            - Toggle emoji
  /banner                    - Show skin banner art

--- Tools & Integration ---
  /mcp [add|remove|tools]    - MCP servers
  /skills [add|remove]       - Agent skills
  /memory [init|add|show]    - Project memory (CALLIOPE.md)
  /project [init|show|run]   - Project config (.calliope)
  /hooks [list|add]          - Pre/post tool hooks
  /profile [name|save|del]   - Switch/save/delete profiles

--- Multi-Agent ---
  /agents                    - Sub-agent status (--agents mode)
  /swarm [start|coord|status] - Agent swarms & coordination
  /loop [prompt] [n]         - Iterative agent loop
  /cancel-loop               - Stop running loop (/stop)

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
Modes: Plan | Hybrid | Work | Auto-route: ${ctx.autoRoute ? 'ON' : 'OFF'}${ctx.agtermEnabled ? '\nAgents: ON' : ''}`);
      break;

    case '/provider':
    case '/providers':
    case '/p':
      if (parts[1]) {
        const p = parts[1].toLowerCase() as LLMProvider;
        ctx.setProvider(p);
        ctx.addMessage('system', `Provider: ${selectProvider(p)}`);
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
          const models = await getAvailableModels(ctx.actualProvider);
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
        const models = await getAvailableModels(ctx.actualProvider);
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

    case '/persona':
      if (parts[1] && ['calliope', 'muse', 'minimal'].includes(parts[1])) {
        const p = parts[1] as AgentPersona;
        ctx.setPersona(p);
        ctx.llmMessages.current = [{ role: 'system', content: getSystemPrompt(p) }];
        ctx.addMessage('system', `Persona: ${p}`);
      } else {
        ctx.addMessage('system', `Persona: ${ctx.persona} | Options: calliope, muse, minimal`);
      }
      break;

    case '/clear':
    case '/c':
      ctx.setMessages([]);
      ctx.llmMessages.current = [{ role: 'system', content: getSystemPrompt(ctx.persona) }];
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
      ctx.addMessage('system', `${ctx.actualProvider}:${ctx.actualModel} | ${ctx.stats.messageCount} msgs | ${ctx.stats.inputTokens + ctx.stats.outputTokens} tokens | terminal: ${getImageModeLabel(imgInfo.mode)}${imgInfo.truecolor ? ' (truecolor)' : ''} ${imgInfo.width}cols`);
      break;
    }

    case '/config':
      ctx.addMessage('system', `Config: ${config.getConfigPath()}\nProviders: ${config.getConfiguredProviders().join(', ') || 'none'}\nmaxIterations: ${config.get('maxIterations')}`);
      break;

    case '/agents': {
      if (!ctx.agtermEnabled) {
        ctx.addMessage('system', 'Agents mode not enabled. Start with --agents flag to unlock multi-agent features.');
        break;
      }
      const sub = parts[1];
      if (!sub) {
        ctx.addMessage('system', getAgentStatusReport());
      } else if (sub === 'defs' || sub === 'list') {
        const defs = listAgentDefs(process.cwd());
        if (defs.length === 0) {
          ctx.addMessage('system', 'No agent definitions loaded. Run /agents init to create examples.');
        } else {
          const lines = defs.map(d => {
            const src = d._source || 'unknown';
            return `  ${d.name} — ${d.engine}/${d.provider || 'auto'}/${d.model || 'default'} [${src}]${d.description ? `\n    ${d.description}` : ''}`;
          });
          ctx.addMessage('system', `Agent Definitions (${defs.length}):\n${lines.join('\n')}`);
        }
      } else if (sub === 'teams') {
        const teams = listTeamDefs(process.cwd());
        if (teams.length === 0) {
          ctx.addMessage('system', 'No team definitions loaded. Run /agents init to create examples.');
        } else {
          const lines = teams.map(t => {
            const src = t._source || 'unknown';
            return `  ${t.name} — ${t.mode}, ${t.members.length} members [${src}]${t.description ? `\n    ${t.description}` : ''}`;
          });
          ctx.addMessage('system', `Team Definitions (${teams.length}):\n${lines.join('\n')}`);
        }
      } else if (sub === 'init') {
        const result = scaffoldAgentsDir(process.cwd());
        if (result.created.length > 0) {
          ctx.addMessage('system', `Created .calliope/agents/ with examples:\n${result.created.map(f => `  ${f}`).join('\n')}`);
        } else {
          ctx.addMessage('system', '.calliope/agents/ already exists.');
        }
      } else if (sub === 'show') {
        const name = parts[2];
        if (!name) {
          ctx.addMessage('system', 'Usage: /agents show <name>');
        } else {
          const agentDef = getAgent(name, process.cwd());
          const teamDef = getTeam(name, process.cwd());
          if (agentDef) {
            const lines = [
              `Agent: ${agentDef.name}`,
              agentDef.description ? `Description: ${agentDef.description}` : '',
              `Engine: ${agentDef.engine}`,
              `Provider: ${agentDef.provider || 'auto'}`,
              `Model: ${agentDef.model || 'default'}`,
              agentDef.role ? `Role: ${agentDef.role}` : '',
              agentDef.weight !== undefined ? `Weight: ${agentDef.weight}` : '',
              agentDef.instructions ? `Instructions:\n  ${agentDef.instructions.split('\n').join('\n  ')}` : '',
              `Source: ${agentDef._source || 'unknown'}`,
              agentDef._filePath ? `File: ${agentDef._filePath}` : '',
            ].filter(Boolean);
            ctx.addMessage('system', lines.join('\n'));
          } else if (teamDef) {
            const lines = [
              `Team: ${teamDef.name}`,
              teamDef.description ? `Description: ${teamDef.description}` : '',
              `Mode: ${teamDef.mode}`,
              `Members (${teamDef.members.length}):`,
              ...teamDef.members.map(m => `  ${m.name} — ${m.engine}/${m.provider || 'auto'}/${m.model || 'default'} [${m.role || 'no role'}] w=${m.weight}`),
            ].filter(Boolean);
            ctx.addMessage('system', lines.join('\n'));
          } else {
            ctx.addMessage('system', `No agent or team found with name '${name}'.`);
          }
        }
      } else {
        ctx.addMessage('system', `Unknown subcommand: ${sub}\nUsage: /agents [defs|teams|init|show <name>]`);
      }
      break;
    }

    case '/install-agents': {
      // /install-agents [name] — install missing agent CLIs and SDK backends
      const target = parts[1];
      if (target) {
        ctx.addMessage('system', `Installing ${target}...`);
        const result = installItem(target);
        ctx.addMessage('system', result.success
          ? `✓ ${target} installed successfully.`
          : `✗ ${result.output}`);
      } else if (parts.includes('--all')) {
        ctx.addMessage('system', 'Installing all missing agents and SDK backends...');
        const result = await installAllMissing();
        const lines: string[] = [];
        if (result.installed.length > 0) {
          lines.push(`✓ Installed: ${result.installed.join(', ')}`);
        }
        if (result.failed.length > 0) {
          lines.push(`✗ Failed:\n  ${result.failed.join('\n  ')}`);
        }
        if (result.installed.length === 0 && result.failed.length === 0) {
          lines.push('Everything is already installed!');
        }
        ctx.addMessage('system', lines.join('\n'));
      } else {
        const report = await getInstallReport();
        ctx.addMessage('system', `${report}\n\nUsage:\n  /install-agents <name>   Install a specific agent or SDK\n  /install-agents --all    Install everything missing`);
      }
      break;
    }

    case '/build-agent': {
      // Interactive agent definition builder
      // Parse inline args: /build-agent [name] [--engine X] [--provider X] [--model X]
      const agentName = parts[1] && !parts[1].startsWith('--') ? parts[1] : undefined;
      const engineArg = parts.includes('--engine') ? parts[parts.indexOf('--engine') + 1] : undefined;
      const providerArg = parts.includes('--provider') ? parts[parts.indexOf('--provider') + 1] : undefined;
      const modelArg = parts.includes('--model') ? parts[parts.indexOf('--model') + 1] : undefined;
      const roleArg = parts.includes('--role') ? parts[parts.indexOf('--role') + 1] : undefined;

      if (!agentName) {
        // Interactive wizard — show guided step-by-step builder
        const executors = await getAvailableExecutors();
        const providers = config.getConfiguredProviders();

        // Engine descriptions
        const engineDescriptions: Record<string, string> = {
          'cli': 'Built-in CLI agent loop (works with all providers, most flexible)',
          'claude-sdk': 'Anthropic Claude SDK (native tool use, streaming, best for Anthropic models)',
          'openai-sdk': 'OpenAI SDK (function calling, JSON mode, best for OpenAI models)',
          'google-adk': 'Google ADK (grounding, search, best for Gemini models)',
        };

        // Provider-to-engine recommendations
        const providerEngineMap: Record<string, string> = {
          anthropic: 'claude-sdk',
          openai: 'openai-sdk',
          google: 'google-adk',
          together: 'cli',
          openrouter: 'cli',
          groq: 'cli',
          fireworks: 'cli',
          mistral: 'cli',
          ollama: 'cli',
          bedrock: 'cli',
        };

        // Common roles
        const roles = [
          { name: 'coder', desc: 'Writes and refactors code' },
          { name: 'reviewer', desc: 'Reviews code for bugs, style, and security' },
          { name: 'architect', desc: 'Designs system architecture and APIs' },
          { name: 'researcher', desc: 'Gathers information and summarizes findings' },
          { name: 'qa-engineer', desc: 'Writes tests and validates correctness' },
          { name: 'devops', desc: 'Infrastructure, CI/CD, and deployment' },
          { name: 'writer', desc: 'Documentation, READMEs, and technical writing' },
          { name: 'analyst', desc: 'Data analysis and insights' },
        ];

        const lines: string[] = [];
        lines.push('=== Build Agent Wizard ===');
        lines.push('');

        // Step 1: Engine
        lines.push('STEP 1: Choose an engine');
        lines.push('The engine determines how the agent executes (SDK backend or CLI loop).');
        lines.push('');
        for (const eng of ['cli', 'claude-sdk', 'openai-sdk', 'google-adk']) {
          const available = executors.includes(eng);
          const marker = available ? '[installed]' : '[not installed]';
          lines.push(`  ${eng}  ${marker}`);
          lines.push(`    ${engineDescriptions[eng] || ''}`);
        }
        lines.push('');
        if (executors.length === 1) {
          lines.push('  Recommendation: Only "cli" is available. Install SDK packages for more options.');
          lines.push('  Run /install-agents to see what can be installed.');
        } else {
          lines.push(`  Available on this system: ${executors.join(', ')}`);
        }
        lines.push('');

        // Step 2: Provider
        lines.push('STEP 2: Choose a provider');
        lines.push('The provider determines which API your agent calls.');
        lines.push('');
        if (providers.length === 0) {
          lines.push('  No providers configured! Run calliope --setup to add API keys.');
        } else {
          for (const p of providers) {
            const recEngine = providerEngineMap[p] || 'cli';
            const model = DEFAULT_MODELS[p] || 'auto';
            lines.push(`  ${p}  (best with --engine ${recEngine}, default model: ${model})`);
          }
        }
        lines.push('');

        // Step 3: Model
        lines.push('STEP 3: Choose a model');
        lines.push('Each provider has a default model. Override with --model if needed.');
        lines.push('');
        if (providers.length > 0) {
          for (const p of providers) {
            lines.push(`  ${p}: ${DEFAULT_MODELS[p] || 'auto'}`);
          }
          lines.push('');
          lines.push('  Tip: Run /models to see all available models for your providers.');
        }
        lines.push('');

        // Step 4: Role
        lines.push('STEP 4: Set a role');
        lines.push('The role labels what this agent specializes in. Common roles:');
        lines.push('');
        for (const r of roles) {
          lines.push(`  ${r.name.padEnd(14)} ${r.desc}`);
        }
        lines.push('');
        lines.push('  You can also use any custom role name.');
        lines.push('');

        // Step 5: Instructions
        lines.push('STEP 5: Write instructions (after creation)');
        lines.push('After creating the agent, edit its YAML file to add detailed instructions.');
        lines.push('');
        lines.push('  Template:');
        lines.push('    instructions: |');
        lines.push('      You are a specialized {role} agent.');
        lines.push('      Your focus areas: ...');
        lines.push('      When reviewing code: ...');
        lines.push('      Output format: ...');
        lines.push('');

        // Final command
        lines.push('--- Ready to build? ---');
        lines.push('');
        if (providers.includes('anthropic') && executors.includes('claude-sdk')) {
          lines.push('  /build-agent my-agent --engine claude-sdk --provider anthropic --role coder');
        } else if (providers.includes('openai') && executors.includes('openai-sdk')) {
          lines.push('  /build-agent my-agent --engine openai-sdk --provider openai --role coder');
        } else if (providers.length > 0) {
          const firstProvider = providers[0];
          lines.push(`  /build-agent my-agent --engine cli --provider ${firstProvider} --role coder`);
        } else {
          lines.push('  /build-agent my-agent --engine cli --provider anthropic --role coder');
        }
        lines.push('');
        lines.push('Add --model <model> to override the default model for the chosen provider.');

        ctx.addMessage('system', lines.join('\n'));
      } else if (!engineArg && !providerArg && !modelArg && !roleArg) {
        // Name provided but no flags — show a concise personalized wizard
        const executors = await getAvailableExecutors();
        const providers = config.getConfiguredProviders();

        const providerEngineMap: Record<string, string> = {
          anthropic: 'claude-sdk', openai: 'openai-sdk', google: 'google-adk',
          together: 'cli', openrouter: 'cli', groq: 'cli', fireworks: 'cli',
          mistral: 'cli', ollama: 'cli', bedrock: 'cli',
        };

        const lines: string[] = [];
        lines.push(`=== Building agent: ${agentName} ===`);
        lines.push('');
        lines.push('Choose your configuration:');
        lines.push('');

        // Show ready-to-run commands for each configured provider
        let optionNum = 0;
        for (const p of providers) {
          const recEngine = providerEngineMap[p] || 'cli';
          const engineAvailable = executors.includes(recEngine);
          const engine = engineAvailable ? recEngine : 'cli';
          const model = DEFAULT_MODELS[p] || 'auto';
          optionNum++;
          lines.push(`  Option ${optionNum}: ${p}`);
          lines.push(`    /build-agent ${agentName} --engine ${engine} --provider ${p} --model ${model} --role coder`);
          lines.push('');
        }

        if (optionNum === 0) {
          lines.push('  No providers configured. Run calliope --setup to add API keys.');
          lines.push(`  Or build with defaults: /build-agent ${agentName} --engine cli --provider anthropic --role coder`);
        }

        lines.push('Common roles: coder, reviewer, architect, researcher, qa-engineer, devops, writer');
        lines.push('');
        lines.push('Pick an option above and change --role to match your needs.');
        lines.push(`After creation, customize instructions in .calliope/agents/${agentName}.yaml`);

        ctx.addMessage('system', lines.join('\n'));
      } else {
        // Build and save agent definition (flags provided)
        const newDef: AgentDefinition = {
          name: agentName,
          engine: (engineArg as import('../agents/types.js').TaskExecutor) || 'cli',
          provider: providerArg,
          model: modelArg,
          role: roleArg,
          weight: 1.0,
          instructions: `You are a specialized agent (${roleArg || agentName}). Complete assigned tasks thoroughly.`,
          limits: { timeout: 600000 },
        };
        const filePath = saveAgentDef(process.cwd(), newDef);
        ctx.addMessage('system', `Agent '${agentName}' created: ${filePath}\n\nEdit the file to customize instructions and settings.\nUse with: spawn_agent agentDef="${agentName}"`);
      }
      break;
    }

    case '/build-team': {
      // Interactive team builder
      const teamNameArg = parts[1] && !parts[1].startsWith('--') ? parts[1] : undefined;
      const modeArg = parts.includes('--mode') ? parts[parts.indexOf('--mode') + 1] : undefined;

      if (!teamNameArg) {
        // Interactive wizard — guided team builder
        const teams = listTeamDefs(process.cwd());
        const agents = listAgentDefs(process.cwd());

        const lines: string[] = [];
        lines.push('=== Build Team Wizard ===');
        lines.push('');

        // Step 1: Available agents
        lines.push('STEP 1: Review your available agents');
        lines.push('Teams are composed of agent definitions. Here is what you have:');
        lines.push('');
        if (agents.length === 0) {
          lines.push('  No agents defined yet!');
          lines.push('  Create agents first: /build-agent (run without args for the wizard)');
          lines.push('');
        } else {
          for (const a of agents) {
            const src = (a as AgentDefinition & { _source?: string })._source === 'builtin' ? ' (built-in)' : '';
            lines.push(`  ${a.name.padEnd(20)} engine: ${a.engine.padEnd(12)} provider: ${(a.provider || 'auto').padEnd(12)} role: ${a.role || 'any'}${src}`);
          }
          lines.push('');
          lines.push(`  Total: ${agents.length} agents available`);
          if (agents.length < 2) {
            lines.push('  You need at least 2 agents for a team. Create more with /build-agent.');
          }
          lines.push('');
        }

        // Step 2: Choose mode
        lines.push('STEP 2: Choose a coordination mode');
        lines.push('The mode determines how agents work together:');
        lines.push('');
        lines.push('  competitive');
        lines.push('    All agents tackle the same task independently.');
        lines.push('    The best response wins (scored by quality/relevance).');
        lines.push('    Best for: code review, creative alternatives, getting multiple perspectives.');
        lines.push('');
        lines.push('  collaborative');
        lines.push('    Agents work in a pipeline, each building on the previous output.');
        lines.push('    First agent plans, next implements, last reviews.');
        lines.push('    Best for: refactoring, multi-step tasks, plan-implement-review workflows.');
        lines.push('');
        lines.push('  consensus');
        lines.push('    All agents must agree before a result is accepted.');
        lines.push('    Disagreements trigger additional rounds of discussion.');
        lines.push('    Best for: security audits, critical decisions, high-stakes analysis.');
        lines.push('');
        lines.push('  overseer');
        lines.push('    A lead agent decomposes the task and delegates to workers.');
        lines.push('    The overseer reviews and merges all results.');
        lines.push('    Best for: complex projects, research, large feature implementation.');
        lines.push('');

        // Step 3: Strategy recommendations
        lines.push('STEP 3: Pick a strategy based on your task');
        lines.push('');
        lines.push('  Task Type            Mode            Recommended Agents');
        lines.push('  ─────────────────────────────────────────────────────────');
        lines.push('  Code review          competitive     code-reviewer, qa-engineer');
        lines.push('  Refactoring          collaborative   architect, coder, reviewer');
        lines.push('  Security audit       consensus       security-analyst, code-reviewer, qa-engineer');
        lines.push('  Research             overseer        researcher, analyst, writer');
        lines.push('  Feature development  overseer        architect, coder, qa-engineer, reviewer');
        lines.push('  Documentation        collaborative   researcher, writer');
        lines.push('');

        // Existing teams
        if (teams.length > 0) {
          lines.push('Existing teams:');
          for (const t of teams) {
            lines.push(`  ${t.name.padEnd(20)} mode: ${t.mode.padEnd(14)} members: ${t.members.length}`);
          }
          lines.push('');
        }

        // Final command
        lines.push('--- Ready to build? ---');
        lines.push('');
        if (agents.length >= 2) {
          const sampleAgents = agents.slice(0, 3).map(a => a.name).join(', ');
          lines.push(`  /build-team my-team --mode collaborative`);
          lines.push('');
          lines.push(`  This will auto-compose a team from your available agents (${sampleAgents}${agents.length > 3 ? ', ...' : ''}).`);
          lines.push('  After creation, edit the YAML to fine-tune members and settings.');
        } else {
          lines.push('  First, create at least 2 agents:');
          lines.push('    /build-agent planner --engine cli --provider anthropic --role architect');
          lines.push('    /build-agent coder --engine cli --provider anthropic --role coder');
          lines.push('');
          lines.push('  Then build a team:');
          lines.push('    /build-team my-team --mode collaborative');
        }
        lines.push('');
        lines.push('After creation, use the team with:');
        lines.push('  /swarm --team <name> <prompt>');
        lines.push('  spawn_agent team="<name>" prompt="..."');

        ctx.addMessage('system', lines.join('\n'));
      } else {
        // Create a team with available agents
        const availableAgents = listAgentDefs(process.cwd());
        const mode = (modeArg || 'collaborative') as import('../agents/council-types.js').CouncilMode;

        // Auto-compose a reasonable team from available agent definitions
        const memberAgents = availableAgents
          .filter(a => a._source !== 'builtin' || ['code-reviewer', 'architect', 'qa-engineer', 'researcher'].includes(a.name))
          .slice(0, 4);

        if (memberAgents.length < 2) {
          ctx.addMessage('system', `Need at least 2 agent definitions to build a team.\nCreate agents first with /build-agent <name>, then compose them with /build-team.`);
        } else {
          const { saveTeamDef } = await import('../agents/index.js');
          const teamDef: import('../agents/index.js').TeamDefinition = {
            name: teamNameArg,
            description: `${teamNameArg} team`,
            mode,
            members: memberAgents.map(a => ({ agent: a.name, role: a.role, weight: a.weight })),
            swarm: { strategy: 'parallel', aggregation: 'structured', maxWorkers: 3 },
            council: { maxRounds: 2, consensusThreshold: 0.67 },
          };
          const filePath = saveTeamDef(process.cwd(), teamDef);
          ctx.addMessage('system', `Team '${teamNameArg}' created: ${filePath}

Members:
${memberAgents.map(a => `  ${a.name} [${a.role || 'any'}]`).join('\n')}

Mode: ${mode}

Use with:
  /swarm --team ${teamNameArg} <prompt>
  /swarm coord --team ${teamNameArg} <prompt>
  spawn_agent team="${teamNameArg}" prompt="..."

Edit the YAML to customize members, strategy, and coordination settings.`);
        }
      }
      break;
    }

    case '/set': {
      // /set <key> <value>
      const key = parts[1];
      const value = parts.slice(2).join(' ');
      if (!key || !value) {
        ctx.addMessage('system', `Usage: /set <key> <value>
Available keys:
  maxIterations <number>  - Max agent iterations (current: ${config.get('maxIterations')})
  persona <name>          - calliope, muse, minimal
  fancyOutput <bool>      - true/false`);
        break;
      }

      try {
        if (key === 'maxIterations') {
          const num = parseInt(value, 10);
          if (isNaN(num) || num < 1 || num > 10000) {
            ctx.addMessage('error', 'maxIterations must be 1-10000');
            break;
          }
          config.set('maxIterations', num);
          ctx.addMessage('system', `\u2713 maxIterations set to ${num}`);
        } else if (key === 'persona') {
          if (!['calliope', 'muse', 'minimal'].includes(value)) {
            ctx.addMessage('error', 'persona must be: calliope, muse, or minimal');
            break;
          }
          config.set('persona', value as 'calliope' | 'muse' | 'minimal');
          ctx.setPersona(value as AgentPersona);
          ctx.addMessage('system', `\u2713 persona set to ${value}`);
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

      // Start the loop
      ctx.setLoopActive(true);
      ctx.setLoopPrompt(prompt);
      ctx.setLoopMaxIterations(maxIterMatch ? parseInt(maxIterMatch[1], 10) : 100);
      ctx.setLoopCompletionPromise(completionMatch ? completionMatch[1] : undefined);
      ctx.setLoopIteration(0);
      ctx.loopCancelledRef.current = false;

      ctx.addMessage('system', `\u{1F504} Agent Loop Started
  Prompt: "${prompt.substring(0, 50)}${prompt.length > 50 ? '...' : ''}"
  Max iterations: ${maxIterMatch ? maxIterMatch[1] : '100'}
  ${completionMatch ? `Completion promise: "${completionMatch[1]}"` : 'No completion promise (runs until max iterations)'}
  Use /cancel-loop to stop`);

      // Start the loop execution (non-blocking)
      ctx.runLoop(prompt, maxIterMatch ? parseInt(maxIterMatch[1], 10) : 100, completionMatch?.[1]);
      break;
    }

    case '/cancel-loop':
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
          persona: ctx.persona,
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
          ctx.setPersona(profile.persona);
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

    case '/branch': {
      const branching = await import('../branching.js');
      const subCmd = parts[1];
      const sessionId = ctx.sessionRef.current?.id || `session_${Date.now()}`;

      if (subCmd === 'list' || !subCmd) {
        const tree = branching.getBranchTree(sessionId);
        ctx.addMessage('system', `Branches:\n${tree}`);
      } else if (subCmd === 'new' && parts[2]) {
        const branch = branching.createBranch(sessionId, parts[2], ctx.llmMessages.current, parts.slice(3).join(' '));
        ctx.addMessage('system', `Created branch: ${branch.name}`);
      } else if (subCmd === 'switch' && parts[2]) {
        const msgs = branching.switchBranch(sessionId, parts[2], ctx.llmMessages.current);
        if (msgs) {
          ctx.llmMessages.current = msgs;
          ctx.addMessage('system', `Switched to branch: ${parts[2]}`);
        } else {
          ctx.addMessage('error', 'Branch not found');
        }
      } else if (subCmd === 'delete' && parts[2]) {
        if (branching.deleteBranch(sessionId, parts[2])) {
          ctx.addMessage('system', 'Branch deleted');
        } else {
          ctx.addMessage('error', 'Cannot delete branch');
        }
      } else {
        ctx.addMessage('system', 'Usage: /branch [list|new <name>|switch <name>|delete <name>]');
      }
      break;
    }

    case '/theme': {
      const subCmd = parts[1];

      if (!subCmd) {
        // Open interactive theme picker
        ctx.setModalMode('theme-picker');
      } else if (subCmd === 'list') {
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

    case '/skin': {
      const subCmd = parts[1];
      if (subCmd === 'list' || !subCmd) {
        const skins = listSkins();
        const current = getCurrentSkin();
        const formatted = skins.map((s: { name: string; custom?: boolean; description: string }) => {
          const marker = s.name === current.name ? ' *' : '';
          const custom = s.custom ? ' (custom)' : '';
          return `  ${s.name}${marker}${custom} - ${s.description}`;
        }).join('\n');
        ctx.addMessage('system', `Active: ${current.name}\nAvailable skins:\n${formatted}`);
      } else {
        applySkin(subCmd);
        const newSkin = getCurrentSkin();
        if (newSkin.name === subCmd) {
          config.set('activeSkin', subCmd);
          ctx.addMessage('system', `Skin set to: ${subCmd} \u2014 ${newSkin.description}`);
        } else {
          ctx.addMessage('error', `Skin not found: ${subCmd}. Available: ${listSkins().map((s: { name: string }) => s.name).join(', ')}`);
        }
      }
      break;
    }

    case '/palette': {
      const subCmd = parts[1];
      if (subCmd === 'list' || !subCmd) {
        const palettes = listPalettes();
        const current = getCurrentPalette();
        const formatted = palettes.map((p: { name: string; custom?: boolean; description: string }) => {
          const marker = p.name === current.name ? ' *' : '';
          const custom = p.custom ? ' (custom)' : '';
          return `  ${p.name}${marker}${custom} - ${p.description}`;
        }).join('\n');
        ctx.addMessage('system', `Active: ${current.name}\nAvailable palettes:\n${formatted}`);
      } else {
        applyPalette(subCmd);
        const newPal = getCurrentPalette();
        if (newPal.name === subCmd) {
          config.set('activePalette', subCmd);
          ctx.addMessage('system', `Palette set to: ${subCmd} \u2014 ${newPal.description}`);
        } else {
          ctx.addMessage('error', `Palette not found: ${subCmd}. Available: ${listPalettes().map((p: { name: string }) => p.name).join(', ')}`);
        }
      }
      break;
    }

    case '/companion': {
      const subCmd = parts[1];
      if (subCmd === 'list' || !subCmd) {
        const companions = listCompanions();
        const current = getCurrentCompanion();
        const formatted = companions.map((comp: { name: string; description: string }) => {
          const marker = comp.name === current.name ? ' *' : '';
          return `  ${comp.name}${marker} - ${comp.description}`;
        }).join('\n');
        ctx.addMessage('system', `Active: ${current.name}\nAvailable companions:\n${formatted}`);
      } else {
        applyCompanion(subCmd);
        const newComp = getCurrentCompanion();
        if (newComp.name === subCmd) {
          config.set('activeCompanion', subCmd);
          ctx.llmMessages.current = [{ role: 'system', content: getSystemPrompt(ctx.persona) }];
          ctx.addMessage('system', `Companion set to: ${subCmd} \u2014 "${newComp.greeting}"`);
        } else {
          ctx.addMessage('error', `Companion not found: ${subCmd}. Available: ${listCompanions().map((c: { name: string }) => c.name).join(', ')}`);
        }
      }
      break;
    }

    case '/banner': {
      const bannerSkin = getCurrentSkin();
      const bannerPalette = getCurrentPalette();
      const bannerColor = bannerPalette.colors.primary;
      const imgInfo = getTerminalImageInfo();
      const rendered = renderSkinBanner(
        bannerSkin.banner.art,
        bannerColor,
        bannerSkin.banner.tagline ?? undefined,
        imgInfo.mode,
      );
      ctx.addMessage('system', `${rendered}\n\nSkin: ${bannerSkin.name} | Terminal: ${getImageModeLabel(imgInfo.mode)}${imgInfo.truecolor ? ' (truecolor)' : ''}`);
      break;
    }

    case '/hud': {
      const hudSkin = getCurrentSkin();
      const hudPalette = getCurrentPalette();
      const hudCompanion = getCurrentCompanion();
      const hudPack = getCurrentPack();
      const hudIntensity = getCompanionMode();
      ctx.addMessage('system',
        `HUD Configuration\n` +
        (hudPack ? `  Pack:      ${hudPack.name} — ${hudPack.description}\n` : '') +
        `  Skin:      ${hudSkin.name} — ${hudSkin.description}\n` +
        `  Palette:   ${hudPalette.name} — ${hudPalette.description}\n` +
        `  Companion: ${hudCompanion.name} — ${hudCompanion.description}\n` +
        `  Intensity: ${hudIntensity}\n` +
        `  Emojis:    ${config.get('useEmojis') !== false ? 'ON' : 'OFF'}\n` +
        `  Mood:      ${getMoodText()}\n\n` +
        `  /pack <name>  /intensity <pro|immersive>  /emoji [on|off]\n` +
        `  /skin <name>  /palette <name>  /companion <name>`
      );
      break;
    }

    case '/pack': {
      const subCmd = parts[1];
      if (!subCmd) {
        ctx.setModalMode('pack-picker');
        break;
      }
      if (subCmd === 'list') {
        const category = parts[2] as any;
        const packs = listThemePacks(category || undefined);
        const currentP = getCurrentPack();
        // Group by category
        const grouped = new Map<string, typeof packs>();
        for (const p of packs) {
          const group = grouped.get(p.category) || [];
          group.push(p);
          grouped.set(p.category, group);
        }
        let output = 'Theme Packs:\n';
        for (const [cat, catPacks] of grouped) {
          output += `\n  [${cat}]\n`;
          for (const p of catPacks) {
            const marker = currentP && p.name === currentP.name ? ' *' : '';
            output += `    ${p.name}${marker} — ${p.description}\n`;
          }
        }
        output += '\nUse: /pack <name>';
        ctx.addMessage('system', output);
      } else {
        // Run theme transition animation before applying
        const targetPack = getThemePack(subCmd);
        if (targetPack?.skin.splash?.transition) {
          await renderTransition(targetPack.skin.splash.transition);
        }
        const success = applyThemePack(subCmd, getCompanionMode());
        if (success) {
          const pack = getCurrentPack()!;
          config.set('activeThemePack', subCmd);
          config.set('activeSkin', pack.skin.name);
          config.set('activePalette', pack.palette.name);
          const companion = getCompanionMode() === 'professional'
            ? pack.companions.professional
            : pack.companions.immersive;
          config.set('activeCompanion', companion.name);
          // Reset LLM system prompt to use the companion's persona
          ctx.llmMessages.current = [{ role: 'system', content: getSystemPrompt(ctx.persona) }];
          ctx.addMessage('system',
            `Theme pack: ${subCmd}\n` +
            `  Skin: ${pack.skin.name}, Palette: ${pack.palette.name}, Companion: ${companion.name}\n` +
            `  "${companion.greeting}"`
          );
        } else {
          ctx.addMessage('error', `Theme pack not found: ${subCmd}. Use /pack list to see available packs.`);
        }
      }
      break;
    }

    case '/intensity': {
      const intensity = parts[1];
      if (intensity === 'professional' || intensity === 'pro') {
        const success = setCompanionMode('professional');
        if (success) {
          const pack = getCurrentPack()!;
          config.set('companionIntensity', 'professional');
          config.set('activeCompanion', pack.companions.professional.name);
          ctx.llmMessages.current = [{ role: 'system', content: getSystemPrompt(ctx.persona) }];
          ctx.addMessage('system', `Switched to professional mode — ${pack.companions.professional.description}`);
        } else {
          ctx.addMessage('error', 'No theme pack active. Use /pack <name> first.');
        }
      } else if (intensity === 'immersive' || intensity === 'imm') {
        const success = setCompanionMode('immersive');
        if (success) {
          const pack = getCurrentPack()!;
          config.set('companionIntensity', 'immersive');
          config.set('activeCompanion', pack.companions.immersive.name);
          ctx.llmMessages.current = [{ role: 'system', content: getSystemPrompt(ctx.persona) }];
          ctx.addMessage('system', `Switched to immersive mode — ${pack.companions.immersive.description}`);
        } else {
          ctx.addMessage('error', 'No theme pack active. Use /pack <name> first.');
        }
      } else {
        const currentIntensity = getCompanionMode();
        ctx.addMessage('system', `Intensity: ${currentIntensity}\nOptions: /intensity professional (pro), /intensity immersive (imm)`);
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
          ctx.addMessage('system', `Session: ${session.projectName}\nID: ${session.id}\nCreated: ${new Date(session.createdAt).toLocaleString()}\nMessages: ${session.messageCount}\nSaved LLM messages: ${savedCount}`);
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
        ctx.addMessage('system', `Saved ${ctx.llmMessages.current.length} LLM messages to session.`);
      } else {
        ctx.addMessage('system', 'Usage: /session [list|info|fork|save] or just /sessions');
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
        const history = storage.getChatHistory(20);
        if (history.length === 0) {
          ctx.addMessage('system', 'No previous messages to resume. Start a conversation first, messages are auto-saved.');
        } else {
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
        ctx.addMessage('system', '\u2713 Circuit breakers disabled (will take effect on next agent run)');
      } else if (subCmd === 'on') {
        config.set('circuitBreakersEnabled', true);
        ctx.addMessage('system', '\u2713 Circuit breakers enabled');
      } else {
        ctx.addMessage('system', `Usage: /breaker [status|resume|reset|on|off]
  /breaker resume [type]  - Resume tripped breaker (half-open)
  /breaker reset [type]   - Reset breaker to closed
  /breaker on|off         - Enable/disable circuit breakers

Breaker types: repeated-failure, cost-runaway, infinite-loop, token-burn, stall`);
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

    case '/swarm':
    case '/council': {
      const subCmd = parts[1];
      if (!ctx.agtermEnabled) {
        ctx.addMessage('system', 'Agents mode not enabled. Start with --agents flag to use agent swarms.');
        break;
      }

      // /swarm coordinate — multi-agent coordination (formerly /council)
      if (subCmd === 'coordinate' || subCmd === 'coord') {
        const coordSubCmd = parts[2];

        if (coordSubCmd === 'templates') {
          const templates = Object.values(COUNCIL_TEMPLATES);
          let msg = 'Swarm Coordination Templates:\n';
          for (const t of templates) {
            msg += `\n  ${t.name} - ${t.description}`;
            msg += `\n    Mode: ${t.mode}, Agents: ${t.members.map(m => m.name).join(', ')}`;
          }
          ctx.addMessage('system', msg);
        } else if (coordSubCmd === 'status') {
          const sessionId = parts[3];
          if (sessionId) {
            const session = councilManager.getAllSessions().find(s => s.id.startsWith(sessionId));
            if (session) {
              let msg = councilManager.formatSessionStatus(session);
              if (session.status === 'completed' && session.result) {
                msg += `\n\nResult:\n${session.result.slice(0, 500)}${(session.result.length > 500) ? '...' : ''}`;
              }
              ctx.addMessage('system', msg);
            } else {
              ctx.addMessage('system', `Coordination session not found: ${sessionId}`);
            }
          } else {
            const sessions = councilManager.getAllSessions();
            if (sessions.length === 0) {
              ctx.addMessage('system', 'No coordination sessions.');
            } else {
              const lines = sessions.map(s => `  ${s.id.slice(0, 8)} [${s.config.mode}] ${s.status} - ${s.prompt.slice(0, 50)}`);
              ctx.addMessage('system', `Coordination Sessions:\n${lines.join('\n')}`);
            }
          }
        } else if (coordSubCmd === 'list') {
          const sessions = councilManager.getAllSessions();
          const stats = councilManager.getStats();
          let msg = `Coordination Stats: ${stats.totalSessions} total, ${stats.activeSessions} active, ${stats.completedSessions} completed, ${stats.failedSessions} failed\n`;
          for (const s of sessions) {
            msg += `\n  ${s.id.slice(0, 8)} [${s.config.mode}] ${s.status} - ${s.prompt.slice(0, 60)}`;
          }
          ctx.addMessage('system', msg);
        } else if (coordSubCmd === 'cancel' && parts[3]) {
          const session = councilManager.getAllSessions().find(s => s.id.startsWith(parts[3]));
          if (session) {
            await councilManager.cancelCouncil(session.id);
            ctx.addMessage('system', `\u2713 Coordination ${parts[3]} cancelled.`);
          } else {
            ctx.addMessage('system', `Coordination session not found: ${parts[3]}`);
          }
        } else if (coordSubCmd && !['help'].includes(coordSubCmd)) {
          // /swarm coordinate <objective>
          const prompt = parts.slice(2).join(' ');
          let cleanPrompt = prompt;
          let template: string | undefined;
          let mode: CouncilMode = 'competitive';

          const templateMatch = prompt.match(/--template\s+(\S+)/);
          if (templateMatch) {
            template = templateMatch[1];
            cleanPrompt = cleanPrompt.replace(templateMatch[0], '').trim();
          }
          const modeMatch = prompt.match(/--mode\s+(competitive|collaborative|consensus|overseer)/);
          if (modeMatch) {
            mode = modeMatch[1] as CouncilMode;
            cleanPrompt = cleanPrompt.replace(modeMatch[0], '').trim();
          }

          try {
            let session;
            if (template) {
              session = await councilManager.startFromTemplate(template, cleanPrompt);
            } else {
              const { randomUUID } = await import('crypto');
              const members = [
                { id: randomUUID(), name: 'Agent A', agent: 'claude' as const, weight: 1.0 },
                { id: randomUUID(), name: 'Agent B', agent: 'claude' as const, weight: 1.0 },
                { id: randomUUID(), name: 'Agent C', agent: 'claude' as const, weight: 1.0 },
              ];
              session = await councilManager.startCouncil(cleanPrompt, { mode, members });
            }
            ctx.addMessage('system', `\u2713 Swarm coordination started: ${session.id.slice(0, 8)}\nMode: ${session.config.mode}\nAgents: ${session.config.members.map(m => m.name).join(', ')}\n\nUse /swarm coord status ${session.id.slice(0, 8)} to check progress.`);
          } catch (err) {
            ctx.addMessage('error', `Failed to start coordination: ${err instanceof Error ? err.message : String(err)}`);
          }
        } else {
          ctx.addMessage('system', `Swarm Coordination: Multi-agent teams working toward shared objectives.

Modes:
  competitive    — Agents work independently, best result wins
  collaborative  — Pipeline: each agent builds on previous work
  consensus      — Agents vote on approach, supermajority decides
  overseer       — Lead decomposes, delegates, reviews, coordinates

Usage:
  /swarm coord <objective>               Start with default competitive mode
  /swarm coord <objective> [options]     Start with explicit options
  /swarm coord status [id]               Show session status
  /swarm coord list                      List all sessions
  /swarm coord templates                 Show available templates
  /swarm coord cancel <id>               Cancel a running session

Options:
  --template code-review|architecture|security-audit|brainstorm|debate
  --mode competitive|collaborative|consensus|overseer`);
        }
      } else if (subCmd === 'templates') {
        // Shortcut: /swarm templates → show coordination templates
        const templates = Object.values(COUNCIL_TEMPLATES);
        let msg = 'Swarm Coordination Templates:\n';
        for (const t of templates) {
          msg += `\n  ${t.name} - ${t.description}`;
          msg += `\n    Mode: ${t.mode}, Agents: ${t.members.map(m => m.name).join(', ')}`;
        }
        ctx.addMessage('system', msg);
      } else if (subCmd === 'start' || (subCmd && !['status', 'list', 'cancel', 'templates', 'coordinate', 'coord', 'help'].includes(subCmd))) {
        // /swarm start <prompt> or /swarm <prompt> — task decomposition
        const promptStart = subCmd === 'start' ? 2 : 1;
        const prompt = parts.slice(promptStart).join(' ');
        if (!prompt) {
          ctx.addMessage('system', 'Usage: /swarm <task description>\n  /swarm start <task> [--strategy parallel|sequential|map-reduce|pipeline] [--aggregation concatenate|merge-dedupe|summarize|structured]');
          break;
        }

        let strategy: DecompositionStrategy = 'parallel';
        let aggregation: AggregationStrategy = 'concatenate';
        let cleanPrompt = prompt;

        const strategyMatch = prompt.match(/--strategy\s+(parallel|sequential|map-reduce|pipeline)/);
        if (strategyMatch) {
          strategy = strategyMatch[1] as DecompositionStrategy;
          cleanPrompt = cleanPrompt.replace(strategyMatch[0], '').trim();
        }

        const aggMatch = prompt.match(/--aggregation\s+(concatenate|merge-dedupe|summarize|structured)/);
        if (aggMatch) {
          aggregation = aggMatch[1] as AggregationStrategy;
          cleanPrompt = cleanPrompt.replace(aggMatch[0], '').trim();
        }

        try {
          const session = await swarmManager.startSwarm(
            cleanPrompt,
            { decomposition: strategy, aggregation }
          );
          ctx.addMessage('system', `\u2713 Swarm started: ${session.id.slice(0, 8)}\nStrategy: ${strategy} \u2192 ${aggregation}\nStatus: ${session.status}\n\nUse /swarm status ${session.id.slice(0, 8)} to check progress.`);
        } catch (err) {
          ctx.addMessage('error', `Failed to start swarm: ${err instanceof Error ? err.message : String(err)}`);
        }
      } else if (subCmd === 'status') {
        // Show both swarm and coordination sessions
        const sessionId = parts[2];
        if (sessionId) {
          // Check decomposition swarms first, then coordination
          const swarmSession = swarmManager.getAllSessions().find(s => s.id.startsWith(sessionId));
          const coordSession = councilManager.getAllSessions().find(s => s.id.startsWith(sessionId));
          if (swarmSession) {
            let msg = swarmManager.formatSessionStatus(swarmSession);
            if (swarmSession.status === 'completed' && swarmSession.result) {
              msg += `\n\nResult:\n${swarmSession.result.slice(0, 500)}${(swarmSession.result.length > 500) ? '...' : ''}`;
            }
            ctx.addMessage('system', msg);
          } else if (coordSession) {
            let msg = councilManager.formatSessionStatus(coordSession);
            if (coordSession.status === 'completed' && coordSession.result) {
              msg += `\n\nResult:\n${coordSession.result.slice(0, 500)}${(coordSession.result.length > 500) ? '...' : ''}`;
            }
            ctx.addMessage('system', msg);
          } else {
            ctx.addMessage('system', `Swarm session not found: ${sessionId}`);
          }
        } else {
          const swarmSessions = swarmManager.getAllSessions();
          const coordSessions = councilManager.getAllSessions();
          if (swarmSessions.length === 0 && coordSessions.length === 0) {
            ctx.addMessage('system', 'No swarm sessions.');
          } else {
            const lines: string[] = [];
            for (const s of swarmSessions) {
              const subtaskInfo = s.subtasks.length > 0
                ? ` (${s.subtasks.filter(st => st.status === 'completed').length}/${s.subtasks.length} done)`
                : '';
              lines.push(`  ${s.id.slice(0, 8)} [decompose] ${s.status}${subtaskInfo} - ${s.prompt.slice(0, 50)}`);
            }
            for (const s of coordSessions) {
              lines.push(`  ${s.id.slice(0, 8)} [${s.config.mode}] ${s.status} - ${s.prompt.slice(0, 50)}`);
            }
            ctx.addMessage('system', `Swarm Sessions:\n${lines.join('\n')}`);
          }
        }
      } else if (subCmd === 'list') {
        const swarmSessions = swarmManager.getAllSessions();
        const swarmStats = swarmManager.getStats();
        const coordSessions = councilManager.getAllSessions();
        const coordStats = councilManager.getStats();
        let msg = `Decomposition: ${swarmStats.totalSessions} total, ${swarmStats.activeSessions} active, ${swarmStats.completedSessions} completed\n`;
        msg += `Coordination: ${coordStats.totalSessions} total, ${coordStats.activeSessions} active, ${coordStats.completedSessions} completed\n`;
        for (const s of swarmSessions) {
          msg += `\n  ${s.id.slice(0, 8)} [decompose] ${s.status} - ${s.prompt.slice(0, 60)}`;
        }
        for (const s of coordSessions) {
          msg += `\n  ${s.id.slice(0, 8)} [${s.config.mode}] ${s.status} - ${s.prompt.slice(0, 60)}`;
        }
        ctx.addMessage('system', msg);
      } else if (subCmd === 'cancel' && parts[2]) {
        const swarmSession = swarmManager.getAllSessions().find(s => s.id.startsWith(parts[2]));
        const coordSession = councilManager.getAllSessions().find(s => s.id.startsWith(parts[2]));
        if (swarmSession) {
          await swarmManager.cancelSwarm(swarmSession.id);
          ctx.addMessage('system', `\u2713 Swarm ${parts[2]} cancelled.`);
        } else if (coordSession) {
          await councilManager.cancelCouncil(coordSession.id);
          ctx.addMessage('system', `\u2713 Coordination ${parts[2]} cancelled.`);
        } else {
          ctx.addMessage('system', `Swarm session not found: ${parts[2]}`);
        }
      } else {
        ctx.addMessage('system', `Agent Swarms: Decompose tasks and coordinate multi-agent teams.

Decomposition (parallel workers):
  /swarm <task>                          Decompose and execute in parallel
  /swarm start <task> [options]          Start with explicit strategy

Coordination (multi-agent teamwork):
  /swarm coord <objective>               Start coordinated agents
  /swarm coord <objective> [options]     Start with explicit mode
  /swarm coord templates                 Show coordination templates

Management:
  /swarm status [id]                     Show session status
  /swarm list                            List all sessions
  /swarm cancel <id>                     Cancel a session

Decomposition options:
  --strategy parallel|sequential|map-reduce|pipeline
  --aggregation concatenate|merge-dedupe|summarize|structured

Coordination options:
  --mode competitive|collaborative|consensus|overseer
  --template code-review|architecture|security-audit|brainstorm|debate

Requires --agents flag.`);
      }
      break;
    }

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
    // Background Jobs
    // ================================================================

    case '/bg': {
      const bgPrompt = parts.slice(1).join(' ');
      if (!bgPrompt) {
        ctx.addMessage('error', 'Usage: /bg <prompt> — run a task in the background');
        break;
      }
      const bgJob = createJob(bgPrompt, { provider: ctx.actualProvider, model: ctx.actualModel });
      ctx.addMessage('system', `Background job ${bgJob.id} created: "${bgPrompt.length > 60 ? bgPrompt.slice(0, 57) + '...' : bgPrompt}"`);
      // Run the job using the agent
      runJob(bgJob.id, async (prompt, signal) => {
        const { chat } = await import('../providers/index.js');
        const { TOOLS } = await import('../tools.js');
        const { getSystemPrompt: getSysPrompt } = await import('../types.js');
        const bgMessages: LLMMessage[] = [
          { role: 'system', content: getSysPrompt(ctx.persona) },
          { role: 'user', content: prompt },
        ];
        let iterations = 0;
        let lastContent = '';
        while (iterations < 20 && !signal.aborted) {
          iterations++;
          const response = await chat(ctx.provider, bgMessages, TOOLS, ctx.model);
          if (!response.toolCalls?.length) {
            lastContent = response.content;
            break;
          }
          bgMessages.push({ role: 'assistant', content: response.content, toolCalls: response.toolCalls });
          const { executeTool: execTool } = await import('../tools.js');
          for (const tc of response.toolCalls) {
            const result = await execTool(tc, process.cwd());
            bgMessages.push({ role: 'tool', content: result.result, toolCallId: tc.id });
          }
        }
        return { result: lastContent, iterations };
      }).then(completed => {
        ctx.addMessage('system', `Background job ${completed.id} ${completed.status}: ${completed.result?.slice(0, 200) || completed.error || 'done'}`);
      }).catch(() => { /* handled in job status */ });
      break;
    }

    case '/jobs': {
      ctx.addMessage('system', formatJobsList());
      break;
    }

    case '/job': {
      const jobId = parts[1];
      if (!jobId) {
        ctx.addMessage('error', 'Usage: /job <id> — show job details');
        break;
      }
      const jobInfo = getJob(jobId);
      if (!jobInfo) {
        ctx.addMessage('error', `Job "${jobId}" not found.`);
      } else {
        ctx.addMessage('system', formatJob(jobInfo) + (jobInfo.result ? `\n\nResult:\n${jobInfo.result.slice(0, 2000)}` : ''));
      }
      break;
    }

    case '/cancel': {
      const cancelId = parts[1];
      if (!cancelId) {
        ctx.addMessage('error', 'Usage: /cancel <job-id>');
        break;
      }
      const cancelled = cancelJob(cancelId);
      ctx.addMessage('system', cancelled ? `Cancelled job ${cancelId}` : `Could not cancel ${cancelId} (not running or not found)`);
      break;
    }

    case '/clear-jobs': {
      const cleared = clearFinishedJobs();
      ctx.addMessage('system', cleared > 0 ? `Cleared ${cleared} finished job(s).` : 'No finished jobs to clear.');
      break;
    }

    // ================================================================
    // Recordings
    // ================================================================

    case '/recordings': {
      const recs = listRecordings();
      if (recs.length === 0) {
        ctx.addMessage('system', 'No recordings found.');
      } else {
        const lines = recs.slice(0, 20).map(r => {
          const dur = r.duration > 0 ? ` (${Math.floor(r.duration / 60000)}m${Math.floor((r.duration % 60000) / 1000)}s)` : '';
          return `  ${r.id}  ${r.startTime}  ${r.eventCount} events${dur}`;
        });
        ctx.addMessage('system', `Recordings (${recs.length} total):\n${lines.join('\n')}`);
      }
      break;
    }

    case '/recording': {
      const recId = parts[1];
      if (!recId) {
        ctx.addMessage('error', 'Usage: /recording <id> — show recording details');
        break;
      }
      const rec = loadRecording(recId);
      if (!rec) {
        ctx.addMessage('error', `Recording "${recId}" not found.`);
      } else {
        ctx.addMessage('system', formatRecording(rec));
      }
      break;
    }

    case '/delete-recording': {
      const delRecId = parts[1];
      if (!delRecId) {
        ctx.addMessage('error', 'Usage: /delete-recording <id>');
        break;
      }
      const delResult = deleteRecording(delRecId);
      ctx.addMessage('system', delResult ? `Deleted recording ${delRecId}` : `Recording "${delRecId}" not found.`);
      break;
    }

    // ================================================================
    // API Server
    // ================================================================

    case '/serve': {
      if (isApiServerRunning()) {
        ctx.addMessage('system', 'API server is already running.');
        break;
      }
      const servePort = parts[1] ? parseInt(parts[1], 10) : 3100;
      if (isNaN(servePort) || servePort < 1 || servePort > 65535) {
        ctx.addMessage('error', 'Invalid port. Usage: /serve [port]');
        break;
      }
      try {
        const info = await startApiServer({ port: servePort, host: '127.0.0.1' });
        ctx.addMessage('system', `API server started on http://${info.host}:${info.port}`);
      } catch (err) {
        ctx.addMessage('error', `Failed to start API server: ${err instanceof Error ? err.message : String(err)}`);
      }
      break;
    }

    case '/serve-stop': {
      if (!isApiServerRunning()) {
        ctx.addMessage('system', 'API server is not running.');
        break;
      }
      await stopApiServer();
      ctx.addMessage('system', 'API server stopped.');
      break;
    }

    case '/exit':
    case '/quit':
      process.exit(0);

    default:
      ctx.addMessage('error', `Unknown command: ${command}. Type /help for help.`);
  }
}
