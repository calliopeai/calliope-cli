/** The crash screen retains explicit exit keys when Ink does not own Ctrl+C. */
import React, { useEffect } from 'react';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, render } from 'ink-testing-library';
import { ErrorFallback } from '../src/ui/error-boundary.js';

afterEach(cleanup);

it.each(['\x03', '\x1b', 'q'])('exits the crash screen on %j', async key => {
  let mounted = false;
  function Harness() {
    useEffect(() => { mounted = true; return () => { mounted = false; }; }, []);
    return React.createElement(ErrorFallback, { error: new Error('fixture'), errorInfo: '', onRetry: () => {} });
  }
  const screen = render(React.createElement(Harness));
  await vi.waitFor(() => expect(mounted).toBe(true));
  screen.stdin.write(key);
  await vi.waitFor(() => expect(mounted).toBe(false));
});

it('keeps retry available without exiting the crash screen', async () => {
  const retry = vi.fn();
  const screen = render(React.createElement(ErrorFallback, { error: new Error('fixture'), errorInfo: '', onRetry: retry }));
  await vi.waitFor(() => expect(screen.lastFrame()).toContain('fixture'));
  screen.stdin.write('r');
  await vi.waitFor(() => expect(retry).toHaveBeenCalledOnce());
  expect(screen.lastFrame()).toContain('fixture');
});
