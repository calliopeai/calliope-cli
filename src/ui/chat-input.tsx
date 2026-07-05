/**
 * UI Module - Chat Input Component
 *
 * Full-featured input line with cursor, history, tab completion,
 * queue mode, and multiline support. Keyboard handling lives in
 * chat-input-keys.ts; this file owns the refs, paint cadence, and layout.
 */

import React from 'react';
import { Box, Text, useInput } from 'ink';
import * as fs from 'fs';
import type { Mode } from '../types.js';
import { getInkColor } from '../hud/api.js';
import { Separator } from './components.js';
import { handleChatInputKey } from './chat-input-keys.js';

// ============================================================================
// ChatInput Component
// ============================================================================

export function ChatInput({
  value,
  valueVersion,
  onChange,
  onSubmit,
  onEscape,
  onExit,
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
  // Bumps when the parent explicitly sets the value (clear on submit,
  // history nav). Needed because during typing the parent holds the value
  // in a ref and does not re-render, so the `value` prop can be stale;
  // watching a version counter guarantees we sync on explicit resets.
  valueVersion?: number;
  onChange: (value: string) => void;
  onSubmit: (value: string) => void;
  onEscape: () => void;
  onExit?: () => void;
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
  const lastCtrlCRef = React.useRef(0); // Timestamp of last Ctrl+C for double-press exit

  // Force re-render so input echoes immediately from refs, independent of
  // parent re-render cadence (parent can be slow during streaming/tool output).
  const [, forceRender] = React.useState(0);

  // Sync refs when parent authoritatively pushes a value. We depend on
  // `valueVersion` rather than `value` alone: during typing the parent keeps
  // the canonical value in a ref and does not re-render, so the `value` prop
  // can lag behind our own ref. The parent bumps `valueVersion` on explicit
  // resets (clear after submit, history nav) so we know to overwrite.
  React.useEffect(() => {
    if (value !== valueRef.current) {
      valueRef.current = value;
      cursorRef.current = value.length;
      forceRender(n => n + 1);
    }
    internalChangeRef.current = false;
  }, [value, valueVersion]);

  // Helper to update value - updates ref IMMEDIATELY, paints, then notifies parent
  const updateValue = (newValue: string, newCursor?: number) => {
    valueRef.current = newValue;
    cursorRef.current = newCursor ?? newValue.length;
    internalChangeRef.current = true;
    forceRender(n => n + 1); // Paint now; don't wait for parent's batch
    onChange(newValue);
  };

  const updateCursor = (pos: number) => {
    cursorRef.current = Math.max(0, Math.min(pos, valueRef.current.length));
    forceRender(n => n + 1);
  };

  // Handle ALL keyboard input here - single source of input handling
  useInput((input, key) => {
    handleChatInputKey(input, key, {
      valueRef,
      cursorRef,
      lastCtrlCRef,
      updateValue,
      updateCursor,
      log,
      disabled,
      isProcessing,
      queuedMessages,
      editingQueueIndex,
      workingDir,
      hasGitRepo,
      contextPercentage,
      currentMode,
      recentCommands,
      onEscape,
      onExit,
      onCycleMode,
      onSubmit,
      onDirectSend,
      onQueueMessage,
      onEditQueuedMessage,
      onSetEditingQueueIndex,
      onNavigateHistory,
      onSuggestionsChange,
    });
  }, {isActive: !disabled});

  // Determine prompt style based on state
  const promptColor = disabled ? 'gray' : isProcessing ? 'yellow' : 'cyan';
  const isEditing = editingQueueIndex !== null && editingQueueIndex !== undefined;
  const promptText = isProcessing
    ? (isEditing ? `edit[${editingQueueIndex + 1}]>` : 'queue>')
    : 'calliope>';
  const displayValue = valueRef.current;
  const cursorPos = Math.max(0, Math.min(cursorRef.current, displayValue.length));

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
          <Text dimColor> | #msg to send now</Text>
        </Box>
      )}
      <Box>
        <Text color={promptColor}>{promptText} </Text>
        <Text>{displayValue.slice(0, cursorPos)}</Text>
        {!disabled && <Text color={promptColor}>▌</Text>}
        <Text>{displayValue.slice(cursorPos)}</Text>
      </Box>
    </Box>
  );
}
