import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { canonicalJson, digest } from '../src/approvals/index.js';
import {
  replayBrain,
  validateHeader,
  validateEvent,
  change,
  source as validateSource,
  entity as validateEntity,
  provenance,
  type EntityInput,
} from '../src/brain/index.js';
import { append, emptyJournal, changes, source, entity, edge } from './helpers/brain.js';

const malformed = (valid: string) => [[valid], { value: valid }, null, true, 1];
const origin = () => ({
  brainId: randomUUID(),
  recordId: 'original',
  revision: randomUUID(),
  createdAt: '2026-09-12T00:00:00.000Z',
  updatedAt: '2026-09-12T00:00:00.000Z',
  checksum: '0'.repeat(64),
});

describe('strict native journal enums', () => {
  it('cannot coerce an inferred basis array to bypass the automated-claim review rule', () => {
    const claim = entity('document', {
      state: 'accepted',
      provenance: [
        {
          sourceId: 'source',
          basis: ['inferred'] as unknown as EntityInput['provenance'][number]['basis'],
        },
      ],
    });
    const journal = append(emptyJournal(), changes(claim), { actor: 'run' });
    const { hash, ...body } = journal.events[0]!;
    expect(digest(canonicalJson(body))).toBe(hash); // An otherwise correct event hash is not schema validation.
    expect(() => replayBrain(JSON.parse(JSON.stringify(journal)))).toThrow();
    claim.provenance[0]!.basis = 'inferred';
    expect(() => replayBrain(append(emptyJournal(), changes(claim), { actor: 'run' }))).toThrow(
      'human review',
    );
    claim.state = 'proposed';
    expect(
      replayBrain(append(emptyJournal(), changes(claim), { actor: 'run' })).state.entities.document
        ?.state,
    ).toBe('proposed');
  });

  it.each([
    ['basis', 'observed', (value: unknown) => provenance([{ sourceId: 'source', basis: value }])],
    [
      'knowledge state',
      'accepted',
      (value: unknown) => validateEntity({ ...entity(), state: value }),
    ],
    ['source kind', 'human', (value: unknown) => validateSource({ ...source(), kind: value })],
    [
      'origin state',
      'accepted',
      (value: unknown) => validateEntity({ ...entity(), origins: [{ ...origin(), state: value }] }),
    ],
    [
      'origin source kind',
      'file',
      (value: unknown) =>
        validateSource({ ...source(), origins: [{ ...origin(), sourceKind: value }] }),
    ],
    [
      'change kind',
      'edge',
      (value: unknown) => change({ kind: value, id: 'rel', expected: null, value: edge() }),
    ],
    [
      'scope',
      'project',
      (value: unknown) =>
        validateHeader({
          ...emptyJournal().header,
          scope: value,
          project: { root: '/fixture', key: '0'.repeat(64) },
        }),
    ],
    [
      'actor',
      'human',
      (value: unknown) => {
        const event = append(emptyJournal(), changes(entity())).events[0]!;
        const { hash: _hash, ...body } = { ...event, actor: value };
        return validateEvent({ ...body, hash: digest(canonicalJson(body)) });
      },
    ],
  ] as const)('requires a string for %s', (_name, valid, validate) => {
    expect(() => validate(valid)).not.toThrow();
    for (const value of malformed(valid)) expect(() => validate(value)).toThrow();
  });
});
