import type { ChildProcess } from 'node:child_process';

/** Children using this helper are spawned in their own process group on POSIX. */
export const detachedProcess = process.platform !== 'win32';

/** Await this at process completion so early parent exit cannot strand children. */
export function bindProcessCancellation(
  child: ChildProcess, signal?: AbortSignal, onCancel?: () => void,
): Promise<void> {
  if (!signal) return Promise.resolve();
  return new Promise(resolve => {
    let cancelling = false;
    const kill = (kind: NodeJS.Signals) => {
      try {
        if (detachedProcess && child.pid) process.kill(-child.pid, kind);
        else child.kill(kind);
      } catch { /* The process/group may have already exited. */ }
    };
    const abort = () => {
      cancelling = true;
      onCancel?.();
      kill('SIGTERM');
      // Keep ownership through escalation even if the parent exits first.
      // Descendants can ignore TERM and close stdio before they stop.
      setTimeout(() => { kill('SIGKILL'); resolve(); }, 250);
    };
    const finish = () => {
      signal.removeEventListener('abort', abort);
      if (!cancelling) resolve();
    };
    child.on('close', finish);
    child.on('error', finish);
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
  });
}
