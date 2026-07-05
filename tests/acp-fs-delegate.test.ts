/**
 * Tests for the FsDelegate seam in src/tools.ts (#190).
 *
 * These exercise the REAL executeTool / read_file / write_file / edit_file against
 * a delegate — proving that when a filesystem delegate is supplied (the seam an
 * ACP session uses to prefer the editor's unsaved buffers), file ops route
 * through it instead of local disk, and fall back to disk when it is absent.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { executeTool, type FsDelegate } from '../src/tools.js';
import { resetScope } from '../src/scope.js';
import type { ToolCall } from '../src/types.js';

let tmpDir: string;

function tool(name: string, args: Record<string, unknown>): ToolCall {
  return { id: `call-${Math.random().toString(36).slice(2)}`, name, arguments: args };
}

/** An in-memory "editor buffer" filesystem keyed by absolute path. */
function bufferFs(initial: Record<string, string> = {}): {
  delegate: Required<FsDelegate>;
  buffers: Map<string, string>;
  reads: string[];
  writes: { path: string; content: string }[];
} {
  const buffers = new Map(Object.entries(initial));
  const reads: string[] = [];
  const writes: { path: string; content: string }[] = [];
  const delegate: Required<FsDelegate> = {
    async readTextFile(absPath) {
      reads.push(absPath);
      if (!buffers.has(absPath)) throw new Error(`buffer miss: ${absPath}`);
      return buffers.get(absPath)!;
    },
    async writeTextFile(absPath, content) {
      writes.push({ path: absPath, content });
      buffers.set(absPath, content);
    },
  };
  return { delegate, buffers, reads, writes };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-acpfs-test-'));
  resetScope(tmpDir);
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('read_file fs delegation', () => {
  it('prefers the delegate buffer over what is on disk', async () => {
    const abs = path.join(tmpDir, 'note.txt');
    fs.writeFileSync(abs, 'DISK CONTENT');
    const { delegate, reads } = bufferFs({ [abs]: 'BUFFER CONTENT' });

    const res = await executeTool(tool('read_file', { path: 'note.txt' }), tmpDir, 60000, undefined, { fs: delegate });

    expect(res.isError).toBeFalsy();
    expect(res.result).toContain('BUFFER CONTENT');
    expect(res.result).not.toContain('DISK CONTENT');
    expect(reads).toContain(abs);
  });

  it('falls back to local disk when no delegate is supplied', async () => {
    const abs = path.join(tmpDir, 'note.txt');
    fs.writeFileSync(abs, 'DISK CONTENT');

    const res = await executeTool(tool('read_file', { path: 'note.txt' }), tmpDir);

    expect(res.result).toContain('DISK CONTENT');
  });

  it('surfaces a delegate read error as a normal tool error', async () => {
    const { delegate } = bufferFs(); // buffer empty → read throws
    const res = await executeTool(tool('read_file', { path: 'missing.txt' }), tmpDir, 60000, undefined, { fs: delegate });
    expect(res.isError).toBe(true);
    expect(res.result).toContain('buffer miss');
  });
});

describe('write_file fs delegation', () => {
  it('writes through the delegate and does NOT touch local disk', async () => {
    const abs = path.join(tmpDir, 'out.txt');
    const { delegate, writes, buffers } = bufferFs();

    const res = await executeTool(
      tool('write_file', { path: 'out.txt', content: 'hello buffer' }),
      tmpDir,
      60000,
      undefined,
      { fs: delegate },
    );

    expect(res.isError).toBeFalsy();
    expect(writes).toEqual([{ path: abs, content: 'hello buffer' }]);
    expect(buffers.get(abs)).toBe('hello buffer');
    // The marquee behaviour: local disk is untouched when delegated.
    expect(fs.existsSync(abs)).toBe(false);
  });

  it('diffs against the delegate buffer for an existing file', async () => {
    const abs = path.join(tmpDir, 'out.txt');
    const { delegate } = bufferFs({ [abs]: 'old line\n' });

    const res = await executeTool(
      tool('write_file', { path: 'out.txt', content: 'new line\n' }),
      tmpDir,
      60000,
      undefined,
      { fs: delegate },
    );

    expect(res.isError).toBeFalsy();
    // Existing file → a real diff, not a "new file" banner.
    expect(res.result).not.toContain('new file');
  });

  it('falls back to local disk when no delegate is supplied', async () => {
    const abs = path.join(tmpDir, 'out.txt');
    await executeTool(tool('write_file', { path: 'out.txt', content: 'on disk' }), tmpDir);
    expect(fs.readFileSync(abs, 'utf-8')).toBe('on disk');
  });
});

describe('edit_file fs delegation', () => {
  it('edits the delegate buffer and writes back through it', async () => {
    const abs = path.join(tmpDir, 'code.ts');
    fs.writeFileSync(abs, 'const x = 1;\n'); // disk differs from buffer
    const { delegate, writes, buffers } = bufferFs({ [abs]: 'const x = 999;\n' });

    const res = await executeTool(
      tool('edit_file', { path: 'code.ts', old_string: 'const x = 999;', new_string: 'const x = 42;' }),
      tmpDir,
      60000,
      undefined,
      { fs: delegate },
    );

    expect(res.isError).toBeFalsy();
    expect(buffers.get(abs)).toBe('const x = 42;\n');
    expect(writes).toHaveLength(1);
    // Local disk (which held the un-buffered `const x = 1;`) is untouched.
    expect(fs.readFileSync(abs, 'utf-8')).toBe('const x = 1;\n');
  });

  it('errors when the old_string is not in the delegate buffer', async () => {
    const abs = path.join(tmpDir, 'code.ts');
    const { delegate } = bufferFs({ [abs]: 'const x = 1;\n' });
    const res = await executeTool(
      tool('edit_file', { path: 'code.ts', old_string: 'not present', new_string: 'y' }),
      tmpDir,
      60000,
      undefined,
      { fs: delegate },
    );
    expect(res.isError).toBe(true);
    expect(res.result).toContain('old_string not found');
  });
});
