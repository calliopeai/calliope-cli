/**
 * Integration tests for governance wiring in the headless runner (#189):
 * budget halt (run cost, run tokens, project cost) with exit code 3, the policy
 * deny path, and the audit run log it emits (run_start … run_end + budget_event,
 * verifiable hash chain).
 *
 * Heavy deps are mocked (no network, no real tools). os.homedir is redirected to
 * a temp dir so the run log + project ledger + conf store land under tmp.
 */

import { describe, it, expect, vi, beforeEach, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { EventEmitter } from 'events';

const { tmpHome } = vi.hoisted(() => {
  const _fs = require('fs') as typeof import('fs');
  const _path = require('path') as typeof import('path');
  const _os = require('os') as typeof import('os');
  const dir = _fs.mkdtempSync(_path.join(_os.tmpdir(), 'calliope-hlgov-test-'));
  return { tmpHome: dir };
});

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpHome };
});

// -- Config mock (test-controlled budget/policy) ----------------------------
let budgetCaps: Record<string, number> | undefined;
let policyConfig: { command?: string } | undefined;

vi.mock('../src/config.js', () => ({
  default: {},
  get: vi.fn((key: string) => {
    if (key === 'maxIterations') return 10;
    if (key === 'budget') return budgetCaps;
    if (key === 'policy') return policyConfig;
    if (key === 'audit') return undefined; // enabled by default
    if (key === 'defaultProvider') return 'anthropic';
    if (key === 'defaultModel') return 'claude-sonnet-4-6';
    return undefined;
  }),
  getConfig: vi.fn(() => ({ defaultProvider: 'anthropic' })),
  getApiKey: vi.fn(),
  getBaseUrl: vi.fn(),
  getConfiguredProviders: vi.fn(() => []),
}));

const mockChat = vi.fn();
const mockExecuteTool = vi.fn();

vi.mock('../src/providers/index.js', () => ({
  chat: (...args: unknown[]) => mockChat(...args),
  selectProvider: (p: string) => p || 'anthropic',
}));

vi.mock('../src/tools.js', () => ({
  TOOLS: [],
  executeTool: (...args: unknown[]) => mockExecuteTool(...args),
  getTools: vi.fn(() => []),
}));

vi.mock('../src/memory.js', () => ({
  buildMemoryContext: vi.fn(() => ''),
}));

vi.mock('../src/local-model.js', () => ({
  getSystemPromptForProvider: vi.fn(() => 'system'),
  isLocalBackend: vi.fn(() => false),
}));

// child_process for the policy hook
const spawnMock = vi.fn();
vi.mock('child_process', () => ({ spawn: (...a: unknown[]) => spawnMock(...a) }));

import { runHeadless } from '../src/headless.js';
import { readRunLog, verifyChain, resetRunLogs, type RunLogLine } from '../src/runlog.js';
import { recordProjectSpend, resetProjectSpend } from '../src/budget.js';

const RUNS_DIR = path.join(tmpHome, '.calliope-cli', 'runs');
const CWD = tmpHome;

function finalResponse(content = 'done', usage = { inputTokens: 10, outputTokens: 5 }) {
  return { content, toolCalls: [], finishReason: 'stop', usage };
}
function toolResponse(usage = { inputTokens: 10, outputTokens: 5 }) {
  return {
    content: '',
    toolCalls: [{ id: 'tc1', name: 'shell', arguments: { command: 'ls' } }],
    finishReason: 'tool_use',
    usage,
  };
}

/** The single run-log file written by a headless run in the fresh tmp runs dir. */
function onlyRunLog(): RunLogLine[] {
  const files = fs.readdirSync(RUNS_DIR).filter((f) => f.endsWith('.jsonl'));
  expect(files).toHaveLength(1);
  return readRunLog(path.join(RUNS_DIR, files[0]));
}

let stderrSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  budgetCaps = undefined;
  policyConfig = undefined;
  mockChat.mockReset();
  mockExecuteTool.mockReset();
  spawnMock.mockReset();
  resetRunLogs();
  resetProjectSpend(CWD);
  fs.rmSync(RUNS_DIR, { recursive: true, force: true });
  // Silence (and capture) the JSON/stderr the runner writes.
  vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
  stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterAll(() => {
  vi.restoreAllMocks();
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

function stderrText(): string {
  return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
}

// ---------------------------------------------------------------------------
// Budget halt
// ---------------------------------------------------------------------------

describe('headless budget halt', () => {
  it('exits 3 when the run cost cap is exceeded', async () => {
    budgetCaps = { maxCostPerRun: 0.00001 };
    // claude-sonnet-4-6 = $3/M input; 10k input ≈ $0.00003 > cap.
    mockChat.mockResolvedValueOnce(finalResponse('big', { inputTokens: 10000, outputTokens: 0 }));

    const code = await runHeadless({ prompt: 'go', provider: 'anthropic', model: 'claude-sonnet-4-6', outputMode: 'json', cwd: CWD });

    expect(code).toBe(3);
    expect(stderrText()).toContain('Budget cap reached');
  });

  it('exits 3 when the run token cap is exceeded', async () => {
    budgetCaps = { maxTokensPerRun: 100 };
    mockChat.mockResolvedValueOnce(finalResponse('big', { inputTokens: 200, outputTokens: 0 }));

    const code = await runHeadless({ prompt: 'go', provider: 'anthropic', model: 'claude-sonnet-4-6', outputMode: 'json', cwd: CWD });
    expect(code).toBe(3);
  });

  it('exits 3 up-front when the project cost cap is already spent (no chat call)', async () => {
    budgetCaps = { maxCostPerProject: 0.001 };
    recordProjectSpend(CWD, 0.01); // already over cap

    const code = await runHeadless({ prompt: 'go', provider: 'anthropic', model: 'claude-sonnet-4-6', outputMode: 'json', cwd: CWD });

    expect(code).toBe(3);
    expect(mockChat).not.toHaveBeenCalled();
  });

  it('records a budget_event and a run_end(budget) in a verifiable run log', async () => {
    budgetCaps = { maxCostPerRun: 0.00001 };
    mockChat.mockResolvedValueOnce(finalResponse('big', { inputTokens: 10000, outputTokens: 0 }));

    await runHeadless({ prompt: 'go', provider: 'anthropic', model: 'claude-sonnet-4-6', outputMode: 'json', cwd: CWD });

    const lines = onlyRunLog();
    expect(verifyChain(lines).ok).toBe(true);
    expect(lines.some((l) => l.type === 'run_start')).toBe(true);
    expect(lines.some((l) => l.type === 'budget_event')).toBe(true);
    const end = lines.find((l) => l.type === 'run_end') as unknown as { exitReason: string };
    expect(end.exitReason).toBe('budget');
  });

  it('completes normally (exit 0) when under budget', async () => {
    budgetCaps = { maxCostPerRun: 100 };
    mockChat.mockResolvedValueOnce(finalResponse('all good'));

    const code = await runHeadless({ prompt: 'go', provider: 'anthropic', model: 'claude-sonnet-4-6', outputMode: 'json', cwd: CWD });
    expect(code).toBe(0);
    const lines = onlyRunLog();
    const end = lines.find((l) => l.type === 'run_end') as unknown as { exitReason: string };
    expect(end.exitReason).toBe('completed');
  });
});

// ---------------------------------------------------------------------------
// Policy hook
// ---------------------------------------------------------------------------

describe('headless policy hook', () => {
  function fakeDenyProc(reason: string) {
    const proc = new EventEmitter() as EventEmitter & {
      pid: number; stdin: { write: () => void; end: () => void }; stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
    };
    proc.pid = 2147483646;
    proc.stdin = { write: () => {}, end: () => {} };
    proc.stdout = new EventEmitter();
    proc.stderr = new EventEmitter();
    proc.kill = () => {};
    // Deny asynchronously after listeners attach.
    queueMicrotask(() => {
      proc.stderr.emit('data', Buffer.from(reason));
      proc.emit('close', 1);
    });
    return proc;
  }

  it('denies a tool call and never executes it, then completes', async () => {
    policyConfig = { command: 'policy.sh' };
    spawnMock.mockImplementation(() => fakeDenyProc('blocked by policy'));

    // First response asks for a tool; second is the final answer.
    mockChat
      .mockResolvedValueOnce(toolResponse())
      .mockResolvedValueOnce(finalResponse('finished without the tool'));

    const code = await runHeadless({ prompt: 'go', provider: 'anthropic', model: 'claude-sonnet-4-6', outputMode: 'json', cwd: CWD });

    expect(code).toBe(0);
    expect(mockExecuteTool).not.toHaveBeenCalled();

    const lines = onlyRunLog();
    const policyEvent = lines.find((l) => l.type === 'policy_event') as unknown as { decision: string; reason: string };
    expect(policyEvent.decision).toBe('deny');
    expect(policyEvent.reason).toContain('blocked by policy');
    expect(verifyChain(lines).ok).toBe(true);
  });

  it('executes the tool when policy allows', async () => {
    policyConfig = { command: 'policy.sh' };
    spawnMock.mockImplementation(() => {
      const proc = new EventEmitter() as EventEmitter & {
        pid: number; stdin: { write: () => void; end: () => void }; stdout: EventEmitter; stderr: EventEmitter; kill: () => void;
      };
      proc.pid = 2147483646;
      proc.stdin = { write: () => {}, end: () => {} };
      proc.stdout = new EventEmitter();
      proc.stderr = new EventEmitter();
      proc.kill = () => {};
      queueMicrotask(() => proc.emit('close', 0));
      return proc;
    });
    mockExecuteTool.mockResolvedValue({ result: 'ok', isError: false });
    mockChat
      .mockResolvedValueOnce(toolResponse())
      .mockResolvedValueOnce(finalResponse('done'));

    const code = await runHeadless({ prompt: 'go', provider: 'anthropic', model: 'claude-sonnet-4-6', outputMode: 'json', cwd: CWD });
    expect(code).toBe(0);
    expect(mockExecuteTool).toHaveBeenCalledTimes(1);
  });
});
