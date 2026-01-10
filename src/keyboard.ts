/**
 * Calliope CLI - Keyboard Shortcuts
 *
 * Vim-like keybindings and keyboard shortcuts.
 */

// ============================================================================
// Types
// ============================================================================

export type KeyAction =
  | 'submit'
  | 'cancel'
  | 'clear'
  | 'historyUp'
  | 'historyDown'
  | 'complete'
  | 'completeNext'
  | 'completePrev'
  | 'cursorLeft'
  | 'cursorRight'
  | 'cursorWordLeft'
  | 'cursorWordRight'
  | 'cursorHome'
  | 'cursorEnd'
  | 'deleteChar'
  | 'deleteWord'
  | 'deleteLine'
  | 'deleteToEnd'
  | 'paste'
  | 'copy'
  | 'undo'
  | 'redo'
  | 'newline'
  | 'escape'
  | 'toggleVimMode'
  | 'vimNormal'
  | 'vimInsert'
  | 'vimAppend'
  | 'vimDelete'
  | 'vimChange'
  | 'vimYank'
  | 'none';

export interface KeyBinding {
  key: string;
  ctrl?: boolean;
  alt?: boolean;
  shift?: boolean;
  action: KeyAction;
  description?: string;
}

export type VimMode = 'normal' | 'insert' | 'visual';

export interface KeyboardState {
  vimMode: VimMode;
  vimEnabled: boolean;
  pendingKeys: string;  // For multi-key commands like 'dd'
  lastAction?: KeyAction;
}

// ============================================================================
// Default Keybindings
// ============================================================================

const DEFAULT_BINDINGS: KeyBinding[] = [
  // Standard bindings
  { key: 'return', action: 'submit', description: 'Submit input' },
  { key: 'c', ctrl: true, action: 'cancel', description: 'Cancel' },
  { key: 'l', ctrl: true, action: 'clear', description: 'Clear screen' },
  { key: 'up', action: 'historyUp', description: 'Previous history' },
  { key: 'down', action: 'historyDown', description: 'Next history' },
  { key: 'tab', action: 'complete', description: 'Tab completion' },
  { key: 'tab', shift: true, action: 'completePrev', description: 'Previous completion' },

  // Cursor movement
  { key: 'left', action: 'cursorLeft' },
  { key: 'right', action: 'cursorRight' },
  { key: 'left', ctrl: true, action: 'cursorWordLeft' },
  { key: 'right', ctrl: true, action: 'cursorWordRight' },
  { key: 'a', ctrl: true, action: 'cursorHome' },
  { key: 'e', ctrl: true, action: 'cursorEnd' },
  { key: 'home', action: 'cursorHome' },
  { key: 'end', action: 'cursorEnd' },

  // Editing
  { key: 'backspace', action: 'deleteChar' },
  { key: 'delete', action: 'deleteChar' },
  { key: 'w', ctrl: true, action: 'deleteWord' },
  { key: 'u', ctrl: true, action: 'deleteLine' },
  { key: 'k', ctrl: true, action: 'deleteToEnd' },

  // Clipboard
  { key: 'v', ctrl: true, action: 'paste' },
  { key: 'c', ctrl: true, shift: true, action: 'copy' },

  // Undo/Redo
  { key: 'z', ctrl: true, action: 'undo' },
  { key: 'z', ctrl: true, shift: true, action: 'redo' },
  { key: 'y', ctrl: true, action: 'redo' },

  // Escape
  { key: 'escape', action: 'escape' },

  // Multi-line
  { key: 'return', shift: true, action: 'newline' },
  { key: 'return', alt: true, action: 'newline' },
];

// ============================================================================
// Vim Keybindings
// ============================================================================

const VIM_NORMAL_BINDINGS: KeyBinding[] = [
  // Mode switching
  { key: 'i', action: 'vimInsert', description: 'Insert mode' },
  { key: 'a', action: 'vimAppend', description: 'Append mode' },
  { key: 'A', action: 'vimAppend', description: 'Append at end' },
  { key: 'I', action: 'vimInsert', description: 'Insert at start' },

  // Movement
  { key: 'h', action: 'cursorLeft' },
  { key: 'j', action: 'historyDown' },
  { key: 'k', action: 'historyUp' },
  { key: 'l', action: 'cursorRight' },
  { key: 'w', action: 'cursorWordRight' },
  { key: 'b', action: 'cursorWordLeft' },
  { key: '0', action: 'cursorHome' },
  { key: '$', action: 'cursorEnd' },
  { key: '^', action: 'cursorHome' },

  // Editing
  { key: 'x', action: 'deleteChar' },
  { key: 'd', action: 'vimDelete' },  // Starts delete command
  { key: 'c', action: 'vimChange' },  // Starts change command
  { key: 'y', action: 'vimYank' },    // Starts yank command
  { key: 'p', action: 'paste' },
  { key: 'u', action: 'undo' },
  { key: 'r', ctrl: true, action: 'redo' },

  // Submit
  { key: 'return', action: 'submit' },
];

const VIM_INSERT_BINDINGS: KeyBinding[] = [
  { key: 'escape', action: 'vimNormal' },
  { key: 'c', ctrl: true, action: 'vimNormal' },  // Also exit with Ctrl+C
  { key: '[', ctrl: true, action: 'vimNormal' },  // Also exit with Ctrl+[
];

// ============================================================================
// Key Matching
// ============================================================================

/**
 * Check if key event matches a binding
 */
export function matchBinding(
  key: string,
  ctrl: boolean,
  alt: boolean,
  shift: boolean,
  bindings: KeyBinding[]
): KeyBinding | null {
  for (const binding of bindings) {
    if (binding.key.toLowerCase() === key.toLowerCase() &&
        (binding.ctrl || false) === ctrl &&
        (binding.alt || false) === alt &&
        (binding.shift || false) === shift) {
      return binding;
    }
  }
  return null;
}

/**
 * Get action for key event
 */
export function getKeyAction(
  key: string,
  ctrl: boolean,
  alt: boolean,
  shift: boolean,
  state: KeyboardState
): KeyAction {
  // Check vim bindings first if enabled
  if (state.vimEnabled) {
    if (state.vimMode === 'normal') {
      const vimBinding = matchBinding(key, ctrl, alt, shift, VIM_NORMAL_BINDINGS);
      if (vimBinding) return vimBinding.action;
    } else if (state.vimMode === 'insert') {
      const insertBinding = matchBinding(key, ctrl, alt, shift, VIM_INSERT_BINDINGS);
      if (insertBinding) return insertBinding.action;
    }
  }

  // Check default bindings
  const binding = matchBinding(key, ctrl, alt, shift, DEFAULT_BINDINGS);
  if (binding) return binding.action;

  return 'none';
}

// ============================================================================
// Keyboard State Management
// ============================================================================

/**
 * Create initial keyboard state
 */
export function createKeyboardState(vimEnabled = false): KeyboardState {
  return {
    vimMode: vimEnabled ? 'normal' : 'insert',
    vimEnabled,
    pendingKeys: '',
  };
}

/**
 * Update state after action
 */
export function updateState(state: KeyboardState, action: KeyAction): KeyboardState {
  const newState = { ...state, lastAction: action };

  switch (action) {
    case 'vimNormal':
      return { ...newState, vimMode: 'normal', pendingKeys: '' };
    case 'vimInsert':
    case 'vimAppend':
      return { ...newState, vimMode: 'insert', pendingKeys: '' };
    case 'escape':
      if (state.vimEnabled && state.vimMode !== 'normal') {
        return { ...newState, vimMode: 'normal', pendingKeys: '' };
      }
      return { ...newState, pendingKeys: '' };
    default:
      return newState;
  }
}

/**
 * Toggle vim mode
 */
export function toggleVimMode(state: KeyboardState): KeyboardState {
  return {
    ...state,
    vimEnabled: !state.vimEnabled,
    vimMode: !state.vimEnabled ? 'normal' : 'insert',
    pendingKeys: '',
  };
}

// ============================================================================
// Vim Command Processing
// ============================================================================

/**
 * Process vim command key sequence
 */
export function processVimCommand(
  state: KeyboardState,
  key: string
): { state: KeyboardState; actions: KeyAction[] } {
  if (!state.vimEnabled || state.vimMode !== 'normal') {
    return { state, actions: [] };
  }

  const pending = state.pendingKeys + key;
  const actions: KeyAction[] = [];

  // Two-character commands
  if (pending === 'dd') {
    actions.push('deleteLine');
    return { state: { ...state, pendingKeys: '' }, actions };
  }
  if (pending === 'cc') {
    actions.push('deleteLine', 'vimInsert');
    return { state: { ...state, pendingKeys: '', vimMode: 'insert' }, actions };
  }
  if (pending === 'yy') {
    actions.push('copy');
    return { state: { ...state, pendingKeys: '' }, actions };
  }
  if (pending === 'dw') {
    actions.push('deleteWord');
    return { state: { ...state, pendingKeys: '' }, actions };
  }
  if (pending === 'cw') {
    actions.push('deleteWord', 'vimInsert');
    return { state: { ...state, pendingKeys: '', vimMode: 'insert' }, actions };
  }
  if (pending === 'd$') {
    actions.push('deleteToEnd');
    return { state: { ...state, pendingKeys: '' }, actions };
  }
  if (pending === 'c$') {
    actions.push('deleteToEnd', 'vimInsert');
    return { state: { ...state, pendingKeys: '', vimMode: 'insert' }, actions };
  }

  // Pending commands (d, c, y)
  if (pending === 'd' || pending === 'c' || pending === 'y') {
    return { state: { ...state, pendingKeys: pending }, actions: [] };
  }

  // Number prefix (for repeat counts) - simplified
  if (/^\d+$/.test(pending) && pending.length < 3) {
    return { state: { ...state, pendingKeys: pending }, actions: [] };
  }

  // Unknown sequence, reset
  return { state: { ...state, pendingKeys: '' }, actions: [] };
}

// ============================================================================
// Keybinding Display
// ============================================================================

/**
 * Format keybinding for display
 */
export function formatBinding(binding: KeyBinding): string {
  const parts: string[] = [];
  if (binding.ctrl) parts.push('Ctrl');
  if (binding.alt) parts.push('Alt');
  if (binding.shift) parts.push('Shift');
  parts.push(binding.key.charAt(0).toUpperCase() + binding.key.slice(1));
  return parts.join('+');
}

/**
 * Get all keybindings for display
 */
export function getBindingsHelp(vimEnabled: boolean): string {
  const lines: string[] = ['Keyboard Shortcuts:', ''];

  const bindings = vimEnabled
    ? [...DEFAULT_BINDINGS, ...VIM_NORMAL_BINDINGS]
    : DEFAULT_BINDINGS;

  const groups: Record<string, KeyBinding[]> = {
    'Navigation': bindings.filter(b =>
      ['historyUp', 'historyDown', 'cursorLeft', 'cursorRight',
       'cursorWordLeft', 'cursorWordRight', 'cursorHome', 'cursorEnd'].includes(b.action)
    ),
    'Editing': bindings.filter(b =>
      ['deleteChar', 'deleteWord', 'deleteLine', 'deleteToEnd',
       'paste', 'copy', 'undo', 'redo'].includes(b.action)
    ),
    'Actions': bindings.filter(b =>
      ['submit', 'cancel', 'clear', 'complete', 'escape'].includes(b.action)
    ),
  };

  for (const [group, groupBindings] of Object.entries(groups)) {
    if (groupBindings.length === 0) continue;
    lines.push(`${group}:`);
    for (const binding of groupBindings) {
      if (binding.description) {
        lines.push(`  ${formatBinding(binding).padEnd(15)} ${binding.description}`);
      }
    }
    lines.push('');
  }

  if (vimEnabled) {
    lines.push('Vim Mode: Enabled (press i for insert, Esc for normal)');
  }

  return lines.join('\n');
}
