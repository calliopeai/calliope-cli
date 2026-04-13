import { describe, expect, it } from 'vitest';
import { getSessionResumeAction, shouldInsertInputChunk } from '../src/ui/input-utils.js';

describe('getSessionResumeAction', () => {
  it('resumes only on explicit resume keys', () => {
    expect(getSessionResumeAction('r', {})).toBe('resume');
    expect(getSessionResumeAction('R', {})).toBe('resume');
  });

  it('starts a new session on explicit new-session keys', () => {
    expect(getSessionResumeAction('n', {})).toBe('new');
    expect(getSessionResumeAction('N', {})).toBe('new');
    expect(getSessionResumeAction('', { return: true })).toBe('new');
    expect(getSessionResumeAction('', { escape: true })).toBe('new');
  });

  it('ignores arbitrary typing so the first prompt character is not eaten', () => {
    expect(getSessionResumeAction('h', {})).toBe('ignore');
    expect(getSessionResumeAction('', {})).toBe('ignore');
  });
});

describe('shouldInsertInputChunk', () => {
  it('accepts printable text and multiline paste chunks', () => {
    expect(shouldInsertInputChunk('hello', {})).toBe(true);
    expect(shouldInsertInputChunk('hello\nworld', {})).toBe(true);
  });

  it('rejects raw escape sequences and control characters', () => {
    expect(shouldInsertInputChunk('\x1b[D', {})).toBe(false);
    expect(shouldInsertInputChunk('[99~', {})).toBe(false);
    expect(shouldInsertInputChunk('[1;5D', {})).toBe(false);
    expect(shouldInsertInputChunk('OP', {})).toBe(false);
    expect(shouldInsertInputChunk('oops\u0007', {})).toBe(false);
  });

  it('rejects modified keys handled elsewhere', () => {
    expect(shouldInsertInputChunk('a', { ctrl: true })).toBe(false);
    expect(shouldInsertInputChunk('a', { meta: true })).toBe(false);
    expect(shouldInsertInputChunk('\t', { tab: true })).toBe(false);
  });
});
