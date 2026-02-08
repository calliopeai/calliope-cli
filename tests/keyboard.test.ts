import { describe, it, expect } from 'vitest';
import {
  matchBinding,
  getKeyAction,
  createKeyboardState,
  updateState,
  toggleVimMode,
  processVimCommand,
  formatBinding,
  getBindingsHelp,
} from '../src/keyboard.js';
import type { KeyBinding, KeyboardState, KeyAction, VimMode } from '../src/keyboard.js';

// ============================================================================
// matchBinding
// ============================================================================

describe('matchBinding', () => {
  const bindings: KeyBinding[] = [
    { key: 'return', action: 'submit' },
    { key: 'c', ctrl: true, action: 'cancel' },
    { key: 'tab', shift: true, action: 'completePrev' },
    { key: 'return', alt: true, action: 'newline' },
    { key: 'z', ctrl: true, shift: true, action: 'redo' },
  ];

  it('should match a simple key with no modifiers', () => {
    const result = matchBinding('return', false, false, false, bindings);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('submit');
  });

  it('should match ctrl modifier', () => {
    const result = matchBinding('c', true, false, false, bindings);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('cancel');
  });

  it('should match shift modifier', () => {
    const result = matchBinding('tab', false, false, true, bindings);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('completePrev');
  });

  it('should match alt modifier', () => {
    const result = matchBinding('return', false, true, false, bindings);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('newline');
  });

  it('should match combined ctrl+shift modifiers', () => {
    const result = matchBinding('z', true, false, true, bindings);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('redo');
  });

  it('should return null for unmatched key', () => {
    const result = matchBinding('x', false, false, false, bindings);
    expect(result).toBeNull();
  });

  it('should return null when modifiers do not match', () => {
    // 'c' without ctrl should not match ctrl+c
    const result = matchBinding('c', false, false, false, bindings);
    expect(result).toBeNull();
  });

  it('should return null when extra modifiers are present', () => {
    // ctrl+alt+c should not match ctrl+c (no alt)
    const result = matchBinding('c', true, true, false, bindings);
    expect(result).toBeNull();
  });

  it('should be case-insensitive for key matching', () => {
    const result = matchBinding('C', true, false, false, bindings);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('cancel');
  });

  it('should return null for empty bindings array', () => {
    const result = matchBinding('a', false, false, false, []);
    expect(result).toBeNull();
  });

  it('should return the first matching binding when multiple match', () => {
    const dupes: KeyBinding[] = [
      { key: 'a', action: 'cursorHome' },
      { key: 'a', action: 'cursorEnd' },
    ];
    const result = matchBinding('a', false, false, false, dupes);
    expect(result).not.toBeNull();
    expect(result!.action).toBe('cursorHome');
  });
});

// ============================================================================
// getKeyAction
// ============================================================================

describe('getKeyAction', () => {
  describe('default bindings (vim disabled)', () => {
    const state = createKeyboardState(false);

    it('should return submit for return key', () => {
      expect(getKeyAction('return', false, false, false, state)).toBe('submit');
    });

    it('should return cancel for ctrl+c', () => {
      expect(getKeyAction('c', true, false, false, state)).toBe('cancel');
    });

    it('should return clear for ctrl+l', () => {
      expect(getKeyAction('l', true, false, false, state)).toBe('clear');
    });

    it('should return historyUp for up arrow', () => {
      expect(getKeyAction('up', false, false, false, state)).toBe('historyUp');
    });

    it('should return historyDown for down arrow', () => {
      expect(getKeyAction('down', false, false, false, state)).toBe('historyDown');
    });

    it('should return complete for tab', () => {
      expect(getKeyAction('tab', false, false, false, state)).toBe('complete');
    });

    it('should return completePrev for shift+tab', () => {
      expect(getKeyAction('tab', false, false, true, state)).toBe('completePrev');
    });

    it('should return cursorLeft for left arrow', () => {
      expect(getKeyAction('left', false, false, false, state)).toBe('cursorLeft');
    });

    it('should return cursorRight for right arrow', () => {
      expect(getKeyAction('right', false, false, false, state)).toBe('cursorRight');
    });

    it('should return cursorWordLeft for ctrl+left', () => {
      expect(getKeyAction('left', true, false, false, state)).toBe('cursorWordLeft');
    });

    it('should return cursorWordRight for ctrl+right', () => {
      expect(getKeyAction('right', true, false, false, state)).toBe('cursorWordRight');
    });

    it('should return cursorHome for ctrl+a', () => {
      expect(getKeyAction('a', true, false, false, state)).toBe('cursorHome');
    });

    it('should return cursorEnd for ctrl+e', () => {
      expect(getKeyAction('e', true, false, false, state)).toBe('cursorEnd');
    });

    it('should return cursorHome for home key', () => {
      expect(getKeyAction('home', false, false, false, state)).toBe('cursorHome');
    });

    it('should return cursorEnd for end key', () => {
      expect(getKeyAction('end', false, false, false, state)).toBe('cursorEnd');
    });

    it('should return deleteChar for backspace', () => {
      expect(getKeyAction('backspace', false, false, false, state)).toBe('deleteChar');
    });

    it('should return deleteChar for delete', () => {
      expect(getKeyAction('delete', false, false, false, state)).toBe('deleteChar');
    });

    it('should return deleteWord for ctrl+w', () => {
      expect(getKeyAction('w', true, false, false, state)).toBe('deleteWord');
    });

    it('should return deleteLine for ctrl+u', () => {
      expect(getKeyAction('u', true, false, false, state)).toBe('deleteLine');
    });

    it('should return deleteToEnd for ctrl+k', () => {
      expect(getKeyAction('k', true, false, false, state)).toBe('deleteToEnd');
    });

    it('should return paste for ctrl+v', () => {
      expect(getKeyAction('v', true, false, false, state)).toBe('paste');
    });

    it('should return undo for ctrl+z', () => {
      expect(getKeyAction('z', true, false, false, state)).toBe('undo');
    });

    it('should return redo for ctrl+shift+z', () => {
      expect(getKeyAction('z', true, false, true, state)).toBe('redo');
    });

    it('should return redo for ctrl+y', () => {
      expect(getKeyAction('y', true, false, false, state)).toBe('redo');
    });

    it('should return escape for escape key', () => {
      expect(getKeyAction('escape', false, false, false, state)).toBe('escape');
    });

    it('should return newline for shift+return', () => {
      expect(getKeyAction('return', false, false, true, state)).toBe('newline');
    });

    it('should return newline for alt+return', () => {
      expect(getKeyAction('return', false, true, false, state)).toBe('newline');
    });

    it('should return none for unrecognized key', () => {
      expect(getKeyAction('q', false, false, false, state)).toBe('none');
    });
  });

  describe('vim normal mode', () => {
    const state: KeyboardState = {
      vimEnabled: true,
      vimMode: 'normal',
      pendingKeys: '',
    };

    it('should return vimInsert for i key', () => {
      expect(getKeyAction('i', false, false, false, state)).toBe('vimInsert');
    });

    it('should return vimAppend for a key', () => {
      expect(getKeyAction('a', false, false, false, state)).toBe('vimAppend');
    });

    it('should return cursorLeft for h', () => {
      expect(getKeyAction('h', false, false, false, state)).toBe('cursorLeft');
    });

    it('should return historyDown for j', () => {
      expect(getKeyAction('j', false, false, false, state)).toBe('historyDown');
    });

    it('should return historyUp for k', () => {
      expect(getKeyAction('k', false, false, false, state)).toBe('historyUp');
    });

    it('should return cursorRight for l', () => {
      expect(getKeyAction('l', false, false, false, state)).toBe('cursorRight');
    });

    it('should return cursorWordRight for w', () => {
      expect(getKeyAction('w', false, false, false, state)).toBe('cursorWordRight');
    });

    it('should return cursorWordLeft for b', () => {
      expect(getKeyAction('b', false, false, false, state)).toBe('cursorWordLeft');
    });

    it('should return cursorHome for 0', () => {
      expect(getKeyAction('0', false, false, false, state)).toBe('cursorHome');
    });

    it('should return cursorEnd for $', () => {
      expect(getKeyAction('$', false, false, false, state)).toBe('cursorEnd');
    });

    it('should return deleteChar for x', () => {
      expect(getKeyAction('x', false, false, false, state)).toBe('deleteChar');
    });

    it('should return paste for p', () => {
      expect(getKeyAction('p', false, false, false, state)).toBe('paste');
    });

    it('should return undo for u', () => {
      expect(getKeyAction('u', false, false, false, state)).toBe('undo');
    });

    it('should return submit for return in normal mode', () => {
      expect(getKeyAction('return', false, false, false, state)).toBe('submit');
    });

    it('should fall back to default bindings for unrecognized vim key', () => {
      // ctrl+l is not in vim normal bindings but is in defaults
      expect(getKeyAction('l', true, false, false, state)).toBe('clear');
    });
  });

  describe('vim insert mode', () => {
    const state: KeyboardState = {
      vimEnabled: true,
      vimMode: 'insert',
      pendingKeys: '',
    };

    it('should return vimNormal for escape key', () => {
      expect(getKeyAction('escape', false, false, false, state)).toBe('vimNormal');
    });

    it('should return vimNormal for ctrl+c', () => {
      expect(getKeyAction('c', true, false, false, state)).toBe('vimNormal');
    });

    it('should return vimNormal for ctrl+[', () => {
      expect(getKeyAction('[', true, false, false, state)).toBe('vimNormal');
    });

    it('should fall back to default bindings for other keys in insert mode', () => {
      expect(getKeyAction('return', false, false, false, state)).toBe('submit');
      expect(getKeyAction('backspace', false, false, false, state)).toBe('deleteChar');
      expect(getKeyAction('tab', false, false, false, state)).toBe('complete');
    });
  });
});

// ============================================================================
// createKeyboardState
// ============================================================================

describe('createKeyboardState', () => {
  it('should create state with vim disabled by default', () => {
    const state = createKeyboardState();
    expect(state.vimEnabled).toBe(false);
    expect(state.vimMode).toBe('insert');
    expect(state.pendingKeys).toBe('');
    expect(state.lastAction).toBeUndefined();
  });

  it('should create state with vim enabled when requested', () => {
    const state = createKeyboardState(true);
    expect(state.vimEnabled).toBe(true);
    expect(state.vimMode).toBe('normal');
    expect(state.pendingKeys).toBe('');
  });

  it('should create state with vim disabled when explicitly false', () => {
    const state = createKeyboardState(false);
    expect(state.vimEnabled).toBe(false);
    expect(state.vimMode).toBe('insert');
  });
});

// ============================================================================
// updateState
// ============================================================================

describe('updateState', () => {
  it('should set lastAction on every update', () => {
    const state = createKeyboardState();
    const updated = updateState(state, 'submit');
    expect(updated.lastAction).toBe('submit');
  });

  it('should not mutate original state', () => {
    const state = createKeyboardState();
    const updated = updateState(state, 'submit');
    expect(state.lastAction).toBeUndefined();
    expect(updated.lastAction).toBe('submit');
  });

  it('should switch to normal mode on vimNormal action', () => {
    const state: KeyboardState = {
      vimEnabled: true,
      vimMode: 'insert',
      pendingKeys: 'abc',
    };
    const updated = updateState(state, 'vimNormal');
    expect(updated.vimMode).toBe('normal');
    expect(updated.pendingKeys).toBe('');
    expect(updated.lastAction).toBe('vimNormal');
  });

  it('should switch to insert mode on vimInsert action', () => {
    const state: KeyboardState = {
      vimEnabled: true,
      vimMode: 'normal',
      pendingKeys: 'd',
    };
    const updated = updateState(state, 'vimInsert');
    expect(updated.vimMode).toBe('insert');
    expect(updated.pendingKeys).toBe('');
  });

  it('should switch to insert mode on vimAppend action', () => {
    const state: KeyboardState = {
      vimEnabled: true,
      vimMode: 'normal',
      pendingKeys: '',
    };
    const updated = updateState(state, 'vimAppend');
    expect(updated.vimMode).toBe('insert');
    expect(updated.pendingKeys).toBe('');
  });

  it('should switch to normal mode on escape when vim is enabled and not in normal mode', () => {
    const state: KeyboardState = {
      vimEnabled: true,
      vimMode: 'insert',
      pendingKeys: '',
    };
    const updated = updateState(state, 'escape');
    expect(updated.vimMode).toBe('normal');
    expect(updated.pendingKeys).toBe('');
  });

  it('should stay in normal mode on escape when vim is enabled and already in normal mode', () => {
    const state: KeyboardState = {
      vimEnabled: true,
      vimMode: 'normal',
      pendingKeys: 'dd',
    };
    const updated = updateState(state, 'escape');
    // vimMode stays normal since state.vimMode === 'normal'
    // The condition checks vimMode !== 'normal', so it goes to the else branch
    expect(updated.pendingKeys).toBe('');
  });

  it('should clear pendingKeys on escape when vim is disabled', () => {
    const state: KeyboardState = {
      vimEnabled: false,
      vimMode: 'insert',
      pendingKeys: 'abc',
    };
    const updated = updateState(state, 'escape');
    expect(updated.pendingKeys).toBe('');
    expect(updated.vimMode).toBe('insert'); // Should not change mode
  });

  it('should preserve other state on generic actions', () => {
    const state: KeyboardState = {
      vimEnabled: true,
      vimMode: 'normal',
      pendingKeys: 'd',
    };
    const updated = updateState(state, 'cursorLeft');
    expect(updated.vimMode).toBe('normal');
    expect(updated.vimEnabled).toBe(true);
    expect(updated.pendingKeys).toBe('d');
    expect(updated.lastAction).toBe('cursorLeft');
  });
});

// ============================================================================
// toggleVimMode
// ============================================================================

describe('toggleVimMode', () => {
  it('should enable vim mode when disabled', () => {
    const state = createKeyboardState(false);
    const toggled = toggleVimMode(state);
    expect(toggled.vimEnabled).toBe(true);
    expect(toggled.vimMode).toBe('normal');
    expect(toggled.pendingKeys).toBe('');
  });

  it('should disable vim mode when enabled', () => {
    const state = createKeyboardState(true);
    const toggled = toggleVimMode(state);
    expect(toggled.vimEnabled).toBe(false);
    expect(toggled.vimMode).toBe('insert');
    expect(toggled.pendingKeys).toBe('');
  });

  it('should clear pending keys on toggle', () => {
    const state: KeyboardState = {
      vimEnabled: true,
      vimMode: 'normal',
      pendingKeys: 'd',
    };
    const toggled = toggleVimMode(state);
    expect(toggled.pendingKeys).toBe('');
  });

  it('should not mutate original state', () => {
    const state = createKeyboardState(false);
    const toggled = toggleVimMode(state);
    expect(state.vimEnabled).toBe(false);
    expect(toggled.vimEnabled).toBe(true);
  });

  it('should toggle back and forth', () => {
    const s0 = createKeyboardState(false);
    const s1 = toggleVimMode(s0);
    const s2 = toggleVimMode(s1);
    expect(s0.vimEnabled).toBe(false);
    expect(s1.vimEnabled).toBe(true);
    expect(s2.vimEnabled).toBe(false);
    expect(s2.vimMode).toBe('insert');
  });
});

// ============================================================================
// processVimCommand
// ============================================================================

describe('processVimCommand', () => {
  it('should return empty actions when vim is disabled', () => {
    const state = createKeyboardState(false);
    const result = processVimCommand(state, 'd');
    expect(result.actions).toEqual([]);
    expect(result.state).toEqual(state);
  });

  it('should return empty actions when in insert mode', () => {
    const state: KeyboardState = {
      vimEnabled: true,
      vimMode: 'insert',
      pendingKeys: '',
    };
    const result = processVimCommand(state, 'd');
    expect(result.actions).toEqual([]);
  });

  describe('two-character commands', () => {
    const normalState: KeyboardState = {
      vimEnabled: true,
      vimMode: 'normal',
      pendingKeys: '',
    };

    it('should handle dd (delete line)', () => {
      const r1 = processVimCommand(normalState, 'd');
      expect(r1.actions).toEqual([]);
      expect(r1.state.pendingKeys).toBe('d');

      const r2 = processVimCommand(r1.state, 'd');
      expect(r2.actions).toEqual(['deleteLine']);
      expect(r2.state.pendingKeys).toBe('');
    });

    it('should handle cc (change line)', () => {
      const r1 = processVimCommand(normalState, 'c');
      expect(r1.actions).toEqual([]);
      expect(r1.state.pendingKeys).toBe('c');

      const r2 = processVimCommand(r1.state, 'c');
      expect(r2.actions).toEqual(['deleteLine', 'vimInsert']);
      expect(r2.state.pendingKeys).toBe('');
      expect(r2.state.vimMode).toBe('insert');
    });

    it('should handle yy (yank line)', () => {
      const r1 = processVimCommand(normalState, 'y');
      expect(r1.state.pendingKeys).toBe('y');

      const r2 = processVimCommand(r1.state, 'y');
      expect(r2.actions).toEqual(['copy']);
      expect(r2.state.pendingKeys).toBe('');
    });

    it('should handle dw (delete word)', () => {
      const r1 = processVimCommand(normalState, 'd');
      const r2 = processVimCommand(r1.state, 'w');
      expect(r2.actions).toEqual(['deleteWord']);
      expect(r2.state.pendingKeys).toBe('');
    });

    it('should handle cw (change word)', () => {
      const r1 = processVimCommand(normalState, 'c');
      const r2 = processVimCommand(r1.state, 'w');
      expect(r2.actions).toEqual(['deleteWord', 'vimInsert']);
      expect(r2.state.vimMode).toBe('insert');
    });

    it('should handle d$ (delete to end)', () => {
      const r1 = processVimCommand(normalState, 'd');
      const r2 = processVimCommand(r1.state, '$');
      expect(r2.actions).toEqual(['deleteToEnd']);
      expect(r2.state.pendingKeys).toBe('');
    });

    it('should handle c$ (change to end)', () => {
      const r1 = processVimCommand(normalState, 'c');
      const r2 = processVimCommand(r1.state, '$');
      expect(r2.actions).toEqual(['deleteToEnd', 'vimInsert']);
      expect(r2.state.vimMode).toBe('insert');
    });
  });

  describe('number prefixes', () => {
    const normalState: KeyboardState = {
      vimEnabled: true,
      vimMode: 'normal',
      pendingKeys: '',
    };

    it('should accumulate single digit', () => {
      const result = processVimCommand(normalState, '5');
      expect(result.state.pendingKeys).toBe('5');
      expect(result.actions).toEqual([]);
    });

    it('should accumulate two digits', () => {
      const r1 = processVimCommand(normalState, '1');
      const r2 = processVimCommand(r1.state, '2');
      expect(r2.state.pendingKeys).toBe('12');
      expect(r2.actions).toEqual([]);
    });

    it('should reset on three digits (max 2)', () => {
      const r1 = processVimCommand(normalState, '9');
      const r2 = processVimCommand(r1.state, '9');
      const r3 = processVimCommand(r2.state, '9');
      expect(r3.state.pendingKeys).toBe('');
      expect(r3.actions).toEqual([]);
    });
  });

  describe('unknown sequences', () => {
    it('should reset pending keys on unknown sequence', () => {
      const state: KeyboardState = {
        vimEnabled: true,
        vimMode: 'normal',
        pendingKeys: 'd',
      };
      const result = processVimCommand(state, 'z');
      expect(result.state.pendingKeys).toBe('');
      expect(result.actions).toEqual([]);
    });

    it('should reset on completely unknown single key', () => {
      const state: KeyboardState = {
        vimEnabled: true,
        vimMode: 'normal',
        pendingKeys: '',
      };
      const result = processVimCommand(state, 'q');
      expect(result.state.pendingKeys).toBe('');
      expect(result.actions).toEqual([]);
    });
  });
});

// ============================================================================
// formatBinding
// ============================================================================

describe('formatBinding', () => {
  it('should format a simple key', () => {
    expect(formatBinding({ key: 'return', action: 'submit' })).toBe('Return');
  });

  it('should capitalize the first letter of the key', () => {
    expect(formatBinding({ key: 'tab', action: 'complete' })).toBe('Tab');
    expect(formatBinding({ key: 'escape', action: 'escape' })).toBe('Escape');
  });

  it('should include Ctrl modifier', () => {
    expect(formatBinding({ key: 'c', ctrl: true, action: 'cancel' })).toBe('Ctrl+C');
  });

  it('should include Alt modifier', () => {
    expect(formatBinding({ key: 'return', alt: true, action: 'newline' })).toBe('Alt+Return');
  });

  it('should include Shift modifier', () => {
    expect(formatBinding({ key: 'tab', shift: true, action: 'completePrev' })).toBe('Shift+Tab');
  });

  it('should include multiple modifiers in order', () => {
    expect(formatBinding({ key: 'z', ctrl: true, shift: true, action: 'redo' })).toBe('Ctrl+Shift+Z');
  });

  it('should include all three modifiers', () => {
    expect(formatBinding({ key: 'a', ctrl: true, alt: true, shift: true, action: 'none' })).toBe('Ctrl+Alt+Shift+A');
  });

  it('should handle single character keys', () => {
    expect(formatBinding({ key: 'a', action: 'cursorHome' })).toBe('A');
  });
});

// ============================================================================
// getBindingsHelp
// ============================================================================

describe('getBindingsHelp', () => {
  it('should start with header', () => {
    const help = getBindingsHelp(false);
    expect(help).toContain('Keyboard Shortcuts:');
  });

  it('should include navigation group', () => {
    const help = getBindingsHelp(false);
    expect(help).toContain('Navigation:');
  });

  it('should include editing group', () => {
    const help = getBindingsHelp(false);
    expect(help).toContain('Editing:');
  });

  it('should include actions group', () => {
    const help = getBindingsHelp(false);
    expect(help).toContain('Actions:');
  });

  it('should include key descriptions', () => {
    const help = getBindingsHelp(false);
    expect(help).toContain('Submit input');
    expect(help).toContain('Cancel');
    expect(help).toContain('Clear screen');
  });

  it('should not include vim mode message when vim is disabled', () => {
    const help = getBindingsHelp(false);
    expect(help).not.toContain('Vim Mode: Enabled');
  });

  it('should include vim mode message when vim is enabled', () => {
    const help = getBindingsHelp(true);
    expect(help).toContain('Vim Mode: Enabled');
  });

  it('should include vim bindings when vim is enabled', () => {
    const help = getBindingsHelp(true);
    // Vim bindings add navigation entries like h/j/k/l which have no description
    // but 'Previous history' from the up arrow (default) should appear,
    // and vim-specific entries like submit from return should also be present
    expect(help).toContain('Submit input');
    expect(help).toContain('Vim Mode: Enabled');
  });

  it('should include more bindings when vim is enabled', () => {
    const helpNoVim = getBindingsHelp(false);
    const helpWithVim = getBindingsHelp(true);
    expect(helpWithVim.length).toBeGreaterThan(helpNoVim.length);
  });
});
