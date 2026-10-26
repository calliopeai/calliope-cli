/**
 * UI state - terminal width
 *
 * Reactive terminal width; re-renders on resize via SIGWINCH. Terminal-derived,
 * so there is no reset() — a session reset must not change the window size.
 */

import { useWindowSize } from 'ink';

export function useTerminalWidth(): number {
  return useWindowSize().columns;
}
