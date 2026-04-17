/**
 * UI Module - Message Components
 *
 * MessageItem and MessageHistory for displaying conversation messages.
 * All colors are sourced from the active palette via getInkColor().
 */

import React from 'react';
import { Box, Text } from 'ink';
import type { BoxProps } from 'ink';
import { renderMarkdown } from '../markdown.js';
import { getToolLabel, getCurrentCompanion } from '../companions.js';
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
  // AGTerm tools
  spawn_agent: '🤖',
  check_agent: '📋',
  list_agents: '📊',
  cancel_agent: '🛑',
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

export function MessageItem({ msg, collapse }: { msg: UIMessage; collapse?: CollapseSettings }) {
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
      const companionName = getCurrentCompanion().name;

      if (hasBorders) {
        const bStyle = getInkBorderStyle(skin) as BoxProps['borderStyle'];
        return (
          <Box flexDirection="column" marginTop={1} marginBottom={1}>
            <Text color={assistantColor}>{skin.decorations.assistantPrefix}{companionName}:</Text>
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
          <Text color={assistantColor}>{skin.decorations.assistantPrefix || '●'} {companionName}:</Text>
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
        const firstLine = msg.content.split('\n')[0].substring(0, 60);
        return (
          <Text dimColor>╰─ ▸ {firstLine}{msg.content.length > 60 ? '...' : ''}</Text>
        );
      }

      if (isToolCall) {
        const match = msg.content.match(/^⚡ (\w+): (.*)$/);
        if (match) {
          const [, toolName, preview] = match;
          const icon = getToolIcon(toolName);
          const immersionLabel = getToolLabel(toolName);
          return (
            <Box flexDirection="column">
              <Text><Text color={borderColor}>╭─</Text> {icon} <Text color={accentColor}>{toolName}</Text>{immersionLabel ? <Text dimColor> {immersionLabel}</Text> : null}</Text>
              <Text><Text color={borderColor}>│</Text>  <Text dimColor>{preview}</Text></Text>
            </Box>
          );
        }
      }

      // Check for diff output from write_file
      const isDiff = msg.content.startsWith('DIFF:');
      if (isDiff) {
        const diffLines = msg.content.split('\n');
        const header = diffLines[0];
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
                    <Text color={color}>  {content.substring(0, 70)}</Text>
                  </Text>
                );
              }
              const contextMatch = line.match(/^(\s*\d+)\s{4}(.*)$/);
              if (contextMatch) {
                const [, lineNum, content] = contextMatch;
                return (
                  <Text key={i}>
                    <Text dimColor>      {lineNum}    {content.substring(0, 70)}</Text>
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

      const lowerContent = msg.content.toLowerCase();
      const hasError = lowerContent.includes('error') ||
                       lowerContent.includes('failed') ||
                       lowerContent.includes('permission denied') ||
                       lowerContent.includes('not found') ||
                       lowerContent.includes('exception');
      const hasWarning = lowerContent.includes('warning') ||
                         lowerContent.includes('deprecated') ||
                         lowerContent.includes('caution');

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

function MessageHistoryInner({ messages, collapseSettings }: { messages: UIMessage[]; collapseSettings: CollapseSettings }) {

  // Count tool messages for toolDisplayLimit calculation
  const toolMessages = messages.filter(m => m.type === 'tool');
  const totalTools = toolMessages.length;

  // Track tool index
  let toolIndex = 0;

  return (
    <Box flexDirection="column">
      {messages.map((msg) => {
        const msgCollapseSettings = msg.type === 'tool'
          ? { ...collapseSettings, toolIndex: toolIndex++, totalTools }
          : collapseSettings;

        return (
          <Box key={msg.id}>
            <MessageItem msg={msg} collapse={msgCollapseSettings} />
          </Box>
        );
      })}
    </Box>
  );
}

// Memoized so unrelated parent re-renders (e.g. input keystrokes) don't
// re-render the entire message list.
export const MessageHistory = React.memo(MessageHistoryInner);
