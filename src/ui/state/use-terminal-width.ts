/**
 * UI state - terminal width
 *
 * Reactive terminal width; re-renders on resize via SIGWINCH. Terminal-derived,
 * so there is no reset() — a session reset must not change the window size.
 */

import { useState, useEffect } from 'react';
import { useStdout } from 'ink';

export function useTerminalWidth(): number {
  const { stdout } = useStdout();
  const [width, setWidth] = useState(() => stdout?.columns || 80);

  useEffect(() => {
    const onResize = () => {
      const cols = stdout?.columns || process.stdout.columns || 80;
      setWidth(cols);
    };
    process.stdout.on('resize', onResize);
    return () => { process.stdout.off('resize', onResize); };
  }, [stdout]);

  return width;
}
