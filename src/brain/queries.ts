import { authorizeSessionAction } from '../session-management/index.js';
import { throwIfCancelled } from '../cancellation.js';
import { brainStore, BrainAccess, type BrainOptions } from './access.js';
import {
  BrainError,
  BRAIN_LIMITS,
  ENTITY_KINDS,
  type EntityKind,
  type BrainEntity,
  type BrainEdge,
} from './types.js';
export interface BrainQuery {
  query?: string;
  kind?: EntityKind;
  limit?: number;
  from?: string;
  to?: string;
  depth?: number;
  direction?: 'out' | 'both';
  includeRejected?: boolean;
}
export async function queryBrain(
  cwd: string,
  action:
    | 'status'
    | 'search'
    | 'entity'
    | 'neighbors'
    | 'path'
    | 'graph'
    | 'decisions'
    | 'risks'
    | 'history',
  input: BrainQuery = {},
  options: BrainOptions = {},
) {
  const store = brainStore(cwd, options);
  await authorizeSessionAction(
    cwd,
    'read_file',
    { path: store.project.root, operation: 'brain-' + action, scope: store.scope },
    options,
  );
  const view = store.read(options.signal),
    access = new BrainAccess(cwd, view.state.sources, options),
    limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > BRAIN_LIMITS.results)
    throw new BrainError('invalid', 'Result limit must be 1–100.');
  if (input.kind !== undefined && !ENTITY_KINDS.includes(input.kind))
    throw new BrainError('invalid', 'Unknown knowledge kind.');
  if (action === 'status')
    return {
      version: 1,
      scope: store.scope,
      brainId: view.state.header.id,
      revision: view.state.revision,
      events: view.journal.events.length,
      entities: Object.keys(view.state.entities).length,
      edges: Object.keys(view.state.edges).length,
      sources: Object.keys(view.state.sources).length,
      limits: BRAIN_LIMITS,
    };
  if (action === 'history') {
    // History may contain now-restricted prior records, so require access to all retained evidence.
    await access.all();
    return {
      revision: view.state.revision,
      events: view.journal.events.slice(-limit).map((e) => ({
        id: e.id,
        at: e.at,
        actor: e.actor,
        reason: e.reason,
        hash: e.hash,
        reverses: e.reverses,
        changes: e.changes.map((c) => ({
          kind: c.kind,
          id: c.kind === 'source' ? c.value.id : c.id,
        })),
      })),
    };
  }
  const index = await store.index(options.signal);
  try {
    if (index.state.revision !== view.state.revision)
      throw new BrainError('conflict', 'Brain changed during query; retry.');
    const visible = new Map<string, Awaited<ReturnType<BrainAccess['visible']>>>();
    const entity = async (id: string) => {
      if (!visible.has(id)) {
        const record = view.state.entities[id];
        visible.set(
          id,
          record && (input.includeRejected || record.state !== 'rejected')
            ? await access.visible(record)
            : null,
        );
      }
      return visible.get(id) as
        (BrainEntity & { freshness: string; effectiveState: string }) | null;
    };
    if (action === 'entity') {
      const record = index.entity(input.query ?? ''),
        result = await access.record(record);
      return {
        entity: result,
        sources: [...new Set(record.provenance.map((p) => p.sourceId))].map(
          (id) => view.state.sources[id]!,
        ),
        index: index.cache,
        revision: view.state.revision,
      };
    }
    if (action === 'search' || action === 'decisions' || action === 'risks') {
      const kind = action === 'decisions' ? 'decision' : action === 'risks' ? 'risk' : input.kind;
      const candidates =
        action === 'search'
          ? index.search(input.query ?? '', {
              kind,
              limit: BRAIN_LIMITS.results,
              includeRejected: input.includeRejected,
              signal: options.signal,
            })
          : Object.values(view.state.entities)
              .filter((e) => e.kind === kind && (input.includeRejected || e.state !== 'rejected'))
              .sort((a, b) => (a.id < b.id ? -1 : 1));
      const entities = [];
      for (const candidate of candidates) {
        throwIfCancelled(options.signal);
        const record = await entity(candidate.id);
        if (record) entities.push(record);
        if (entities.length === limit) break;
      }
      return {
        entities,
        limit,
        partial: candidates.length >= limit,
        index: index.cache,
        revision: view.state.revision,
      };
    }
    const root = input.from ? index.entity(input.from) : undefined;
    if (action !== 'graph' && !root)
      throw new BrainError('invalid', 'Select a starting knowledge entity.');
    if (root && !(await entity(root.id)))
      throw new BrainError(
        'policy-denied',
        'Starting entity is unavailable under current source policy.',
      );
    if (action === 'neighbors') {
      const edges = [];
      const entities = new Map<string, BrainEntity>();
      for (const e of index.neighbors(root!.id, !!input.includeRejected)) {
        throwIfCancelled(options.signal);
        const relation = await access.visible(e),
          other = await entity(e.from === root!.id ? e.to : e.from);
        if (relation && other) {
          edges.push(relation);
          entities.set(other.id, other);
        }
        if (edges.length === limit) break;
      }
      return {
        entity: await entity(root!.id),
        entities: [...entities.values()],
        edges,
        limit,
        revision: view.state.revision,
      };
    }
    if (action === 'path') {
      const target = index.entity(input.to ?? ''),
        depth = input.depth ?? BRAIN_LIMITS.depth;
      if (
        !Number.isSafeInteger(depth) ||
        depth < 0 ||
        depth > BRAIN_LIMITS.depth ||
        (input.direction !== undefined && !['out', 'both'].includes(input.direction))
      )
        throw new BrainError('invalid', 'Path depth must be 0–16 and direction out or both.');
      if (!(await entity(target.id)))
        throw new BrainError(
          'policy-denied',
          'Target entity is unavailable under current source policy.',
        );
      const queue = [{ id: root!.id, path: [root!.id], edges: [] as BrainEdge[] }],
        seen = new Set([root!.id]);
      let cursor = 0;
      while (cursor < queue.length) {
        throwIfCancelled(options.signal);
        const next = queue[cursor++]!;
        if (next.id === target.id)
          return {
            found: true,
            entities: await Promise.all(next.path.map(entity)),
            edges: next.edges,
            visited: seen.size,
            depth,
            revision: view.state.revision,
          };
        if (next.edges.length === depth) continue;
        for (const e of index.neighbors(next.id, !!input.includeRejected)) {
          if (input.direction === 'out' && e.from !== next.id) continue;
          const id = e.from === next.id ? e.to : e.from;
          if (seen.has(id) || !(await entity(id))) continue;
          const relation = await access.visible(e);
          if (!relation) continue;
          seen.add(id);
          queue.push({ id, path: [...next.path, id], edges: [...next.edges, relation] });
          if (seen.size > BRAIN_LIMITS.entities)
            throw new BrainError('limit', 'Graph traversal exceeded its entity bound.');
        }
      }
      return {
        found: false,
        entities: [],
        edges: [],
        visited: seen.size,
        depth,
        revision: view.state.revision,
      };
    }
    // A bounded, deterministic neighborhood (or overview) suitable for a terminal graph/HUD.
    const ids = root
        ? [
            root.id,
            ...index.neighbors(root.id, !!input.includeRejected).flatMap((e) => [e.from, e.to]),
          ]
        : Object.keys(view.state.entities).sort(),
      entities = [];
    for (const id of new Set(ids)) {
      const record = await entity(id);
      if (record) entities.push(record);
      if (entities.length === limit) break;
    }
    const included = new Set(entities.map((e) => e.id)),
      edges = [];
    for (const e of Object.values(view.state.edges)) {
      throwIfCancelled(options.signal);
      if (
        included.has(e.from) &&
        included.has(e.to) &&
        (input.includeRejected || e.state !== 'rejected')
      ) {
        const record = await access.visible(e);
        if (record) edges.push(record);
      }
      if (edges.length === BRAIN_LIMITS.results) break;
    }
    return {
      entities,
      edges,
      limit,
      partial: ids.length > entities.length || edges.length === BRAIN_LIMITS.results,
      revision: view.state.revision,
    };
  } finally {
    index.close();
  }
}
