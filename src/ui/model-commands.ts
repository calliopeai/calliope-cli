import { getAvailableModels } from '../model-detection.js';
import { formatRoutingDecision } from '../routing/index.js';
import { providerChoices, validateSelection, readProjectDefaults, saveProjectDefaults, resolvePreferences } from '../preferences/index.js';
import { RunLog } from '../runlog.js';
import { throwIfCancelled } from '../cancellation.js';
import type { LLMProvider } from '../types.js';
import type { CommandContext } from './commands.js';

/** Provider controls share the same live eligibility checks as inference. */
export async function handleModelCommand(command: string, ctx: CommandContext): Promise<void> {
  const parts = command.trim().split(/\s+/), verb = parts[0]?.toLowerCase(), arg = parts[1];
  const cwd = ctx.sessionRef.current?.projectPath ?? process.cwd();
  const log = RunLog.open(`${ctx.sessionRef.current?.id ?? 'session_adhoc'}_controls`);
  try {
    if (verb === '/defaults') {
      if (parts.length > 2 || arg && !['save', 'reset'].includes(arg)) throw new Error('Usage: /defaults [save|reset]');
      if (arg) {
        const selection = arg === 'reset' ? {} : { provider: ctx.provider ?? ctx.actualProvider, model: ctx.model ?? null };
        const file = await saveProjectDefaults(cwd, selection, { signal: ctx.signal, runlog: log });
        ctx.addMessage('system', `Project model defaults ${arg === 'reset' ? 'reset' : 'saved'}: ${file}`);
      }
      const project = readProjectDefaults(cwd), effective = resolvePreferences(cwd);
      ctx.addMessage('system', `Project defaults: ${JSON.stringify(project.selection ?? {})}\nNew session: ${effective.provider}:${effective.model ?? 'discovered default'} (provider: ${effective.sources.provider}; model: ${effective.sources.model ?? 'discovery'})`);
      if (project.warning) ctx.addMessage('system', project.warning);
      return;
    }
    if (parts.length > 2) throw new Error(`Usage: ${verb} [name|list]`);
    if (verb === '/provider' && (!arg || arg === 'list')) {
      if (!arg && ctx.openProviderPicker) { await ctx.openProviderPicker(); return; }
      const choices = await providerChoices();
      throwIfCancelled(ctx.signal);
      ctx.addMessage('system', choices.map(p => `${p.id}: ${p.health}${p.note ? ` (${p.note})` : ''}${p.configured ? '' : `; configure ${p.configHint}`}`).join('\n'));
      return;
    }
    if (verb === '/model' && (!arg || arg === 'list')) {
      ctx.addMessage('system', `Fetching models for ${ctx.actualProvider}...`);
      const signal = ctx.signal ? AbortSignal.any([ctx.signal, AbortSignal.timeout(30000)]) : AbortSignal.timeout(30000);
      const models = await getAvailableModels(ctx.actualProvider, { signal, throwOnError: true });
      throwIfCancelled(signal);
      if (!models.length) throw new Error(`No models found for ${ctx.actualProvider}. Check /doctor provider ${ctx.actualProvider} --probe.`);
      ctx.setAvailableModels(models); ctx.setModalMode('model');
      return;
    }
    const choice = verb === '/provider' ? { provider: arg!.toLowerCase() as LLMProvider }
      : { provider: ctx.provider ?? ctx.actualProvider, model: arg! };
    const decision = await validateSelection(choice, ctx.llmMessages.current, { signal: ctx.signal, runlog: log });
    throwIfCancelled(ctx.signal);
    if (verb === '/provider') { ctx.setProvider(choice.provider); ctx.setModel(undefined); }
    else ctx.setModel(arg);
    ctx.addMessage('system', `${verb === '/provider' ? 'Provider' : 'Model'}: ${arg} (session only; /defaults save persists for this project)\n${formatRoutingDecision(decision)}`);
  } catch (error) {
    throwIfCancelled(ctx.signal);
    ctx.addMessage('error', `${verb} (${ctx.provider ?? ctx.actualProvider}): ${error instanceof Error ? error.message : 'Model control failed'}. Use /doctor for diagnostics.`);
  } finally { await log.flush(); }
}
