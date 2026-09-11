import { expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ToolOutputViewer } from '../src/ui/modals/index.js';
import { makeToolOutput } from '../src/sessions/index.js';
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
it('pages through complete retained text and allows expand/collapse without changing the record', async () => {
  const record = makeToolOutput('call', 'read_file', Array.from({ length: 45 }, (_, i) => `Line ${i + 1}`).join('\n'), false);
  const onClose = vi.fn(), ui = render(React.createElement(ToolOutputViewer, { output: { record, saved: true }, onClose }));
  await pause(); expect(ui.lastFrame()).toContain('Page 1/3'); expect(ui.lastFrame()).not.toContain('Line 45');
  ui.stdin.write('n'); await pause(); ui.stdin.write('n'); await pause(); expect(ui.lastFrame()).toContain('Line 45');
  ui.stdin.write('e'); await pause(); expect(ui.lastFrame()).toContain('Collapsed'); expect(ui.lastFrame()).not.toContain('Line 45');
  ui.stdin.write('e'); await pause(); expect(ui.lastFrame()).toContain('Line 45');
  ui.stdin.write('\x1b'); await pause(); expect(onClose).toHaveBeenCalledOnce(); expect(record.content).toContain('Line 45'); ui.unmount();
});
it('labels truncated/thinking output and escapes imported terminal controls', async () => {
  const record = { ...makeToolOutput('call', 'think', 'retained', false), content: '\x1b[2J TOKEN="opaque credential"', truncated: true };
  const ui = render(React.createElement(ToolOutputViewer, { output: { record, saved: false }, onClose: vi.fn() })); await pause();
  expect(ui.lastFrame()).toContain('Thinking tool'); expect(ui.lastFrame()).toContain('truncated'); expect(ui.lastFrame()).toContain('saving failed');
  expect(ui.lastFrame()).not.toContain('opaque credential'); expect(ui.lastFrame()).toContain('\\u001b'); ui.unmount();
});
it('reflows pages on resize while preserving graphemes and releases its resize listener', async () => {
  const record = makeToolOutput('call', 'read_file', '漢字👩🏽‍💻e\u0301'.repeat(30), false);
  const ui = render(React.createElement(ToolOutputViewer, { output: { record, saved: true }, onClose: vi.fn() }));
  await pause(); expect(ui.lastFrame()).toContain('Page 1/1'); const listeners = ui.stdout.listenerCount('resize');
  Object.defineProperty(ui.stdout, 'columns', { value: 28, configurable: true });
  Object.defineProperty(ui.stdout, 'rows', { value: 13, configurable: true }); ui.stdout.emit('resize');
  await pause(); expect(ui.lastFrame()).toContain('Page 1/3'); expect(ui.lastFrame()).toContain('👩🏽‍💻');
  ui.stdin.write('n'); await pause(); expect(ui.lastFrame()).toContain('Page 2/3');
  ui.unmount(); expect(ui.stdout.listenerCount('resize')).toBeLessThan(listeners);
});
