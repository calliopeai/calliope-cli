/**
 * Extended coverage tests for src/branching.ts
 *
 * Targets uncovered branches:
 * - getBranchTree: isLast = false when a parent has multiple children (shows '│   ' indent)
 * - getBranchTree: main branch not found (no tree output)
 * - loadBranchMessages: corrupted JSONL file (catch branch)
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import * as fs from 'fs';
import type { BranchState } from '../src/branching.js';

// fs is already mocked by agterm-branching.test.ts at module level, but
// each test file gets its own module instance in Vitest.
// We need to re-mock here.

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

import {
  getBranchTree,
  switchBranch,
} from '../src/branching.js';

const TEST_SESSION = 'ext-session-999';

function mockFsWithState(state: BranchState, branchMessages: Record<string, string> = {}) {
  vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
    const pathStr = String(p);
    if (pathStr.endsWith('state.json')) return true;
    for (const branchId of Object.keys(branchMessages)) {
      if (pathStr.endsWith(`${branchId}.jsonl`)) return true;
    }
    return false;
  });

  vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
    const pathStr = String(p);
    if (pathStr.endsWith('state.json')) return JSON.stringify(state);
    for (const [branchId, content] of Object.entries(branchMessages)) {
      if (pathStr.endsWith(`${branchId}.jsonl`)) return content;
    }
    throw new Error(`ENOENT: ${pathStr}`);
  });
}

// ===========================================================================
// getBranchTree - isLast = false (multiple siblings)
// ===========================================================================

describe('getBranchTree - multiple children (isLast = false)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should use non-last prefix (├──) when a branch has multiple children', () => {
    const state: BranchState = {
      currentBranch: 'main',
      branches: {
        main: {
          id: 'main',
          name: 'main',
          parentId: null,
          parentMessageIndex: 0,
          createdAt: '2025-01-01T00:00:00.000Z',
        },
        child1: {
          id: 'child1',
          name: 'first-child',
          parentId: 'main',
          parentMessageIndex: 2,
          createdAt: '2025-01-02T00:00:00.000Z',
        },
        child2: {
          id: 'child2',
          name: 'second-child',
          parentId: 'main',
          parentMessageIndex: 3,
          createdAt: '2025-01-03T00:00:00.000Z',
        },
      },
    };

    mockFsWithState(state);

    const tree = getBranchTree(TEST_SESSION);

    // When main has 2 children, first-child is NOT the last → uses '├──'
    // second-child IS the last → uses '└──'
    expect(tree).toContain('├──');
    expect(tree).toContain('└──');
    expect(tree).toContain('first-child');
    expect(tree).toContain('second-child');
  });

  it('should use vertical bar indent (│   ) for non-last parent children', () => {
    const state: BranchState = {
      currentBranch: 'main',
      branches: {
        main: {
          id: 'main',
          name: 'main',
          parentId: null,
          parentMessageIndex: 0,
          createdAt: '2025-01-01T00:00:00.000Z',
        },
        sibling1: {
          id: 'sibling1',
          name: 'sibling-one',
          parentId: 'main',
          parentMessageIndex: 1,
          createdAt: '2025-01-02T00:00:00.000Z',
        },
        sibling2: {
          id: 'sibling2',
          name: 'sibling-two',
          parentId: 'main',
          parentMessageIndex: 2,
          createdAt: '2025-01-03T00:00:00.000Z',
        },
        grandchild: {
          id: 'grandchild',
          name: 'grand-child',
          parentId: 'sibling1',
          parentMessageIndex: 3,
          createdAt: '2025-01-04T00:00:00.000Z',
        },
      },
    };

    mockFsWithState(state);

    const tree = getBranchTree(TEST_SESSION);

    // sibling1 is NOT the last child of main (sibling2 comes after),
    // so grandchild's indent uses '│   ' (not '    ')
    expect(tree).toContain('│   ');
    expect(tree).toContain('grand-child');
  });
});

// ===========================================================================
// getBranchTree - no main branch
// ===========================================================================

describe('getBranchTree - no main branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty string when no main branch exists', () => {
    const state: BranchState = {
      currentBranch: 'other',
      branches: {
        // No 'main' branch
        other: {
          id: 'other',
          name: 'other',
          parentId: null,
          parentMessageIndex: 0,
          createdAt: '2025-01-01T00:00:00.000Z',
        },
      },
    };

    mockFsWithState(state);

    const tree = getBranchTree(TEST_SESSION);
    // No main branch → addBranch never called → lines array stays empty → ''
    expect(tree).toBe('');
  });
});

// ===========================================================================
// loadBranchMessages - corrupted JSONL (catch branch)
// ===========================================================================

describe('loadBranchMessages - corrupted JSONL', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return empty array when branch file has invalid JSON', () => {
    const state: BranchState = {
      currentBranch: 'main',
      branches: {
        main: {
          id: 'main',
          name: 'main',
          parentId: null,
          parentMessageIndex: 0,
          createdAt: '2025-01-01T00:00:00.000Z',
        },
        corrupted: {
          id: 'corrupted',
          name: 'corrupted',
          parentId: 'main',
          parentMessageIndex: 0,
          createdAt: '2025-01-02T00:00:00.000Z',
        },
      },
    };

    // Provide a corrupted JSONL file for the 'corrupted' branch
    mockFsWithState(state, {
      corrupted: 'not valid json\nalso {not valid',
    });

    // switchBranch loads the target branch messages via loadBranchMessages
    const result = switchBranch(TEST_SESSION, 'corrupted', []);
    // Should return empty array (catch branch returns [])
    expect(result).toEqual([]);
  });
});
