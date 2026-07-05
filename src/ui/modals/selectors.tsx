/**
 * UI Module - Selector Modals
 *
 * List-based pickers: model selection, session management, provider selection.
 */

import React, { useState } from 'react';
import { Box, Text, useInput } from 'ink';
import type { ModelInfo } from '../../model-detection.js';
import type { LLMProvider } from '../../types.js';
import type { SessionInfo } from '../types.js';

// ============================================================================
// Model Selector
// ============================================================================

export function ModelSelector({
  models,
  onSelect,
  onCancel
}: {
  models: ModelInfo[];
  onSelect: (model: string) => void;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  const pageSize = 10;
  const start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), models.length - pageSize));
  const visible = models.slice(start, start + pageSize);

  useInput((input, key) => {
    if (key.upArrow) setIndex(i => Math.max(0, i - 1));
    else if (key.downArrow) setIndex(i => Math.min(models.length - 1, i + 1));
    else if (key.return) onSelect(models[index].id);
    else if (key.escape || input === 'q') onCancel();
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="yellow">Select model (↑/↓ navigate, Enter select, Esc cancel):</Text>
      {visible.map((model, i) => {
        const globalIndex = start + i;
        const isSelected = globalIndex === index;
        const name = model.name || model.id;
        const displayName = name.length > 50 ? name.slice(0, 47) + '...' : name;
        return (
          <Text key={model.id} color={isSelected ? 'cyan' : undefined} bold={isSelected}>
            {isSelected ? '❯ ' : '  '}{displayName}
          </Text>
        );
      })}
      {models.length > pageSize && (
        <Text dimColor>  ({index + 1}/{models.length})</Text>
      )}
    </Box>
  );
}

// ============================================================================
// Session Selector
// ============================================================================

export function SessionSelector({
  sessions,
  onSelect,
  onDelete,
  onCancel
}: {
  sessions: SessionInfo[];
  onSelect: (session: SessionInfo) => void;
  onDelete: (session: SessionInfo) => void;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(0);
  const pageSize = 5;

  // Keep selection visible - scroll window to follow selection
  const start = Math.max(0, Math.min(index - pageSize + 1, sessions.length - pageSize));
  const end = Math.min(start + pageSize, sessions.length);
  const visible = sessions.slice(start, end);

  const hasMore = sessions.length > pageSize;
  const hasAbove = start > 0;
  const hasBelow = end < sessions.length;

  useInput((input, key) => {
    if (key.upArrow) setIndex(i => Math.max(0, i - 1));
    else if (key.downArrow) setIndex(i => Math.min(sessions.length - 1, i + 1));
    else if (key.return && sessions.length > 0) onSelect(sessions[index]);
    else if ((key.backspace || key.delete) && sessions.length > 0) onDelete(sessions[index]);
    else if (key.escape || input === 'q') onCancel();
  });

  const formatTimeAgo = (dateStr: string) => {
    const diff = Date.now() - new Date(dateStr).getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days}d ago`;
    if (hours > 0) return `${hours}h ago`;
    const minutes = Math.floor(diff / (1000 * 60));
    return `${minutes}m ago`;
  };

  if (sessions.length === 0) {
    return (
      <Box flexDirection="column" marginY={1}>
        <Text dimColor>No sessions found. Press Esc to close.</Text>
      </Box>
    );
  }

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="yellow">Sessions (↑/↓, Enter load, Del delete, Esc cancel):</Text>
      {hasMore && hasAbove && <Text dimColor>  ↑ more</Text>}
      {visible.map((session, i) => {
        const globalIndex = start + i;
        const isSelected = globalIndex === index;
        const timeAgo = formatTimeAgo(session.lastAccessedAt);
        const name = session.projectName.length > 30 ? session.projectName.slice(0, 27) + '...' : session.projectName;
        return (
          <Text key={session.id} color={isSelected ? 'cyan' : undefined} bold={isSelected}>
            {isSelected ? '❯ ' : '  '}{name} <Text dimColor>({timeAgo}, {session.messageCount} msgs)</Text>
          </Text>
        );
      })}
      {hasMore && hasBelow && <Text dimColor>  ↓ more</Text>}
      {hasMore && <Text dimColor>  {index + 1}/{sessions.length}</Text>}
    </Box>
  );
}

// ============================================================================
// Provider Selector
// ============================================================================

export interface ProviderEntry {
  id: LLMProvider;
  label: string;           // Display name
  configured: boolean;     // Has creds?
  configHint: string;      // e.g. "ANTHROPIC_API_KEY" or "AWS_PROFILE / AWS_ACCESS_KEY_ID"
  recommended?: boolean;   // Highlight as easiest option (Ollama)
  note?: string;           // Extra info (e.g. "local, free")
}

export function ProviderSelector({
  providers,
  onSelect,
  onCancel,
}: {
  providers: ProviderEntry[];
  onSelect: (p: ProviderEntry) => void;
  onCancel: () => void;
}) {
  const [index, setIndex] = useState(() => {
    // Start on the first configured provider; fall back to 0.
    const firstConfigured = providers.findIndex(p => p.configured);
    return firstConfigured >= 0 ? firstConfigured : 0;
  });
  const pageSize = 12;
  const start = Math.max(0, Math.min(index - Math.floor(pageSize / 2), providers.length - pageSize));
  const visible = providers.slice(start, start + pageSize);
  const anyConfigured = providers.some(p => p.configured);

  useInput((input, key) => {
    if (key.upArrow) setIndex(i => Math.max(0, i - 1));
    else if (key.downArrow) setIndex(i => Math.min(providers.length - 1, i + 1));
    else if (key.return) onSelect(providers[index]);
    else if (key.escape || input === 'q') onCancel();
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="yellow">Select provider (↑/↓ navigate, Enter select, Esc cancel):</Text>
      {!anyConfigured && (
        <Text dimColor>  No providers configured. Ollama is the easiest starting point (local, free).</Text>
      )}
      {visible.map((p, i) => {
        const globalIndex = start + i;
        const isSelected = globalIndex === index;
        const star = p.configured ? '★' : '☆';
        const starColor = p.configured ? 'green' : 'gray';
        const tag = p.recommended ? ' (recommended)' : '';
        return (
          <Box key={p.id}>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {isSelected ? '❯ ' : '  '}
            </Text>
            <Text color={starColor}>{star} </Text>
            <Text color={isSelected ? 'cyan' : undefined} bold={isSelected}>
              {p.label}
            </Text>
            {p.note && <Text dimColor>  — {p.note}</Text>}
            {tag && <Text color="yellow">{tag}</Text>}
            {!p.configured && <Text dimColor>  (needs {p.configHint})</Text>}
          </Box>
        );
      })}
      {providers.length > pageSize && (
        <Text dimColor>  ({index + 1}/{providers.length})</Text>
      )}
    </Box>
  );
}
