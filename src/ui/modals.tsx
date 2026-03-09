/**
 * UI Module - Modal Components
 *
 * Modal dialogs for model selection, session management, confirmations, etc.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { parseFileReferences } from '../files.js';
import type { ModelInfo } from '../model-detection.js';
import type { ToolCall, RiskLevel } from '../types.js';
import type { SessionInfo } from './types.js';

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
// Upgrade Prompt
// ============================================================================

export function UpgradePrompt({
  currentVersion,
  latestVersion,
  onConfirm,
  onCancel
}: {
  currentVersion: string;
  latestVersion: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onConfirm();
    else if (input === 'n' || input === 'N' || key.escape) onCancel();
  });

  return (
    <Box flexDirection="column" marginY={1}>
      <Text color="yellow">
        Update available: v{currentVersion} → <Text color="green">v{latestVersion}</Text>
      </Text>
      <Text>Upgrade now? <Text color="cyan">(y/N)</Text></Text>
    </Box>
  );
}

// ============================================================================
// Complexity Warning
// ============================================================================

export function ComplexityWarning({
  reason,
  prompt,
  onProceed,
  onPlan,
  onCancel,
}: {
  reason: string;
  prompt?: string;
  onProceed: () => void;
  onPlan: () => void;
  onCancel: () => void;
}) {
  useInput((input, key) => {
    if (input === 'p' || input === 'P') onProceed();
    else if (input === 'l' || input === 'L') onPlan();
    else if (key.escape || input === 'c' || input === 'C') onCancel();
  });

  // Analyze the prompt for operation preview
  const analysis = useMemo(() => {
    if (!prompt) return null;

    const lower = prompt.toLowerCase();
    const cwd = process.cwd();

    // Parse file references
    const fileRefs = parseFileReferences(prompt, cwd);

    // Detect operation types
    const operations: string[] = [];
    if (lower.includes('delete') || lower.includes('remove') || lower.includes('rm ')) {
      operations.push('Delete files');
    }
    if (lower.includes('create') || lower.includes('add') || lower.includes('new ')) {
      operations.push('Create files');
    }
    if (lower.includes('modify') || lower.includes('change') || lower.includes('update') || lower.includes('edit')) {
      operations.push('Modify files');
    }
    if (lower.includes('refactor') || lower.includes('restructure') || lower.includes('reorganize')) {
      operations.push('Refactor code');
    }
    if (lower.includes('install') || lower.includes('npm') || lower.includes('yarn') || lower.includes('pip')) {
      operations.push('Install packages');
    }
    if (lower.includes('git ') || lower.includes('commit') || lower.includes('push') || lower.includes('merge')) {
      operations.push('Git operations');
    }
    if (lower.includes('test') || lower.includes('build') || lower.includes('compile')) {
      operations.push('Build/Test');
    }

    // Estimate risk level based on keywords
    let riskLevel: 'low' | 'medium' | 'high' = 'medium';
    if (lower.includes('delete') || lower.includes('remove') || lower.includes('force') || lower.includes('--hard')) {
      riskLevel = 'high';
    } else if (lower.includes('read') || lower.includes('show') || lower.includes('list') || lower.includes('find')) {
      riskLevel = 'low';
    }

    return {
      files: fileRefs.files,
      operations,
      riskLevel,
    };
  }, [prompt]);

  const riskColors = { low: 'green', medium: 'yellow', high: 'red' } as const;

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="yellow" paddingX={1}>
      <Text color="yellow" bold>🔍 Operation Preview</Text>
      <Text> </Text>
      <Text dimColor>{reason}</Text>

      {analysis && (
        <>
          <Text> </Text>
          {analysis.operations.length > 0 && (
            <Text>Operations: <Text color="cyan">{analysis.operations.join(', ')}</Text></Text>
          )}
          {analysis.files.length > 0 && (
            <Text>Files referenced: <Text color="cyan">{analysis.files.length}</Text>
              {analysis.files.length <= 3 && (
                <Text dimColor> ({analysis.files.map(f => f.split('/').pop()).join(', ')})</Text>
              )}
            </Text>
          )}
          <Text>Risk level: <Text color={riskColors[analysis.riskLevel]}>{analysis.riskLevel.toUpperCase()}</Text></Text>
        </>
      )}

      <Text> </Text>
      <Text>This operation may affect multiple files or require careful planning.</Text>
      <Text> </Text>
      <Text color="cyan">How would you like to proceed?</Text>
      <Text> </Text>
      <Text>
        <Text color="green">[P]</Text><Text>roceed directly  </Text>
        <Text color="yellow">[L]</Text><Text>et me plan first  </Text>
        <Text color="red">[C]</Text><Text>ancel</Text>
      </Text>
    </Box>
  );
}

// ============================================================================
// Session Resume Prompt
// ============================================================================

export function SessionResumePrompt({
  session,
  onResume,
  onNew,
}: {
  session: { projectName: string; lastAccessedAt: string; messageCount: number };
  onResume: () => void;
  onNew: () => void;
}) {
  useInput((input) => {
    if (input === 'r' || input === 'R') onResume();
    else onNew();  // Any other key starts a new session
  });

  const timeAgo = (() => {
    const diff = Date.now() - new Date(session.lastAccessedAt).getTime();
    const hours = Math.floor(diff / (1000 * 60 * 60));
    const days = Math.floor(hours / 24);
    if (days > 0) return `${days} day${days > 1 ? 's' : ''} ago`;
    if (hours > 0) return `${hours} hour${hours > 1 ? 's' : ''} ago`;
    const minutes = Math.floor(diff / (1000 * 60));
    return `${minutes} minute${minutes > 1 ? 's' : ''} ago`;
  })();

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor="cyan" paddingX={1}>
      <Text color="cyan" bold>📂 Previous Session Found</Text>
      <Text> </Text>
      <Text>Project: <Text color="yellow">{session.projectName}</Text></Text>
      <Text>Last active: <Text dimColor>{timeAgo}</Text></Text>
      <Text>Messages: <Text dimColor>{session.messageCount}</Text></Text>
      <Text> </Text>
      <Text><Text color="cyan">[R]</Text>esume session  <Text dimColor>any other key = new session</Text></Text>
    </Box>
  );
}

// ============================================================================
// Tool Confirmation
// ============================================================================

export function ToolConfirmation({
  toolCall,
  riskLevel,
  reason,
  onConfirm,
  onDeny
}: {
  toolCall: ToolCall;
  riskLevel: RiskLevel;
  reason: string;
  onConfirm: () => void;
  onDeny: () => void;
}) {
  useInput((input, key) => {
    if (input === 'y' || input === 'Y') onConfirm();
    else if (input === 'n' || input === 'N' || key.escape) onDeny();
  });

  const args = toolCall.arguments as Record<string, unknown>;
  const preview = String(args.command || args.path || args.operation || '...');
  const riskColor = riskLevel === 'critical' ? 'red' : 'yellow';
  const riskIcon = riskLevel === 'critical' ? '⚠️' : '⚡';

  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={riskColor} paddingX={1}>
      <Text color={riskColor} bold>{riskIcon} {riskLevel.toUpperCase()} RISK OPERATION</Text>
      <Text> </Text>
      <Text>Tool: <Text color="cyan">{toolCall.name}</Text></Text>
      <Text>Command: <Text dimColor>{preview.substring(0, 60)}</Text></Text>
      <Text>Reason: <Text dimColor>{reason}</Text></Text>
      <Text> </Text>
      <Text>Execute this operation? <Text color="cyan">(y/N)</Text></Text>
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
