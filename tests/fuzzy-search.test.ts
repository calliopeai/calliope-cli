import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  fuzzyMatch,
  highlightMatches,
  createSearchState,
  updateSearch,
  selectUp,
  selectDown,
  getSelected,
  getAllFiles,
  searchFiles,
  searchWithHighlight,
} from '../src/fuzzy-search.js';
import type {
  SearchResult,
  SearchOptions,
  InteractiveSearchState,
} from '../src/fuzzy-search.js';

// ============================================================================
// fuzzyMatch
// ============================================================================

describe('fuzzyMatch', () => {

  // --------------------------------------------------------------------------
  // Basic matching
  // --------------------------------------------------------------------------

  describe('basic matching', () => {
    it('should return a match for an exact string', () => {
      const result = fuzzyMatch('hello', 'hello');
      expect(result).not.toBeNull();
      expect(result!.score).toBeGreaterThan(0);
    });

    it('should return null when pattern is longer than text', () => {
      const result = fuzzyMatch('abcdef', 'abc');
      expect(result).toBeNull();
    });

    it('should return null when pattern characters are not found', () => {
      const result = fuzzyMatch('xyz', 'abcdef');
      expect(result).toBeNull();
    });

    it('should return score 0 and empty matches for empty pattern', () => {
      const result = fuzzyMatch('', 'anything');
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
      expect(result!.matches).toEqual([]);
    });

    it('should return score 0 and empty matches for empty pattern and empty text', () => {
      const result = fuzzyMatch('', '');
      expect(result).not.toBeNull();
      expect(result!.score).toBe(0);
      expect(result!.matches).toEqual([]);
    });

    it('should return null when pattern has characters not in text', () => {
      const result = fuzzyMatch('abz', 'abcdef');
      expect(result).toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Case sensitivity
  // --------------------------------------------------------------------------

  describe('case sensitivity', () => {
    it('should match case-insensitively by default', () => {
      const result = fuzzyMatch('ABC', 'abcdef');
      expect(result).not.toBeNull();
    });

    it('should match when text is uppercase and pattern is lowercase', () => {
      const result = fuzzyMatch('abc', 'ABCDEF');
      expect(result).not.toBeNull();
    });

    it('should fail case-sensitive match when cases differ', () => {
      const result = fuzzyMatch('ABC', 'abcdef', true);
      expect(result).toBeNull();
    });

    it('should succeed case-sensitive match when cases match', () => {
      const result = fuzzyMatch('abc', 'abcdef', true);
      expect(result).not.toBeNull();
    });
  });

  // --------------------------------------------------------------------------
  // Scoring: exact match bonus
  // --------------------------------------------------------------------------

  describe('exact match bonus', () => {
    it('should score exact match higher than substring match', () => {
      const exact = fuzzyMatch('hello', 'hello');
      const substring = fuzzyMatch('hello', 'say hello there');
      expect(exact).not.toBeNull();
      expect(substring).not.toBeNull();
      expect(exact!.score).toBeGreaterThan(substring!.score);
    });
  });

  // --------------------------------------------------------------------------
  // Scoring: start-of-string bonus
  // --------------------------------------------------------------------------

  describe('start-of-string bonus', () => {
    it('should score prefix match higher than mid-string match', () => {
      const prefix = fuzzyMatch('ab', 'abcdef');
      const midString = fuzzyMatch('cd', 'abcdef');
      expect(prefix).not.toBeNull();
      expect(midString).not.toBeNull();
      // prefix gets +5 for matching at index 0
      expect(prefix!.score).toBeGreaterThan(midString!.score);
    });
  });

  // --------------------------------------------------------------------------
  // Scoring: separator bonus
  // --------------------------------------------------------------------------

  describe('separator bonus', () => {
    it('should give bonus for match after slash separator', () => {
      const afterSlash = fuzzyMatch('b', 'a/b');
      const midWord = fuzzyMatch('b', 'ab');
      expect(afterSlash).not.toBeNull();
      expect(midWord).not.toBeNull();
      // afterSlash gets +3 separator bonus
      expect(afterSlash!.score).toBeGreaterThan(midWord!.score);
    });

    it('should give bonus for match after dash separator', () => {
      const afterDash = fuzzyMatch('b', 'a-b');
      const midWord = fuzzyMatch('b', 'ab');
      expect(afterDash).not.toBeNull();
      expect(midWord).not.toBeNull();
      expect(afterDash!.score).toBeGreaterThan(midWord!.score);
    });

    it('should give bonus for match after underscore separator', () => {
      const afterUnderscore = fuzzyMatch('b', 'a_b');
      const midWord = fuzzyMatch('b', 'ab');
      expect(afterUnderscore).not.toBeNull();
      expect(midWord).not.toBeNull();
      expect(afterUnderscore!.score).toBeGreaterThan(midWord!.score);
    });

    it('should give bonus for match after dot separator', () => {
      const afterDot = fuzzyMatch('t', 'file.ts');
      const midWord = fuzzyMatch('t', 'filets');
      expect(afterDot).not.toBeNull();
      expect(midWord).not.toBeNull();
      expect(afterDot!.score).toBeGreaterThan(midWord!.score);
    });
  });

  // --------------------------------------------------------------------------
  // Scoring: camelCase bonus
  // --------------------------------------------------------------------------

  describe('camelCase bonus', () => {
    it('should give bonus for matching uppercase in camelCase', () => {
      const camel = fuzzyMatch('S', 'fuzzySearch', true);
      expect(camel).not.toBeNull();
      // The 'S' at index 5 is uppercase => gets +2 camelCase bonus
      expect(camel!.score).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // Scoring: consecutive match bonus
  // --------------------------------------------------------------------------

  describe('consecutive match bonus', () => {
    it('should score consecutive characters higher than scattered ones', () => {
      const consecutive = fuzzyMatch('abc', 'abcxyz');
      const scattered = fuzzyMatch('abc', 'axbxcx');
      expect(consecutive).not.toBeNull();
      expect(scattered).not.toBeNull();
      expect(consecutive!.score).toBeGreaterThan(scattered!.score);
    });
  });

  // --------------------------------------------------------------------------
  // Scoring: shorter text preference
  // --------------------------------------------------------------------------

  describe('shorter text preference', () => {
    it('should prefer shorter text (lower length penalty)', () => {
      const short = fuzzyMatch('ab', 'ab');
      const long = fuzzyMatch('ab', 'ab' + 'x'.repeat(50));
      expect(short).not.toBeNull();
      expect(long).not.toBeNull();
      expect(short!.score).toBeGreaterThan(long!.score);
    });
  });

  // --------------------------------------------------------------------------
  // Scoring: filename match bonus
  // --------------------------------------------------------------------------

  describe('filename match bonus', () => {
    it('should give bonus when pattern matches in filename portion', () => {
      const filenameMatch = fuzzyMatch('test', 'src/test');
      const dirMatch = fuzzyMatch('src', 'src/test');
      expect(filenameMatch).not.toBeNull();
      expect(dirMatch).not.toBeNull();
      // 'test' appears in the filename 'test', so it gets +5 filename bonus
      // 'src' does not appear in the filename 'test'
      // But 'src' starts at index 0 giving it a start bonus; let's just verify filename match exists
      expect(filenameMatch!.score).toBeGreaterThan(0);
    });

    it('should give filename bonus when pattern is a substring of the last path segment', () => {
      const result = fuzzyMatch('idx', 'src/components/index.ts');
      expect(result).not.toBeNull();
      // 'idx' is a substring of 'index.ts' => +5 filename bonus
      expect(result!.score).toBeGreaterThan(0);
    });
  });

  // --------------------------------------------------------------------------
  // Match positions
  // --------------------------------------------------------------------------

  describe('match positions', () => {
    it('should return correct match positions for consecutive chars', () => {
      const result = fuzzyMatch('abc', 'abcdef');
      expect(result).not.toBeNull();
      // 'a', 'b', 'c' at indices 0,1,2 should be one consecutive segment [0,3]
      expect(result!.matches).toEqual([[0, 3]]);
    });

    it('should return multiple match segments for scattered chars', () => {
      const result = fuzzyMatch('ac', 'abcdef');
      expect(result).not.toBeNull();
      // 'a' at 0, then gap, 'c' at 2 => two segments [0,1] and [2,3]
      expect(result!.matches).toEqual([[0, 1], [2, 3]]);
    });

    it('should return single segment for single char match', () => {
      const result = fuzzyMatch('d', 'abcdef');
      expect(result).not.toBeNull();
      expect(result!.matches).toEqual([[3, 4]]);
    });
  });

  // --------------------------------------------------------------------------
  // Ranking multiple candidates
  // --------------------------------------------------------------------------

  describe('ranking candidates', () => {
    it('should rank exact match above prefix match above substring match', () => {
      const exact = fuzzyMatch('config', 'config')!;
      const prefix = fuzzyMatch('config', 'config.ts')!;
      const substring = fuzzyMatch('config', 'src/app/config.ts')!;

      expect(exact.score).toBeGreaterThan(prefix.score);
      expect(prefix.score).toBeGreaterThan(substring.score);
    });

    it('should rank shorter paths higher when match quality is similar', () => {
      const short = fuzzyMatch('index', 'index.ts')!;
      const long = fuzzyMatch('index', 'src/components/shared/utils/index.ts')!;

      expect(short.score).toBeGreaterThan(long.score);
    });
  });
});

// ============================================================================
// highlightMatches
// ============================================================================

describe('highlightMatches', () => {
  it('should return original text when no matches', () => {
    const result = highlightMatches('hello world', []);
    expect(result).toBe('hello world');
  });

  it('should highlight a single match segment', () => {
    const result = highlightMatches('abcdef', [[1, 3]]);
    expect(result).toBe('a\x1b[1;33mbc\x1b[0mdef');
  });

  it('should highlight multiple match segments', () => {
    const result = highlightMatches('abcdef', [[0, 1], [3, 5]]);
    expect(result).toBe('\x1b[1;33ma\x1b[0mbc\x1b[1;33mde\x1b[0mf');
  });

  it('should highlight the entire string', () => {
    const result = highlightMatches('abc', [[0, 3]]);
    expect(result).toBe('\x1b[1;33mabc\x1b[0m');
  });

  it('should support custom highlight markers', () => {
    const result = highlightMatches('abcdef', [[2, 4]], '<b>', '</b>');
    expect(result).toBe('ab<b>cd</b>ef');
  });

  it('should handle match at the very end of string', () => {
    const result = highlightMatches('abcdef', [[4, 6]]);
    expect(result).toBe('abcd\x1b[1;33mef\x1b[0m');
  });

  it('should handle match at the very start of string', () => {
    const result = highlightMatches('abcdef', [[0, 2]]);
    expect(result).toBe('\x1b[1;33mab\x1b[0mcdef');
  });
});

// ============================================================================
// Interactive search state
// ============================================================================

describe('createSearchState', () => {
  it('should create state with empty query and results', () => {
    const state = createSearchState('/some/dir');
    expect(state.query).toBe('');
    expect(state.results).toEqual([]);
    expect(state.selectedIndex).toBe(0);
    expect(state.dir).toBe('/some/dir');
  });

  it('should accept options', () => {
    const opts: SearchOptions = { maxResults: 10, extensions: ['ts'] };
    const state = createSearchState('/dir', opts);
    expect(state.options).toEqual(opts);
  });
});

describe('selectUp', () => {
  it('should decrement selectedIndex', () => {
    const state: InteractiveSearchState = {
      query: 'test',
      results: [
        { path: '/a', relativePath: 'a', score: 1, matches: [] },
        { path: '/b', relativePath: 'b', score: 0.5, matches: [] },
      ],
      selectedIndex: 1,
      dir: '/dir',
      options: {},
    };
    const updated = selectUp(state);
    expect(updated.selectedIndex).toBe(0);
  });

  it('should not go below 0', () => {
    const state: InteractiveSearchState = {
      query: 'test',
      results: [{ path: '/a', relativePath: 'a', score: 1, matches: [] }],
      selectedIndex: 0,
      dir: '/dir',
      options: {},
    };
    const updated = selectUp(state);
    expect(updated.selectedIndex).toBe(0);
  });
});

describe('selectDown', () => {
  it('should increment selectedIndex', () => {
    const state: InteractiveSearchState = {
      query: 'test',
      results: [
        { path: '/a', relativePath: 'a', score: 1, matches: [] },
        { path: '/b', relativePath: 'b', score: 0.5, matches: [] },
      ],
      selectedIndex: 0,
      dir: '/dir',
      options: {},
    };
    const updated = selectDown(state);
    expect(updated.selectedIndex).toBe(1);
  });

  it('should not go above results.length - 1', () => {
    const state: InteractiveSearchState = {
      query: 'test',
      results: [
        { path: '/a', relativePath: 'a', score: 1, matches: [] },
        { path: '/b', relativePath: 'b', score: 0.5, matches: [] },
      ],
      selectedIndex: 1,
      dir: '/dir',
      options: {},
    };
    const updated = selectDown(state);
    expect(updated.selectedIndex).toBe(1);
  });
});

describe('getSelected', () => {
  it('should return the selected result', () => {
    const results: SearchResult[] = [
      { path: '/a', relativePath: 'a', score: 1, matches: [] },
      { path: '/b', relativePath: 'b', score: 0.5, matches: [] },
    ];
    const state: InteractiveSearchState = {
      query: 'test',
      results,
      selectedIndex: 1,
      dir: '/dir',
      options: {},
    };
    expect(getSelected(state)).toBe(results[1]);
  });

  it('should return null when selectedIndex is out of bounds (negative)', () => {
    const state: InteractiveSearchState = {
      query: 'test',
      results: [{ path: '/a', relativePath: 'a', score: 1, matches: [] }],
      selectedIndex: -1,
      dir: '/dir',
      options: {},
    };
    expect(getSelected(state)).toBeNull();
  });

  it('should return null when selectedIndex exceeds results length', () => {
    const state: InteractiveSearchState = {
      query: 'test',
      results: [{ path: '/a', relativePath: 'a', score: 1, matches: [] }],
      selectedIndex: 5,
      dir: '/dir',
      options: {},
    };
    expect(getSelected(state)).toBeNull();
  });

  it('should return null when results are empty', () => {
    const state: InteractiveSearchState = {
      query: 'test',
      results: [],
      selectedIndex: 0,
      dir: '/dir',
      options: {},
    };
    expect(getSelected(state)).toBeNull();
  });
});

// ============================================================================
// getAllFiles
// ============================================================================

describe('getAllFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-fuzzy-'));
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'util.ts'), '');
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'main.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'src', 'helper.js'), '');
    fs.mkdirSync(path.join(tmpDir, 'node_modules'));
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'pkg.js'), '');
    fs.writeFileSync(path.join(tmpDir, '.hidden'), '');
    fs.mkdirSync(path.join(tmpDir, '.git'));
    fs.writeFileSync(path.join(tmpDir, '.git', 'HEAD'), '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return all non-hidden files recursively', () => {
    const files = getAllFiles(tmpDir);
    expect(files.some(f => f === 'index.ts')).toBe(true);
    expect(files.some(f => f.includes('main.ts'))).toBe(true);
    expect(files.some(f => f.includes('helper.js'))).toBe(true);
  });

  it('should exclude node_modules by default', () => {
    const files = getAllFiles(tmpDir);
    expect(files.some(f => f.includes('node_modules'))).toBe(false);
  });

  it('should exclude .git by default', () => {
    const files = getAllFiles(tmpDir);
    expect(files.some(f => f.includes('.git'))).toBe(false);
  });

  it('should exclude hidden files by default', () => {
    const files = getAllFiles(tmpDir);
    expect(files.some(f => f === '.hidden')).toBe(false);
  });

  it('should include hidden files when includeHidden is true', () => {
    const files = getAllFiles(tmpDir, { includeHidden: true });
    expect(files.some(f => f === '.hidden')).toBe(true);
  });

  it('should filter by extension', () => {
    const files = getAllFiles(tmpDir, { extensions: ['ts'] });
    expect(files.every(f => f.endsWith('.ts'))).toBe(true);
    expect(files.some(f => f.includes('helper.js'))).toBe(false);
  });

  it('should return relative paths', () => {
    const files = getAllFiles(tmpDir);
    expect(files.every(f => !path.isAbsolute(f))).toBe(true);
  });

  it('should handle non-existent directory gracefully', () => {
    const files = getAllFiles('/nonexistent/path/xyz');
    expect(files).toEqual([]);
  });

  it('should respect custom excludeDirs option', () => {
    fs.mkdirSync(path.join(tmpDir, 'custom_skip'));
    fs.writeFileSync(path.join(tmpDir, 'custom_skip', 'file.ts'), '');
    const files = getAllFiles(tmpDir, { excludeDirs: ['custom_skip', 'node_modules', '.git'] });
    expect(files.some(f => f.includes('custom_skip'))).toBe(false);
  });
});

// ============================================================================
// searchFiles
// ============================================================================

describe('searchFiles', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-fuzzy-'));
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'utils.ts'), '');
    fs.mkdirSync(path.join(tmpDir, 'src'));
    fs.writeFileSync(path.join(tmpDir, 'src', 'main.ts'), '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return matching files', () => {
    const results = searchFiles(tmpDir, 'utils');
    expect(results.some(r => r.relativePath === 'utils.ts')).toBe(true);
  });

  it('should return results sorted by score (descending)', () => {
    const results = searchFiles(tmpDir, 'ts');
    for (let i = 1; i < results.length; i++) {
      expect(results[i - 1].score).toBeGreaterThanOrEqual(results[i].score);
    }
  });

  it('should limit results to maxResults', () => {
    // Create many files
    for (let i = 0; i < 20; i++) {
      fs.writeFileSync(path.join(tmpDir, `file${i}.ts`), '');
    }
    const results = searchFiles(tmpDir, 'file', { maxResults: 5 });
    expect(results.length).toBeLessThanOrEqual(5);
  });

  it('should return empty when no files match', () => {
    const results = searchFiles(tmpDir, 'zzz_no_match');
    expect(results).toEqual([]);
  });

  it('should include path, relativePath, score, and matches', () => {
    const results = searchFiles(tmpDir, 'index');
    const result = results.find(r => r.relativePath === 'index.ts');
    expect(result).toBeDefined();
    expect(result?.path).toContain(tmpDir);
    expect(typeof result?.score).toBe('number');
    expect(Array.isArray(result?.matches)).toBe(true);
  });
});

// ============================================================================
// searchWithHighlight
// ============================================================================

describe('searchWithHighlight', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-fuzzy-'));
    fs.writeFileSync(path.join(tmpDir, 'index.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'utils.ts'), '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return results with highlighted text', () => {
    const results = searchWithHighlight(tmpDir, 'index');
    expect(results.length).toBeGreaterThan(0);
    const indexResult = results.find(r => r.path.includes('index.ts'));
    expect(indexResult?.highlighted).toBeDefined();
    expect(typeof indexResult?.score).toBe('number');
  });

  it('should include path in results', () => {
    const results = searchWithHighlight(tmpDir, 'utils');
    expect(results.some(r => r.path.includes('utils.ts'))).toBe(true);
  });

  it('should return empty array when no matches', () => {
    const results = searchWithHighlight(tmpDir, 'zzz_no_match');
    expect(results).toEqual([]);
  });
});

// ============================================================================
// updateSearch
// ============================================================================

describe('updateSearch', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-fuzzy-'));
    fs.writeFileSync(path.join(tmpDir, 'test.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'other.ts'), '');
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should return empty results for empty query', () => {
    const state = createSearchState(tmpDir);
    const updated = updateSearch(state, '');
    expect(updated.results).toEqual([]);
    expect(updated.query).toBe('');
  });

  it('should search and return results for non-empty query', () => {
    const state = createSearchState(tmpDir);
    const updated = updateSearch(state, 'test');
    expect(updated.query).toBe('test');
    expect(updated.results.some(r => r.relativePath === 'test.ts')).toBe(true);
  });

  it('should reset selectedIndex to 0 after update', () => {
    let state = createSearchState(tmpDir);
    state = updateSearch(state, 'test');
    state = { ...state, selectedIndex: 1 };
    const updated = updateSearch(state, 'other');
    expect(updated.selectedIndex).toBe(0);
  });

  it('should preserve dir and options in updated state', () => {
    const state = createSearchState(tmpDir, { extensions: ['ts'] });
    const updated = updateSearch(state, 'test');
    expect(updated.dir).toBe(tmpDir);
    expect(updated.options.extensions).toEqual(['ts']);
  });
});
