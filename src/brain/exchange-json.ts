/** RFC 8785 serialization with bounded depth, finite numbers and safe integers.
 * Emit object members directly: JSON.stringify(object) reorders integer keys.
 */
import { BrainError } from './types.js';

export function canonicalExchangeJson(value: unknown): string {
  let count = 0;
  const visit = (item: unknown, depth: number): string => {
    if (++count > 100000 || depth > 32)
      throw new BrainError('limit', 'Exchange JSON exceeds its structural limits.');
    if (item === null || typeof item === 'boolean') return JSON.stringify(item);
    if (typeof item === 'number') {
      if (!Number.isFinite(item) || (Number.isInteger(item) && !Number.isSafeInteger(item)))
        throw new BrainError(
          'invalid',
          'Exchange numbers must be finite; large exact integers must be strings.',
        );
      return JSON.stringify(item);
    }
    if (typeof item === 'string') {
      if (/[\uD800-\uDFFF]/u.test(item))
        throw new BrainError('invalid', 'Exchange JSON contains invalid Unicode.');
      return JSON.stringify(item);
    }
    if (Array.isArray(item))
      return '[' + Array.from(item, (child) => visit(child, depth + 1)).join(',') + ']';
    if (!item || typeof item !== 'object' || Object.getPrototypeOf(item) !== Object.prototype)
      throw new BrainError('invalid', 'Exchange requires plain JSON values.');
    return (
      '{' +
      Object.keys(item)
        .sort()
        .map(
          (key) =>
            visit(key, depth + 1) + ':' + visit((item as Record<string, unknown>)[key], depth + 1),
        )
        .join(',') +
      '}'
    );
  };
  const output = visit(value, 0);
  if (Buffer.byteLength(output) > 16 * 1024 * 1024)
    throw new BrainError('limit', 'Exchange JSON exceeds 16 MiB.');
  return output;
}

/** Native syntax parser plus a key-token pass, because JSON.parse overwrites duplicates. */
export function parseExchangeJson(text: string): unknown {
  if (Buffer.byteLength(text) > 16 * 1024 * 1024)
    throw new BrainError('limit', 'Exchange JSON exceeds 16 MiB.');
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new BrainError('invalid', 'Knowledge exchange must be JSON.');
  }
  const stack: { keys: Set<string> | null; expectingKey: boolean }[] = [];
  for (const match of text.matchAll(/"(?:\\.|[^"\\])*"|[{}\[\]:,]/g)) {
    const token = match[0],
      parent = stack.at(-1);
    if (token === '{' || token === '[') {
      stack.push({
        keys: token === '{' ? new Set() : null,
        expectingKey: token === '{',
      });
      if (stack.length > 32)
        throw new BrainError('limit', 'Exchange JSON exceeds its structural limits.');
    } else if (token === '}' || token === ']') stack.pop();
    else if (token === ',') {
      if (parent?.keys) parent.expectingKey = true;
    } else if (token.startsWith('"') && parent?.keys && parent.expectingKey) {
      const key = JSON.parse(token) as string;
      if (parent.keys.has(key))
        throw new BrainError('invalid', 'Duplicate exchange JSON property.');
      parent.keys.add(key);
      parent.expectingKey = false;
    }
  }
  canonicalExchangeJson(value);
  return value;
}
