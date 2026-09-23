import * as path from 'node:path';
import { vi } from 'vitest';

/**
 * Makes node:path's relative()/sep behave like Windows (backslash separators),
 * using Node's own path.win32 implementation rather than a hand-rolled stand-in.
 * Reproduces the failure behind calliopeai/calliope-cli#382: code that imports
 * `relative`/`sep` from 'node:path' gets backslash-separated output on Windows,
 * even from POSIX-style absolute paths, so a hardcoded '../' check never
 * matches there (confirmed: path.win32.relative('/a/project', '/a/store/x')
 * returns '..\\store\\x', which does not start with the literal '../').
 *
 * Deliberately narrow: only relative()/sep are redirected. resolve()/dirname()
 * etc. stay real, since path.win32.resolve() on a POSIX absolute path (no
 * drive letter) produces a backslash string that no longer matches anything
 * on the real POSIX test filesystem, breaking any code (e.g. canonicalPath)
 * that walks the real fs with the resolved string. Scope activation tightly
 * around only the assertion under test, since path.sep is a module-global
 * override for the test's whole node:path import (node:path and path share
 * one mock registration) and would otherwise also perturb unrelated
 * same-test code that reads path.sep against real POSIX-resolved strings
 * (for example src/scope.ts's in-scope check).
 *
 * The caller's test file must `vi.mock('node:path', async original => ({
 * ...await original<typeof import('node:path')>() }))` for spyOn to work.
 * Restore with the returned function (or vi.restoreAllMocks() plus resetting
 * path.sep, since restoreAllMocks does not touch defineProperty).
 */
export function simulateWindowsPathSeparators(): () => void {
  const relativeSpy = vi.spyOn(path, 'relative').mockImplementation(path.win32.relative);
  const sepDescriptor = Object.getOwnPropertyDescriptor(path, 'sep')!;
  Object.defineProperty(path, 'sep', { value: path.win32.sep, configurable: true });
  return () => {
    relativeSpy.mockRestore();
    Object.defineProperty(path, 'sep', sepDescriptor);
  };
}
