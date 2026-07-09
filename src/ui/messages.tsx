/**
 * UI Module - Message Components
 *
 * MessageItem renders a single conversation message; it is mapped over the
 * transcript by StaticScrollback (regions/static-scrollback.tsx), which owns the
 * write-once <Static> emission. All colors come from the active palette via
 * getInkColor().
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { BoxProps } from 'ink';
import { renderMarkdown } from '../markdown.js';
import { getCurrentSkin, getInkBorderStyle, getInkColor } from '../hud/api.js';
import type { UIMessage, CollapseSettings } from './types.js';

// ============================================================================
// Constants
// ============================================================================

export const TOOL_ICONS: Record<string, string> = {
  shell: '⚡',
  read_file: '📄',
  write_file: '✍️',
  list_files: '📁',
  think: '💭',
  execute_code: '▶️',
  web_search: '🔍',
  git: '🔀',
  mermaid: '📊',
};

/** Get tool icon from active skin, falling back to default TOOL_ICONS */
export function getToolIcon(toolName: string): string {
  const skinIcons = getCurrentSkin().icons;
  if (skinIcons?.[toolName]) {
    return skinIcons[toolName]!;
  }
  return TOOL_ICONS[toolName] || '⚙️';
}

// ============================================================================
// Components
// ============================================================================

function MessageItemInner({ msg, collapse }: { msg: UIMessage; collapse?: CollapseSettings }) {
  // Determine if this tool should be collapsed
  const shouldCollapseThisTool = collapse?.collapseTools &&
    collapse.toolDisplayLimit > 0 &&
    collapse.toolIndex !== undefined &&
    collapse.totalTools !== undefined &&
    (collapse.totalTools - collapse.toolIndex) > collapse.toolDisplayLimit;

  // Pull all colors from palette
  const userColor = getInkColor('user');
  const assistantColor = getInkColor('assistant');
  const borderColor = getInkColor('border');
  const systemColor = getInkColor('system');
  const errorColor = getInkColor('error');
  const successColor = getInkColor('success');
  const warningColor = getInkColor('warning');
  const accentColor = getInkColor('accent');
  const dimColor = getInkColor('textDim');

  const skin = getCurrentSkin();

  switch (msg.type) {
    case 'user':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text><Text color={userColor}>{skin.decorations.promptPrefix || '›'}</Text> {msg.content}</Text>
        </Box>
      );

    case 'assistant': {
      // Render markdown with syntax highlighting
      const rendered = renderMarkdown(msg.content);
      // Collapse consecutive blank lines to single blank line
      const lines = rendered.split('\n').reduce((acc: string[], line) => {
        if (line === '' && acc.length > 0 && acc[acc.length - 1] === '') {
          return acc;
        }
        acc.push(line);
        return acc;
      }, []);

      const hasBorders = skin.borders.style !== 'none';

      if (hasBorders) {
        const bStyle = getInkBorderStyle(skin) as BoxProps['borderStyle'];
        return (
          <Box flexDirection="column" marginTop={1} marginBottom={1}>
            <Text color={assistantColor}>{skin.decorations.assistantPrefix}Calliope:</Text>
            <Box
              flexDirection="column"
              borderStyle={bStyle}
              borderColor={borderColor}
              paddingX={1}
            >
              {lines.map((line, i) => (
                <Text key={i}>{line}</Text>
              ))}
            </Box>
          </Box>
        );
      }

      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Text color={assistantColor}>{skin.decorations.assistantPrefix || '●'} Calliope:</Text>
          {lines.map((line, i) => (
            <Text key={i}><Text color={borderColor}>{skin.decorations.separator || '│'}</Text> {line}</Text>
          ))}
        </Box>
      );
    }

    case 'tool': {
      const isToolCall = msg.content.startsWith('⚡');
      const isThinkTool = msg.content.includes('💭') || msg.content.startsWith('Perfect!') || msg.content.startsWith('Let me');

      // Check if this is a think tool that should be collapsed
      if (collapse?.collapseThinking && isThinkTool && !isToolCall) {
        const preview = msg.content.substring(0, 50).replace(/\n/g, ' ');
        return (
          <Text dimColor>╰─ 💭 <Text italic>{preview}...</Text></Text>
        );
      }

      // Check if this tool should be collapsed (based on toolDisplayLimit)
      if (shouldCollapseThisTool || (collapse?.collapseTools && !isToolCall)) {
        const firstLine = msg.content.split('\n')[0]!.substring(0, 60);
        return (
          <Text dimColor>╰─ ▸ {firstLine}{msg.content.length > 60 ? '...' : ''}</Text>
        );
      }

      if (isToolCall) {
        const match = msg.content.match(/^⚡ (\w+): (.*)$/);
        if (match) {
          const toolName = match[1]!;
          const preview = match[2]!;
          const icon = getToolIcon(toolName);
          return (
            <Box flexDirection="column">
              <Text><Text color={borderColor}>╭─</Text> {icon} <Text color={accentColor}>{toolName}</Text></Text>
              <Text><Text color={borderColor}>│</Text>  <Text dimColor>{preview}</Text></Text>
            </Box>
          );
        }
      }

      // Check for diff output from write_file
      const isDiff = msg.content.startsWith('DIFF:');
      if (isDiff) {
        const diffLines = msg.content.split('\n');
        const header = diffLines[0]!;
        const isNewFile = header.includes('NEW_FILE:');
        const filePath = isNewFile
          ? header.replace('DIFF:NEW_FILE:', '')
          : header.replace('DIFF:', '');

        const summaryLine = diffLines.find(l => l.startsWith('⎿'));
        const diffStartIdx = summaryLine ? diffLines.indexOf(summaryLine) + 1 : 1;
        const visibleDiffLines = diffLines.slice(diffStartIdx, diffStartIdx + 12);
        const hasMore = diffLines.length > diffStartIdx + 12;

        const action = isNewFile ? 'Write' : 'Update';
        const addColor = getInkColor('diffAdd');
        const removeColor = getInkColor('diffRemove');

        return (
          <Box flexDirection="column">
            <Text>
              <Text color={assistantColor}>{action}</Text>
              <Text dimColor>(</Text>
              <Text>{filePath}</Text>
              <Text dimColor>)</Text>
            </Text>
            {summaryLine && (
              <Text>  <Text dimColor>{summaryLine}</Text></Text>
            )}
            {visibleDiffLines.map((line, i) => {
              const lineNumMatch = line.match(/^(\s*\d+)\s*([+-])\s{2}(.*)$/);
              if (lineNumMatch) {
                const [, lineNum, prefix, content] = lineNumMatch;
                const color = prefix === '+' ? addColor : removeColor;
                return (
                  <Text key={i}>
                    <Text dimColor>      {lineNum}</Text>
                    <Text color={color}> {prefix}</Text>
                    <Text color={color}>  {content!.substring(0, 70)}</Text>
                  </Text>
                );
              }
              const contextMatch = line.match(/^(\s*\d+)\s{4}(.*)$/);
              if (contextMatch) {
                const [, lineNum, content] = contextMatch;
                return (
                  <Text key={i}>
                    <Text dimColor>      {lineNum}    {content!.substring(0, 70)}</Text>
                  </Text>
                );
              }
              let color: string | undefined;
              if (line.includes(' + ') || line.startsWith('+ ')) color = addColor;
              else if (line.includes(' - ') || line.startsWith('- ')) color = removeColor;
              return (
                <Text key={i}>
                  <Text color={color}>      {line.substring(0, 80)}</Text>
                </Text>
              );
            })}
            {hasMore && <Text dimColor>      ...</Text>}
          </Box>
        );
      }

      // Regular tool result
      const allLines = msg.content.split('\n');
      const resultLines = allLines.slice(0, 5);
      const totalLines = allLines.length;
      const hasMore = totalLines > 5;

      // Prefer the authoritative isError flag plumbed from executeTool. Fall
      // back to a conservative marker scan (matching the structured prefixes the
      // agent actually emits for failures) only when the flag is unavailable, so
      // benign output that merely *mentions* "error"/"not found" isn't flagged.
      const errorFlag = (msg as { isError?: boolean }).isError;
      let hasError: boolean;
      let hasWarning = false;
      if (errorFlag !== undefined) {
        hasError = errorFlag;
      } else {
        // Genuine failures are emitted as a leading "Error:" line or a 🛑 block
        // marker, not as an arbitrary substring buried in successful output.
        const firstLine = msg.content.split('\n', 1)[0]!;
        hasError = /^(error[:!]|✗|🛑)/i.test(firstLine.trimStart());
        const lowerFirst = firstLine.toLowerCase();
        hasWarning = !hasError && (
          lowerFirst.startsWith('warning') ||
          lowerFirst.startsWith('⚠') ||
          firstLine.includes('⚠')
        );
      }

      let statusIcon = '✓';
      let statusClr = successColor;
      if (hasError) {
        statusIcon = '✗';
        statusClr = errorColor;
      } else if (hasWarning) {
        statusIcon = '⚠';
        statusClr = warningColor;
      }

      return (
        <Box flexDirection="column">
          {resultLines.map((line, i) => (
            <Text key={i}><Text color={borderColor}>│</Text>  <Text dimColor>{line.substring(0, 100)}</Text></Text>
          ))}
          {hasMore && <Text><Text color={borderColor}>│</Text>  <Text dimColor>... ({totalLines - 5} more lines)</Text></Text>}
          <Text><Text color={borderColor}>╰─</Text> <Text color={statusClr}>{statusIcon}</Text></Text>
        </Box>
      );
    }

    case 'system':
      return <Text color={systemColor}>{msg.content}</Text>;

    case 'error':
      return <Text color={errorColor}>✗ {msg.content}</Text>;

    default:
      return <Text>{msg.content}</Text>;
  }
}

// Per-item memoization so appending a new message does not re-run
// renderMarkdown for already-finalized messages. A message's id/content are
// immutable once committed, so the memo only re-renders when collapse settings
// (which affect how the tool is displayed) actually change for this item.
// Per-item memoization: appending a new message must not re-run renderMarkdown
// for already-finalized messages. A message's id/content are immutable once
// committed, so the memo only re-renders when this item's collapse settings
// change. Under <StaticScrollback> this is a second line of defense — Static
// already renders each item exactly once — but it keeps MessageItem correct in
// isolation and for any future non-Static caller.
export const MessageItem = React.memo(
  MessageItemInner,
  (prev, next) =>
    prev.msg === next.msg &&
    prev.collapse?.collapseTools === next.collapse?.collapseTools &&
    prev.collapse?.collapseThinking === next.collapse?.collapseThinking &&
    prev.collapse?.toolDisplayLimit === next.collapse?.toolDisplayLimit &&
    prev.collapse?.toolIndex === next.collapse?.toolIndex &&
    prev.collapse?.totalTools === next.collapse?.totalTools,
);
