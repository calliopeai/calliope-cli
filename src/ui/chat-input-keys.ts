/**
 * UI Module - Chat Input Key Handling
 *
 * The full keyboard-handling logic for ChatInput, extracted verbatim from the
 * component's useInput callback so chat-input.tsx stays a focused component
 * file. Operates on a context bag of refs, props, and paint helpers — behavior
 * is identical to the inline handler it replaced.
 */

import type { Key } from 'ink';
import type { Mode } from '../types.js';
import { SLASH_COMMANDS, PATH_COMMANDS, getPathCompletions, getSmartCommandSuggestions } from './completions.js';
import { shouldInsertInputChunk } from './input-utils.js';

export interface ChatInputKeyCtx {
  valueRef: React.MutableRefObject<string>;
  cursorRef: React.MutableRefObject<number>;
  lastCtrlCRef: React.MutableRefObject<number>;
  /** Update value ref, paint, and notify parent. */
  updateValue: (newValue: string, newCursor?: number) => void;
  /** Move the cursor and paint. */
  updateCursor: (pos: number) => void;
  log: (msg: string) => void;
  disabled: boolean;
  isProcessing?: boolean;
  queuedMessages?: string[];
  editingQueueIndex?: number | null;
  workingDir: string;
  hasGitRepo?: boolean;
  contextPercentage?: number;
  currentMode?: Mode;
  recentCommands?: string[];
  onEscape: () => void;
  onExit?: () => void;
  onCycleMode: () => void;
  onSubmit: (value: string) => void;
  onDirectSend?: (msg: string) => void;
  onQueueMessage?: (msg: string) => void;
  onEditQueuedMessage?: (index: number, msg: string) => void;
  onSetEditingQueueIndex?: (index: number | null) => void;
  onNavigateHistory?: (direction: 'up' | 'down') => void;
  onSuggestionsChange?: (suggestions: string[]) => void;
}

/** Handle a single key event for the chat input. */
export function handleChatInputKey(input: string, key: Key, ctx: ChatInputKeyCtx): void {
  const {
    valueRef, cursorRef, lastCtrlCRef, updateValue, updateCursor, log,
    disabled, isProcessing, queuedMessages, editingQueueIndex, workingDir,
    hasGitRepo, contextPercentage, currentMode, recentCommands,
    onEscape, onExit, onCycleMode, onSubmit, onDirectSend, onQueueMessage,
    onEditQueuedMessage, onSetEditingQueueIndex, onNavigateHistory, onSuggestionsChange,
  } = ctx;

  const currentValue = valueRef.current;
  log(`key: "${input}" ${JSON.stringify(key)} val="${currentValue}" disabled=${disabled}`);

  // ESC to exit (always works)
  if (key.escape) {
    log('-> escape');
    onEscape();
    return;
  }

  // Ctrl+C: first press cancels (like Esc); second press within 2s exits.
  if (key.ctrl && input === 'c') {
    const now = Date.now();
    if (onExit && now - lastCtrlCRef.current < 2000) {
      lastCtrlCRef.current = 0;
      onExit();
      return;
    }
    lastCtrlCRef.current = now;
    onEscape();
    return;
  }

  // When fully disabled (modal), ignore all input
  if (disabled) {
    return;
  }

  // When processing, queue messages instead of submitting directly
  if (isProcessing) {
    // Ensure cursor is valid
    let cursor = cursorRef.current;
    if (cursor > currentValue.length) cursor = currentValue.length;
    if (cursor < 0) cursor = 0;

    // Left/right arrow for cursor movement
    if (key.leftArrow) {
      updateCursor(cursor - 1);
      return;
    }
    if (key.rightArrow) {
      updateCursor(cursor + 1);
      return;
    }

    // Alt+Backspace or Alt+Delete for word deletion (Mac Option+Delete)
    const isWordDelete = (key.backspace || key.delete || input === '\x7f' || input === '\b') && key.meta;
    if (isWordDelete) {
      if (cursor > 0) {
        // Find start of current word (delete backwards to word boundary)
        let wordStart = cursor - 1;
        // Skip whitespace
        while (wordStart > 0 && /\s/.test(currentValue[wordStart]!)) {
          wordStart--;
        }
        // Skip non-whitespace (the word)
        while (wordStart > 0 && !/\s/.test(currentValue[wordStart]!)) {
          wordStart--;
        }
        // If we stopped at whitespace, move forward one
        if (wordStart < cursor - 1 && /\s/.test(currentValue[wordStart]!)) {
          wordStart++;
        }
        const newValue = currentValue.slice(0, wordStart) + currentValue.slice(cursor);
        updateValue(newValue, wordStart);
      }
      return;
    }

    // Backspace - support multiple variants including Mac delete key
    const isBackspace = key.backspace || key.delete || (key.ctrl && input === 'h') || input === '\x7f' || input === '\b';
    if (isBackspace) {
      if (cursor > 0) {
        const newValue = currentValue.slice(0, cursor - 1) + currentValue.slice(cursor);
        updateValue(newValue, cursor - 1);
      } else if (currentValue.length > 0) {
        updateValue(currentValue.slice(0, -1), currentValue.length - 1);
      }
      return;
    }
    if (key.ctrl && input === 'u') {
      updateValue('');
      onSetEditingQueueIndex?.(null); // Clear editing state
      return;
    }
    // Ctrl+A to go to start, Ctrl+E to go to end
    if (key.ctrl && input === 'a') {
      updateCursor(0);
      return;
    }
    if (key.ctrl && input === 'e') {
      updateCursor(currentValue.length);
      return;
    }

    // Up/Down arrows to navigate queued messages for editing
    if (key.upArrow && queuedMessages && queuedMessages.length > 0) {
      if (editingQueueIndex === null || editingQueueIndex === undefined) {
        // Start editing the last queued message
        const idx = queuedMessages.length - 1;
        onSetEditingQueueIndex?.(idx);
        updateValue(queuedMessages[idx]!);
      } else if (editingQueueIndex > 0) {
        // Move to previous message
        const idx = editingQueueIndex - 1;
        onSetEditingQueueIndex?.(idx);
        updateValue(queuedMessages[idx]!);
      }
      return;
    }

    if (key.downArrow && queuedMessages && editingQueueIndex !== null && editingQueueIndex !== undefined) {
      if (editingQueueIndex < queuedMessages.length - 1) {
        // Move to next message
        const idx = editingQueueIndex + 1;
        onSetEditingQueueIndex?.(idx);
        updateValue(queuedMessages[idx]!);
      } else {
        // At the end, clear to new input
        onSetEditingQueueIndex?.(null);
        updateValue('');
      }
      return;
    }

    // Alt+Enter or Ctrl+Enter to insert newline (multiline input)
    // On Mac, Option key is detected as key.meta
    if (key.return && (key.meta || key.ctrl)) {
      updateValue(currentValue + '\n');
      return;
    }

    // Shift+Enter sends directly (interrupts current operation)
    // Note: Many terminals don't distinguish Shift+Enter from Enter
    // Use ! prefix as reliable alternative: "!message" sends immediately
    if (key.return && key.shift && currentValue.trim() && onDirectSend) {
      onDirectSend(currentValue.trim());
      onSetEditingQueueIndex?.(null);
      updateValue('');
      return;
    }

    // # prefix sends directly to LLM: "#fix this now" interrupts and sends
    if (key.return && currentValue.trim().startsWith('#') && onDirectSend) {
      const msg = currentValue.trim().slice(1).trim(); // Remove # prefix
      if (msg) {
        onDirectSend(msg);
        onSetEditingQueueIndex?.(null);
        updateValue('');
        return;
      }
    }

    // Enter queues or updates the message
    if (key.return && currentValue.trim()) {
      if (editingQueueIndex !== null && editingQueueIndex !== undefined && onEditQueuedMessage) {
        // Update existing queued message
        onEditQueuedMessage(editingQueueIndex, currentValue.trim());
        onSetEditingQueueIndex?.(null);
        updateValue('');
      } else if (onQueueMessage) {
        // Add new queued message
        onQueueMessage(currentValue.trim());
        updateValue('');
      }
      return;
    }

    // Ctrl+D to delete currently editing queued message
    if (key.ctrl && input === 'd' && editingQueueIndex !== null && editingQueueIndex !== undefined && onEditQueuedMessage) {
      onEditQueuedMessage(editingQueueIndex, ''); // Empty string signals deletion
      onSetEditingQueueIndex?.(null);
      updateValue('');
      return;
    }

    // Regular input - insert at cursor position
    if (shouldInsertInputChunk(input, key)) {
      const cursorNow = cursorRef.current;
      const newValue = currentValue.slice(0, cursorNow) + input + currentValue.slice(cursorNow);
      updateValue(newValue, cursorNow + input.length);
    }
    return;
  }

  // Shift+Tab to cycle mode
  if (key.shift && key.tab) {
    onCycleMode();
    return;
  }

  // Alt+Enter or Ctrl+Enter to insert newline (multiline input)
  // On Mac, Option key is detected as key.meta
  if (key.return && (key.meta || key.ctrl)) {
    updateValue(currentValue + '\n');
    return;
  }

  // Enter to submit
  if (key.return) {
    if (currentValue.trim()) {
      onSubmit(currentValue);
    }
    return;
  }

  // Cursor movement with arrow keys
  // Ensure cursor is valid (might be out of sync)
  let cursor = cursorRef.current;
  if (cursor > currentValue.length) cursor = currentValue.length;
  if (cursor < 0) cursor = 0;

  if (key.leftArrow) {
    updateCursor(cursor - 1);
    return;
  }
  if (key.rightArrow) {
    updateCursor(cursor + 1);
    return;
  }

  // Alt+Backspace or Alt+Delete for word deletion (Mac Option+Delete)
  const isWordDelete = (key.backspace || key.delete || input === '\x7f' || input === '\b') && key.meta;
  if (isWordDelete) {
    if (cursor > 0) {
      // Find start of current word (delete backwards to word boundary)
      let wordStart = cursor - 1;
      // Skip whitespace
      while (wordStart > 0 && /\s/.test(currentValue[wordStart]!)) {
        wordStart--;
      }
      // Skip non-whitespace (the word)
      while (wordStart > 0 && !/\s/.test(currentValue[wordStart]!)) {
        wordStart--;
      }
      // If we stopped at whitespace, move forward one
      if (wordStart < cursor - 1 && /\s/.test(currentValue[wordStart]!)) {
        wordStart++;
      }
      const newValue = currentValue.slice(0, wordStart) + currentValue.slice(cursor);
      updateValue(newValue, wordStart);
    }
    return;
  }

  // Backspace deletes character before cursor (or from end if cursor is 0 but there's text)
  // Support multiple backspace variants:
  // - key.backspace (Ink's detection)
  // - key.delete (Mac delete key is often detected as this)
  // - Ctrl+H (ASCII backspace control code)
  // - \x7f DEL char (Mac delete key raw)
  // - \b BS char (traditional backspace)
  const isBackspace = key.backspace || key.delete || (key.ctrl && input === 'h') || input === '\x7f' || input === '\b';
  if (isBackspace) {
    if (cursor > 0) {
      const newValue = currentValue.slice(0, cursor - 1) + currentValue.slice(cursor);
      updateValue(newValue, cursor - 1);
    } else if (currentValue.length > 0) {
      // Fallback: delete from end if cursor is somehow at 0
      updateValue(currentValue.slice(0, -1), currentValue.length - 1);
    }
    return;
  }

  // Ctrl+U to clear line
  if (key.ctrl && input === 'u') {
    updateValue('');
    return;
  }
  // Ctrl+A to go to start, Ctrl+E to go to end
  if (key.ctrl && input === 'a') {
    updateCursor(0);
    return;
  }
  if (key.ctrl && input === 'e') {
    updateCursor(currentValue.length);
    return;
  }

  // Tab completion for slash commands and paths
  if (key.tab && !key.shift) {
    // Check if we're completing a path after a path command
    const parts = currentValue.split(/\s+/);
    const cmd = parts[0]?.toLowerCase() ?? '';

    if (PATH_COMMANDS.includes(cmd) && parts.length >= 1) {
      // Path completion
      const pathPart = parts.slice(1).join(' ');
      const completions = getPathCompletions(pathPart, workingDir);

      if (completions.length === 1) {
        updateValue(`${cmd} ${completions[0]}`);
        onSuggestionsChange?.([]);
      } else if (completions.length > 1) {
        // Find common prefix
        let commonPrefix = completions[0]!;
        for (const comp of completions) {
          while (!comp.startsWith(commonPrefix)) {
            commonPrefix = commonPrefix.slice(0, -1);
          }
        }
        if (commonPrefix.length > pathPart.length) {
          updateValue(`${cmd} ${commonPrefix}`);
        }
        onSuggestionsChange?.(completions);
      }
      return;
    }

    // Slash command completion with smart suggestions
    if (currentValue.startsWith('/')) {
      // Use smart suggestions if context is available
      const smartMatches = getSmartCommandSuggestions({
        input: currentValue,
        hasGitRepo: hasGitRepo ?? false,
        contextPercentage: contextPercentage ?? 0,
        currentMode: currentMode ?? 'hybrid',
        recentCommands: recentCommands ?? [],
        isProcessing: isProcessing ?? false,
      });

      // Fall back to basic matching if smart suggestions didn't find anything
      const partial = currentValue.toLowerCase();
      const matches = smartMatches.length > 0 ? smartMatches : SLASH_COMMANDS.filter(cmdName =>
        cmdName.startsWith(partial) && cmdName !== partial
      );

      if (matches.length === 1) {
        updateValue(matches[0] + ' ');
        onSuggestionsChange?.([]);
      } else if (matches.length > 1) {
        let commonPrefix = matches[0]!;
        for (const match of matches) {
          while (!match.startsWith(commonPrefix)) {
            commonPrefix = commonPrefix.slice(0, -1);
          }
        }
        if (commonPrefix.length > currentValue.length) {
          updateValue(commonPrefix);
        }
        onSuggestionsChange?.(matches);
      }
      return;
    }
  }

  // Up/down arrows for history navigation
  if (key.upArrow && onNavigateHistory) {
    onNavigateHistory('up');
    return;
  }
  if (key.downArrow && onNavigateHistory) {
    onNavigateHistory('down');
    return;
  }

  // Ignore other control keys, meta, and tab
  if (key.ctrl || key.meta || key.tab) {
    return;
  }

  // Regular character input - insert at cursor position
  if (shouldInsertInputChunk(input, key)) {
    const cursorPos = cursorRef.current;
    const newValue = currentValue.slice(0, cursorPos) + input + currentValue.slice(cursorPos);
    log(`-> char "${input}": "${currentValue}" -> "${newValue}" cursor=${cursorPos}`);
    updateValue(newValue, cursorPos + input.length);
  }
}
