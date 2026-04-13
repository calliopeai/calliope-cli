export interface InputKeyLike {
  ctrl?: boolean;
  meta?: boolean;
  tab?: boolean;
  return?: boolean;
  escape?: boolean;
}

export type SessionResumeAction = 'resume' | 'new' | 'ignore';

/**
 * Only insert printable text chunks. Ink may surface raw escape/control
 * sequences for unsupported terminal input, which should never end up in
 * the visible prompt.
 */
export function shouldInsertInputChunk(input: string, key: InputKeyLike): boolean {
  if (!input || key.ctrl || key.meta || key.tab) {
    return false;
  }

  if (input.includes('\x1b')) {
    return false;
  }

  // Some terminals surface escape fragments with the leading ESC stripped,
  // e.g. "[A", "[1;5D", or "OP". Treat those as control sequences.
  if (
    (/^\[[0-9;?]*[ -/]*[@-~]$/.test(input) && input.length > 1) ||
    /^O[A-Z]$/.test(input)
  ) {
    return false;
  }

  const withoutAllowedWhitespace = input.replace(/[\r\n\t]/g, '');
  return !/[\x00-\x08\x0B-\x1F\x7F]/.test(withoutAllowedWhitespace);
}

/**
 * The session resume prompt must not consume arbitrary typing, or the first
 * character of the user's message disappears before the chat input is active.
 */
export function getSessionResumeAction(input: string, key: Pick<InputKeyLike, 'return' | 'escape'>): SessionResumeAction {
  if (input === 'r' || input === 'R') {
    return 'resume';
  }

  if (input === 'n' || input === 'N' || key.return || key.escape) {
    return 'new';
  }

  return 'ignore';
}
