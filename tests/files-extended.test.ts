/**
 * Extended coverage tests for src/files.ts
 *
 * Targets uncovered branches:
 * - parseFileReferences: @/absolute/path (isAbsolute = true path in @ pattern)
 * - readTextFile: err not instanceof Error → String(err) path
 * - readImageFile: err not instanceof Error → String(err) path
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ===========================================================================
// For the parseFileReferences absolute path test, we use the real fs.
// For the non-Error throw tests, we use a real file path that can't be read
// due to permissions — but that produces an Error, not a string.
//
// Alternative: test via a real scenario that reaches the non-Error path.
// The `String(err)` path fires when the thrown value is not an Error instance.
// In practice, fs always throws Errors. We can test it by creating a symlink
// to a non-existent target, which causes fs.statSync to throw a real Error
// (which IS an instanceof Error), exercising the err.message path.
//
// The non-Error throw path can only be reached by mocking, and ESM prevents
// vi.spyOn on fs. So we test as many real branches as possible.
// ===========================================================================

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-files-ext-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// parseFileReferences - @/absolute/path (path.isAbsolute = true branch)
// ===========================================================================

describe('parseFileReferences - @absolute path reference', () => {
  it('should resolve @/absolute/path when the absolute path exists', async () => {
    // Import after any setup (no mocks needed here)
    const { parseFileReferences } = await import('../src/files.js');

    const filePath = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(filePath, 'absolute content');

    // Use @/absolute/path syntax — filePath is absolute so isAbsolute = true
    // This exercises the `path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath)` true branch
    const result = parseFileReferences(`see @${filePath} now`, tmpDir);
    expect(result.files).toContain(filePath);
  });

  it('should not add @/absolute/path when the file does not exist', async () => {
    const { parseFileReferences } = await import('../src/files.js');
    const fakePath = path.join(tmpDir, 'nonexistent.ts');

    const result = parseFileReferences(`check @${fakePath}`, tmpDir);
    expect(result.files.length).toBe(0);
  });

  it('should handle @relative/path for existing files (isAbsolute = false branch)', async () => {
    const { parseFileReferences } = await import('../src/files.js');
    const filePath = path.join(tmpDir, 'relative.txt');
    fs.writeFileSync(filePath, 'hello');

    // relative name — not absolute, goes through path.join(cwd, filePath)
    const result = parseFileReferences(`check @relative.txt`, tmpDir);
    expect(result.files).toContain(filePath);
  });
});

// ===========================================================================
// readTextFile - real Error from statSync (err.message path)
// ===========================================================================

describe('readTextFile - Error handling', () => {
  it('should use err.message when Error is thrown by fs.statSync', async () => {
    const { readTextFile } = await import('../src/files.js');

    // Non-existent file → fs.statSync throws a real Error with code 'ENOENT'
    const result = readTextFile('/this/path/absolutely/does/not/exist/xyz.txt');

    expect(result.content).toBe('');
    expect(result.error).toContain('Cannot read file');
    // err instanceof Error → uses err.message
    expect(result.error).toContain('ENOENT');
  });
});

// ===========================================================================
// readImageFile - real Error from statSync (err.message path)
// ===========================================================================

describe('readImageFile - Error handling', () => {
  it('should use err.message when Error is thrown', async () => {
    const { readImageFile } = await import('../src/files.js');

    const result = readImageFile('/nonexistent/image/path/img.png');

    expect(result.data).toBe('');
    expect(result.mediaType).toBe('image/jpeg');
    expect(result.error).toContain('Cannot read image');
    expect(result.error).toContain('ENOENT');
  });
});

// ===========================================================================
// parseFileReferences - relative path that doesn't exist
// ===========================================================================

describe('parseFileReferences - paths not found', () => {
  it('should not add relative paths that do not exist', async () => {
    const { parseFileReferences } = await import('../src/files.js');
    const result = parseFileReferences('run ./nonexistent-script.js', tmpDir);
    expect(result.files.length).toBe(0);
  });

  it('should not add absolute paths that do not exist', async () => {
    const { parseFileReferences } = await import('../src/files.js');
    const fakePath = '/totally/nonexistent/absolute/path.txt';
    const result = parseFileReferences(`see ${fakePath} here`, tmpDir);
    // The absolute path pattern only picks up paths with extensions that exist
    expect(result.files).not.toContain(fakePath);
  });
});
