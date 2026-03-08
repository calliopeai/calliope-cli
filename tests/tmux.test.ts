/**
 * Tests for src/tmux.ts - Tmux Integration
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  isTmux,
  getTmuxSession,
  listTmuxWindows,
  listTmuxPanes,
  sendToPane,
  capturePane,
  splitPane,
  getTmuxInfo,
} from '../src/tmux.js';

vi.mock('child_process', () => ({
  execSync: vi.fn(),
}));

import { execSync } from 'child_process';

const mockedExecSync = vi.mocked(execSync);

describe('tmux', () => {
  const originalEnv = process.env.TMUX;

  beforeEach(() => {
    vi.clearAllMocks();
    delete process.env.TMUX;
  });

  afterEach(() => {
    if (originalEnv !== undefined) {
      process.env.TMUX = originalEnv;
    } else {
      delete process.env.TMUX;
    }
  });

  // ── isTmux ──────────────────────────────────────────────

  describe('isTmux', () => {
    it('returns false when TMUX env is not set', () => {
      delete process.env.TMUX;
      expect(isTmux()).toBe(false);
    });

    it('returns true when TMUX env is set', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      expect(isTmux()).toBe(true);
    });

    it('returns false when TMUX is empty string', () => {
      process.env.TMUX = '';
      expect(isTmux()).toBe(false);
    });
  });

  // ── getTmuxSession ─────────────────────────────────────

  describe('getTmuxSession', () => {
    it('returns null when not in tmux', () => {
      expect(getTmuxSession()).toBeNull();
    });

    it('returns session name when in tmux', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockReturnValue('my-session\n');
      expect(getTmuxSession()).toBe('my-session');
      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux display-message -p "#S"',
        { encoding: 'utf-8' },
      );
    });

    it('returns null when execSync throws', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockImplementation(() => { throw new Error('tmux error'); });
      expect(getTmuxSession()).toBeNull();
    });
  });

  // ── listTmuxWindows ────────────────────────────────────

  describe('listTmuxWindows', () => {
    it('returns empty array when not in tmux', () => {
      expect(listTmuxWindows()).toEqual([]);
    });

    it('parses window list output', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockReturnValue('0:bash:1\n1:vim:0\n2:node:0\n');
      const windows = listTmuxWindows();
      expect(windows).toEqual([
        { index: 0, name: 'bash', active: true },
        { index: 1, name: 'vim', active: false },
        { index: 2, name: 'node', active: false },
      ]);
    });

    it('returns empty array when execSync throws', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockImplementation(() => { throw new Error('fail'); });
      expect(listTmuxWindows()).toEqual([]);
    });

    it('handles single window output', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockReturnValue('0:main:1\n');
      const windows = listTmuxWindows();
      expect(windows).toEqual([{ index: 0, name: 'main', active: true }]);
    });
  });

  // ── listTmuxPanes ──────────────────────────────────────

  describe('listTmuxPanes', () => {
    it('returns empty array when not in tmux', () => {
      expect(listTmuxPanes()).toEqual([]);
    });

    it('parses pane list output', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockReturnValue('0:1:54321:~/project\n1:0:54322:~/other\n');
      const panes = listTmuxPanes();
      expect(panes).toEqual([
        { index: 0, active: true, pid: 54321, title: '~/project' },
        { index: 1, active: false, pid: 54322, title: '~/other' },
      ]);
    });

    it('handles pane title with colons', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockReturnValue('0:1:12345:host:~/path:extra\n');
      const panes = listTmuxPanes();
      expect(panes).toEqual([
        { index: 0, active: true, pid: 12345, title: 'host:~/path:extra' },
      ]);
    });

    it('returns empty array when execSync throws', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockImplementation(() => { throw new Error('fail'); });
      expect(listTmuxPanes()).toEqual([]);
    });
  });

  // ── sendToPane ─────────────────────────────────────────

  describe('sendToPane', () => {
    it('returns false when not in tmux', () => {
      expect(sendToPane(0, 'echo hello')).toBe(false);
    });

    it('sends command to pane and returns true', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockReturnValue('');
      expect(sendToPane(1, 'echo hello')).toBe(true);
      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux send-keys -t 1 "echo hello" Enter',
        { encoding: 'utf-8' },
      );
    });

    it('escapes double quotes in command', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockReturnValue('');
      sendToPane(0, 'echo "hi"');
      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux send-keys -t 0 "echo \\"hi\\"" Enter',
        { encoding: 'utf-8' },
      );
    });

    it('returns false when execSync throws', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockImplementation(() => { throw new Error('fail'); });
      expect(sendToPane(0, 'cmd')).toBe(false);
    });
  });

  // ── capturePane ────────────────────────────────────────

  describe('capturePane', () => {
    it('returns null when not in tmux', () => {
      expect(capturePane(0)).toBeNull();
    });

    it('captures pane output with default lines', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      const output = '$ echo hello\nhello\n$';
      mockedExecSync.mockReturnValue(output);
      expect(capturePane(0)).toBe(output);
      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux capture-pane -t 0 -p -S -50',
        { encoding: 'utf-8' },
      );
    });

    it('captures pane output with custom line count', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockReturnValue('output');
      capturePane(2, 100);
      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux capture-pane -t 2 -p -S -100',
        { encoding: 'utf-8' },
      );
    });

    it('returns null when execSync throws', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockImplementation(() => { throw new Error('fail'); });
      expect(capturePane(0)).toBeNull();
    });
  });

  // ── splitPane ──────────────────────────────────────────

  describe('splitPane', () => {
    it('returns null when not in tmux', () => {
      expect(splitPane()).toBeNull();
    });

    it('splits horizontally by default and returns active pane index', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync
        .mockReturnValueOnce('') // split-window
        .mockReturnValueOnce('0:0:111:title\n1:1:222:title\n'); // list-panes
      expect(splitPane()).toBe(1);
      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux split-window -h',
        { encoding: 'utf-8' },
      );
    });

    it('splits vertically when horizontal=false', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync
        .mockReturnValueOnce('') // split-window
        .mockReturnValueOnce('0:1:111:title\n'); // list-panes
      splitPane(false);
      expect(mockedExecSync).toHaveBeenCalledWith(
        'tmux split-window -v',
        { encoding: 'utf-8' },
      );
    });

    it('returns null when no active pane found', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync
        .mockReturnValueOnce('') // split-window
        .mockReturnValueOnce('0:0:111:title\n'); // list-panes (none active)
      expect(splitPane()).toBeNull();
    });

    it('returns null when execSync throws', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockImplementation(() => { throw new Error('fail'); });
      expect(splitPane()).toBeNull();
    });
  });

  // ── getTmuxInfo ────────────────────────────────────────

  describe('getTmuxInfo', () => {
    it('returns null when not in tmux', () => {
      expect(getTmuxInfo()).toBeNull();
    });

    it('returns session info when in tmux', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync
        .mockReturnValueOnce('dev-session\n') // getTmuxSession
        .mockReturnValueOnce('0:bash:1\n1:vim:0\n') // listTmuxWindows
        .mockReturnValueOnce('0:1:111:title\n1:0:222:title\n'); // listTmuxPanes

      const info = getTmuxInfo();
      expect(info).toEqual({
        session: 'dev-session',
        windows: 2,
        panes: 2,
      });
    });

    it('returns null when getTmuxSession returns null', () => {
      process.env.TMUX = '/tmp/tmux-501/default,12345,0';
      mockedExecSync.mockImplementation(() => { throw new Error('fail'); });
      expect(getTmuxInfo()).toBeNull();
    });
  });
});
