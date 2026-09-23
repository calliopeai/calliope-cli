import * as fs from 'node:fs';
import { vi } from 'vitest';

/**
 * Simulates the Windows-only failure behind calliopeai/calliope-cli#384: libuv
 * opens directories with a read-only (FILE_GENERIC_READ) handle for
 * fs.openSync(dir, 'r') (src/win/fs.c fs__open), so a subsequent
 * fs.fsyncSync() on that handle calls FlushFileBuffers, which requires
 * GENERIC_WRITE and fails with EPERM. The identical call succeeds on POSIX.
 *
 * Only directory handles opened with 'r' (or the default flag) are affected;
 * file handles in this codebase are always opened with a write flag before
 * being fsynced, so they are left alone here exactly as they behave on real
 * Windows. process.platform is also stubbed to 'win32' so platform guards in
 * application code (`process.platform !== 'win32'`) take their Windows branch.
 *
 * The caller's test file must `vi.mock('node:fs', async original => ({
 * ...await original<typeof import('node:fs')>() }))` for spyOn to work.
 * Restore with the returned function (or vi.restoreAllMocks() plus resetting
 * process.platform, since restoreAllMocks does not touch defineProperty).
 */
export function simulateWindowsDirectoryFsyncDenial(): () => void {
  const realOpenSync = fs.openSync.bind(fs);
  const realFsyncSync = fs.fsyncSync.bind(fs);
  const realCloseSync = fs.closeSync.bind(fs);
  const readOnlyDirFds = new Set<number>();
  const openSpy = vi.spyOn(fs, 'openSync').mockImplementation((...args: Parameters<typeof fs.openSync>) => {
    const fd = realOpenSync(...args);
    const [target, flags] = args;
    if (typeof target === 'string' && (flags === undefined || flags === 'r')) {
      try { if (fs.lstatSync(target).isDirectory()) readOnlyDirFds.add(fd); } catch { /* not statable; leave unmarked */ }
    }
    return fd;
  });
  const fsyncSpy = vi.spyOn(fs, 'fsyncSync').mockImplementation((fd: number) => {
    if (readOnlyDirFds.has(fd)) {
      const error = new Error('EPERM: operation not permitted, fsync') as NodeJS.ErrnoException;
      error.code = 'EPERM';
      throw error;
    }
    return realFsyncSync(fd);
  });
  // fd numbers are recycled by the OS after close; without this, a later,
  // unrelated file fd could reuse a marked directory fd's number and produce
  // a false-positive denial.
  const closeSpy = vi.spyOn(fs, 'closeSync').mockImplementation((fd: number) => {
    readOnlyDirFds.delete(fd);
    return realCloseSync(fd);
  });
  const platform = Object.getOwnPropertyDescriptor(process, 'platform')!;
  Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
  return () => {
    openSpy.mockRestore(); fsyncSpy.mockRestore(); closeSpy.mockRestore(); readOnlyDirFds.clear();
    Object.defineProperty(process, 'platform', platform);
  };
}
