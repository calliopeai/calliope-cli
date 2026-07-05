/**
 * UI Module - Prompt Modals
 *
 * Confirmation dialogs: upgrade, complexity warning, session resume, tool
 * confirmation.
 */

import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { parseFileReferences } from '../../files.js';
import type { ToolCall, RiskLevel } from '../../types.js';
import { getSessionResumeAction } from '../input-utils.js';

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
  useInput((input, key) => {
    const action = getSessionResumeAction(input, key);
    if (action === 'resume') onResume();
    else if (action === 'new') onNew();
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
      <Text><Text color="cyan">[R]</Text>esume session  <Text color="cyan">[N]</Text>ew session  <Text dimColor>[Enter/Esc] new</Text></Text>
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
