/**
 * UI Module - Setup & Info Modals
 *
 * Inline API-key configuration and the keybindings help overlay.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { LLMProvider } from '../../types.js';
import { shouldInsertInputChunk } from '../input-utils.js';

// ============================================================================
// Api Key Setup (inline configuration for unconfigured providers)
// ============================================================================

export function ApiKeySetup({
  provider,
  configHint,
  onSubmit,
  onCancel,
  extraInstructions,
}: {
  provider: LLMProvider;
  configHint: string;
  onSubmit: (value: string) => void;
  onCancel: () => void;
  extraInstructions?: string;
}) {
  const [value, setValue] = useState('');

  useInput((input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }
    if (key.return) {
      const trimmed = value.trim();
      if (trimmed) onSubmit(trimmed);
      return;
    }
    if (key.backspace || key.delete || input === '\x7f' || input === '\b' || (key.ctrl && input === 'h')) {
      setValue(v => v.slice(0, -1));
      return;
    }
    if (key.ctrl && input === 'u') {
      setValue('');
      return;
    }
    if (shouldInsertInputChunk(input, key)) {
      setValue(v => v + input);
    }
  });

  const masked = value ? '•'.repeat(Math.min(value.length, 40)) : '';

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>🔑 Configure {provider}</Text>
      <Text> </Text>
      <Text dimColor>Paste your {configHint} and press Enter (Esc to cancel):</Text>
      {extraInstructions && <Text dimColor>{extraInstructions}</Text>}
      <Text> </Text>
      <Box>
        <Text color="yellow">{configHint}: </Text>
        <Text>{masked}</Text>
        <Text color="cyan">▌</Text>
      </Box>
    </Box>
  );
}

// ============================================================================
// Keybindings Modal
// ============================================================================

export function KeybindingsModal({ onClose }: { onClose: () => void }) {
  useInput((input, key) => {
    if (key.escape || key.return || input === 'q') onClose();
  });

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="cyan" paddingX={2} paddingY={1}>
      <Text color="cyan" bold>⌨️  Keyboard Shortcuts</Text>
      <Text> </Text>
      <Text bold color="yellow">General:</Text>
      <Text>  Enter          Submit message</Text>
      <Text>  Alt/Ctrl+Enter Insert newline (multiline)</Text>
      <Text>  Shift+Tab      Cycle modes (plan/hybrid/work)</Text>
      <Text>  Esc            Cancel operation / show hint</Text>
      <Text>  Ctrl+C         Exit</Text>
      <Text>  ↑/↓            Navigate input history</Text>
      <Text>  Tab            Auto-complete commands/paths</Text>
      <Text>  Ctrl+U         Clear input line</Text>
      <Text> </Text>
      <Text bold color="yellow">During Processing (queue mode):</Text>
      <Text>  Enter          Queue message for later</Text>
      <Text>  !message       Send directly (interrupt agent)</Text>
      <Text>  ↑/↓            Edit queued messages</Text>
      <Text>  Ctrl+D         Delete queued message</Text>
      <Text> </Text>
      <Text bold color="yellow">Quick Commands:</Text>
      <Text>  /keys          This help</Text>
      <Text>  /work          Switch to work mode</Text>
      <Text>  /plan          Switch to plan mode</Text>
      <Text>  /flush         Force-process queue</Text>
      <Text>  /unstick       Reset stuck state</Text>
      <Text>  /debug on/off  Toggle debug mode</Text>
      <Text> </Text>
      <Text dimColor>Press any key to close...</Text>
    </Box>
  );
}
