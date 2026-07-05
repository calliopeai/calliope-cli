/**
 * Hash-anchored edits (#188 feature 4) — read_file anchor footer + edit_file
 * anchor_hash stale-view protection, exercised through executeTool with a real
 * temp file. Fully local (no network).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { executeTool } from '../src/tools.js';
import { resetScope } from '../src/scope.js';
import { computeAnchorHash } from '../src/local-model.js';
import type { ToolCall } from '../src/types.js';

let tmpDir: string;
const tc = (name: string, args: Record<string, unknown>): ToolCall => ({ id: `c-${Date.now()}`, name, arguments: args });

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-anchor-test-'));
  resetScope(tmpDir);
});
afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function write(name: string, content: string): string {
  const p = path.join(tmpDir, name);
  fs.writeFileSync(p, content);
  return p;
}

describe('read_file anchor footer (local backends)', () => {
  it('appends the current content hash when appendAnchorHash is set', async () => {
    const content = 'line one\nline two\n';
    write('a.txt', content);
    const res = await executeTool(tc('read_file', { path: 'a.txt' }), tmpDir, 60000, undefined, { appendAnchorHash: true });
    expect(res.isError).toBeFalsy();
    expect(res.result).toContain(`[anchor_hash: ${computeAnchorHash(content)}`);
    expect(res.result).toContain(content);
  });

  it('omits the footer by default (cloud backends)', async () => {
    write('b.txt', 'hello');
    const res = await executeTool(tc('read_file', { path: 'b.txt' }), tmpDir);
    expect(res.result).not.toContain('anchor_hash');
  });

  it('omits the footer when appendAnchorHash is explicitly false', async () => {
    write('c.txt', 'hello');
    const res = await executeTool(tc('read_file', { path: 'c.txt' }), tmpDir, 60000, undefined, { appendAnchorHash: false });
    expect(res.result).not.toContain('anchor_hash');
  });
});

describe('edit_file anchor_hash stale-view protection', () => {
  it('applies the edit when the anchor_hash matches current content', async () => {
    const content = 'const x = 1;\n';
    write('m.ts', content);
    const res = await executeTool(
      tc('edit_file', { path: 'm.ts', old_string: 'const x = 1;', new_string: 'const x = 2;', anchor_hash: computeAnchorHash(content) }),
      tmpDir,
    );
    expect(res.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(tmpDir, 'm.ts'), 'utf-8')).toContain('const x = 2;');
  });

  it('rejects the edit and tells the model to re-read when the anchor_hash is stale', async () => {
    write('n.ts', 'const y = 1;\n');
    const res = await executeTool(
      tc('edit_file', { path: 'n.ts', old_string: 'const y = 1;', new_string: 'const y = 2;', anchor_hash: 'deadbeef' }),
      tmpDir,
    );
    expect(res.isError).toBe(true);
    expect(res.result).toContain('anchor_hash mismatch');
    expect(res.result.toLowerCase()).toContain('re-read');
    // File must be untouched on a rejected edit.
    expect(fs.readFileSync(path.join(tmpDir, 'n.ts'), 'utf-8')).toBe('const y = 1;\n');
  });

  it('performs no check when anchor_hash is absent (inert for cloud)', async () => {
    const content = 'const z = 1;\n';
    write('o.ts', content);
    const res = await executeTool(
      tc('edit_file', { path: 'o.ts', old_string: 'const z = 1;', new_string: 'const z = 9;' }),
      tmpDir,
    );
    expect(res.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(tmpDir, 'o.ts'), 'utf-8')).toContain('const z = 9;');
  });

  it('round-trips: read_file footer hash unlocks a subsequent anchored edit', async () => {
    const content = 'export const flag = false;\n';
    write('p.ts', content);
    const read = await executeTool(tc('read_file', { path: 'p.ts' }), tmpDir, 60000, undefined, { appendAnchorHash: true });
    const hash = read.result.match(/\[anchor_hash: ([0-9a-f]{8})/)![1];
    const edit = await executeTool(
      tc('edit_file', { path: 'p.ts', old_string: 'false', new_string: 'true', anchor_hash: hash }),
      tmpDir,
    );
    expect(edit.isError).toBeFalsy();
    expect(fs.readFileSync(path.join(tmpDir, 'p.ts'), 'utf-8')).toContain('flag = true');
  });

  it('a hash from before an external change is rejected as stale', async () => {
    const original = 'a = 1\n';
    write('q.ts', original);
    const staleHash = computeAnchorHash(original);
    // Something else changed the file after the model read it.
    fs.writeFileSync(path.join(tmpDir, 'q.ts'), 'a = 1\nb = 2\n');
    const res = await executeTool(
      tc('edit_file', { path: 'q.ts', old_string: 'a = 1', new_string: 'a = 3', anchor_hash: staleHash }),
      tmpDir,
    );
    expect(res.isError).toBe(true);
    expect(res.result).toContain('anchor_hash mismatch');
  });
});
