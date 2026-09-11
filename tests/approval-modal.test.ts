import { expect, it, vi } from 'vitest';
import React from 'react';
import { render } from 'ink-testing-library';
import { ToolConfirmation } from '../src/ui/modals/index.js';
import type { PendingApproval } from '../src/approvals/index.js';
const pause = () => new Promise(resolve => setTimeout(resolve, 30));
const pending: PendingApproval = { id: 'one', queued: 2, request: { version: 1, key: 'key', project: '/project', projectKey: 'project', tool: 'write_file', risk: 'medium', reason: 'File write',
  details: ['Path: /project/' + 'long-directory/'.repeat(8) + 'END.txt', 'Content: 10 bytes'], reusable: true } };
it('renders complete scope and provides once/session/project/deny/cancel keyboard choices', async () => {
  const onAnswer = vi.fn(); const ui = render(React.createElement(ToolConfirmation, { pending, onAnswer })); await pause();
  expect(ui.lastFrame()).toContain('END.txt'); expect(ui.lastFrame()).toContain('2 other approval requests');
  for (const [input, choice] of [['y', 'allow'], ['s', 'allow_session'], ['p', 'allow_project'], ['n', 'reject'], ['\x1b', 'cancelled']]) {
    ui.stdin.write(input); await pause(); expect(onAnswer).toHaveBeenLastCalledWith(choice);
  }
  ui.unmount();
});
it('does not accept session/project choices when the operation cannot be narrowed for reuse', async () => {
  const onAnswer = vi.fn(); const ui = render(React.createElement(ToolConfirmation, { pending: { ...pending, request: { ...pending.request, tool: 'shell', risk: 'critical', reusable: false } }, onAnswer }));
  await pause(); ui.stdin.write('p'); ui.stdin.write('s'); await pause(); expect(onAnswer).not.toHaveBeenCalled();
  expect(ui.lastFrame()).toContain('Reusable approval is unavailable'); ui.unmount();
});
