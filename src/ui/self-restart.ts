/**
 * UI Module - Self-restart
 *
 * After an in-place upgrade the CLI re-launches itself. The upgrade handler
 * records the desired argv; startInkCLI spawns it after Ink exits.
 */

let pendingRestartArgs: string[] | null = null;

export function requestSelfRestart(args: string[] = process.argv.slice(1)): void {
  pendingRestartArgs = [...args];
}

export async function spawnPendingRestart(): Promise<void> {
  if (!pendingRestartArgs) {
    return;
  }

  const restartArgs = pendingRestartArgs;
  pendingRestartArgs = null;
  const { spawn } = await import('child_process');
  const child = spawn(process.argv[0]!, restartArgs, {
    stdio: 'inherit',
    detached: true,
  });
  child.unref();
}
