/**
 * Calliope CLI - Fuzzy File Search
 *
 * Fast fuzzy file finder with fzf-style matching.
 */

import * as fs from 'fs';
import * as path from 'path';

// ============================================================================
// Types
// ============================================================================

export interface SearchResult {
  path: string;
  relativePath: string;
  score: number;
  matches: Array<[number, number]>;  // [start, end] of matching segments
}

export interface SearchOptions {
  maxResults?: number;
  includeHidden?: boolean;
  extensions?: string[];
  excludeDirs?: string[];
  caseSensitive?: boolean;
}

// ============================================================================
// Default Ignore Patterns
// ============================================================================

const DEFAULT_IGNORE_DIRS = [
  'node_modules',
  '.git',
  '.svn',
  '.hg',
  'dist',
  'build',
  'out',
  '.next',
  '.nuxt',
  '__pycache__',
  '.pytest_cache',
  'coverage',
  '.nyc_output',
  'vendor',
  'target',
  '.cargo',
];

// ============================================================================
// File Scanning
// ============================================================================

/**
 * Recursively get all files in directory
 */
export function getAllFiles(
  dir: string,
  options: SearchOptions = {},
  basePath = dir
): string[] {
  const files: string[] = [];
  const excludeDirs = options.excludeDirs || DEFAULT_IGNORE_DIRS;

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      // Skip hidden files unless requested
      if (!options.includeHidden && entry.name.startsWith('.')) {
        continue;
      }

      const fullPath = path.join(dir, entry.name);
      const relativePath = path.relative(basePath, fullPath);

      if (entry.isDirectory()) {
        // Skip excluded directories
        if (excludeDirs.includes(entry.name)) {
          continue;
        }
        files.push(...getAllFiles(fullPath, options, basePath));
      } else if (entry.isFile()) {
        // Filter by extension if specified
        if (options.extensions && options.extensions.length > 0) {
          const ext = path.extname(entry.name).slice(1);
          if (!options.extensions.includes(ext)) {
            continue;
          }
        }
        files.push(relativePath);
      }
    }
  } catch {
    // Ignore permission errors
  }

  return files;
}

// ============================================================================
// Fuzzy Matching
// ============================================================================

/**
 * Calculate fuzzy match score and positions
 * Higher score = better match
 */
export function fuzzyMatch(
  pattern: string,
  text: string,
  caseSensitive = false
): { score: number; matches: Array<[number, number]> } | null {
  const p = caseSensitive ? pattern : pattern.toLowerCase();
  const t = caseSensitive ? text : text.toLowerCase();

  if (p.length === 0) return { score: 0, matches: [] };
  if (p.length > t.length) return null;

  const matches: Array<[number, number]> = [];
  let score = 0;
  let patternIdx = 0;
  let lastMatchEnd = -1;
  let consecutiveBonus = 0;

  for (let textIdx = 0; textIdx < t.length && patternIdx < p.length; textIdx++) {
    if (t[textIdx] === p[patternIdx]) {
      // Start new match or extend existing
      if (textIdx === lastMatchEnd) {
        // Consecutive match - extend and add bonus
        matches[matches.length - 1]![1] = textIdx + 1;
        consecutiveBonus += 2;
      } else {
        // New match segment
        matches.push([textIdx, textIdx + 1]);
        consecutiveBonus = 0;
      }

      // Scoring bonuses
      let matchScore = 1 + consecutiveBonus;

      // Bonus for matching at start
      if (textIdx === 0) matchScore += 5;

      // Bonus for matching after separator
      if (textIdx > 0 && (t[textIdx - 1] === '/' || t[textIdx - 1] === '-' || t[textIdx - 1] === '_' || t[textIdx - 1] === '.')) {
        matchScore += 3;
      }

      // Bonus for matching uppercase in camelCase
      const camelCh = text[textIdx]!;
      if (camelCh === camelCh.toUpperCase() && camelCh !== camelCh.toLowerCase()) {
        matchScore += 2;
      }

      score += matchScore;
      lastMatchEnd = textIdx + 1;
      patternIdx++;
    }
  }

  // Did we match all pattern characters?
  if (patternIdx !== p.length) return null;

  // Penalize longer strings (prefer shorter matches)
  score -= t.length * 0.1;

  // Bonus for exact match
  if (p === t) score += 10;

  // Bonus for matching filename (last segment)
  const filename = text.split('/').pop() || '';
  if (filename.toLowerCase().includes(p)) {
    score += 5;
  }

  return { score, matches };
}

// ============================================================================
// Search
// ============================================================================

/**
 * Search files with fuzzy matching
 */
export function searchFiles(
  dir: string,
  pattern: string,
  options: SearchOptions = {}
): SearchResult[] {
  const maxResults = options.maxResults || 50;
  const files = getAllFiles(dir, options);
  const results: SearchResult[] = [];

  for (const relativePath of files) {
    const match = fuzzyMatch(pattern, relativePath, options.caseSensitive);
    if (match) {
      results.push({
        path: path.join(dir, relativePath),
        relativePath,
        score: match.score,
        matches: match.matches,
      });
    }
  }

  // Sort by score (descending)
  results.sort((a, b) => b.score - a.score);

  return results.slice(0, maxResults);
}

/**
 * Search with highlighting for display
 */
export function searchWithHighlight(
  dir: string,
  pattern: string,
  options: SearchOptions = {}
): Array<{ path: string; highlighted: string; score: number }> {
  const results = searchFiles(dir, pattern, options);

  return results.map(result => ({
    path: result.path,
    highlighted: highlightMatches(result.relativePath, result.matches),
    score: result.score,
  }));
}

/**
 * Highlight matching segments in text
 */
export function highlightMatches(
  text: string,
  matches: Array<[number, number]>,
  highlightStart = '\x1b[1;33m',  // Bold yellow
  highlightEnd = '\x1b[0m'
): string {
  if (matches.length === 0) return text;

  let result = '';
  let lastEnd = 0;

  for (const [start, end] of matches) {
    result += text.slice(lastEnd, start);
    result += highlightStart + text.slice(start, end) + highlightEnd;
    lastEnd = end;
  }

  result += text.slice(lastEnd);
  return result;
}

// ============================================================================
// Interactive Search (for use with UI)
// ============================================================================

export interface InteractiveSearchState {
  query: string;
  results: SearchResult[];
  selectedIndex: number;
  dir: string;
  options: SearchOptions;
}

/**
 * Create interactive search state
 */
export function createSearchState(dir: string, options: SearchOptions = {}): InteractiveSearchState {
  return {
    query: '',
    results: [],
    selectedIndex: 0,
    dir,
    options,
  };
}

/**
 * Update search with new query
 */
export function updateSearch(state: InteractiveSearchState, query: string): InteractiveSearchState {
  const results = query ? searchFiles(state.dir, query, state.options) : [];
  return {
    ...state,
    query,
    results,
    selectedIndex: 0,
  };
}

/**
 * Move selection up
 */
export function selectUp(state: InteractiveSearchState): InteractiveSearchState {
  return {
    ...state,
    selectedIndex: Math.max(0, state.selectedIndex - 1),
  };
}

/**
 * Move selection down
 */
export function selectDown(state: InteractiveSearchState): InteractiveSearchState {
  return {
    ...state,
    selectedIndex: Math.min(state.results.length - 1, state.selectedIndex + 1),
  };
}

/**
 * Get selected result
 */
export function getSelected(state: InteractiveSearchState): SearchResult | null {
  if (state.selectedIndex < 0 || state.selectedIndex >= state.results.length) {
    return null;
  }
  return state.results[state.selectedIndex]!;
}
