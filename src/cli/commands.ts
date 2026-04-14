/**
 * CLI Command Handlers
 *
 * Slash command processing, help text, and upgrade flow.
 */

import * as readline from 'readline';
import * as path from 'path';
import * as config from '../config.js';
import { getAvailableProviders, selectProvider } from '../providers/index.js';
import { getSystemPrompt, DEFAULT_MODELS, MODE_CONFIG } from '../types.js';
import { getVersion, getLatestVersion, performUpgrade } from '../version-check.js';
import { selectModelInteractively } from '../model-detection.js';
import * as memory from '../memory.js';
import * as hooks from '../hooks.js';
import * as modelRouter from '../model-router.js';
import * as summarization from '../summarization.js';
import * as themes from '../themes.js';
import * as branching from '../branching.js';
import * as fuzzySearch from '../fuzzy-search.js';
import { scuttlebotClient } from '../scuttlebot/index.js';
import type { LLMProvider, AgentPersona, Mode } from '../types.js';
import * as storage from '../storage.js';
import { addToScope, removeFromScope, getScopeSummary, getScopeDetails, resetScope } from '../scope.js';
import { color } from '../styles.js';
import { getCurrentSkin, getCurrentPalette, applySkin, applyPalette, listSkins, listPalettes } from '../hud/api.js';
import { getCurrentCompanion, applyCompanion, listCompanions, getMoodText } from '../companions.js';
import { applyThemePack, listThemePacks, getCurrentPack, getCompanionMode, setCompanionMode } from '../hud/theme-packs/api.js';
import { isDockerAvailable } from '../sandbox.js';
import { getSandboxStatus } from '../sandbox-native.js';
import type { CLIState } from './types.js';
import { resolveIterationLimit, formatIterationLimit } from '../iteration-limit.js';

// Builds the full system prompt including memory context (project + global)
function buildFullSystemPrompt(persona: AgentPersona, cwd: string): string {
  const base = getSystemPrompt(persona);
  const mem = memory.buildMemoryContext(cwd);
  return mem.trim() ? base + '\n\n--- Project Context ---\n' + mem : base;
}

function formatLedgerDuration(durationMs: number): string {
  if (durationMs < 1000) return `${durationMs}ms`;
  if (durationMs < 60_000) return `${(durationMs / 1000).toFixed(1)}s`;
  return `${(durationMs / 60_000).toFixed(1)}m`;
}

function formatSessionLogLimit(limit: number): string {
  return limit > 0 ? String(limit) : 'unlimited';
}

// Forward declaration — injected by index.ts to avoid circular imports
let _startLoop: (args: string, state: CLIState) => Promise<void>;
export function setStartLoop(fn: typeof _startLoop): void {
  _startLoop = fn;
}

export async function handleCommand(input: string, state: CLIState, rl: readline.Interface): Promise<void> {
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
        const validProviders: LLMProvider[] = ['anthropic', 'google', 'openai', 'together', 'openrouter', 'groq', 'fireworks', 'mistral', 'ollama', 'ai21', 'huggingface', 'litellm', 'bedrock', 'auto'];
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
      if (parts[1] && ['calliope', 'muse', 'minimal'].includes(parts[1])) {
        state.persona = parts[1] as AgentPersona;
        state.messages = [{ role: 'system', content: buildFullSystemPrompt(state.persona, state.cwd) }];
        console.log(color(`Persona set to: ${parts[1]}`, 'green'));
      } else {
        console.log(`Current: ${color(state.persona, 'magenta')}`);
        console.log('Options: calliope, muse, minimal');
      }
      console.log();
      break;

    case '/clear':
    case '/c':
      state.messages = [{ role: 'system', content: buildFullSystemPrompt(state.persona, state.cwd) }];
      state.ledger.reset();
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
      
      // Show scuttlebot status if enabled
      if (scuttlebotClient.isEnabled()) {
        const sbStatus = scuttlebotClient.getStatus();
        console.log(`Scuttlebot: ${color('enabled', 'green')} (${sbStatus.nick})`);
        console.log(`  IRC: ${sbStatus.config?.ircAddr}`);
        console.log(`  Channel: ${sbStatus.config?.channel}`);
      }
      
      console.log();
      break;
    
    case '/scuttlebot':
      {
        const subCmd = parts[1];
        const sbStatus = scuttlebotClient.getStatus();
        
        // /scuttlebot enable - enable mid-session
        if (subCmd === 'enable') {
          if (sbStatus.enabled) {
            console.log(color('Scuttlebot is already enabled.', 'yellow'));
            console.log();
            break;
          }
          
          // Initialize scuttlebot — config loaded from ~/.config/scuttlebot-relay.env,
          // process.env, and .scuttlebot.yaml inside initialize()
          const sessionId = state.sessionId || 'default';
          const enabled = await scuttlebotClient.initialize(sessionId, state.cwd);
          
          if (enabled) {
            const status = scuttlebotClient.getStatus();
            console.log(color('✓ Scuttlebot enabled!', 'green'));
            console.log(`  Nick:      ${color(status.nick || '', 'cyan')}`);
            console.log(`  IRC:       ${status.config?.ircAddr}`);
            console.log(`  Channel:   #${status.config?.channel}`);
            if (status.config?.channels && status.config.channels.length > 1) {
              console.log(`  Channels:  ${status.config.channels.map(c => '#' + c).join(', ')}`);
            }
            console.log();
            
            // Post online status
            await scuttlebotClient.postOnline();
            console.log(color('Posted online status to channel', 'dim'));
          } else {
            console.log(color('Failed to enable scuttlebot', 'red'));
          }
          console.log();
          break;
        }
        
        // /scuttlebot disable - disable mid-session
        if (subCmd === 'disable') {
          if (!sbStatus.enabled) {
            console.log(color('Scuttlebot is not enabled.', 'dim'));
            console.log();
            break;
          }
          
          await scuttlebotClient.postOffline();
          await scuttlebotClient.disconnect();
          console.log(color('Scuttlebot disabled', 'green'));
          console.log();
          break;
        }
        
        // Show status
        if (!sbStatus.enabled) {
          console.log(color('Scuttlebot integration is not enabled.', 'yellow'));
          console.log();
          console.log('To enable scuttlebot:');
          console.log(color('  1. Set environment variables:', 'bold'));
          console.log(color('     SCUTTLEBOT_URL', 'cyan') + '         - scuttlebot API URL');
          console.log(color('     SCUTTLEBOT_TOKEN', 'cyan') + '       - API token');
          console.log(color('     SCUTTLEBOT_CHANNEL', 'cyan') + '     - IRC channel (optional)');
          console.log(color('     SCUTTLEBOT_IRC_ADDR', 'cyan') + '    - IRC server (default: 127.0.0.1:6667)');
          console.log();
          console.log(color('  2. Run:', 'bold'));
          console.log(color('     /scuttlebot enable', 'cyan'));
          console.log();
          console.log(color('  Note:', 'dim') + ' Channel config from .scuttlebot.yaml will be used if present');
          console.log();
          break;
        }
        
        console.log(color('Scuttlebot Status', 'cyan'));
        console.log(color('─'.repeat(40), 'dim'));
        console.log(`Enabled:     ${color('yes', 'green')}`);
        console.log(`Nick:        ${color(sbStatus.nick || '', 'cyan')}`);
        console.log(`IRC:         ${sbStatus.config?.ircAddr}`);
        console.log(`Channel:     #${sbStatus.config?.channel}`);
        console.log(`Connected:   ${sbStatus.connected ? color('yes', 'green') : color('no', 'red')}`);
        if (sbStatus.config?.channels && sbStatus.config.channels.length > 1) {
          console.log(`Channels:    ${sbStatus.config.channels.map(c => '#' + c).join(', ')}`);
        }
        console.log();
        console.log(color('Commands:', 'dim'));
        console.log(color('  /scuttlebot <message>  Post a message', 'dim'));
        console.log(color('  /scuttlebot disable    Disable integration', 'dim'));
        console.log();
        
        // Allow manual message posting
        if (subCmd && subCmd !== 'enable' && subCmd !== 'disable') {
          const message = parts.slice(1).join(' ');
          await scuttlebotClient.postMessage(message);
          console.log(color('Message posted to scuttlebot.', 'green'));
          console.log();
        }
      }
      break;

    case '/loop':
      await _startLoop(parts.slice(1).join(' '), state);
      break;

    case '/cancel-loop':
    case '/breakloop':
      if (state.loopActive) {
        state.loopActive = false;
        console.log(color('Loop cancelled.', 'yellow'));
      } else {
        console.log(color('No active loop.', 'dim'));
      }
      console.log();
      break;

    case '/setup':
      const { reconfigure } = await import('../setup.js');
      await reconfigure();
      break;

    case '/config':
      console.log(`Config: ${config.getConfigPath()}`);
      console.log(`Providers: ${config.getConfiguredProviders().join(', ') || 'none'}`);
      console.log(`sessionLogLimit: ${formatSessionLogLimit(config.get('sessionLogLimit'))} (set > 0 to cap)`);
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

    case '/skin':
      if (parts[1] === 'list' || !parts[1]) {
        const skins = listSkins();
        const currentSkin = getCurrentSkin();
        console.log(`Skins: ${skins.map(s => s.name === currentSkin.name ? color(s.name, 'green') : s.name).join(', ')}`);
        if (!parts[1]) console.log(`Current: ${color(currentSkin.name, 'cyan')} — ${currentSkin.description}`);
      } else {
        applySkin(parts[1]);
        const newSkin = getCurrentSkin();
        if (newSkin.name === parts[1]) {
          config.set('activeSkin', parts[1]);
          console.log(color(`Skin set to: ${parts[1]}`, 'green'));
        } else {
          console.log(color(`Skin not found: ${parts[1]}. Using: ${newSkin.name}`, 'yellow'));
        }
      }
      console.log();
      break;

    case '/palette':
      if (parts[1] === 'list' || !parts[1]) {
        const palettes = listPalettes();
        const currentPal = getCurrentPalette();
        console.log(`Palettes: ${palettes.map(p => p.name === currentPal.name ? color(p.name, 'green') : p.name).join(', ')}`);
        if (!parts[1]) console.log(`Current: ${color(currentPal.name, 'cyan')} — ${currentPal.description}`);
      } else {
        applyPalette(parts[1]);
        const newPal = getCurrentPalette();
        if (newPal.name === parts[1]) {
          config.set('activePalette', parts[1]);
          console.log(color(`Palette set to: ${parts[1]}`, 'green'));
        } else {
          console.log(color(`Palette not found: ${parts[1]}. Using: ${newPal.name}`, 'yellow'));
        }
      }
      console.log();
      break;

    case '/companion':
      if (parts[1] === 'list' || !parts[1]) {
        const companions = listCompanions();
        const currentComp = getCurrentCompanion();
        console.log(`Companions: ${companions.map(comp => comp.name === currentComp.name ? color(comp.name, 'green') : comp.name).join(', ')}`);
        if (!parts[1]) console.log(`Current: ${color(currentComp.name, 'cyan')} — ${currentComp.description}`);
      } else {
        applyCompanion(parts[1]);
        const newComp = getCurrentCompanion();
        if (newComp.name === parts[1]) {
          config.set('activeCompanion', parts[1]);
          state.messages = [{ role: 'system', content: buildFullSystemPrompt(state.persona, state.cwd) }];
          console.log(color(`Companion set to: ${parts[1]}`, 'green'));
          console.log(color(`  "${newComp.greeting}"`, 'dim'));
        } else {
          console.log(color(`Companion not found: ${parts[1]}. Using: ${newComp.name}`, 'yellow'));
        }
      }
      console.log();
      break;

    case '/hud':
      {
        const hudSkin = getCurrentSkin();
        const hudPalette = getCurrentPalette();
        const hudCompanion = getCurrentCompanion();
        const hudPack = getCurrentPack();
        const hudIntensity = getCompanionMode();
        console.log(color('HUD Configuration', 'bold'));
        if (hudPack) console.log(`  Pack:      ${color(hudPack.name, 'cyan')} — ${hudPack.description}`);
        console.log(`  Skin:      ${color(hudSkin.name, 'cyan')} — ${hudSkin.description}`);
        console.log(`  Palette:   ${color(hudPalette.name, 'cyan')} — ${hudPalette.description}`);
        console.log(`  Companion: ${color(hudCompanion.name, 'cyan')} — ${hudCompanion.description}`);
        console.log(`  Intensity: ${hudIntensity}`);
        console.log(`  Emojis:    ${config.get('useEmojis') !== false ? 'ON' : 'OFF'}`);
        console.log(`  Mood:      ${getMoodText()}`);
        console.log();
        console.log(color('  /pack <name>  /intensity <pro|immersive>  /emoji [on|off]', 'dim'));
        console.log(color('  /skin <name>  /palette <name>  /companion <name>', 'dim'));
      }
      console.log();
      break;

    case '/pack':
      if (parts[1] === 'list' || !parts[1]) {
        const category = parts[2] as any;
        const packs = listThemePacks(category || undefined);
        const currentP = getCurrentPack();
        const grouped = new Map<string, typeof packs>();
        for (const p of packs) {
          const group = grouped.get(p.category) || [];
          group.push(p);
          grouped.set(p.category, group);
        }
        console.log(color('Theme Packs:', 'bold'));
        for (const [cat, catPacks] of grouped) {
          console.log(color(`\n  [${cat}]`, 'dim'));
          for (const p of catPacks) {
            const marker = currentP && p.name === currentP.name ? color(' *', 'green') : '';
            console.log(`    ${p.name}${marker} — ${p.description}`);
          }
        }
        console.log(color('\n  /pack <name>', 'dim'));
      } else {
        const success = applyThemePack(parts[1], getCompanionMode());
        if (success) {
          const pack = getCurrentPack()!;
          config.set('activeThemePack', parts[1]);
          config.set('activeSkin', pack.skin.name);
          config.set('activePalette', pack.palette.name);
          const companion = getCompanionMode() === 'professional'
            ? pack.companions.professional
            : pack.companions.immersive;
          config.set('activeCompanion', companion.name);
          // Reset system prompt to use the companion's persona
          state.messages = [{ role: 'system', content: buildFullSystemPrompt(state.persona, state.cwd) }];
          console.log(color(`Theme pack: ${parts[1]}`, 'green'));
          console.log(color(`  "${companion.greeting}"`, 'dim'));
        } else {
          console.log(color(`Theme pack not found: ${parts[1]}`, 'yellow'));
        }
      }
      console.log();
      break;

    case '/intensity':
      if (parts[1] === 'professional' || parts[1] === 'pro') {
        const success = setCompanionMode('professional');
        if (success) {
          const pack = getCurrentPack()!;
          config.set('companionIntensity', 'professional');
          config.set('activeCompanion', pack.companions.professional.name);
          state.messages = [{ role: 'system', content: buildFullSystemPrompt(state.persona, state.cwd) }];
          console.log(color(`Switched to professional mode`, 'green'));
        } else {
          console.log(color('No theme pack active. Use /pack <name> first.', 'yellow'));
        }
      } else if (parts[1] === 'immersive' || parts[1] === 'imm') {
        const success = setCompanionMode('immersive');
        if (success) {
          const pack = getCurrentPack()!;
          config.set('companionIntensity', 'immersive');
          config.set('activeCompanion', pack.companions.immersive.name);
          state.messages = [{ role: 'system', content: buildFullSystemPrompt(state.persona, state.cwd) }];
          console.log(color(`Switched to immersive mode`, 'green'));
        } else {
          console.log(color('No theme pack active. Use /pack <name> first.', 'yellow'));
        }
      } else {
        console.log(`Intensity: ${getCompanionMode()}`);
        console.log(color('Options: /intensity professional (pro), /intensity immersive (imm)', 'dim'));
      }
      console.log();
      break;

    case '/emoji': {
      const emojiArg = parts[1];
      const emojiCurrent = config.get('useEmojis') !== false;
      if (emojiArg === 'on') {
        config.set('useEmojis', true);
        console.log(color('Emojis enabled', 'green'));
      } else if (emojiArg === 'off') {
        config.set('useEmojis', false);
        console.log(color('Emojis disabled — text fallbacks will be used', 'green'));
      } else if (emojiArg === 'toggle') {
        config.set('useEmojis', !emojiCurrent);
        console.log(color(`Emojis ${!emojiCurrent ? 'enabled' : 'disabled'}`, 'green'));
      } else {
        console.log(`Emojis: ${emojiCurrent ? 'ON' : 'OFF'}`);
        console.log(color('Usage: /emoji [on|off|toggle]', 'dim'));
      }
      console.log();
      break;
    }

    case '/branch':
      {
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
        if (!isNaN(val) && val >= 0 && val <= 1000000) {
          config.set('maxIterations', val);
          state.loopMaxIterations = resolveIterationLimit(val);
          console.log(color(`maxIterations set to ${formatIterationLimit(state.loopMaxIterations)}`, 'green'));
        }
      } else if (parts[1] === 'sessionLogLimit' && parts[2]) {
        const val = parseInt(parts[2]);
        if (!isNaN(val) && val >= 0 && val <= 100000) {
          config.set('sessionLogLimit', val);
          state.ledger.setRetentionLimit(val);
          console.log(color(`sessionLogLimit set to ${val === 0 ? 'unlimited (set > 0 to cap)' : val}`, 'green'));
        } else {
          console.log(color('sessionLogLimit must be 0-100000 (0 = unlimited)', 'red'));
        }
      } else {
        console.log('Usage: /set maxIterations <number>');
        console.log('       /set sessionLogLimit <number>');
        console.log('       sessionLogLimit uses 0 for unlimited; set > 0 to cap retained log items');
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
      if (state.sessionId) {
        console.log(`  Session ID: ${state.sessionId}`);
      }
      console.log(`  Messages: ${state.messages.length}`);
      console.log(`  Provider: ${selectProvider(state.provider)}`);
      console.log(`  Model: ${state.model || DEFAULT_MODELS[selectProvider(state.provider)]}`);
      console.log(`  Mode: ${MODE_CONFIG[state.mode].icon} ${state.mode}`);
      console.log(`  Cost: $${state.sessionCost.toFixed(4)}`);
      console.log(`  Logged iterations: ${state.ledger.getTotals().iterations}`);
      console.log(`  Failed approaches: ${state.ledger.getFailedApproachCount()}`);
      const latestRun = state.ledger.getLatestRun();
      if (latestRun) {
        console.log(`  Latest run: ${latestRun.kind} [${latestRun.status}]`);
      }
      console.log();
      break;

    case '/log': {
      const subCmd = parts[1] || 'summary';
      if (subCmd === 'summary') {
        const totals = state.ledger.getTotals();
        const runs = state.ledger.getRuns(5);
        const failures = state.ledger.getFailedApproaches().slice(-5);

        console.log(color('Session Log:', 'cyan'));
        console.log(`  Iterations: ${totals.iterations}`);
        console.log(`  Failed approaches: ${state.ledger.getFailedApproachCount()}`);
        console.log(`  Tokens: ${totals.totalTokens}`);
        console.log(`  Cost: $${totals.totalCost.toFixed(4)}`);
        console.log(`  Duration: ${formatLedgerDuration(totals.totalDurationMs)}`);
        if (runs.length > 0) {
          console.log('\n  Recent runs:');
          for (const run of runs) {
            console.log(`    - ${run.kind} [${run.status}] ${run.prompt}`);
          }
        }
        if (failures.length > 0) {
          console.log('\n  Recent failures:');
          for (const failure of failures) {
            console.log(`    - #${failure.iteration} ${failure.description} — ${failure.reason}`);
          }
        }
      } else if (subCmd === 'tail') {
        const limit = parts[2] ? parseInt(parts[2], 10) : 10;
        const entries = state.ledger.getEntries().slice(-(isNaN(limit) || limit <= 0 ? 10 : limit));
        if (entries.length === 0) {
          console.log(color('No logged iterations yet.', 'dim'));
        } else {
          console.log(color('Recent iterations:', 'cyan'));
          for (const entry of entries) {
            const actions = entry.actions.length > 0
              ? entry.actions.map(action => `${action.tool}(${action.args})${action.result === 'error' ? ' FAILED' : action.result === 'blocked' ? ' BLOCKED' : ''}`).join(', ')
              : 'no tool actions';
            console.log(`  #${entry.iteration} [${entry.outcome}] ${formatLedgerDuration(entry.durationMs)} — ${actions}`);
          }
        }
      } else if (subCmd === 'failures') {
        const failures = state.ledger.getFailedApproaches();
        if (failures.length === 0) {
          console.log(color('No failed approaches recorded.', 'dim'));
        } else {
          console.log(color('Failed approaches:', 'cyan'));
          for (const failure of failures.slice(-10)) {
            console.log(`  - #${failure.iteration} ${failure.description} — ${failure.reason}`);
          }
        }
      } else if (subCmd === 'reset') {
        state.ledger.reset();
        console.log(color('Session log reset.', 'green'));
      } else {
        console.log(color('Usage: /log [summary|tail [N]|failures|reset]', 'dim'));
      }
      console.log();
      break;
    }

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

    case '/sandbox':
      {
        const sandboxArg = parts[1];
        const validModes = ['auto', 'native', 'docker', 'off'];
        if (sandboxArg && validModes.includes(sandboxArg)) {
          config.set('sandboxMode', sandboxArg as 'auto' | 'native' | 'docker' | 'off');
          console.log(color(`Sandbox mode set to: ${sandboxArg}`, 'green'));
        } else if (sandboxArg && !validModes.includes(sandboxArg)) {
          console.log(color(`Invalid sandbox mode: ${sandboxArg}`, 'red'));
          console.log(`Available modes: ${validModes.join(', ')}`);
        } else {
          // Show sandbox status
          const currentMode = config.get('sandboxMode') || 'auto';
          const nativeStatus = getSandboxStatus();
          const dockerReady = isDockerAvailable();

          console.log(color('Sandbox Configuration', 'bold'));
          console.log(`  Mode:     ${color(currentMode, 'cyan')}`);
          console.log();
          console.log(color('  Backends:', 'bold'));
          console.log(`  Docker:   ${dockerReady ? color('available', 'green') : color('not available', 'dim')}`);
          console.log(`  Native:   ${nativeStatus.available ? color('available', 'green') : color('not available', 'dim')}`);
          if (nativeStatus.available) {
            console.log(`            ${nativeStatus.description}`);
          }
          console.log(`  Platform: ${nativeStatus.platform}`);
          console.log();

          // Show effective behaviour
          let effective: string;
          switch (currentMode) {
            case 'auto':
              if (nativeStatus.available) effective = `native (${nativeStatus.backend}) for shell commands`;
              else effective = 'unsandboxed (no native backend available)';
              if (dockerReady) effective += ', Docker for code execution';
              break;
            case 'native':
              effective = nativeStatus.available ? `${nativeStatus.backend}` : 'ERROR: native not available';
              break;
            case 'docker':
              effective = dockerReady ? 'Docker' : 'ERROR: Docker not available';
              break;
            case 'off':
              effective = 'all sandboxing disabled';
              break;
            default:
              effective = 'unknown';
          }
          console.log(`  Effective: ${effective}`);
          console.log();
          console.log(color('  /sandbox <auto|native|docker|off>', 'dim'));
        }
      }
      console.log();
      break;

    case '/exit':
    case '/quit':
      process.exit(0);

    default:
      console.log(color(`Unknown command: ${cmd}. Type /help for help.`, 'red'));
      console.log();
  }
}

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

  rl.question(`${color('Upgrade now? (y/N)', 'cyan')} `, async (answer) => {
    if (answer.toLowerCase() === 'y' || answer.toLowerCase() === 'yes') {
      console.log();
      const success = await performUpgrade();

      if (success) {
        console.log();
        console.log(color('Upgrade complete!', 'green'));
        console.log(color('Restarting Calliope...', 'dim'));
        console.log();

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
  console.log('  /set <key> <val>   Change settings (maxIterations, sessionLogLimit)');
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
  console.log('  /sandbox [mode]    Sandbox status or set mode (auto|native|docker|off)');
  console.log();
  console.log(color('Navigation:', 'bold'));
  console.log('  /find <pattern>    Fuzzy file search');
  console.log('  /branch [list|new|switch]  Conversation branches');
  console.log();
  console.log(color('Extensions:', 'bold'));
  console.log('  /hooks [init|list] Pre/post tool hooks');
  console.log('  /theme [name|list] Color themes');
  console.log();
  console.log(color('HUD:', 'bold'));
  console.log('  /skin [name|list]      Switch visual skin');
  console.log('  /palette [name|list]   Switch color palette');
  console.log('  /companion [name|list] Switch AI companion');
  console.log('  /hud               Show HUD status');
  console.log();
  console.log(color('Agent Loop:', 'bold'));
  console.log('  /loop "<prompt>"   Start autonomous loop (default: unlimited)');
  console.log('    --max-iterations N');
  console.log('    --completion-promise "text"');
  console.log('  /cancel-loop       Stop active loop');
  console.log('  /breakloop         Stop active loop');
  console.log();
  console.log(color('Info & Config:', 'bold'));
  console.log('  /session           Show session info');
  console.log('  /log               Show iteration/run log');
  console.log('  /cost [reset]      Show cost tracking');
  console.log('  /scuttlebot [enable|disable|msg]  Scuttlebot integration');
  console.log('  /setup             Reconfigure');
  console.log('  /config            Show config path');
  console.log('  /upgrade           Check for and install updates');
  console.log('  /exit              Exit');
  console.log();
}
