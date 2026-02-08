/**
 * UI Module - Chat Input Component
 *
 * Full-featured input line with cursor, history, tab completion,
 * queue mode, and multiline support.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import * as fs from 'fs';
import type { Mode } from '../types.js';
import { getCurrentCompanion } from '../companions.js';
import { getInkColor } from '../hud.js';
import { Separator } from './components.js';
import { SLASH_COMMANDS, PATH_COMMANDS, getPathCompletions, getSmartCommandSuggestions } from './completions.js';

// ============================================================================
// ChatInput Component
// ============================================================================

export function ChatInput({
  value,
  onChange,
  onSubmit,
  onEscape,
  onCycleMode,
  disabled,
  isProcessing,
  queuedCount,
  queuedMessages,
  editingQueueIndex,
  onQueueMessage,
  onEditQueuedMessage,
  onSetEditingQueueIndex,
  onDirectSend,
  cwd,
  suggestions,
  onSuggestionsChange,
  onNavigateHistory,
  // Smart suggestion context
  currentMode,
  contextPercentage,
  recentCommands,
  hasGitRepo,
}: {
  value: string;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onEscape: () => void;
  onCycleMode: () => void;
  disabled: boolean;
  isProcessing?: boolean;
  queuedCount?: number;
  queuedMessages?: string[];
  editingQueueIndex?: number | null;
  onQueueMessage?: (msg: string) => void;
  onEditQueuedMessage?: (index: number, msg: string) => void;
  onSetEditingQueueIndex?: (index: number | null) => void;
  onDirectSend?: (msg: string) => void;
  cwd?: string;
  suggestions?: string[];
  onSuggestionsChange?: (suggestions: string[]) => void;
  onNavigateHistory?: (direction: 'up' | 'down') => void;
  // Smart suggestion context
  currentMode?: Mode;
  contextPercentage?: number;
  recentCommands?: string[];
  hasGitRepo?: boolean;
}) {
  const workingDir = cwd || process.cwd();

  // Debug logging (set CALLIOPE_DEBUG=1 to enable) - use async to avoid input lag
  const debug = process.env.CALLIOPE_DEBUG === '1';
  const log = debug
    ? (msg: string) => fs.appendFile('/tmp/calliope-debug.log', `${new Date().toISOString()} [input] ${msg}\n`, () => {})
    : () => {};

  // CRITICAL FIX: Use refs to track the current value and cursor position
  // This prevents stale closure issues when typing rapidly before React re-renders
  const valueRef = React.useRef(value);
  const cursorRef = React.useRef(value.length); // Cursor position (0 = start, length = end)
  const internalChangeRef = React.useRef(false); // Track if change was from typing

  // Sync refs when prop changes (from external sources like history navigation)
  React.useEffect(() => {
    // Only reset cursor if change was external (not from our own typing)
    if (!internalChangeRef.current) {
      valueRef.current = value;
      cursorRef.current = value.length; // Move cursor to end on external change
    }
    internalChangeRef.current = false;
  }, [value]);

  // Helper to update value - updates ref IMMEDIATELY, then notifies parent
  const updateValue = (newValue: string, newCursor?: number) => {
    valueRef.current = newValue;  // Update ref synchronously
    cursorRef.current = newCursor ?? newValue.length; // Default cursor to end
    internalChangeRef.current = true; // Mark as internal change
    onChange(newValue);           // Then notify parent (may batch)
  };

  // Force re-render for cursor position changes (cursor is visual only)
  const [, forceRender] = React.useState(0);
  const updateCursor = (pos: number) => {
    cursorRef.current = Math.max(0, Math.min(pos, valueRef.current.length));
    forceRender(n => n + 1);
  };

  // Handle ALL keyboard input here - single source of input handling
  useInput((input, key) => {
    const currentValue = valueRef.current;
    log(`key: "${input}" ${JSON.stringify(key)} val="${currentValue}" disabled=${disabled}`);

    // ESC to exit (always works)
    if (key.escape) {
      log('-> escape');
      onEscape();
      return;
    }

    // Ctrl+C to exit (always works)
    if (key.ctrl && input === 'c') {
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
          updateValue(queuedMessages[idx]);
        } else if (editingQueueIndex > 0) {
          // Move to previous message
          const idx = editingQueueIndex - 1;
          onSetEditingQueueIndex?.(idx);
          updateValue(queuedMessages[idx]);
        }
        return;
      }

      if (key.downArrow && queuedMessages && editingQueueIndex !== null && editingQueueIndex !== undefined) {
        if (editingQueueIndex < queuedMessages.length - 1) {
          // Move to next message
          const idx = editingQueueIndex + 1;
          onSetEditingQueueIndex?.(idx);
          updateValue(queuedMessages[idx]);
        } else {
          // At the end, clear to new input
          onSetEditingQueueIndex?.(null);
          updateValue('');
        }
        return;
      }

      // Alt+Enter or Ctrl+Enter to insert newline (multiline input)
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

      // ! prefix sends directly: "!fix this now" interrupts and sends
      if (key.return && currentValue.trim().startsWith('!') && onDirectSend) {
        const msg = currentValue.trim().slice(1).trim(); // Remove ! prefix
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
      if (input && !key.ctrl && !key.meta && !key.tab) {
        const cursor = cursorRef.current;
        const newValue = currentValue.slice(0, cursor) + input + currentValue.slice(cursor);
        updateValue(newValue, cursor + input.length);
      }
      return;
    }

    // Shift+Tab to cycle mode
    if (key.shift && key.tab) {
      onCycleMode();
      return;
    }

    // Alt+Enter or Ctrl+Enter to insert newline (multiline input)
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
      const cmd = parts[0]?.toLowerCase();

      if (PATH_COMMANDS.includes(cmd) && parts.length >= 1) {
        // Path completion
        const pathPart = parts.slice(1).join(' ');
        const completions = getPathCompletions(pathPart, workingDir);

        if (completions.length === 1) {
          updateValue(`${cmd} ${completions[0]}`);
          onSuggestionsChange?.([]);
        } else if (completions.length > 1) {
          // Find common prefix
          let commonPrefix = completions[0];
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
          let commonPrefix = matches[0];
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
    if (input) {
      const cursorPos = cursorRef.current;
      const newValue = currentValue.slice(0, cursorPos) + input + currentValue.slice(cursorPos);
      log(`-> char "${input}": "${currentValue}" -> "${newValue}" cursor=${cursorPos}`);
      updateValue(newValue, cursorPos + input.length);
    }
  }, {isActive: !disabled});

  // Determine prompt style based on state
  const promptColor = disabled ? 'gray' : isProcessing ? 'yellow' : 'cyan';
  const isEditing = editingQueueIndex !== null && editingQueueIndex !== undefined;
  const promptText = isProcessing
    ? (isEditing ? `edit[${editingQueueIndex + 1}]>` : 'queue>')
    : `${getCurrentCompanion().name}>`;

  return (
    <Box flexDirection="column">
      <Separator />
      {/* Suggestions display */}
      {suggestions && suggestions.length > 0 && (
        <Box>
          <Text dimColor>Tab: </Text>
          <Text color={getInkColor('secondary')}>{suggestions.slice(0, 5).join('  ')}</Text>
          {suggestions.length > 5 && <Text dimColor>  (+{suggestions.length - 5} more)</Text>}
        </Box>
      )}
      {/* Queue indicator */}
      {(queuedCount ?? 0) > 0 && (
        <Box>
          <Text color={getInkColor('warning')}>📨 {queuedCount} queued</Text>
          <Text dimColor> | !msg to send now</Text>
        </Box>
      )}
      <Box>
        <Text color={promptColor}>{promptText} </Text>
        <Text>{value.slice(0, cursorRef.current)}</Text>
        <Text color={promptColor}>▌</Text>
        <Text>{value.slice(cursorRef.current)}</Text>
      </Box>
    </Box>
  );
}
