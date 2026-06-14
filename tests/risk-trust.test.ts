import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { assessShellRisk, requiresConfirmation } from '../src/risk.js';

// ============================================================================
// #134 - Unknown/destructive shell commands must require confirmation
// ============================================================================

describe('#134 risk: deny-by-default for shell commands', () => {
  it('unknown binary returns high risk and requires confirmation', () => {
    const risk = assessShellRisk('custom-script --do-something');
    expect(risk.level).toBe('high');
    expect(risk.requiresConfirmation).toBe(true);
    // In non-god mode this means a prompt is forced.
    expect(requiresConfirmation(risk, false)).toBe(true);
  });

  it('god mode still skips confirmation for the unknown-command default (not critical)', () => {
    const risk = assessShellRisk('custom-script --do-something');
    expect(requiresConfirmation(risk, true)).toBe(false);
  });

  it('find -delete is high and requires confirmation (not low)', () => {
    const risk = assessShellRisk('find . -delete');
    expect(risk.level).toBe('high');
    expect(requiresConfirmation(risk, false)).toBe(true);
  });

  it('find -exec rm is high and requires confirmation', () => {
    const risk = assessShellRisk('find . -name "*.tmp" -exec rm {} \\;');
    expect(risk.level).toBe('high');
    expect(requiresConfirmation(risk, false)).toBe(true);
  });

  it('plain read-only find is no longer classified low', () => {
    expect(assessShellRisk('find . -name "*.ts"').level).not.toBe('low');
  });

  it('shred requires confirmation', () => {
    const risk = assessShellRisk('shred -u secret.txt');
    expect(risk.level).toBe('high');
    expect(requiresConfirmation(risk, false)).toBe(true);
  });

  it('truncate requires confirmation', () => {
    const risk = assessShellRisk('truncate -s 0 important.log');
    expect(risk.level).toBe('high');
    expect(requiresConfirmation(risk, false)).toBe(true);
  });

  it('> file redirect (truncate) requires confirmation', () => {
    const risk = assessShellRisk('echo "" > important.txt');
    expect(requiresConfirmation(risk, false)).toBe(true);
  });

  it('>> file redirect (append) requires confirmation', () => {
    const risk = assessShellRisk('cat log >> archive.txt');
    expect(requiresConfirmation(risk, false)).toBe(true);
  });

  it('redirect to /dev/ is still classified critical (always confirms)', () => {
    const risk = assessShellRisk('echo x > /dev/sda');
    expect(risk.level).toBe('critical');
    // critical confirms even in god mode
    expect(requiresConfirmation(risk, true)).toBe(true);
  });

  // Happy path: known safe read-only commands stay low / no confirmation.
  it('known read-only commands stay low and do not require confirmation', () => {
    const ls = assessShellRisk('ls -la');
    expect(ls.level).toBe('low');
    expect(requiresConfirmation(ls, false)).toBe(false);

    const cat = assessShellRisk('cat README.md');
    expect(cat.level).toBe('low');
    expect(requiresConfirmation(cat, false)).toBe(false);
  });
});

// ============================================================================
// #135 - autoTrustIfNew must not silently trust new directories
// ============================================================================

let tmpDir: string;
let projectDir: string;

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os');
  return { ...actual, homedir: () => tmpDir };
});

const { checkTrust, trustProject, autoTrustIfNew } = await import('../src/trust.js');

describe('#135 trust: no silent auto-trust of new directories', () => {
  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-risktrust-home-'));
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-risktrust-proj-'));
  });

  afterEach(() => {
    delete process.env.CALLIOPE_AUTO_TRUST;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(projectDir, { recursive: true, force: true });
  });

  it('unknown directory is NOT trusted by default (no silent trust)', () => {
    // Simulates buildMemoryContext calling autoTrustIfNew before checkTrust.
    autoTrustIfNew(projectDir);
    expect(checkTrust(projectDir).trusted).toBe(false);
  });

  it('explicitly trusted directory IS trusted (happy path)', () => {
    trustProject(projectDir, 'explicit /trust');
    expect(checkTrust(projectDir).trusted).toBe(true);
  });

  it('opt-in flag allows auto-trust for an unknown directory', () => {
    expect(autoTrustIfNew(projectDir, { optIn: true })).toBe(true);
    expect(checkTrust(projectDir).trusted).toBe(true);
  });

  it('changed CALLIOPE.md hash does not get silently re-trusted on its own', () => {
    // Trust with an initial CALLIOPE.md, then mutate it.
    const calliopeMd = path.join(projectDir, 'CALLIOPE.md');
    fs.writeFileSync(calliopeMd, '# original');
    trustProject(projectDir, 'trusted with original content');
    fs.writeFileSync(calliopeMd, '# tampered injection payload');

    const result = checkTrust(projectDir);
    // Still flagged as changed so callers can re-prompt; never silently re-hashed by autoTrustIfNew.
    expect(result.changed).toBe(true);

    // An unknown sibling directory is still untrusted by default.
    const sibling = fs.mkdtempSync(path.join(os.tmpdir(), 'calliope-risktrust-sib-'));
    try {
      autoTrustIfNew(sibling);
      expect(checkTrust(sibling).trusted).toBe(false);
    } finally {
      fs.rmSync(sibling, { recursive: true, force: true });
    }
  });
});
