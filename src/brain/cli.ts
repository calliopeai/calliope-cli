import { brainLines } from './presentation.js';
import { parseArgs } from 'node:util';
import { approvalDisplayText } from '../approvals/index.js';
import { isCancellation } from '../cancellation.js';
import { ExecutionLimitError } from '../execution/index.js';
import { SessionPolicyError } from '../session-management/index.js';
import { OrchestrationError } from '../orchestration/types.js';
import { BrainError, type BrainInspection, type EntityInput } from './types.js';
import {
  initBrain,
  ingestBrainFile,
  noteBrain,
  editBrain,
  editBrainEdge,
  linkBrain,
  reverseBrain,
  reindexBrain,
  refreshBrain,
} from './actions.js';
import { queryBrain } from './queries.js';
import { exportBrain, exportKnowledgeGraphFile, importBrain } from './transfer.js';
import { ingestBrainRun, type BrainRunOptions } from './run-ingest.js';
export const BRAIN_USAGE =
  'calliope brain init|status|ingest <path>|ingest-run <id>|search <query>|entity <id/name>|neighbors <id/name>|path <from> <to>|graph [root]|decisions|risks|history|export [path] [--kg]|import <path>|note <name> <text>|edit <id/name>|edit-edge <id>|link <from> <to> <type> --source <id>|reverse <event> --reason <text>|refresh|reindex [--global] [--allow-mutations] [--json]';
export function brainReceipt(result: BrainInspection & Record<string, unknown>) {
  const { journal, state, ...extra } = result;
  return {
    ...extra,
    version: 1,
    scope: state.header.scope,
    brainId: state.header.id,
    revision: state.revision,
    eventId: journal.events.at(-1)?.id ?? null,
    events: journal.events.length,
  };
}
export async function runBrainCommand(
  args: string[],
  options: BrainRunOptions & { cwd?: string; write?: (line: string) => void; kg?: boolean } = {},
): Promise<number> {
  const write = options.write ?? ((line) => process.stdout.write(line)),
    cwd = options.cwd ?? process.cwd();
  let json = args.includes('--json'),
    action = 'status';
  const emit = (data: unknown) => write(JSON.stringify(data) + '\n');
  try {
    if (args.length > 64 || args.some((s) => s.length > 16384 || /[\x00-\x1f\x7f]/.test(s)))
      throw new BrainError('invalid', BRAIN_USAGE);
    const { values: v, positionals: p } = parseArgs({
      args,
      allowPositionals: true,
      options: {
        json: { type: 'boolean' },
        global: { type: 'boolean' },
        'allow-mutations': { type: 'boolean' },
        kind: { type: 'string' },
        limit: { type: 'string' },
        depth: { type: 'string' },
        direction: { type: 'string' },
        'include-rejected': { type: 'boolean' },
        source: { type: 'string' },
        reason: { type: 'string' },
        name: { type: 'string' },
        summary: { type: 'string' },
        state: { type: 'string' },
        confidence: { type: 'string' },
        kg: { type: 'boolean' },
      },
    });
    json = !!v.json;
    action = p[0] ?? (options.kg ? 'graph' : 'status');
    const counts: Record<string, number[]> = {
      init: [0],
      status: [0],
      ingest: [1],
      'ingest-run': [1],
      search: [1],
      entity: [1],
      neighbors: [1],
      path: [2],
      graph: [0, 1],
      decisions: [0],
      risks: [0],
      history: [0],
      export: [0, 1],
      import: [1],
      note: [2],
      edit: [1],
      'edit-edge': [1],
      link: [3],
      reverse: [1],
      refresh: [0],
      reindex: [0],
    };
    if (
      !counts[action]?.includes(p.slice(1).length) ||
      (options.kg && !['search', 'graph'].includes(action))
    )
      throw new BrainError('invalid', BRAIN_USAGE);
    const allowed: Record<string, string[]> = {
      kind: ['note', 'search'],
      limit: ['search', 'decisions', 'risks', 'history', 'neighbors', 'graph'],
      depth: ['path'],
      direction: ['path'],
      'include-rejected': ['search', 'decisions', 'risks', 'neighbors', 'path', 'graph'],
      source: ['link'],
      reason: ['edit', 'edit-edge', 'reverse'],
      name: ['edit'],
      summary: ['edit'],
      state: ['edit', 'edit-edge'],
      confidence: ['edit', 'edit-edge'],
      kg: ['export'],
    };
    for (const [flag, actions] of Object.entries(allowed))
      if (v[flag as keyof typeof v] !== undefined && !actions.includes(action))
        throw new BrainError('invalid', BRAIN_USAGE);
    if (
      (['edit', 'edit-edge', 'reverse'].includes(action) && !v.reason) ||
      (action === 'link' && !v.source)
    )
      throw new BrainError('invalid', BRAIN_USAGE);
    const opts: BrainRunOptions = {
      ...options,
      scope: v.global ? 'global' : options.scope,
      confirmation: v['allow-mutations'] ? 'none' : (options.confirmation ?? 'mutating'),
      ...(v['allow-mutations'] ? { approve: async () => 'allow' as const } : {}),
    };
    let result: unknown;
    switch (action) {
      case 'init':
        result = brainReceipt(await initBrain(cwd, opts));
        break;
      case 'ingest':
        result = brainReceipt(await ingestBrainFile(cwd, p[1]!, opts));
        break;
      case 'ingest-run':
        result = brainReceipt(await ingestBrainRun(cwd, p[1]!, opts));
        break;
      case 'note':
        result = brainReceipt(
          await noteBrain(cwd, p[1]!, p[2]!, v.kind as EntityInput['kind'] | undefined, opts),
        );
        break;
      case 'edit': {
        const patch = {
          ...(v.name !== undefined ? { name: v.name } : {}),
          ...(v.summary !== undefined ? { summary: v.summary } : {}),
          ...(v.state !== undefined ? { state: v.state as EntityInput['state'] } : {}),
          ...(v.confidence !== undefined ? { confidence: Number(v.confidence) } : {}),
        };
        result = brainReceipt(await editBrain(cwd, p[1]!, patch, v.reason!, opts));
        break;
      }
      case 'edit-edge':
        result = brainReceipt(
          await editBrainEdge(
            cwd,
            p[1]!,
            {
              ...(v.state !== undefined ? { state: v.state as EntityInput['state'] } : {}),
              ...(v.confidence !== undefined ? { confidence: Number(v.confidence) } : {}),
            },
            v.reason!,
            opts,
          ),
        );
        break;
      case 'link':
        result = brainReceipt(await linkBrain(cwd, p[1]!, p[2]!, p[3]!, v.source!, opts));
        break;
      case 'reverse':
        result = brainReceipt(await reverseBrain(cwd, p[1]!, v.reason!, opts));
        break;
      case 'refresh':
        result = brainReceipt(await refreshBrain(cwd, opts));
        break;
      case 'reindex':
        result = brainReceipt(await reindexBrain(cwd, opts));
        break;
      case 'export':
        result = v.kg
          ? await exportKnowledgeGraphFile(cwd, p[1] ?? `calliope-kg-${Date.now()}.json`, opts)
          : await exportBrain(cwd, p[1] ?? `calliope-brain-export-${Date.now()}.json`, opts);
        break;
      case 'import':
        result = brainReceipt(await importBrain(cwd, p[1]!, opts));
        break;
      default:
        result = await queryBrain(
          cwd,
          action as Parameters<typeof queryBrain>[1],
          {
            query: p[1],
            from: p[1],
            to: p[2],
            kind: v.kind as EntityInput['kind'] | undefined,
            limit: v.limit === undefined ? undefined : Number(v.limit),
            depth: v.depth === undefined ? undefined : Number(v.depth),
            direction: v.direction as 'out' | 'both' | undefined,
            includeRejected: v['include-rejected'],
          },
          opts,
        );
    }
    if (json) emit({ version: 1, type: 'brain', action, localOnly: true, data: result });
    else write(approvalDisplayText(brainLines(action, result).join('\n')) + '\n');
    return 0;
  } catch (error) {
    const cancelled = options.signal?.aborted || isCancellation(error),
      denied =
        error instanceof SessionPolicyError ||
        error instanceof ExecutionLimitError ||
        (error instanceof BrainError && error.code === 'policy-denied') ||
        (error instanceof OrchestrationError && error.code === 'policy-denied');
    const known = error instanceof BrainError || error instanceof OrchestrationError,
      invalid = error instanceof TypeError;
    const code = cancelled
        ? 'cancelled'
        : denied
          ? 'policy-denied'
          : known
            ? error.code
            : invalid
              ? 'invalid'
              : 'unavailable',
      message = cancelled
        ? 'Brain operation cancelled; inspect retained history before retrying.'
        : known
          ? approvalDisplayText(error.message)
          : denied
            ? 'Brain operation denied by current policy.'
            : invalid
              ? BRAIN_USAGE
              : 'Brain operation failed; preserve its history and inspect paths, permissions and available storage.';
    if (json)
      emit({ version: 1, type: 'brain', action, localOnly: true, error: { code, message } });
    else write(message + '\n');
    return cancelled ? 130 : denied ? 3 : code === 'invalid' ? 2 : 1;
  }
}
