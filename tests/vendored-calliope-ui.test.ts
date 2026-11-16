/**
 * The vendored @calliopelabs/ui terminal mapping is the published (or packed)
 * file, unedited. scripts/vendor-calliope-ui.mjs writes the version, the
 * source and the sha256 of the body into each file's header; a hand edit to a
 * body fails here, and so do two files from different versions. Update with
 * the script, never by hand.
 */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import * as terminal from '../src/vendor/calliope-ui/tokens.terminal.js';

const dir = new URL('../src/vendor/calliope-ui/', import.meta.url);
const FILES = ['dist/tokens/tokens.terminal.js', 'dist/tokens/tokens.terminal.d.ts'];
const HEADER = /^\/\* Vendored from @calliopelabs\/ui@(\S+) (\S+)\n \* source: (.+)\n \* sha256:([0-9a-f]{64})\n \* Do not edit\. Run scripts\/vendor-calliope-ui\.mjs to update\. \*\/\n/;

function vendored(member: string) {
  const text = readFileSync(new URL(member.split('/').pop()!, dir), 'utf8');
  const match = HEADER.exec(text);
  if (!match) throw new Error(`${member}: missing header; run scripts/vendor-calliope-ui.mjs`);
  const [header, version, recorded, source, sha] = match;
  return { version, recorded, source, sha, body: text.slice(header.length) };
}

describe('vendored @calliopelabs/ui', () => {
  it.each(FILES)('%s matches its recorded hash', (member) => {
    const file = vendored(member);
    expect(file.recorded).toBe(member);
    expect(createHash('sha256').update(file.body).digest('hex'), `${member} was edited by hand`).toBe(file.sha);
  });

  it('holds every file at one version and source', () => {
    const [first, ...rest] = FILES.map(vendored);
    for (const file of rest) {
      expect(file.version).toBe(first!.version);
      expect(file.source).toBe(first!.source);
    }
  });

  it('offers the Workbench brand the CLI wears', () => {
    expect(terminal.BRANDS.workbench.accent).toBe('workbench-blue');
    const dark = terminal.brandTheme('workbench', 'dark');
    expect(dark.ground).toBe('navy');
    for (const role of terminal.ROLES) {
      expect(terminal.contrast(dark.roles[role], dark.background)).toBeGreaterThanOrEqual(3);
    }
  });
});
