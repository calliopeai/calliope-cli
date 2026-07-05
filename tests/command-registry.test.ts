/**
 * Registry === handler invariant for the slash-command surface (#192).
 *
 * These tests guard the reduced command surface: the exported COMMAND_NAMES
 * list, the actual `case` labels in the executeCommand switch, and the
 * completion list must all stay in lockstep. If someone adds a `case` without
 * registering it (or advertises a command with no handler) a test fails.
 */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { COMMAND_NAMES } from '../src/ui/commands.js';
import { SLASH_COMMANDS } from '../src/ui/completions.js';

// The full set of handled labels: 22 visible commands + the /quit alias of
// /exit + the flag-gated /fleet (always handled here, gated only in completions).
const EXPECTED_COMMANDS = [
  '/help', '/status', '/clear', '/exit', '/quit',
  '/model', '/provider', '/mode',
  '/undo', '/export', '/resume', '/compact',
  '/scope', '/memory', '/trust', '/restore',
  '/mcp', '/skills',
  '/config', '/setup', '/cost', '/loop', '/debug',
  '/fleet',
].sort();

// The 22 visible commands offered as completion roots (no /quit alias, and
// /fleet only surfaces when fleet mode is enabled).
const EXPECTED_COMPLETION_ROOTS = [
  '/help', '/status', '/clear', '/exit',
  '/model', '/provider', '/mode',
  '/undo', '/export', '/resume', '/compact',
  '/scope', '/memory', '/trust', '/restore',
  '/mcp', '/skills',
  '/config', '/setup', '/cost', '/loop', '/debug',
].sort();

function completionRoots(): string[] {
  // Completion entries include subcommands like "/model list"; take the root.
  return [...new Set(SLASH_COMMANDS.map(c => c.split(' ')[0]))];
}

describe('command registry', () => {
  it('COMMAND_NAMES is exactly the 22 commands + /quit alias + /fleet', () => {
    expect([...COMMAND_NAMES].sort()).toEqual(EXPECTED_COMMANDS);
  });

  it('COMMAND_NAMES has 24 unique entries', () => {
    expect(COMMAND_NAMES.length).toBe(24);
    expect(new Set(COMMAND_NAMES).size).toBe(24);
  });

  it('every case label in the executeCommand switch is registered (and vice versa)', () => {
    const src = readFileSync(
      fileURLToPath(new URL('../src/ui/commands.ts', import.meta.url)),
      'utf-8',
    );
    const caseLabels = [...src.matchAll(/^\s*case '(\/[^']+)':/gm)].map(m => m[1]);
    // Switch labels and the exported registry must be the identical set.
    expect([...new Set(caseLabels)].sort()).toEqual([...COMMAND_NAMES].sort());
    // No accidental duplicate case labels.
    expect(caseLabels.length).toBe(new Set(caseLabels).size);
  });

  it('completion roots are exactly the 22 visible commands', () => {
    expect(completionRoots().sort()).toEqual(EXPECTED_COMPLETION_ROOTS);
  });

  it('every completion root has a handler (completions ⊆ handlers)', () => {
    for (const root of completionRoots()) {
      expect(COMMAND_NAMES).toContain(root);
    }
  });

  it('subcommand completion entries only use registered roots', () => {
    for (const entry of SLASH_COMMANDS) {
      const root = entry.split(' ')[0];
      expect(COMMAND_NAMES).toContain(root);
    }
  });

  it('the /quit alias is handled but never advertised in completions', () => {
    expect(COMMAND_NAMES).toContain('/quit');
    expect(SLASH_COMMANDS).not.toContain('/quit');
  });

  it('removed commands are absent from both the registry and completions', () => {
    const removed = [
      '/models', '/providers', '/summarize', '/breakloop', '/cancel-loop', '/stop',
      '/add-dir', '/remove-dir', '/dirs', '/set', '/checkpoint', '/cp', '/untrust',
      '/work', '/plan', '/approve', '/route', '/autoroute', '/smart', '/breaker',
      '/theme', '/emoji', '/hooks', '/profile', '/find', '/search', '/project',
      '/todo', '/plans', '/history', '/context', '/session', '/sessions', '/log',
      '/copy', '/edit', '/redo', '/confirm', '/layout', '/density', '/collapse',
      '/bookmark', '/queue', '/flush', '/unstick', '/keys', '/upgrade', '/costs',
    ];
    for (const cmd of removed) {
      expect(COMMAND_NAMES).not.toContain(cmd);
      expect(completionRoots()).not.toContain(cmd);
    }
  });
});
