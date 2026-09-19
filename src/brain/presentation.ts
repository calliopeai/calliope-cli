import type { TransferReport } from './transfer-report.js';
/** Compact terminal views; headless callers keep the complete versioned JSON contract. */
export function brainLines(action: string, result: unknown): string[] {
  const data = result as Record<string, unknown>,
    lines = [`Brain ${action}`];
  const item = (value: unknown) => {
    const e = value as {
      id: string;
      name?: string;
      kind?: string;
      state?: string;
      effectiveState?: string;
      freshness?: string;
      confidence?: number;
      summary?: string;
    };
    return `${e.id} · ${e.kind ?? 'record'} · ${e.name ?? ''}${e.state ? ' · ' + (e.effectiveState ?? e.state) : ''}${e.freshness ? ' · ' + e.freshness : ''}`;
  };
  if (action === 'status')
    lines.push(
      `${data.scope} · ${data.entities} entities · ${data.edges} relationships · ${data.sources} sources · ${data.events} events`,
    );
  else if (data.entity) {
    lines.push(item(data.entity));
    const value = data.entity as { summary?: string };
    if (value.summary) lines.push(value.summary);
  }
  if (Array.isArray(data.entities))
    lines.push(
      ...data.entities.map(item),
      ...(!data.entities.length ? ['No matching knowledge.'] : []),
    );
  if (Array.isArray(data.edges))
    for (const edge of data.edges as {
      id: string;
      from: string;
      to: string;
      type: string;
      state: string;
      effectiveState?: string;
    }[])
      lines.push(
        `${edge.id} · ${edge.from} --${edge.type}--> ${edge.to} · ${edge.effectiveState ?? edge.state}`,
      );
  if (Array.isArray(data.sources))
    for (const source of data.sources as {
      id: string;
      name: string;
      content: string;
    }[])
      lines.push(
        `Source ${source.id} · ${source.name}`,
        source.content.slice(0, 3000) +
          (source.content.length > 3000
            ? '\n… source preview limited; use --json for the full retained snapshot.'
            : ''),
      );
  if (Array.isArray(data.events))
    for (const event of data.events as {
      id: string;
      at: string;
      actor: string;
      reason: string;
    }[])
      lines.push(`${event.id} · ${event.at} · ${event.actor} · ${event.reason}`);
  for (const key of [
    'entityId',
    'sourceId',
    'edgeId',
    'eventId',
    'path',
    'checksum',
    'imported',
    'found',
    'partial',
    'index',
  ])
    if (data[key] !== undefined) lines.push(`${key}: ${String(data[key])}`);
  if (data.revision) lines.push(`Revision ${data.revision}`);
  if (data.report) {
    const report = data.report as TransferReport;
    lines.push(
      `${report.representation}: ${report.losses.length} conversion limits · ${report.conflicts} conflicts · ${report.changes} changes`,
    );
    for (const loss of report.losses) lines.push(`${loss.code}: ${loss.message}`);
    if (report.destinationRevision) lines.push(`Review revision ${report.destinationRevision}`);
    if (data.preview) lines.push('Preview only; no knowledge or output file written.');
  }
  return lines;
}
