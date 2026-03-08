/**
 * Calliope CLI - Tmux Integration
 *
 * Detect tmux sessions, list windows/panes, and execute commands in panes.
 */

import { execSync } from 'child_process';

/** Check if running inside tmux */
export function isTmux(): boolean {
  return !!process.env.TMUX;
}

/** Get current tmux session name */
export function getTmuxSession(): string | null {
  if (!isTmux()) return null;
  try {
    return execSync('tmux display-message -p "#S"', { encoding: 'utf-8' }).trim();
  } catch { return null; }
}

/** List tmux windows in current session */
export function listTmuxWindows(): Array<{ index: number; name: string; active: boolean }> {
  if (!isTmux()) return [];
  try {
    const output = execSync('tmux list-windows -F "#{window_index}:#{window_name}:#{window_active}"', { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean).map(line => {
      const [index, name, active] = line.split(':');
      return { index: parseInt(index, 10), name, active: active === '1' };
    });
  } catch { return []; }
}

/** List tmux panes in current window */
export function listTmuxPanes(): Array<{ index: number; active: boolean; pid: number; title: string }> {
  if (!isTmux()) return [];
  try {
    const output = execSync('tmux list-panes -F "#{pane_index}:#{pane_active}:#{pane_pid}:#{pane_title}"', { encoding: 'utf-8' });
    return output.trim().split('\n').filter(Boolean).map(line => {
      const [index, active, pid, ...titleParts] = line.split(':');
      return { index: parseInt(index, 10), active: active === '1', pid: parseInt(pid, 10), title: titleParts.join(':') };
    });
  } catch { return []; }
}

/** Send keys to a specific pane */
export function sendToPane(paneIndex: number, command: string): boolean {
  if (!isTmux()) return false;
  try {
    // Escape any special characters for tmux send-keys
    const escaped = command.replace(/"/g, '\\"');
    execSync(`tmux send-keys -t ${paneIndex} "${escaped}" Enter`, { encoding: 'utf-8' });
    return true;
  } catch { return false; }
}

/** Capture pane output */
export function capturePane(paneIndex: number, lines = 50): string | null {
  if (!isTmux()) return null;
  try {
    return execSync(`tmux capture-pane -t ${paneIndex} -p -S -${lines}`, { encoding: 'utf-8' });
  } catch { return null; }
}

/** Create a new tmux pane (split) */
export function splitPane(horizontal = true): number | null {
  if (!isTmux()) return null;
  try {
    const flag = horizontal ? '-h' : '-v';
    execSync(`tmux split-window ${flag}`, { encoding: 'utf-8' });
    // Return the new pane index
    const panes = listTmuxPanes();
    const active = panes.find(p => p.active);
    return active?.index ?? null;
  } catch { return null; }
}

/** Get tmux info summary for status display */
export function getTmuxInfo(): { session: string; windows: number; panes: number } | null {
  if (!isTmux()) return null;
  const session = getTmuxSession();
  if (!session) return null;
  return {
    session,
    windows: listTmuxWindows().length,
    panes: listTmuxPanes().length,
  };
}
