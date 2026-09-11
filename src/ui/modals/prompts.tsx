/**
 * UI Module - Prompt Modals
 *
 * Confirmation dialogs: upgrade, complexity warning, session resume, tool
 * confirmation.
 */

import React, { useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { parseFileReferences } from '../../files.js';
import type { ApprovalChoice, PendingApproval } from '../../approvals/index.js';
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

export function ToolConfirmation({ pending, onAnswer }: {
  pending: PendingApproval;
  onAnswer: (choice: ApprovalChoice) => void;
}) {
  const { request, queued } = pending;
  useInput((input, key) => {
    if (key.escape) onAnswer('cancelled');
    else if (input.toLowerCase() === 'y') onAnswer('allow');
    else if (input.toLowerCase() === 's' && request.reusable) onAnswer('allow_session');
    else if (input.toLowerCase() === 'p' && request.reusable) onAnswer('allow_project');
    else if (input.toLowerCase() === 'n') onAnswer('reject');
  });
  const riskColor = request.risk === 'critical' ? 'red' : 'yellow';
  return (
    <Box flexDirection="column" marginY={1} borderStyle="round" borderColor={riskColor} paddingX={1}>
      <Text color={riskColor} bold>{request.risk.toUpperCase()} RISK — {request.tool}</Text>
      <Text>{request.reason}</Text>
      {request.details.map((detail, index) => <Text key={index}>{detail}</Text>)}
      <Text> </Text>
      <Text>[Y] Approve once  [N] Deny  [Esc] Cancel turn</Text>
      {request.reusable ? <>
        <Text>[S] Approve for session (24 hours)  [P] Approve for project (30 days)</Text>
        <Text dimColor>Saved approval covers these exact arguments and policy state. Scope and policy checks still apply.</Text>
      </> : <Text dimColor>Reusable approval is unavailable for code, shell, plugin or cross-project operations.</Text>}
      {queued > 0 && <Text>{queued} other approval request{queued === 1 ? '' : 's'} waiting.</Text>}
    </Box>
  );
}
