import { describe, it, expect, vi, beforeEach } from 'vitest';

// ============================================================================
// Mock child_process
// ============================================================================

const mockExecFileSync = vi.fn();
const mockExecSync = vi.fn();

vi.mock('child_process', () => ({
  execFileSync: (...args: unknown[]) => mockExecFileSync(...args),
  execSync: (...args: unknown[]) => mockExecSync(...args),
}));

// ============================================================================
// Mock agent-detection
// ============================================================================

const mockDetectAgents = vi.fn();

vi.mock('../src/agents/agent-detection.js', () => ({
  detectAgents: () => mockDetectAgents(),
}));

// ============================================================================
// Mock sdk-backend
// ============================================================================

const mockIsClaudeSdkAvailable = vi.fn();
const mockIsOpenaiSdkAvailable = vi.fn();
const mockIsGoogleAdkAvailable = vi.fn();

vi.mock('../src/agents/sdk-backend.js', () => ({
  isClaudeSdkAvailable: () => mockIsClaudeSdkAvailable(),
  isOpenaiSdkAvailable: () => mockIsOpenaiSdkAvailable(),
  isGoogleAdkAvailable: () => mockIsGoogleAdkAvailable(),
}));

// ============================================================================
// Import under test (after mocks)
// ============================================================================

import {
  getInstallableItems,
  getInstallReport,
  installItem,
  installAllMissing,
} from '../src/agents/installer.js';

// ============================================================================
// Helpers
// ============================================================================

function defaultDetectedAgents() {
  return [
    { type: 'calliope', command: 'calliope', args: ['--headless', '--god-mode'], envVar: 'ANTHROPIC_API_KEY' },
    { type: 'claude', command: 'claude', args: ['--print'], envVar: 'ANTHROPIC_API_KEY' },
    { type: 'gemini', command: 'gemini', args: [], envVar: 'GOOGLE_API_KEY' },
    { type: 'codex', command: 'codex', args: [], envVar: 'OPENAI_API_KEY' },
  ];
}

// ============================================================================
// Tests
// ============================================================================

beforeEach(() => {
  vi.clearAllMocks();
  // Default: all SDKs unavailable
  mockIsClaudeSdkAvailable.mockResolvedValue(false);
  mockIsOpenaiSdkAvailable.mockResolvedValue(false);
  mockIsGoogleAdkAvailable.mockResolvedValue(false);
  // Default: all agents detected
  mockDetectAgents.mockReturnValue(defaultDetectedAgents());
  // Default: no CLI commands exist (which throws)
  mockExecFileSync.mockImplementation(() => {
    throw new Error('not found');
  });
});

// ============================================================================
// commandExists (tested indirectly via getInstallableItems)
// ============================================================================

describe('commandExists (via getInstallableItems)', () => {
  it('should mark CLI as installed when which succeeds', async () => {
    // Only claude is installed
    mockExecFileSync.mockImplementation((_cmd: string, args: string[]) => {
      if (args[0] === 'claude') return Buffer.from('/usr/local/bin/claude');
      throw new Error('not found');
    });

    const items = await getInstallableItems();
    const claude = items.find(i => i.name === 'claude');
    const gemini = items.find(i => i.name === 'gemini');

    expect(claude?.installed).toBe(true);
    expect(claude?.reason).toBeUndefined();
    expect(gemini?.installed).toBe(false);
    expect(gemini?.reason).toBe('gemini not found in PATH');
  });

  it('should mark CLI as not installed when which throws', async () => {
    const items = await getInstallableItems();
    const cliItems = items.filter(i => i.category === 'cli');

    for (const item of cliItems) {
      expect(item.installed).toBe(false);
      expect(item.reason).toContain('not found in PATH');
    }
  });

  it('should mark all CLIs as installed when all which calls succeed', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/local/bin/cmd'));

    const items = await getInstallableItems();
    const cliItems = items.filter(i => i.category === 'cli');

    for (const item of cliItems) {
      expect(item.installed).toBe(true);
      expect(item.reason).toBeUndefined();
    }
  });
});

// ============================================================================
// getInstallableItems
// ============================================================================

describe('getInstallableItems', () => {
  it('should return items for all detected CLI agents', async () => {
    const items = await getInstallableItems();
    const cliItems = items.filter(i => i.category === 'cli');

    expect(cliItems.length).toBe(4);
    expect(cliItems.map(i => i.name)).toEqual(['calliope', 'claude', 'gemini', 'codex']);
  });

  it('should return all three SDK backends', async () => {
    const items = await getInstallableItems();
    const sdkItems = items.filter(i => i.category === 'sdk');

    expect(sdkItems.length).toBe(3);
    expect(sdkItems.map(i => i.name)).toEqual(['claude-sdk', 'openai-sdk', 'google-adk']);
  });

  it('should mark SDK as installed when available', async () => {
    mockIsClaudeSdkAvailable.mockResolvedValue(true);
    mockIsOpenaiSdkAvailable.mockResolvedValue(false);
    mockIsGoogleAdkAvailable.mockResolvedValue(true);

    const items = await getInstallableItems();
    const sdkItems = items.filter(i => i.category === 'sdk');

    const claudeSdk = sdkItems.find(i => i.name === 'claude-sdk');
    const openaiSdk = sdkItems.find(i => i.name === 'openai-sdk');
    const googleAdk = sdkItems.find(i => i.name === 'google-adk');

    expect(claudeSdk?.installed).toBe(true);
    expect(claudeSdk?.reason).toBeUndefined();
    expect(openaiSdk?.installed).toBe(false);
    expect(openaiSdk?.reason).toBe('Package not installed');
    expect(googleAdk?.installed).toBe(true);
    expect(googleAdk?.reason).toBeUndefined();
  });

  it('should include correct install commands for CLIs', async () => {
    const items = await getInstallableItems();

    const calliope = items.find(i => i.name === 'calliope');
    const claude = items.find(i => i.name === 'claude');
    const gemini = items.find(i => i.name === 'gemini');
    const codex = items.find(i => i.name === 'codex');

    expect(calliope?.installCommand).toBe('npm install -g @calliopelabs/cli');
    expect(claude?.installCommand).toBe('npm install -g @anthropic-ai/claude-code');
    expect(gemini?.installCommand).toBe('npm install -g @google/gemini-cli');
    expect(codex?.installCommand).toBe('npm install -g @openai/codex');
  });

  it('should include correct install commands for SDKs', async () => {
    const items = await getInstallableItems();

    const claudeSdk = items.find(i => i.name === 'claude-sdk');
    const openaiSdk = items.find(i => i.name === 'openai-sdk');
    const googleAdk = items.find(i => i.name === 'google-adk');

    expect(claudeSdk?.installCommand).toBe('npm install -g @anthropic-ai/claude-agent-sdk');
    expect(openaiSdk?.installCommand).toBe('npm install -g @openai/agents');
    expect(googleAdk?.installCommand).toBe('npm install -g @google/adk');
  });

  it('should include descriptions for all items', async () => {
    const items = await getInstallableItems();

    for (const item of items) {
      expect(item.description).toBeTruthy();
      expect(typeof item.description).toBe('string');
    }
  });

  it('should set checkCommand for CLI items only', async () => {
    const items = await getInstallableItems();
    const cliItems = items.filter(i => i.category === 'cli');
    const sdkItems = items.filter(i => i.category === 'sdk');

    for (const item of cliItems) {
      expect(item.checkCommand).toBeTruthy();
    }
    for (const item of sdkItems) {
      expect(item.checkCommand).toBeUndefined();
    }
  });

  it('should skip agents not in CLI_AGENTS map', async () => {
    mockDetectAgents.mockReturnValue([
      { type: 'unknown-agent', command: 'unknown', args: [], envVar: 'FOO' },
      { type: 'claude', command: 'claude', args: ['--print'], envVar: 'ANTHROPIC_API_KEY' },
    ]);

    const items = await getInstallableItems();
    const cliItems = items.filter(i => i.category === 'cli');

    expect(cliItems.length).toBe(1);
    expect(cliItems[0].name).toBe('claude');
  });

  it('should handle empty detected agents', async () => {
    mockDetectAgents.mockReturnValue([]);

    const items = await getInstallableItems();
    const cliItems = items.filter(i => i.category === 'cli');
    const sdkItems = items.filter(i => i.category === 'sdk');

    expect(cliItems.length).toBe(0);
    expect(sdkItems.length).toBe(3); // SDKs always present
  });
});

// ============================================================================
// getInstallReport
// ============================================================================

describe('getInstallReport', () => {
  it('should include "Agent CLIs:" header', async () => {
    const report = await getInstallReport();
    expect(report).toContain('Agent CLIs:');
  });

  it('should include "SDK Backends" header', async () => {
    const report = await getInstallReport();
    expect(report).toContain('SDK Backends (optional, for in-process execution):');
  });

  it('should show check mark for installed items', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/local/bin/cmd'));
    mockIsClaudeSdkAvailable.mockResolvedValue(true);

    const report = await getInstallReport();
    expect(report).toContain('✓');
    expect(report).toContain('installed');
  });

  it('should show X mark for missing items', async () => {
    const report = await getInstallReport();
    expect(report).toContain('✗');
    expect(report).toContain('not installed');
  });

  it('should include install commands for missing CLIs', async () => {
    const report = await getInstallReport();
    expect(report).toContain('Install: npm install -g @anthropic-ai/claude-code');
    expect(report).toContain('Install: npm install -g @google/gemini-cli');
  });

  it('should include alt install commands when available', async () => {
    const report = await getInstallReport();
    // claude and codex have altInstall
    expect(report).toContain('or: brew install --cask claude-code');
    expect(report).toContain('or: brew install --cask codex');
  });

  it('should include SDK descriptions for missing SDKs', async () => {
    const report = await getInstallReport();
    expect(report).toContain('Claude Agent SDK');
    expect(report).toContain('OpenAI Agents JS');
    expect(report).toContain('Google ADK');
  });

  it('should show "all installed" message when nothing is missing', async () => {
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/local/bin/cmd'));
    mockIsClaudeSdkAvailable.mockResolvedValue(true);
    mockIsOpenaiSdkAvailable.mockResolvedValue(true);
    mockIsGoogleAdkAvailable.mockResolvedValue(true);

    const report = await getInstallReport();
    expect(report).toContain('All agents and SDK backends are installed!');
    expect(report).not.toContain('Install all missing');
  });

  it('should show "install all missing" command when items are missing', async () => {
    const report = await getInstallReport();
    expect(report).toContain('Install all missing:');
    // Should join install commands with &&
    expect(report).toContain('&&');
  });

  it('should not show alt install for installed CLIs', async () => {
    // All CLIs installed
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/local/bin/cmd'));

    const report = await getInstallReport();
    // claude is installed, so no alt install shown
    expect(report).not.toContain('or: brew install --cask claude-code');
  });

  it('should not show SDK description for installed SDKs', async () => {
    mockIsClaudeSdkAvailable.mockResolvedValue(true);

    const report = await getInstallReport();
    // claude-sdk is installed, the description line should not appear under its entry
    // But the description for missing SDKs should still appear
    const lines = report.split('\n');
    const claudeSdkLine = lines.findIndex(l => l.includes('claude-sdk'));
    // Next line should NOT be the description (it would be for a missing item)
    if (claudeSdkLine >= 0) {
      const nextLine = lines[claudeSdkLine + 1] || '';
      expect(nextLine).not.toContain('Claude Agent SDK — in-process');
    }
  });
});

// ============================================================================
// installItem
// ============================================================================

describe('installItem', () => {
  it('should return success when execSync succeeds with output', () => {
    mockExecSync.mockReturnValue('added 1 package');

    const result = installItem('claude');
    expect(result.success).toBe(true);
    expect(result.output).toBe('added 1 package');
  });

  it('should return default success message when execSync returns empty', () => {
    mockExecSync.mockReturnValue('');

    const result = installItem('claude');
    expect(result.success).toBe(true);
    expect(result.output).toBe('claude installed successfully.');
  });

  it('should return default success message when output is only whitespace', () => {
    mockExecSync.mockReturnValue('   \n  ');

    const result = installItem('claude');
    expect(result.success).toBe(true);
    expect(result.output).toBe('claude installed successfully.');
  });

  it('should call execSync with correct install command for CLI agents', () => {
    mockExecSync.mockReturnValue('ok');

    installItem('calliope');
    expect(mockExecSync).toHaveBeenCalledWith(
      'npm install -g @calliopelabs/cli',
      expect.objectContaining({ encoding: 'utf-8', timeout: 120_000 }),
    );

    installItem('claude');
    expect(mockExecSync).toHaveBeenCalledWith(
      'npm install -g @anthropic-ai/claude-code',
      expect.objectContaining({ encoding: 'utf-8' }),
    );

    installItem('gemini');
    expect(mockExecSync).toHaveBeenCalledWith(
      'npm install -g @google/gemini-cli',
      expect.objectContaining({ encoding: 'utf-8' }),
    );

    installItem('codex');
    expect(mockExecSync).toHaveBeenCalledWith(
      'npm install -g @openai/codex',
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('should call execSync with correct install command for SDK backends', () => {
    mockExecSync.mockReturnValue('ok');

    installItem('claude-sdk');
    expect(mockExecSync).toHaveBeenCalledWith(
      'npm install -g @anthropic-ai/claude-agent-sdk',
      expect.objectContaining({ encoding: 'utf-8' }),
    );

    installItem('openai-sdk');
    expect(mockExecSync).toHaveBeenCalledWith(
      'npm install -g @openai/agents',
      expect.objectContaining({ encoding: 'utf-8' }),
    );

    installItem('google-adk');
    expect(mockExecSync).toHaveBeenCalledWith(
      'npm install -g @google/adk',
      expect.objectContaining({ encoding: 'utf-8' }),
    );
  });

  it('should use 120 second timeout', () => {
    mockExecSync.mockReturnValue('ok');

    installItem('claude');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ timeout: 120_000 }),
    );
  });

  it('should use stdio ignore/pipe/pipe', () => {
    mockExecSync.mockReturnValue('ok');

    installItem('claude');
    expect(mockExecSync).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ stdio: ['ignore', 'pipe', 'pipe'] }),
    );
  });

  it('should return failure for unknown item names', () => {
    const result = installItem('nonexistent');
    expect(result.success).toBe(false);
    expect(result.output).toContain('Unknown item: nonexistent');
    expect(result.output).toContain('Available:');
    expect(result.output).toContain('calliope');
    expect(result.output).toContain('claude');
    expect(result.output).toContain('claude-sdk');
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('should return failure when execSync throws Error with stderr', () => {
    const error = new Error('command failed') as Error & { stderr: string };
    error.stderr = 'EACCES: permission denied';
    mockExecSync.mockImplementation(() => { throw error; });

    const result = installItem('claude');
    expect(result.success).toBe(false);
    expect(result.output).toContain('Failed to install claude');
    expect(result.output).toContain('EACCES: permission denied');
  });

  it('should return failure with error.message when no stderr', () => {
    mockExecSync.mockImplementation(() => { throw new Error('npm ERR! code ENOENT'); });

    const result = installItem('claude');
    expect(result.success).toBe(false);
    expect(result.output).toContain('Failed to install claude');
    expect(result.output).toContain('npm ERR! code ENOENT');
  });

  it('should return failure with stringified error for non-Error throws', () => {
    mockExecSync.mockImplementation(() => { throw 'string error'; });

    const result = installItem('claude');
    expect(result.success).toBe(false);
    expect(result.output).toContain('Failed to install claude');
    expect(result.output).toContain('string error');
  });

  it('should prefer stderr over message when both exist', () => {
    const error = new Error('generic message') as Error & { stderr: string };
    error.stderr = 'specific stderr output';
    mockExecSync.mockImplementation(() => { throw error; });

    const result = installItem('gemini');
    expect(result.success).toBe(false);
    expect(result.output).toContain('specific stderr output');
  });

  it('should handle all known CLI agent names', () => {
    mockExecSync.mockReturnValue('ok');

    for (const name of ['calliope', 'claude', 'gemini', 'codex']) {
      const result = installItem(name);
      expect(result.success).toBe(true);
    }
  });

  it('should handle all known SDK backend names', () => {
    mockExecSync.mockReturnValue('ok');

    for (const name of ['claude-sdk', 'openai-sdk', 'google-adk']) {
      const result = installItem(name);
      expect(result.success).toBe(true);
    }
  });
});

// ============================================================================
// installAllMissing
// ============================================================================

describe('installAllMissing', () => {
  it('should install all missing items and return installed list', async () => {
    // All CLIs missing, all SDKs missing
    mockExecSync.mockReturnValue('installed ok');

    const result = await installAllMissing();
    expect(result.installed.length).toBeGreaterThan(0);
    expect(result.failed.length).toBe(0);
  });

  it('should not install already-installed items', async () => {
    // All CLIs installed
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/local/bin/cmd'));
    // All SDKs installed
    mockIsClaudeSdkAvailable.mockResolvedValue(true);
    mockIsOpenaiSdkAvailable.mockResolvedValue(true);
    mockIsGoogleAdkAvailable.mockResolvedValue(true);

    const result = await installAllMissing();
    expect(result.installed.length).toBe(0);
    expect(result.failed.length).toBe(0);
    expect(mockExecSync).not.toHaveBeenCalled();
  });

  it('should track failures separately from successes', async () => {
    // Make some installs fail
    mockExecSync.mockImplementation((cmd: string) => {
      if (cmd.includes('claude-code')) throw new Error('permission denied');
      if (cmd.includes('codex')) throw new Error('network error');
      return 'ok';
    });

    const result = await installAllMissing();
    expect(result.installed).toContain('calliope');
    expect(result.installed).toContain('gemini');
    expect(result.failed.length).toBe(2);
    expect(result.failed.some(f => f.includes('claude'))).toBe(true);
    expect(result.failed.some(f => f.includes('codex'))).toBe(true);
  });

  it('should include error details in failed entries', async () => {
    mockExecSync.mockImplementation(() => {
      throw new Error('EACCES');
    });

    const result = await installAllMissing();
    expect(result.failed.length).toBeGreaterThan(0);
    for (const failure of result.failed) {
      expect(failure).toContain(':');
      expect(failure).toContain('Failed to install');
    }
  });

  it('should install only missing SDKs when CLIs are present', async () => {
    // All CLIs installed
    mockExecFileSync.mockReturnValue(Buffer.from('/usr/local/bin/cmd'));
    // Only claude SDK installed
    mockIsClaudeSdkAvailable.mockResolvedValue(true);
    mockIsOpenaiSdkAvailable.mockResolvedValue(false);
    mockIsGoogleAdkAvailable.mockResolvedValue(false);

    mockExecSync.mockReturnValue('ok');

    const result = await installAllMissing();
    expect(result.installed).toContain('openai-sdk');
    expect(result.installed).toContain('google-adk');
    expect(result.installed).not.toContain('claude-sdk');
    expect(result.installed.length).toBe(2);
  });

  it('should handle all installs failing', async () => {
    mockExecSync.mockImplementation(() => { throw new Error('fail'); });

    const result = await installAllMissing();
    expect(result.installed.length).toBe(0);
    expect(result.failed.length).toBeGreaterThan(0);
  });

  it('should handle empty detected agents with missing SDKs', async () => {
    mockDetectAgents.mockReturnValue([]);
    mockExecSync.mockReturnValue('ok');

    const result = await installAllMissing();
    // Only SDK items should be installed (3 SDKs)
    expect(result.installed.length).toBe(3);
    expect(result.installed).toContain('claude-sdk');
    expect(result.installed).toContain('openai-sdk');
    expect(result.installed).toContain('google-adk');
  });
});

// ============================================================================
// InstallableItem interface shape
// ============================================================================

describe('InstallableItem shape', () => {
  it('should have correct category values', async () => {
    const items = await getInstallableItems();

    for (const item of items) {
      expect(['cli', 'sdk']).toContain(item.category);
    }
  });

  it('should have name, description, installCommand for every item', async () => {
    const items = await getInstallableItems();

    for (const item of items) {
      expect(typeof item.name).toBe('string');
      expect(item.name.length).toBeGreaterThan(0);
      expect(typeof item.description).toBe('string');
      expect(item.description.length).toBeGreaterThan(0);
      expect(typeof item.installCommand).toBe('string');
      expect(item.installCommand.length).toBeGreaterThan(0);
      expect(typeof item.installed).toBe('boolean');
    }
  });
});
