import { afterEach, it, expect } from 'vitest';
import initSql from 'sql.js';
import { BrainIndex, replayBrain } from '../src/brain/index.js';
import { append, emptyJournal, changes, entity, edge } from './helpers/brain.js';
const indexes: BrainIndex[] = [];
const track = (i: BrainIndex) => {
  indexes.push(i);
  return i;
};
afterEach(() => indexes.splice(0).forEach((i) => i.close()));
const state = () =>
  replayBrain(
    append(emptyJournal(), [
      ...changes(
        entity('Z', { name: 'Café storage' }),
        entity('a', { kind: 'risk', name: 'Reliability', summary: 'Persistent index' }),
        entity('a-b', { state: 'rejected', name: 'Rejected option' }),
      ),
      { kind: 'edge', id: 'rel', expected: null, value: edge('rel', { from: 'Z', to: 'a' }) },
    ]),
  ).state;
it('uses real SQLite full-text indexes, source provenance joins, Unicode and bounded parameterized queries', async () => {
  const index = track(await BrainIndex.open(state()));
  expect(index.search('café').map((e) => e.id)).toEqual(['Z']);
  expect(index.search('portable database').map((e) => e.id)).toEqual(['Z', 'a']);
  expect(index.search('portable', { kind: 'risk' }).map((e) => e.id)).toEqual(['a']);
  expect(index.search('portable', { includeRejected: true })).toHaveLength(3);
  expect(index.entity('Z').name).toBe('Café storage');
  expect(index.entity('CAFÉ STORAGE').id).toBe('Z');
  expect(index.neighbors('Z').map((e) => e.id)).toEqual(['rel']);
  expect(index.search('"; DROP TABLE entities; --')).toEqual([]);
  expect(index.entity('a')).toBeDefined();
  expect(() => index.entity('missing')).toThrow('not found');
  expect(() => index.search('')).toThrow('sixteen words');
  expect(() => index.search('x'.repeat(4097))).toThrow('too large');
  expect(() => index.search(Array.from({ length: 17 }, (_, i) => 'x' + i).join(' '))).toThrow(
    'sixteen words',
  );
  for (const limit of [0, -1, 101, 1.5])
    expect(() => index.search('portable', { limit })).toThrow('1–100');
  expect(() => index.search('portable', { kind: 'invalid' as never })).toThrow('kind');
  expect(() => index.search('portable', { signal: AbortSignal.abort() })).toThrow();
});
it('round-trips SQLite and recognizes caches across mixed case and punctuation IDs', async () => {
  const s = state(),
    first = track(await BrainIndex.open(s));
  const bytes = first.export();
  expect(Buffer.from(bytes).subarray(0, 15).toString()).toBe('SQLite format 3');
  const second = track(await BrainIndex.open(s, bytes));
  expect(second.cache).toBe('valid');
  expect(second.search('portable')).toEqual(first.search('portable'));
});
it.each([
  "UPDATE entities SET kind='provider' WHERE id='Z'",
  "UPDATE entities SET payload='{}' WHERE id='Z'",
  "DELETE FROM entities WHERE id='Z'",
  "UPDATE edges SET from_id='a-b'",
  'DELETE FROM sources',
  'DELETE FROM provenance',
  "UPDATE entity_search SET body='fabricated' WHERE id='Z'",
  "UPDATE source_search SET body='fabricated'",
  "UPDATE meta SET value='wrong' WHERE key='brain'",
  'CREATE TABLE extra(secret TEXT)',
])('rebuilds a tampered derived index from the journal: %s', async (sql) => {
  const s = state(),
    original = track(await BrainIndex.open(s)),
    SQL = await initSql(),
    db = new SQL.Database(original.export());
  db.run(sql);
  const bytes = db.export();
  db.close();
  const rebuilt = track(await BrainIndex.open(s, bytes));
  expect(rebuilt.cache).toBe('rebuilt');
  expect(rebuilt.entity('Z').kind).toBe('document');
  expect(rebuilt.search('portable')).toHaveLength(2);
});
it('recovers an unreadable cache without importing facts and honors cancellation', async () => {
  const index = track(await BrainIndex.open(state(), Buffer.from('not SQLite')));
  expect(index.cache).toBe('rebuilt');
  await expect(BrainIndex.open(state(), undefined, AbortSignal.abort())).rejects.toThrow();
  const s = replayBrain(append(emptyJournal(), changes(entity('first'), entity('second')))).state,
    ambiguous = track(await BrainIndex.open(s));
  expect(() => ambiguous.entity('Architecture')).toThrow('ambiguous');
});
