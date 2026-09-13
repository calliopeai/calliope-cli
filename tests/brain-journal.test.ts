import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import {
  replayBrain,
  inverseChanges,
  recordInput,
  validateHeader,
  validateEvent,
  source as validateSource,
  entity as validateEntity,
  edge as validateEdge,
  change as validateChange,
  provenance,
  BrainError,
} from '../src/brain/index.js';
import { append, emptyJournal, changes, source, entity, edge } from './helpers/brain.js';
describe('brain journal', () => {
  it('replays typed records, provenance, revisions and relationship evidence deterministically', () => {
    const journal = append(emptyJournal(), [
      ...changes(entity(), entity('decision', { kind: 'decision' })),
      { kind: 'edge', id: 'rel', expected: null, value: edge() },
    ]);
    const a = replayBrain(journal),
      b = replayBrain(JSON.parse(JSON.stringify(journal)));
    expect(a).toEqual(b);
    expect(a.state.edges.rel?.provenance).toEqual([{ sourceId: 'source', basis: 'observed' }]);
    expect(a.state.entities.document?.revision).toBe(journal.events[0]?.id);
    expect(recordInput(a.state.entities.document!)).toEqual(entity());
  });
  it('allows a reviewed human inference but does not promote automated or imported claims', () => {
    const inferred = entity('document', {
      provenance: [{ sourceId: 'source', basis: 'inferred', excerpt: 'portable database' }],
    });
    expect(
      replayBrain(append(emptyJournal(), changes(inferred))).state.entities.document?.state,
    ).toBe('accepted');
    for (const actor of ['ingest', 'run', 'import'] as const)
      expect(() => replayBrain(append(emptyJournal(), changes(inferred), { actor }))).toThrow(
        'human review',
      );
    expect(() =>
      replayBrain(append(emptyJournal(), changes(entity()), { actor: 'import' })),
    ).toThrow('Imported acceptance');
    expect(
      replayBrain(
        append(emptyJournal(), changes({ ...inferred, state: 'proposed' }), { actor: 'ingest' }),
      ).state.entities.document?.state,
    ).toBe('proposed');
  });
  it('requires source evidence and verifies literal excerpts', () => {
    expect(() =>
      replayBrain(
        append(emptyJournal(), [
          { kind: 'entity', id: 'document', expected: null, value: entity() },
        ]),
      ),
    ).toThrow('missing source');
    expect(() =>
      replayBrain(
        append(
          emptyJournal(),
          changes(
            entity('document', {
              provenance: [
                { sourceId: 'source', basis: 'observed', excerpt: 'Invented quotation' },
              ],
            }),
          ),
        ),
      ),
    ).toThrow('unverified excerpt');
  });
  it('retains immutable evidence and rejects source replacement', () => {
    const first = append(emptyJournal(), changes(entity()));
    const second = append(first, [{ kind: 'source', value: source() }]);
    expect(replayBrain(second).state.sources.source?.revision).toBe(first.events[0]?.id);
    expect(() =>
      replayBrain(append(first, [{ kind: 'source', value: source('source', 'Replacement') }])),
    ).toThrow('immutable evidence');
  });
  it('preserves sources through exact reversals and rejects forged reversals', () => {
    const first = append(emptyJournal(), changes(entity()));
    const inverse = inverseChanges(first.events[0]!, replayBrain(emptyJournal()).state);
    const reverted = append(first, inverse, { actor: 'reversal', reverses: first.events[0]!.id });
    expect(Object.keys(replayBrain(reverted).state.entities)).toHaveLength(0);
    expect(replayBrain(reverted).state.sources.source).toBeDefined();
    expect(() =>
      replayBrain(
        append(
          first,
          [
            {
              kind: 'entity',
              id: 'document',
              expected: first.events[0]!.id,
              value: entity('document', { name: 'Forged' }),
            },
          ],
          { actor: 'reversal', reverses: first.events[0]!.id },
        ),
      ),
    ).toThrow('recorded inverse');
    expect(() => replayBrain(append(first, inverse, { reverses: first.events[0]!.id }))).toThrow(
      'Only a reversal',
    );
  });
  it('detects later edits and delete/recreate races when reversing', () => {
    const first = append(emptyJournal(), changes(entity()));
    const edited = append(first, [
      {
        kind: 'entity',
        id: 'document',
        expected: first.events[0]!.id,
        value: entity('document', { name: 'Corrected' }),
      },
    ]);
    expect(() =>
      replayBrain(
        append(edited, inverseChanges(first.events[0]!, replayBrain(emptyJournal()).state), {
          actor: 'reversal',
          reverses: first.events[0]!.id,
        }),
      ),
    ).toThrow('Knowledge changed');
    const removed = append(edited, [
      { kind: 'entity', id: 'document', expected: edited.events[1]!.id, value: null },
    ]);
    expect(() =>
      replayBrain(
        append(removed, [{ kind: 'entity', id: 'document', expected: null, value: entity() }]),
      ),
    ).toThrow('Knowledge changed');
    const restored = append(
      removed,
      inverseChanges(removed.events[2]!, replayBrain(edited).state),
      { actor: 'reversal', reverses: removed.events[2]!.id },
    );
    expect(replayBrain(restored).state.entities.document?.name).toBe('Corrected');
  });
  it('rejects dangling relationships and removing absent records', () => {
    expect(() =>
      replayBrain(
        append(emptyJournal(), [
          ...changes(entity()),
          { kind: 'edge', id: 'rel', expected: null, value: edge() },
        ]),
      ),
    ).toThrow('missing knowledge');
    expect(() =>
      replayBrain(
        append(emptyJournal(), [{ kind: 'entity', id: 'absent', expected: null, value: null }]),
      ),
    ).toThrow('absent knowledge');
    const first = append(emptyJournal(), [
      ...changes(entity(), entity('decision')),
      { kind: 'edge', id: 'rel', expected: null, value: edge() },
    ]);
    const remove = append(first, [
      { kind: 'edge', id: 'rel', expected: first.events[0]!.id, value: null },
      { kind: 'entity', id: 'decision', expected: first.events[0]!.id, value: null },
    ]);
    expect(replayBrain(remove).state.edges.rel).toBeUndefined();
    expect(
      replayBrain(
        append(remove, inverseChanges(remove.events[1]!, replayBrain(first).state), {
          actor: 'reversal',
          reverses: remove.events[1]!.id,
        }),
      ).state.edges.rel,
    ).toBeDefined();
  });
  it('fails closed for corrupt ancestry, unsupported versions and cancellation', () => {
    const first = append(emptyJournal(), changes(entity()));
    for (const value of [
      { ...first, version: 2 },
      { ...first, hash: '0'.repeat(64) },
      { ...first, events: [{ ...first.events[0], hash: '0'.repeat(64) }] },
      append(first, [{ kind: 'source', value: source() }], { id: first.events[0]!.id }),
      append(first, [{ kind: 'source', value: source() }], { at: '2020-01-01T00:00:00.000Z' }),
      append(first, [{ kind: 'source', value: source() }], { sequence: 4 }),
      append(first, [{ kind: 'source', value: source() }], { previous: '0'.repeat(64) }),
    ])
      expect(() => replayBrain(value)).toThrow();
    expect(() => replayBrain(first, AbortSignal.abort())).toThrow();
  });
});
describe('brain schemas', () => {
  it.each([
    null,
    [],
    {},
    { version: 2 },
    {
      version: 1,
      id: randomUUID(),
      scope: 'global',
      project: {},
      createdAt: new Date().toISOString(),
    },
  ])('rejects malformed headers %j', (value) =>
    expect(() => validateHeader(value)).toThrow(BrainError),
  );
  it('validates field types, bounds, source hashes and relative locators', () => {
    for (const patch of [
      { id: '../escape' },
      { name: '' },
      { content: '\u0000' },
      { contentHash: '0'.repeat(64) },
      { originalHash: '0'.repeat(64) },
      { kind: 'file', locator: {} },
      { kind: 'run', locator: {} },
      { locator: { path: '/private/secret' } },
      { locator: { path: '../escape' } },
      { locator: { path: 'a\\b' } },
      { extra: true },
    ])
      expect(() => validateSource({ ...source(), ...patch })).toThrow();
    expect(
      validateSource({ ...source(), originalHash: '0'.repeat(64), redacted: true }),
    ).toBeDefined();
    for (const patch of [
      { kind: 'unknown' },
      { confidence: NaN },
      { confidence: 2 },
      { state: 'unknown' },
      { summary: 42 },
      { attributes: [] },
      { attributes: { invalid: [] } },
      { provenance: [] },
    ])
      expect(() => validateEntity({ ...entity(), ...patch })).toThrow();
    expect(
      validateEntity({
        ...entity(),
        attributes: { enabled: true, cost: 0, missing: null, note: '' },
      }),
    ).toBeDefined();
    expect(() => validateEdge({ ...edge(), type: 'has space' })).toThrow();
    for (const value of [
      [{ sourceId: 'source', basis: 'maybe' }],
      [
        { sourceId: 'source', basis: 'observed' },
        { sourceId: 'source', basis: 'observed' },
      ],
    ])
      expect(() => provenance(value)).toThrow();
    expect(() => validateChange({ kind: 'source', value: source(), id: 'extra' })).toThrow();
    expect(() =>
      validateChange({ kind: 'entity', id: 'other', expected: null, value: entity() }),
    ).toThrow();
    expect(() =>
      validateChange({ kind: 'entity', id: 'document', expected: 'invalid', value: entity() }),
    ).toThrow();
    expect(() =>
      validateEvent(
        append(emptyJournal(), [...changes(entity()), { kind: 'source', value: source() }])
          .events[0],
      ),
    ).toThrow('only once');
    expect(() => validateEvent(append(emptyJournal(), []).events[0])).toThrow();
  });
});

it('validates bounded original transfer claims without importing arbitrary metadata', () => {
  const origin = {
    brainId: randomUUID(),
    recordId: 'record',
    revision: randomUUID(),
    createdAt: '2026-09-12T00:00:00.000Z',
    updatedAt: '2026-09-12T00:00:00.000Z',
    checksum: 'a'.repeat(64),
    state: 'accepted',
    confidence: 0.8,
  };
  expect(validateEntity({ ...entity(), origins: [origin] })).toBeDefined();
  for (const origins of [
    [],
    Array(9).fill(origin),
    [{ ...origin, brainId: 'bad' }],
    [{ ...origin, state: 'invented' }],
    [{ ...origin, confidence: 2 }],
    [{ ...origin, sourceKind: 'network' }],
    [{ ...origin, locator: { url: 'https://example.invalid' } }],
  ])
    expect(() => validateEntity({ ...entity(), origins })).toThrow();
});
