/**
 * Calliope CLI - File Handling
 *
 * Handles file references, reading, and image processing for vision.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { TextContent, ImageContent } from './types.js';

// Supported image extensions
const IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];

// Max file size for reading (1MB for text, 10MB for images)
const MAX_TEXT_SIZE = 1024 * 1024;
const MAX_IMAGE_SIZE = 10 * 1024 * 1024;

/**
 * Check if a file is an image based on extension
 */
export function isImageFile(filePath: string): boolean {
  const ext = path.extname(filePath).toLowerCase();
  return IMAGE_EXTENSIONS.includes(ext);
}

/**
 * Get MIME type for an image file
 */
export function getImageMimeType(filePath: string): 'image/jpeg' | 'image/png' | 'image/gif' | 'image/webp' {
  const ext = path.extname(filePath).toLowerCase();
  switch (ext) {
    case '.jpg':
    case '.jpeg':
      return 'image/jpeg';
    case '.png':
      return 'image/png';
    case '.gif':
      return 'image/gif';
    case '.webp':
      return 'image/webp';
    default:
      return 'image/jpeg';
  }
}

/**
 * Parse file references from input text
 * Supports: @filename, @path/to/file, /absolute/path, ./relative/path
 */
export function parseFileReferences(input: string, cwd: string): {
  text: string;
  files: string[];
} {
  const files: string[] = [];

  // Match @file references
  const atPattern = /@([\w./-]+)/g;
  let match;
  while ((match = atPattern.exec(input)) !== null) {
    const filePath = match[1]!;
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(cwd, filePath);
    if (fs.existsSync(absPath)) {
      files.push(absPath);
    }
  }

  // Match absolute paths that look like files (contain extension)
  const absPattern = /(?:^|\s)(\/[\w./-]+\.\w+)(?:\s|$)/g;
  while ((match = absPattern.exec(input)) !== null) {
    const filePath = match[1]!;
    if (fs.existsSync(filePath) && !files.includes(filePath)) {
      files.push(filePath);
    }
  }

  // Match relative paths with ./
  const relPattern = /(?:^|\s)(\.\/?[\w./-]+\.\w+)(?:\s|$)/g;
  while ((match = relPattern.exec(input)) !== null) {
    const filePath = match[1]!;
    const absPath = path.join(cwd, filePath);
    if (fs.existsSync(absPath) && !files.includes(absPath)) {
      files.push(absPath);
    }
  }

  // Remove file references from text for cleaner display
  let cleanText = input
    .replace(/@[\w./-]+/g, '')
    .replace(/\s+/g, ' ')
    .trim();

  return { text: cleanText || input, files };
}

/**
 * Read a text file
 */
export function readTextFile(filePath: string): { content: string; error?: string } {
  try {
    const stats = fs.statSync(filePath);

    if (stats.isDirectory()) {
      return { content: '', error: `${filePath} is a directory` };
    }

    if (stats.size > MAX_TEXT_SIZE) {
      return { content: '', error: `File too large (${Math.round(stats.size / 1024)}KB, max ${MAX_TEXT_SIZE / 1024}KB)` };
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    return { content };
  } catch (err) {
    return { content: '', error: `Cannot read file: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Read an image file as base64
 */
export function readImageFile(filePath: string): { data: string; mediaType: ImageContent['mediaType']; error?: string } {
  try {
    const stats = fs.statSync(filePath);

    if (stats.size > MAX_IMAGE_SIZE) {
      return { data: '', mediaType: 'image/jpeg', error: `Image too large (${Math.round(stats.size / 1024 / 1024)}MB, max ${MAX_IMAGE_SIZE / 1024 / 1024}MB)` };
    }

    const buffer = fs.readFileSync(filePath);
    const data = buffer.toString('base64');
    const mediaType = getImageMimeType(filePath);

    return { data, mediaType };
  } catch (err) {
    return { data: '', mediaType: 'image/jpeg', error: `Cannot read image: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Process files and create message content
 */
export function processFilesForMessage(
  text: string,
  files: string[],
  supportsVision: boolean
): {
  content: (TextContent | ImageContent)[];
  warnings: string[];
} {
  const content: (TextContent | ImageContent)[] = [];
  const warnings: string[] = [];

  // Add the text content
  if (text) {
    content.push({ type: 'text', text });
  }

  // Process each file
  for (const filePath of files) {
    const fileName = path.basename(filePath);

    if (isImageFile(filePath)) {
      if (!supportsVision) {
        warnings.push(`⚠️ ${fileName}: Vision not supported by current provider`);
        continue;
      }

      const result = readImageFile(filePath);
      if (result.error) {
        warnings.push(`⚠️ ${fileName}: ${result.error}`);
      } else {
        content.push({
          type: 'image',
          mediaType: result.mediaType,
          data: result.data,
        });
        // Add a text note about the image
        content.push({
          type: 'text',
          text: `[Attached image: ${fileName}]`,
        });
      }
    } else {
      // Text file
      const result = readTextFile(filePath);
      if (result.error) {
        warnings.push(`⚠️ ${fileName}: ${result.error}`);
      } else {
        content.push({
          type: 'text',
          text: `\n--- File: ${fileName} ---\n${result.content}\n--- End of ${fileName} ---\n`,
        });
      }
    }
  }

  return { content, warnings };
}

/**
 * Format file info for display
 */
export function formatFileInfo(files: string[]): string {
  if (files.length === 0) return '';

  const fileInfos = files.map(f => {
    const name = path.basename(f);
    const isImage = isImageFile(f);
    try {
      const stats = fs.statSync(f);
      const size = stats.size < 1024
        ? `${stats.size}B`
        : stats.size < 1024 * 1024
          ? `${Math.round(stats.size / 1024)}KB`
          : `${(stats.size / 1024 / 1024).toFixed(1)}MB`;
      return `${isImage ? '🖼️' : '📄'} ${name} (${size})`;
    } catch {
      return `${isImage ? '🖼️' : '📄'} ${name}`;
    }
  });

  return fileInfos.join(', ');
}
