import { readToolOutputs, type CapturedToolOutput } from '../sessions/index.js';
import { getSessionDirById } from '../storage.js';
import { approvalDisplayText } from '../approvals/index.js';
import type { CommandContext } from './commands.js';

export function handleToolOutputCommand(parts: string[], ctx: CommandContext): void {
  if (parts.length > 2) throw new Error('Usage: /tools [list|last|output-id]');
  const records = new Map<string, CapturedToolOutput>();
  const dir = ctx.sessionRef.current ? getSessionDirById(ctx.sessionRef.current.id) : null;
  let dropped = 0;
  if (dir) {
    try { const saved = readToolOutputs(dir); dropped = saved.dropped; for (const record of saved.records) records.set(record.id, { record, saved: true }); }
    catch { ctx.addMessage('system', 'Saved tool output is unavailable; showing records retained in this transcript.'); }
  }
  for (const output of ctx.toolOutputs?.() ?? []) records.set(output.record.id, output);
  const values = [...records.values()].sort((a, b) => a.record.createdAt.localeCompare(b.record.createdAt)).slice(-100);
  const selector = parts[1] ?? 'list';
  if (selector === 'list') {
    ctx.addMessage('system', values.length ? values.map(({ record, saved }) =>
      `${record.id} | ${record.channel} ${record.tool} | ${record.isError ? 'failed' : 'completed'}${record.truncated ? ' [truncated]' : ''}${saved ? '' : ' [transcript only]'} | ${approvalDisplayText(record.content.split('\n')[0] ?? '').slice(0, 80)}`).join('\n') +
      `\n/tools <output-id> or /tools last to expand.${dropped ? ` ${dropped} older records expired from the bounded store.` : ''}` : 'No retained tool output in this session.');
    return;
  }
  const output = selector === 'last' ? values.at(-1) : records.get(selector);
  if (!output) throw new Error('Tool output is unavailable in this session; use /tools list. Older records may have expired.');
  if (!ctx.showToolOutput) throw new Error('Tool output viewer is unavailable in this client; use calliope session outputs <session-id> <output-id> --json.');
  ctx.showToolOutput(output);
}
