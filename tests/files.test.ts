/**
 * Tests for src/files.ts
 *
 * Covers: isImageFile, getImageMimeType, parseFileReferences, readTextFile,
 * readImageFile, processFilesForMessage, formatFileInfo.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  isImageFile,
  getImageMimeType,
  parseFileReferences,
  readTextFile,
  readImageFile,
  processFilesForMessage,
  formatFileInfo,
} from '../src/files.js';

// ---------------------------------------------------------------------------
// Setup / Teardown
// ---------------------------------------------------------------------------

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-files-test-'));
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

// ===========================================================================
// isImageFile
// ===========================================================================

describe('isImageFile', () => {
  it('should return true for .jpg files', () => {
    expect(isImageFile('photo.jpg')).toBe(true);
  });

  it('should return true for .jpeg files', () => {
    expect(isImageFile('photo.jpeg')).toBe(true);
  });

  it('should return true for .png files', () => {
    expect(isImageFile('screenshot.png')).toBe(true);
  });

  it('should return true for .gif files', () => {
    expect(isImageFile('animation.gif')).toBe(true);
  });

  it('should return true for .webp files', () => {
    expect(isImageFile('image.webp')).toBe(true);
  });

  it('should be case-insensitive', () => {
    expect(isImageFile('PHOTO.JPG')).toBe(true);
    expect(isImageFile('image.PNG')).toBe(true);
    expect(isImageFile('pic.Gif')).toBe(true);
  });

  it('should return false for non-image extensions', () => {
    expect(isImageFile('script.ts')).toBe(false);
    expect(isImageFile('readme.md')).toBe(false);
    expect(isImageFile('data.json')).toBe(false);
    expect(isImageFile('archive.zip')).toBe(false);
  });

  it('should return false for files without extensions', () => {
    expect(isImageFile('Makefile')).toBe(false);
  });

  it('should handle paths with directories', () => {
    expect(isImageFile('/tmp/images/photo.png')).toBe(true);
    expect(isImageFile('src/assets/logo.svg')).toBe(false);
  });
});

// ===========================================================================
// getImageMimeType
// ===========================================================================

describe('getImageMimeType', () => {
  it('should return image/jpeg for .jpg', () => {
    expect(getImageMimeType('photo.jpg')).toBe('image/jpeg');
  });

  it('should return image/jpeg for .jpeg', () => {
    expect(getImageMimeType('photo.jpeg')).toBe('image/jpeg');
  });

  it('should return image/png for .png', () => {
    expect(getImageMimeType('image.png')).toBe('image/png');
  });

  it('should return image/gif for .gif', () => {
    expect(getImageMimeType('anim.gif')).toBe('image/gif');
  });

  it('should return image/webp for .webp', () => {
    expect(getImageMimeType('pic.webp')).toBe('image/webp');
  });

  it('should default to image/jpeg for unknown extensions', () => {
    expect(getImageMimeType('file.bmp')).toBe('image/jpeg');
    expect(getImageMimeType('file.tiff')).toBe('image/jpeg');
  });

  it('should handle uppercase extensions', () => {
    expect(getImageMimeType('PHOTO.PNG')).toBe('image/png');
    expect(getImageMimeType('IMG.GIF')).toBe('image/gif');
  });
});

// ===========================================================================
// parseFileReferences
// ===========================================================================

describe('parseFileReferences', () => {
  it('should detect @filename references for existing files', () => {
    const filePath = path.join(tmpDir, 'test.txt');
    fs.writeFileSync(filePath, 'content');

    const result = parseFileReferences(`look at @test.txt please`, tmpDir);
    expect(result.files).toContain(filePath);
  });

  it('should not include @references for non-existent files', () => {
    const result = parseFileReferences(`look at @nonexistent.txt please`, tmpDir);
    expect(result.files.length).toBe(0);
  });

  it('should detect @path/to/file references', () => {
    const dir = path.join(tmpDir, 'sub');
    fs.mkdirSync(dir);
    const filePath = path.join(dir, 'nested.ts');
    fs.writeFileSync(filePath, 'export {}');

    const result = parseFileReferences(`check @sub/nested.ts`, tmpDir);
    expect(result.files).toContain(filePath);
  });

  it('should detect relative paths with ./', () => {
    const filePath = path.join(tmpDir, 'script.js');
    fs.writeFileSync(filePath, '');

    const result = parseFileReferences(`run ./script.js`, tmpDir);
    expect(result.files).toContain(filePath);
  });

  it('should detect absolute paths with extensions', () => {
    const filePath = path.join(tmpDir, 'abs.txt');
    fs.writeFileSync(filePath, 'data');

    const result = parseFileReferences(`read ${filePath} now`, tmpDir);
    expect(result.files).toContain(filePath);
  });

  it('should not duplicate file entries', () => {
    const filePath = path.join(tmpDir, 'dup.txt');
    fs.writeFileSync(filePath, '');

    // The @dup.txt is found by the @ pattern; ensure no duplicates if also an absolute match
    const result = parseFileReferences(`@dup.txt`, tmpDir);
    const unique = [...new Set(result.files)];
    expect(result.files.length).toBe(unique.length);
  });

  it('should remove @references from returned text', () => {
    fs.writeFileSync(path.join(tmpDir, 'foo.txt'), '');
    const result = parseFileReferences(`analyze @foo.txt carefully`, tmpDir);
    expect(result.text).not.toContain('@foo.txt');
    expect(result.text).toContain('analyze');
    expect(result.text).toContain('carefully');
  });

  it('should return original text when no files found', () => {
    const result = parseFileReferences(`hello world`, tmpDir);
    expect(result.text).toBe('hello world');
    expect(result.files).toEqual([]);
  });
});

// ===========================================================================
// readTextFile
// ===========================================================================

describe('readTextFile', () => {
  it('should read file contents', () => {
    const filePath = path.join(tmpDir, 'hello.txt');
    fs.writeFileSync(filePath, 'hello world');

    const result = readTextFile(filePath);
    expect(result.content).toBe('hello world');
    expect(result.error).toBeUndefined();
  });

  it('should return error for directories', () => {
    const dir = path.join(tmpDir, 'subdir');
    fs.mkdirSync(dir);

    const result = readTextFile(dir);
    expect(result.content).toBe('');
    expect(result.error).toContain('is a directory');
  });

  it('should return error for files over 1MB', () => {
    const filePath = path.join(tmpDir, 'big.txt');
    const buf = Buffer.alloc(1024 * 1024 + 1, 'x');
    fs.writeFileSync(filePath, buf);

    const result = readTextFile(filePath);
    expect(result.content).toBe('');
    expect(result.error).toContain('too large');
    expect(result.error).toContain('1024KB');
  });

  it('should return error for non-existent files', () => {
    const result = readTextFile(path.join(tmpDir, 'ghost.txt'));
    expect(result.content).toBe('');
    expect(result.error).toContain('Cannot read file');
  });

  it('should handle empty files', () => {
    const filePath = path.join(tmpDir, 'empty.txt');
    fs.writeFileSync(filePath, '');

    const result = readTextFile(filePath);
    expect(result.content).toBe('');
    expect(result.error).toBeUndefined();
  });

  it('should handle UTF-8 content', () => {
    const filePath = path.join(tmpDir, 'unicode.txt');
    fs.writeFileSync(filePath, 'Hello \u4e16\u754c \ud83c\udf0d');

    const result = readTextFile(filePath);
    expect(result.content).toBe('Hello \u4e16\u754c \ud83c\udf0d');
  });
});

// ===========================================================================
// readImageFile
// ===========================================================================

describe('readImageFile', () => {
  it('should read an image file as base64', () => {
    const filePath = path.join(tmpDir, 'test.png');
    const data = Buffer.from([0x89, 0x50, 0x4E, 0x47]); // PNG header bytes
    fs.writeFileSync(filePath, data);

    const result = readImageFile(filePath);
    expect(result.data).toBe(data.toString('base64'));
    expect(result.mediaType).toBe('image/png');
    expect(result.error).toBeUndefined();
  });

  it('should detect correct mime type for jpg', () => {
    const filePath = path.join(tmpDir, 'photo.jpg');
    fs.writeFileSync(filePath, Buffer.from([0xFF, 0xD8]));

    const result = readImageFile(filePath);
    expect(result.mediaType).toBe('image/jpeg');
  });

  it('should detect correct mime type for gif', () => {
    const filePath = path.join(tmpDir, 'anim.gif');
    fs.writeFileSync(filePath, Buffer.from('GIF89a'));

    const result = readImageFile(filePath);
    expect(result.mediaType).toBe('image/gif');
  });

  it('should detect correct mime type for webp', () => {
    const filePath = path.join(tmpDir, 'pic.webp');
    fs.writeFileSync(filePath, Buffer.from('RIFF'));

    const result = readImageFile(filePath);
    expect(result.mediaType).toBe('image/webp');
  });

  it('should return error for images over 10MB', () => {
    const filePath = path.join(tmpDir, 'huge.png');
    const buf = Buffer.alloc(10 * 1024 * 1024 + 1);
    fs.writeFileSync(filePath, buf);

    const result = readImageFile(filePath);
    expect(result.data).toBe('');
    expect(result.error).toContain('too large');
    expect(result.error).toContain('10MB');
  });

  it('should return error for non-existent files', () => {
    const result = readImageFile(path.join(tmpDir, 'ghost.png'));
    expect(result.data).toBe('');
    expect(result.error).toContain('Cannot read image');
  });
});

// ===========================================================================
// processFilesForMessage
// ===========================================================================

describe('processFilesForMessage', () => {
  it('should include text content when provided', () => {
    const result = processFilesForMessage('hello', [], true);
    expect(result.content.length).toBe(1);
    expect(result.content[0]).toEqual({ type: 'text', text: 'hello' });
    expect(result.warnings).toEqual([]);
  });

  it('should not include text when empty string', () => {
    const result = processFilesForMessage('', [], true);
    expect(result.content.length).toBe(0);
  });

  it('should process text files', () => {
    const filePath = path.join(tmpDir, 'code.ts');
    fs.writeFileSync(filePath, 'const x = 1;');

    const result = processFilesForMessage('check this', [filePath], true);
    expect(result.content.length).toBe(2); // text + file content
    expect(result.content[1]).toMatchObject({ type: 'text' });
    const textContent = result.content[1] as { type: 'text'; text: string };
    expect(textContent.text).toContain('code.ts');
    expect(textContent.text).toContain('const x = 1;');
  });

  it('should process image files when vision is supported', () => {
    const filePath = path.join(tmpDir, 'img.png');
    const imageData = Buffer.from([0x89, 0x50, 0x4E, 0x47]);
    fs.writeFileSync(filePath, imageData);

    const result = processFilesForMessage('look', [filePath], true);
    // text + image + image note
    expect(result.content.length).toBe(3);
    expect(result.content[1]).toMatchObject({ type: 'image', mediaType: 'image/png' });
    const noteContent = result.content[2] as { type: 'text'; text: string };
    expect(noteContent.text).toContain('[Attached image: img.png]');
  });

  it('should warn when vision not supported for image files', () => {
    const filePath = path.join(tmpDir, 'img.jpg');
    fs.writeFileSync(filePath, Buffer.from([0xFF, 0xD8]));

    const result = processFilesForMessage('look', [filePath], false);
    expect(result.content.length).toBe(1); // just the text
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('Vision not supported');
  });

  it('should warn on unreadable text files', () => {
    const dir = path.join(tmpDir, 'adir');
    fs.mkdirSync(dir);

    const result = processFilesForMessage('', [dir], true);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('is a directory');
  });

  it('should warn on unreadable image files', () => {
    const fakePath = path.join(tmpDir, 'missing.png');

    const result = processFilesForMessage('', [fakePath], true);
    expect(result.warnings.length).toBe(1);
    expect(result.warnings[0]).toContain('Cannot read image');
  });

  it('should handle mix of text and image files', () => {
    const textFile = path.join(tmpDir, 'readme.md');
    const imageFile = path.join(tmpDir, 'logo.png');
    fs.writeFileSync(textFile, '# Hello');
    fs.writeFileSync(imageFile, Buffer.from([0x89, 0x50]));

    const result = processFilesForMessage('describe', [textFile, imageFile], true);
    // text + textFile + image + imageNote = 4
    expect(result.content.length).toBe(4);
    expect(result.warnings).toEqual([]);
  });
});

// ===========================================================================
// formatFileInfo
// ===========================================================================

describe('formatFileInfo', () => {
  it('should return empty string for no files', () => {
    expect(formatFileInfo([])).toBe('');
  });

  it('should show file name and size', () => {
    const filePath = path.join(tmpDir, 'small.txt');
    fs.writeFileSync(filePath, 'hello');

    const result = formatFileInfo([filePath]);
    expect(result).toContain('small.txt');
    expect(result).toContain('5B');
  });

  it('should show KB for larger files', () => {
    const filePath = path.join(tmpDir, 'medium.txt');
    fs.writeFileSync(filePath, Buffer.alloc(2048, 'x'));

    const result = formatFileInfo([filePath]);
    expect(result).toContain('2KB');
  });

  it('should show MB for very large files', () => {
    const filePath = path.join(tmpDir, 'large.bin');
    fs.writeFileSync(filePath, Buffer.alloc(2 * 1024 * 1024, 'x'));

    const result = formatFileInfo([filePath]);
    expect(result).toContain('2.0MB');
  });

  it('should use image icon for image files', () => {
    const filePath = path.join(tmpDir, 'pic.png');
    fs.writeFileSync(filePath, Buffer.from([0x89]));

    const result = formatFileInfo([filePath]);
    expect(result).toContain('\ud83d\uddbc\ufe0f');
  });

  it('should use document icon for text files', () => {
    const filePath = path.join(tmpDir, 'doc.txt');
    fs.writeFileSync(filePath, 'text');

    const result = formatFileInfo([filePath]);
    expect(result).toContain('\ud83d\udcc4');
  });

  it('should handle multiple files separated by comma', () => {
    const f1 = path.join(tmpDir, 'a.txt');
    const f2 = path.join(tmpDir, 'b.txt');
    fs.writeFileSync(f1, 'a');
    fs.writeFileSync(f2, 'b');

    const result = formatFileInfo([f1, f2]);
    expect(result).toContain('a.txt');
    expect(result).toContain('b.txt');
    expect(result).toContain(', ');
  });

  it('should handle non-existent files gracefully', () => {
    const filePath = path.join(tmpDir, 'gone.txt');
    const result = formatFileInfo([filePath]);
    expect(result).toContain('gone.txt');
    // Should not throw
  });
});
