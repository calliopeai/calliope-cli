import { afterEach, it, expect, vi } from 'vitest';
import * as fs from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { privateDirectory, readArtifactBytes } from '../src/orchestration/index.js';

vi.mock('node:fs', async original => ({ ...await original<typeof import('node:fs')>() }));

/** Clone a real Stats instance (keeping its prototype, so isDirectory()/isFile() still work) with mode overridden. */
const withMode = (stat: fs.Stats, mode: number): fs.Stats => {
  const clone = Object.assign(Object.create(Object.getPrototypeOf(stat)), stat) as fs.Stats;
  clone.mode = mode;
  return clone;
};
const stubPlatform = (value: string): (() => void) => {
  const descriptor = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value, configurable: true });
  return () => Object.defineProperty(process, 'platform', descriptor);
};

afterEach(() => vi.restoreAllMocks());

it('accepts a directory Windows reports as group/other-writable, since fs.Stats.mode there only reflects the read-only attribute (#382)', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-privdir-')));
  const restorePlatform = stubPlatform('win32');
  const realLstatSync = fs.lstatSync.bind(fs);
  vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, options?: fs.StatOptions) => {
    const stat = realLstatSync(path, options as undefined);
    return path === dir ? withMode(stat as fs.Stats, 0o40666) : stat;
  }) as typeof fs.lstatSync);
  try {
    expect(() => privateDirectory(dir)).not.toThrow();
  } finally {
    restorePlatform();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('still rejects a group/other-writable directory on POSIX', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-privdir-')));
  const realLstatSync = fs.lstatSync.bind(fs);
  vi.spyOn(fs, 'lstatSync').mockImplementation(((path: fs.PathLike, options?: fs.StatOptions) => {
    const stat = realLstatSync(path, options as undefined);
    return path === dir ? withMode(stat as fs.Stats, 0o40755) : stat;
  }) as typeof fs.lstatSync);
  try {
    expect(() => privateDirectory(dir)).toThrow();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('accepts a private file Windows reports as group/other-readable, since fs.Stats.mode there only reflects the read-only attribute (#382)', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-privfile-')));
  const file = join(dir, 'secret.json');
  fs.writeFileSync(file, JSON.stringify({ ok: true }), { mode: 0o600 });
  const restorePlatform = stubPlatform('win32');
  const realFstatSync = fs.fstatSync.bind(fs);
  vi.spyOn(fs, 'fstatSync').mockImplementation(((fd: number, options?: fs.StatOptions) =>
    withMode(realFstatSync(fd, options as undefined) as fs.Stats, 0o100666)) as typeof fs.fstatSync);
  try {
    expect(() => readArtifactBytes(file, 1024, true)).not.toThrow();
  } finally {
    restorePlatform();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it('still rejects a group/other-readable private file on POSIX', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-privfile-')));
  const file = join(dir, 'secret.json');
  fs.writeFileSync(file, JSON.stringify({ ok: true }), { mode: 0o644 });
  expect(() => readArtifactBytes(file, 1024, true)).toThrow();
  fs.rmSync(dir, { recursive: true, force: true });
});

it('still rejects a non-directory and a symlink on Windows (unrelated checks are unaffected by the platform skip)', () => {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'calliope-privdir-')));
  const file = join(dir, 'notadir'), link = join(dir, 'link'), target = join(dir, 'target');
  fs.writeFileSync(file, '');
  fs.mkdirSync(target);
  fs.symlinkSync(target, link);
  const restorePlatform = stubPlatform('win32');
  try {
    expect(() => privateDirectory(file)).toThrow();
    expect(() => privateDirectory(link)).toThrow();
  } finally {
    restorePlatform();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
