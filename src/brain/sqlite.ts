import { createRequire } from 'node:module';
import { canonicalJson, digest } from '../approvals/index.js';
import { throwIfCancelled } from '../cancellation.js';
import {
  BrainError,
  BRAIN_LIMITS,
  ENTITY_KINDS,
  type BrainState,
  type BrainEntity,
  type EntityKind,
} from './types.js';
import type { Database, SqlJsStatic, SqlValue } from 'sql.js';
const require = createRequire(import.meta.url);
let engine: Promise<SqlJsStatic> | undefined;
const load = () =>
  (engine ??= (async () => {
    const { default: init } = await import('sql.js');
    return init({ locateFile: () => require.resolve('sql.js/dist/sql-wasm.wasm') });
  })());
const SCHEMA = `PRAGMA user_version=1;
CREATE TABLE meta(key TEXT PRIMARY KEY,value TEXT NOT NULL);
CREATE TABLE entities(id TEXT PRIMARY KEY,kind TEXT NOT NULL,name TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL);
CREATE INDEX entities_kind ON entities(kind,state,id);
CREATE INDEX entities_name ON entities(name,id);
CREATE TABLE edges(id TEXT PRIMARY KEY,from_id TEXT NOT NULL,to_id TEXT NOT NULL,type TEXT NOT NULL,state TEXT NOT NULL,payload TEXT NOT NULL);
CREATE INDEX edges_from ON edges(from_id,state,id);
CREATE INDEX edges_to ON edges(to_id,state,id);
CREATE TABLE sources(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
CREATE TABLE provenance(entity_id TEXT NOT NULL,source_id TEXT NOT NULL,PRIMARY KEY(entity_id,source_id));
CREATE INDEX provenance_source ON provenance(source_id,entity_id);
CREATE VIRTUAL TABLE entity_search USING fts4(id,name,body,notindexed=id,tokenize=unicode61);
CREATE VIRTUAL TABLE source_search USING fts4(id,name,body,notindexed=id,tokenize=unicode61);`;
const compare = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
const rowHash = (values: readonly (readonly SqlValue[])[]) =>
  digest(values.map((row) => digest(canonicalJson(row))).join('\n'));
const folded = (s: string) => s.normalize('NFKC').toLocaleLowerCase('en-US');
function rows(db: Database, sql: string, params: SqlValue[] = []): SqlValue[][] {
  const stmt = db.prepare(sql);
  try {
    stmt.bind(params);
    const result: SqlValue[][] = [];
    while (stmt.step()) {
      if (result.length >= BRAIN_LIMITS.entities * 32 + BRAIN_LIMITS.edges + BRAIN_LIMITS.sources)
        throw new BrainError('limit', 'SQLite query result exceeded its bound.');
      result.push(stmt.get());
    }
    return result;
  } finally {
    stmt.free();
  }
}
const schema = (db: Database) =>
  canonicalJson(rows(db, 'SELECT type,name,sql FROM sqlite_master ORDER BY type,name'));
const recordHash = (state: BrainState) =>
  digest(
    ['sources', 'entities', 'edges']
      .flatMap((kind) =>
        Object.values(state[kind as 'sources' | 'entities' | 'edges'])
          .sort((a, b) => compare(a.id, b.id))
          .map((v) => kind + ':' + v.id + ':' + digest(canonicalJson(v))),
      )
      .join('\n'),
  );
let expectedSchema: string | undefined;
async function build(state: BrainState, signal?: AbortSignal): Promise<Database> {
  throwIfCancelled(signal);
  const SQL = await load();
  throwIfCancelled(signal);
  const db = new SQL.Database();
  try {
    db.run(SCHEMA);
    expectedSchema ??= schema(db);
    db.run('BEGIN');
    const insert = (sql: string, values: SqlValue[][]) => {
      const stmt = db.prepare(sql);
      try {
        for (const row of values) {
          throwIfCancelled(signal);
          stmt.run(row);
        }
      } finally {
        stmt.free();
      }
    };
    insert('INSERT INTO meta VALUES(?,?)', [
      ['revision', state.revision],
      ['records', recordHash(state)],
      ['brain', state.header.id],
    ]);
    for (const source of Object.values(state.sources)) {
      throwIfCancelled(signal);
      db.run('INSERT INTO sources VALUES(?,?)', [source.id, canonicalJson(source)]);
      db.run('INSERT INTO source_search VALUES(?,?,?)', [source.id, source.name, source.content]);
    }
    for (const entity of Object.values(state.entities)) {
      throwIfCancelled(signal);
      db.run('INSERT INTO entities VALUES(?,?,?,?,?)', [
        entity.id,
        entity.kind,
        folded(entity.name),
        entity.state,
        canonicalJson(entity),
      ]);
      db.run('INSERT INTO entity_search VALUES(?,?,?)', [
        entity.id,
        entity.name,
        entity.summary + '\n' + canonicalJson(entity.attributes),
      ]);
      for (const sourceId of new Set(entity.provenance.map((p) => p.sourceId)))
        db.run('INSERT INTO provenance VALUES(?,?)', [entity.id, sourceId]);
    }
    for (const edge of Object.values(state.edges)) {
      throwIfCancelled(signal);
      db.run('INSERT INTO edges VALUES(?,?,?,?,?,?)', [
        edge.id,
        edge.from,
        edge.to,
        edge.type,
        edge.state,
        canonicalJson(edge),
      ]);
    }
    db.run('COMMIT');
    return db;
  } catch (e) {
    db.close();
    throw e;
  }
}
function verify(db: Database, state: BrainState): void {
  if (
    rows(db, 'PRAGMA user_version')[0]?.[0] !== 1 ||
    schema(db) !== expectedSchema ||
    rows(db, 'PRAGMA integrity_check').some((r) => r[0] !== 'ok')
  )
    throw new Error('Index schema or integrity differs.');
  const meta = Object.fromEntries(
    rows(db, 'SELECT key,value FROM meta').map((row) => [String(row[0]), row[1]]),
  );
  if (
    meta.revision !== state.revision ||
    meta.brain !== state.header.id ||
    meta.records !== recordHash(state) ||
    Object.keys(meta).length !== 3
  )
    throw new Error('Stale index.');
  for (const table of ['sources', 'entities', 'edges'] as const) {
    const actual = rows(db, `SELECT id,payload FROM ${table} ORDER BY id`),
      expected = Object.values(state[table]).sort((a, b) => compare(a.id, b.id));
    if (
      actual.length !== expected.length ||
      actual.some(
        ([id, payload], i) => id !== expected[i]!.id || payload !== canonicalJson(expected[i]!),
      )
    )
      throw new Error('Index differs from the journal.');
  }
  // Check both searchable content and its derived token index, not just record payloads.
  for (const [table, values] of [
    [
      'entity_search',
      Object.values(state.entities).map((e) => [
        e.id,
        e.name,
        e.summary + '\n' + canonicalJson(e.attributes),
      ]),
    ],
    ['source_search', Object.values(state.sources).map((s) => [s.id, s.name, s.content])],
  ] as const) {
    if (
      rowHash(rows(db, `SELECT id,name,body FROM ${table} ORDER BY id`)) !==
      rowHash([...values].sort((a, b) => compare(a[0]!, b[0]!)))
    )
      throw new Error('Search content differs from the journal.');
    db.run(`INSERT INTO ${table}(${table}) VALUES('integrity-check')`);
  }
  const links = Object.values(state.entities)
    .flatMap((e) => [...new Set(e.provenance.map((p) => p.sourceId))].map((id) => [e.id, id]))
    .sort((a, b) => compare(a[0]!, b[0]!) || compare(a[1]!, b[1]!));
  if (
    rowHash(rows(db, 'SELECT entity_id,source_id FROM provenance ORDER BY entity_id,source_id')) !==
    rowHash(links)
  )
    throw new Error('Index provenance differs.');
  // Indexed scalar columns must match the verified payload too.
  for (const row of rows(db, 'SELECT id,kind,name,state FROM entities')) {
    const e = state.entities[String(row[0])]!;
    if (canonicalJson(row) !== canonicalJson([e.id, e.kind, folded(e.name), e.state]))
      throw new Error('Entity index differs.');
  }
  for (const row of rows(db, 'SELECT id,from_id,to_id,type,state FROM edges')) {
    const e = state.edges[String(row[0])]!;
    if (canonicalJson(row) !== canonicalJson([e.id, e.from, e.to, e.type, e.state]))
      throw new Error('Edge index differs.');
  }
}
export class BrainIndex {
  private constructor(
    private readonly db: Database,
    readonly state: BrainState,
    readonly cache: 'valid' | 'rebuilt',
  ) {}
  static async open(
    state: BrainState,
    bytes?: Uint8Array,
    signal?: AbortSignal,
  ): Promise<BrainIndex> {
    throwIfCancelled(signal);
    const SQL = await load();
    throwIfCancelled(signal);
    if (expectedSchema === undefined) {
      const empty = new SQL.Database();
      try {
        empty.run(SCHEMA);
        expectedSchema = schema(empty);
      } finally {
        empty.close();
      }
    }
    if (bytes && bytes.byteLength <= BRAIN_LIMITS.indexBytes) {
      let db: Database | undefined;
      try {
        db = new SQL.Database(bytes);
        verify(db, state);
        throwIfCancelled(signal);
        db.run('PRAGMA query_only=ON');
        return new BrainIndex(db, state, 'valid');
      } catch (e) {
        db?.close();
        throwIfCancelled(signal);
      }
    }
    const db = await build(state, signal);
    if (db.export().byteLength > BRAIN_LIMITS.indexBytes) {
      db.close();
      throw new BrainError(
        'limit',
        'Brain index exceeds 64 MiB; split or export this knowledge scope.',
      );
    }
    db.run('PRAGMA query_only=ON');
    return new BrainIndex(db, state, 'rebuilt');
  }
  close(): void {
    this.db.close();
  }
  export(): Uint8Array {
    return this.db.export();
  }
  entity(selector: string): BrainEntity {
    if (this.state.entities[selector]) return this.state.entities[selector]!;
    const found = rows(this.db, 'SELECT id FROM entities WHERE name=? ORDER BY id LIMIT 2', [
      folded(selector),
    ]);
    if (!found.length) throw new BrainError('not-found', 'Knowledge entity was not found.');
    if (found.length > 1)
      throw new BrainError('conflict', 'Entity name is ambiguous; select its ID from search.');
    return this.state.entities[String(found[0]![0])]!;
  }
  search(
    query: string,
    options: {
      kind?: EntityKind;
      limit?: number;
      includeRejected?: boolean;
      signal?: AbortSignal;
    } = {},
  ): BrainEntity[] {
    throwIfCancelled(options.signal);
    if (options.kind !== undefined && !ENTITY_KINDS.includes(options.kind))
      throw new BrainError('invalid', 'Unknown entity kind.');
    if (Buffer.byteLength(query) > BRAIN_LIMITS.queryBytes)
      throw new BrainError('limit', 'Brain search query is too large.');
    const tokens = [...new Set(folded(query).match(/[\p{L}\p{N}_]+/gu) ?? [])];
    if (!tokens.length || tokens.length > BRAIN_LIMITS.queryTokens)
      throw new BrainError('invalid', 'Search requires one to sixteen words.');
    const limit = options.limit ?? 20;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > BRAIN_LIMITS.results)
      throw new BrainError('limit', 'Search limit must be 1–100.');
    const match = tokens.map((t) => '"' + t + '"').join(' AND '),
      found = rows(
        this.db,
        `SELECT DISTINCT e.id FROM entities e WHERE e.id IN (SELECT id FROM entity_search WHERE entity_search MATCH ? UNION SELECT p.entity_id FROM provenance p JOIN source_search s ON s.id=p.source_id WHERE source_search MATCH ?) ${options.includeRejected ? '' : "AND e.state!='rejected'"} ${options.kind ? 'AND e.kind=?' : ''} ORDER BY e.name,e.id LIMIT ?`,
        [match, match, ...(options.kind ? [options.kind] : []), limit],
      );
    throwIfCancelled(options.signal);
    return found.map((row) => this.state.entities[String(row[0])]!);
  }
  neighbors(id: string, includeRejected = false) {
    return rows(
      this.db,
      `SELECT id FROM edges WHERE (from_id=? OR to_id=?) ${includeRejected ? '' : "AND state!='rejected'"} ORDER BY id LIMIT ?`,
      [id, id, BRAIN_LIMITS.edges],
    ).map((row) => this.state.edges[String(row[0])]!);
  }
}
