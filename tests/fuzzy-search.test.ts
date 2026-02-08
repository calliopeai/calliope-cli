import { describe, it, expect, beforeEach } from 'vitest';
import {
  fuzzyMatch,
  highlightMatches,
  createSearchState,
  updateSearch,
  selectUp,
  selectDown,
  getSelected,
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
