import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { canonicalExchangeJson, parseExchangeJson } from '../src/brain/exchange-json.js';

const fixture = (name: string) =>
  JSON.parse(
    readFileSync(new URL('./fixtures/brain-interchange/' + name, import.meta.url), 'utf8'),
  );

describe('cross-language exchange JSON', () => {
  it('matches Python RFC 8785 vectors including integer-like keys, Unicode sorting and floats', () => {
    for (const item of fixture('jcs-cases.json'))
      expect(canonicalExchangeJson(item.value)).toBe(item.canonical);
    const archive = fixture('exchange-v2.json');
    const { sha256, ...body } = archive;
    expect(createHash('sha256').update(canonicalExchangeJson(body)).digest('hex')).toBe(sha256);
  });
  it('detects duplicate keys, including escaped names and nested objects', () => {
    for (const raw of [
      '{"a":1,"a":2}',
      '{"a":1,"\\u0061":2}',
      '[{"x":{},"x":2}]',
      '{"a":[{"x":1,"x":2}]}',
    ])
      expect(() => parseExchangeJson(raw)).toThrow('Duplicate');
    expect(parseExchangeJson('{"a":{"a":1},"b":[{"a":2},{"a":3}]}')).toEqual({
      a: { a: 1 },
      b: [{ a: 2 }, { a: 3 }],
    });
    expect(parseExchangeJson('{"a":"comma, brace} quote\\\"","b":1}')).toEqual({
      a: 'comma, brace} quote"',
      b: 1,
    });
  });
  it('rejects malformed, nonfinite, unsafe-integer, ill-formed Unicode and oversized values', () => {
    for (const raw of [
      '{"a":NaN}',
      '{"a":1e999}',
      '{"a":9007199254740993}',
      '{"a":"\\ud800"}',
      '{"\\udfff":1}',
      '{"a":1,}',
      '[1,,2]',
    ])
      expect(() => parseExchangeJson(raw)).toThrow();
    for (const value of [undefined, () => 1, new Date(), Infinity, 9007199254740992, new Array(2)])
      expect(() => canonicalExchangeJson(value)).toThrow();
    expect(() => parseExchangeJson('['.repeat(34) + '0' + ']'.repeat(34))).toThrow('structural');
    expect(() => canonicalExchangeJson({ text: 'x'.repeat(16 * 1024 * 1024) })).toThrow('16 MiB');
    expect(() => parseExchangeJson(' '.repeat(16 * 1024 * 1024 + 1))).toThrow('16 MiB');
  });
});
