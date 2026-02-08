import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import type { Message as LLMMessage } from '../src/types.js';
import type { Branch, BranchState } from '../src/branching.js';

// ============================================================================
// Mock fs to avoid real file system operations
// ============================================================================

vi.mock('fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// Import after mocks
import {
  loadBranchState,
  saveBranchState,
  createBranch,
  switchBranch,
  listBranches,
  getCurrentBranch,
  deleteBranch,
  renameBranch,
  getBranchTree,
} from '../src/branching.js';

// ============================================================================
// Helpers
// ============================================================================

const TEST_SESSION = 'test-session-123';

function makeMessage(role: 'user' | 'assistant', content: string): LLMMessage {
  return { role, content };
}

function makeDefaultState(): BranchState {
  return {
    currentBranch: 'main',
    branches: {
      main: {
        id: 'main',
        name: 'main',
        parentId: null,
        parentMessageIndex: 0,
        createdAt: '2025-01-01T00:00:00.000Z',
      },
    },
  };
}

/**
 * Set up fs mocks to simulate a specific state file and branch files.
 */
function mockFileSystem(state: BranchState | null, branchMessages: Record<string, LLMMessage[]> = {}) {
  vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
    const pathStr = String(p);
    if (pathStr.endsWith('state.json')) return state !== null;
    // Check branch JSONL files
    for (const branchId of Object.keys(branchMessages)) {
      if (pathStr.endsWith(`${branchId}.jsonl`)) return true;
    }
    return false;
  });

  vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor, _opts?: any) => {
    const pathStr = String(p);
    if (pathStr.endsWith('state.json') && state) {
      return JSON.stringify(state);
    }
    // Branch JSONL files
    for (const [branchId, messages] of Object.entries(branchMessages)) {
      if (pathStr.endsWith(`${branchId}.jsonl`)) {
        return messages.map(m => JSON.stringify(m)).join('\n');
      }
    }
    throw new Error(`ENOENT: no such file: ${pathStr}`);
  });
}

// ============================================================================
// Branch State: Loading
// ============================================================================

describe('Branch State Loading', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return default state when no state file exists', () => {
    mockFileSystem(null);

    const state = loadBranchState(TEST_SESSION);

    expect(state.currentBranch).toBe('main');
    expect(state.branches.main).toBeDefined();
    expect(state.branches.main.id).toBe('main');
    expect(state.branches.main.parentId).toBeNull();
  });

  it('should load state from existing file', () => {
    const existingState = makeDefaultState();
    existingState.branches['feature'] = {
      id: 'feature',
      name: 'feature-branch',
      parentId: 'main',
      parentMessageIndex: 3,
      createdAt: '2025-01-02T00:00:00.000Z',
    };
    existingState.currentBranch = 'feature';

    mockFileSystem(existingState);

    const state = loadBranchState(TEST_SESSION);

    expect(state.currentBranch).toBe('feature');
    expect(Object.keys(state.branches).length).toBe(2);
    expect(state.branches['feature'].name).toBe('feature-branch');
  });

  it('should return default state when state file is corrupted', () => {
    vi.mocked(fs.existsSync).mockReturnValue(true);
    vi.mocked(fs.readFileSync).mockReturnValue('not valid json{{{');

    const state = loadBranchState(TEST_SESSION);

    expect(state.currentBranch).toBe('main');
    expect(state.branches.main).toBeDefined();
  });

  it('should ensure branches directory is created', () => {
    mockFileSystem(null);

    loadBranchState(TEST_SESSION);

    expect(vi.mocked(fs.mkdirSync)).toHaveBeenCalledWith(
      expect.stringContaining(TEST_SESSION),
      { recursive: true }
    );
  });
});

// ============================================================================
// Branch State: Saving
// ============================================================================

describe('Branch State Saving', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // existsSync for directory check in ensureBranchesDir
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('should write state as JSON to the correct file', () => {
    const state = makeDefaultState();

    saveBranchState(TEST_SESSION, state);

    expect(vi.mocked(fs.writeFileSync)).toHaveBeenCalledWith(
      expect.stringContaining('state.json'),
      expect.any(String)
    );

    const writtenData = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    const parsed = JSON.parse(writtenData);
    expect(parsed.currentBranch).toBe('main');
    expect(parsed.branches.main).toBeDefined();
  });

  it('should pretty-print the JSON', () => {
    const state = makeDefaultState();

    saveBranchState(TEST_SESSION, state);

    const writtenData = vi.mocked(fs.writeFileSync).mock.calls[0][1] as string;
    // Pretty-printed JSON includes newlines
    expect(writtenData).toContain('\n');
  });
});

// ============================================================================
// Branch Creation
// ============================================================================

describe('Branch Creation', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(fs.existsSync).mockReturnValue(false);
  });

  it('should create a new branch from current position', () => {
    const state = makeDefaultState();
    mockFileSystem(state);

    const messages: LLMMessage[] = [
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi there'),
    ];

    const branch = createBranch(TEST_SESSION, 'experiment', messages);

    expect(branch.name).toBe('experiment');
    expect(branch.parentId).toBe('main');
    expect(branch.parentMessageIndex).toBe(2);
    expect(branch.id).toContain('branch_');
  });

  it('should create branch with description', () => {
    const state = makeDefaultState();
    mockFileSystem(state);

    const messages: LLMMessage[] = [makeMessage('user', 'Test')];

    const branch = createBranch(TEST_SESSION, 'test', messages, 'Testing a new approach');

    expect(branch.description).toBe('Testing a new approach');
  });

  it('should save messages to both parent and new branch', () => {
    const state = makeDefaultState();
    mockFileSystem(state);

    const messages: LLMMessage[] = [
      makeMessage('user', 'Hello'),
      makeMessage('assistant', 'Hi'),
    ];

    createBranch(TEST_SESSION, 'new-branch', messages);

    // writeFileSync is called for: parent branch messages, new branch messages, state
    const writeCalls = vi.mocked(fs.writeFileSync).mock.calls;
    expect(writeCalls.length).toBeGreaterThanOrEqual(3);

    // First two writes should be JSONL branch files
    const branchWrites = writeCalls.filter(
      call => String(call[0]).endsWith('.jsonl')
    );
    expect(branchWrites.length).toBe(2);
  });

  it('should update state to set new branch as current', () => {
    const state = makeDefaultState();
    mockFileSystem(state);

    const messages: LLMMessage[] = [makeMessage('user', 'Test')];

    const branch = createBranch(TEST_SESSION, 'feature', messages);

    // The last writeFileSync should be the state file
    const stateWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
      call => String(call[0]).endsWith('state.json')
    );
    expect(stateWrites.length).toBe(1);

    const savedState = JSON.parse(stateWrites[0][1] as string) as BranchState;
    expect(savedState.currentBranch).toBe(branch.id);
    expect(savedState.branches[branch.id]).toBeDefined();
    expect(savedState.branches[branch.id].name).toBe('feature');
  });

  it('should generate unique branch IDs', () => {
    const state = makeDefaultState();
    mockFileSystem(state);

    const messages: LLMMessage[] = [makeMessage('user', 'Test')];

    const b1 = createBranch(TEST_SESSION, 'a', messages);

    // Re-mock to include the branch we just created in state
    state.branches[b1.id] = b1;
    state.currentBranch = b1.id;
    mockFileSystem(state);

    const b2 = createBranch(TEST_SESSION, 'b', messages);

    expect(b1.id).not.toBe(b2.id);
  });

  it('should record fork point correctly', () => {
    const state = makeDefaultState();
    mockFileSystem(state);

    const messages: LLMMessage[] = [
      makeMessage('user', 'M1'),
      makeMessage('assistant', 'R1'),
      makeMessage('user', 'M2'),
      makeMessage('assistant', 'R2'),
      makeMessage('user', 'M3'),
    ];

    const branch = createBranch(TEST_SESSION, 'fork', messages);
    expect(branch.parentMessageIndex).toBe(5);
  });
});

// ============================================================================
// Branch Switching
// ============================================================================

describe('Branch Switching', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should switch to an existing branch by name', () => {
    const state = makeDefaultState();
    state.branches['feature'] = {
      id: 'feature',
      name: 'feature-branch',
      parentId: 'main',
      parentMessageIndex: 2,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    const featureMessages: LLMMessage[] = [
      makeMessage('user', 'Feature msg'),
      makeMessage('assistant', 'Feature reply'),
    ];

    mockFileSystem(state, { feature: featureMessages });

    const currentMessages: LLMMessage[] = [makeMessage('user', 'Main msg')];

    const result = switchBranch(TEST_SESSION, 'feature-branch', currentMessages);

    expect(result).not.toBeNull();
    expect(result!.length).toBe(2);
    expect(result![0].content).toBe('Feature msg');
  });

  it('should switch to an existing branch by ID', () => {
    const state = makeDefaultState();
    state.branches['b123'] = {
      id: 'b123',
      name: 'my-branch',
      parentId: 'main',
      parentMessageIndex: 1,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    const branchMessages: LLMMessage[] = [
      makeMessage('user', 'Hello from branch'),
    ];

    mockFileSystem(state, { b123: branchMessages });

    const currentMessages: LLMMessage[] = [];

    const result = switchBranch(TEST_SESSION, 'b123', currentMessages);

    expect(result).not.toBeNull();
    expect(result!.length).toBe(1);
  });

  it('should return null for non-existent branch', () => {
    mockFileSystem(makeDefaultState());

    const result = switchBranch(TEST_SESSION, 'nonexistent', []);
    expect(result).toBeNull();
  });

  it('should save current branch messages before switching', () => {
    const state = makeDefaultState();
    state.branches['other'] = {
      id: 'other',
      name: 'other',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    mockFileSystem(state, { other: [] });

    const currentMessages: LLMMessage[] = [
      makeMessage('user', 'Save me'),
    ];

    switchBranch(TEST_SESSION, 'other', currentMessages);

    // writeFileSync should have been called for saving current branch messages
    const jsonlWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
      call => String(call[0]).endsWith('.jsonl')
    );
    expect(jsonlWrites.length).toBeGreaterThanOrEqual(1);

    // Verify the saved content includes the current message
    const savedContent = jsonlWrites[0][1] as string;
    expect(savedContent).toContain('Save me');
  });

  it('should update state to reflect new current branch', () => {
    const state = makeDefaultState();
    state.branches['target'] = {
      id: 'target',
      name: 'target',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    mockFileSystem(state, { target: [] });

    switchBranch(TEST_SESSION, 'target', []);

    const stateWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
      call => String(call[0]).endsWith('state.json')
    );
    expect(stateWrites.length).toBe(1);

    const savedState = JSON.parse(stateWrites[0][1] as string) as BranchState;
    expect(savedState.currentBranch).toBe('target');
  });

  it('should return empty array when switching to branch with no messages', () => {
    const state = makeDefaultState();
    state.branches['empty'] = {
      id: 'empty',
      name: 'empty',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    // Mock: branch file does not exist
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const pathStr = String(p);
      if (pathStr.endsWith('state.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
      const pathStr = String(p);
      if (pathStr.endsWith('state.json')) return JSON.stringify(state);
      throw new Error('ENOENT');
    });

    const result = switchBranch(TEST_SESSION, 'empty', []);

    expect(result).toEqual([]);
  });
});

// ============================================================================
// Branch Listing
// ============================================================================

describe('Branch Listing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should list all branches', () => {
    const state = makeDefaultState();
    state.branches['b1'] = {
      id: 'b1',
      name: 'branch-1',
      parentId: 'main',
      parentMessageIndex: 2,
      createdAt: '2025-01-03T00:00:00.000Z',
    };
    state.branches['b2'] = {
      id: 'b2',
      name: 'branch-2',
      parentId: 'main',
      parentMessageIndex: 4,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    mockFileSystem(state);

    const branches = listBranches(TEST_SESSION);

    expect(branches.length).toBe(3); // main + b1 + b2
  });

  it('should sort branches by creation date (newest first)', () => {
    const state = makeDefaultState();
    state.branches['old'] = {
      id: 'old',
      name: 'old',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2024-01-01T00:00:00.000Z',
    };
    state.branches['new'] = {
      id: 'new',
      name: 'new',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2026-01-01T00:00:00.000Z',
    };

    mockFileSystem(state);

    const branches = listBranches(TEST_SESSION);

    expect(branches[0].id).toBe('new');
    expect(branches[branches.length - 1].id).toBe('old');
  });

  it('should return only main branch when no others exist', () => {
    mockFileSystem(makeDefaultState());

    const branches = listBranches(TEST_SESSION);
    expect(branches.length).toBe(1);
    expect(branches[0].id).toBe('main');
  });
});

// ============================================================================
// Current Branch
// ============================================================================

describe('Current Branch', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should return current branch', () => {
    const state = makeDefaultState();
    mockFileSystem(state);

    const current = getCurrentBranch(TEST_SESSION);

    expect(current.id).toBe('main');
    expect(current.name).toBe('main');
  });

  it('should return updated current branch after switching', () => {
    const state = makeDefaultState();
    state.branches['active'] = {
      id: 'active',
      name: 'active-branch',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };
    state.currentBranch = 'active';

    mockFileSystem(state);

    const current = getCurrentBranch(TEST_SESSION);
    expect(current.id).toBe('active');
    expect(current.name).toBe('active-branch');
  });
});

// ============================================================================
// Branch Deletion
// ============================================================================

describe('Branch Deletion', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should delete a branch by name', () => {
    const state = makeDefaultState();
    state.branches['deleteme'] = {
      id: 'deleteme',
      name: 'delete-me',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    // Provide a branch file so existsSync returns true for the .jsonl
    mockFileSystem(state, { deleteme: [] });

    const result = deleteBranch(TEST_SESSION, 'delete-me');
    expect(result).toBe(true);

    // Should attempt to delete the JSONL file
    expect(vi.mocked(fs.unlinkSync)).toHaveBeenCalled();
  });

  it('should delete a branch by ID', () => {
    const state = makeDefaultState();
    state.branches['b456'] = {
      id: 'b456',
      name: 'branch456',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    mockFileSystem(state);

    const result = deleteBranch(TEST_SESSION, 'b456');
    expect(result).toBe(true);
  });

  it('should not delete the main branch', () => {
    mockFileSystem(makeDefaultState());

    const result = deleteBranch(TEST_SESSION, 'main');
    expect(result).toBe(false);
  });

  it('should not delete the current branch', () => {
    const state = makeDefaultState();
    state.branches['current'] = {
      id: 'current',
      name: 'current-branch',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };
    state.currentBranch = 'current';

    mockFileSystem(state);

    const result = deleteBranch(TEST_SESSION, 'current');
    expect(result).toBe(false);
  });

  it('should return false for non-existent branch', () => {
    mockFileSystem(makeDefaultState());

    const result = deleteBranch(TEST_SESSION, 'nonexistent');
    expect(result).toBe(false);
  });

  it('should remove branch from state after deletion', () => {
    const state = makeDefaultState();
    state.branches['toremove'] = {
      id: 'toremove',
      name: 'to-remove',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    mockFileSystem(state);

    deleteBranch(TEST_SESSION, 'to-remove');

    const stateWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
      call => String(call[0]).endsWith('state.json')
    );
    expect(stateWrites.length).toBe(1);

    const savedState = JSON.parse(stateWrites[0][1] as string) as BranchState;
    expect(savedState.branches['toremove']).toBeUndefined();
  });

  it('should handle deletion when branch file does not exist', () => {
    const state = makeDefaultState();
    state.branches['nobranch'] = {
      id: 'nobranch',
      name: 'no-file',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    // existsSync returns false for branch file
    vi.mocked(fs.existsSync).mockImplementation((p: fs.PathLike) => {
      const pathStr = String(p);
      if (pathStr.endsWith('state.json')) return true;
      return false;
    });
    vi.mocked(fs.readFileSync).mockImplementation((p: fs.PathOrFileDescriptor) => {
      const pathStr = String(p);
      if (pathStr.endsWith('state.json')) return JSON.stringify(state);
      throw new Error('ENOENT');
    });

    const result = deleteBranch(TEST_SESSION, 'no-file');
    expect(result).toBe(true);
    // Should not call unlinkSync since file doesn't exist
    expect(vi.mocked(fs.unlinkSync)).not.toHaveBeenCalled();
  });
});

// ============================================================================
// Branch Renaming
// ============================================================================

describe('Branch Renaming', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should rename a branch by current name', () => {
    const state = makeDefaultState();
    state.branches['b1'] = {
      id: 'b1',
      name: 'old-name',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    mockFileSystem(state);

    const result = renameBranch(TEST_SESSION, 'old-name', 'new-name');
    expect(result).toBe(true);

    const stateWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
      call => String(call[0]).endsWith('state.json')
    );
    const savedState = JSON.parse(stateWrites[0][1] as string) as BranchState;
    expect(savedState.branches['b1'].name).toBe('new-name');
  });

  it('should rename a branch by ID', () => {
    const state = makeDefaultState();
    state.branches['b1'] = {
      id: 'b1',
      name: 'old-name',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    mockFileSystem(state);

    const result = renameBranch(TEST_SESSION, 'b1', 'renamed');
    expect(result).toBe(true);
  });

  it('should rename the main branch', () => {
    mockFileSystem(makeDefaultState());

    const result = renameBranch(TEST_SESSION, 'main', 'trunk');
    expect(result).toBe(true);

    const stateWrites = vi.mocked(fs.writeFileSync).mock.calls.filter(
      call => String(call[0]).endsWith('state.json')
    );
    const savedState = JSON.parse(stateWrites[0][1] as string) as BranchState;
    expect(savedState.branches['main'].name).toBe('trunk');
  });

  it('should return false for non-existent branch', () => {
    mockFileSystem(makeDefaultState());

    const result = renameBranch(TEST_SESSION, 'ghost', 'new-name');
    expect(result).toBe(false);
  });
});

// ============================================================================
// Branch Tree Display
// ============================================================================

describe('Branch Tree Display', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should display a single main branch', () => {
    mockFileSystem(makeDefaultState());

    const tree = getBranchTree(TEST_SESSION);

    expect(tree).toContain('main');
    expect(tree).toContain('*'); // current branch marker
  });

  it('should display tree with children', () => {
    const state = makeDefaultState();
    state.branches['child'] = {
      id: 'child',
      name: 'child-branch',
      parentId: 'main',
      parentMessageIndex: 2,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    mockFileSystem(state);

    const tree = getBranchTree(TEST_SESSION);

    expect(tree).toContain('main');
    expect(tree).toContain('child-branch');
  });

  it('should display description in tree', () => {
    const state = makeDefaultState();
    state.branches['desc'] = {
      id: 'desc',
      name: 'described',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
      description: 'My description',
    };

    mockFileSystem(state);

    const tree = getBranchTree(TEST_SESSION);
    expect(tree).toContain('My description');
  });

  it('should mark current branch with asterisk', () => {
    const state = makeDefaultState();
    state.branches['active'] = {
      id: 'active',
      name: 'active-branch',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };
    state.currentBranch = 'active';

    mockFileSystem(state);

    const tree = getBranchTree(TEST_SESSION);
    // The active branch should have the * marker
    expect(tree).toContain('active-branch *');
  });

  it('should display nested branches correctly', () => {
    const state = makeDefaultState();
    state.branches['level1'] = {
      id: 'level1',
      name: 'level-1',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };
    state.branches['level2'] = {
      id: 'level2',
      name: 'level-2',
      parentId: 'level1',
      parentMessageIndex: 0,
      createdAt: '2025-01-03T00:00:00.000Z',
    };

    mockFileSystem(state);

    const tree = getBranchTree(TEST_SESSION);

    expect(tree).toContain('main');
    expect(tree).toContain('level-1');
    expect(tree).toContain('level-2');
  });
});

// ============================================================================
// Branch Data Integrity
// ============================================================================

describe('Branch Data Integrity', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should preserve message content through save/load cycle', () => {
    const state = makeDefaultState();
    state.branches['test'] = {
      id: 'test',
      name: 'test',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    const messages: LLMMessage[] = [
      makeMessage('user', 'Hello world'),
      makeMessage('assistant', 'Hi there! How can I help?'),
      makeMessage('user', 'Write some code'),
    ];

    mockFileSystem(state, { test: messages });

    // Switch to the test branch to load its messages
    const loaded = switchBranch(TEST_SESSION, 'test', []);

    expect(loaded).not.toBeNull();
    expect(loaded!.length).toBe(3);
    expect(loaded![0].role).toBe('user');
    expect(loaded![0].content).toBe('Hello world');
    expect(loaded![1].role).toBe('assistant');
    expect(loaded![2].content).toBe('Write some code');
  });

  it('should handle messages with special characters', () => {
    const state = makeDefaultState();
    state.branches['special'] = {
      id: 'special',
      name: 'special',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    const messages: LLMMessage[] = [
      makeMessage('user', 'Line 1\nLine 2\n"quoted"'),
    ];

    mockFileSystem(state, { special: messages });

    const loaded = switchBranch(TEST_SESSION, 'special', []);
    expect(loaded).not.toBeNull();
    expect(loaded![0].content).toContain('Line 1\nLine 2');
  });
});

// ============================================================================
// Branch Type Validation
// ============================================================================

describe('Branch Type Validation', () => {
  it('should have correct Branch interface fields', () => {
    const branch: Branch = {
      id: 'test',
      name: 'test-branch',
      parentId: 'main',
      parentMessageIndex: 5,
      createdAt: '2025-01-01T00:00:00.000Z',
      description: 'A test branch',
    };

    expect(branch.id).toBe('test');
    expect(branch.name).toBe('test-branch');
    expect(branch.parentId).toBe('main');
    expect(branch.parentMessageIndex).toBe(5);
    expect(branch.createdAt).toBeTruthy();
    expect(branch.description).toBe('A test branch');
  });

  it('should allow null parentId for root branch', () => {
    const branch: Branch = {
      id: 'main',
      name: 'main',
      parentId: null,
      parentMessageIndex: 0,
      createdAt: '2025-01-01T00:00:00.000Z',
    };

    expect(branch.parentId).toBeNull();
  });

  it('should have correct BranchState interface fields', () => {
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
      },
    };

    expect(state.currentBranch).toBe('main');
    expect(Object.keys(state.branches)).toContain('main');
  });
});

// ============================================================================
// Edge Cases
// ============================================================================

describe('Branch Edge Cases', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should handle creating branch with empty messages', () => {
    mockFileSystem(makeDefaultState());

    const branch = createBranch(TEST_SESSION, 'empty', []);
    expect(branch).toBeDefined();
    expect(branch.parentMessageIndex).toBe(0);
  });

  it('should handle switching with empty current messages', () => {
    const state = makeDefaultState();
    state.branches['target'] = {
      id: 'target',
      name: 'target',
      parentId: 'main',
      parentMessageIndex: 0,
      createdAt: '2025-01-02T00:00:00.000Z',
    };

    mockFileSystem(state, { target: [makeMessage('user', 'Hello')] });

    const result = switchBranch(TEST_SESSION, 'target', []);
    expect(result).not.toBeNull();
  });

  it('should handle listing branches for new session', () => {
    mockFileSystem(null);

    const branches = listBranches(TEST_SESSION);
    expect(branches.length).toBe(1);
    expect(branches[0].name).toBe('main');
  });
});
