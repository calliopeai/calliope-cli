/**
 * UI Module - Message Components
 *
 * MessageItem and MessageHistory for displaying conversation messages.
 */

import React from 'react';
import { Box, Text, Static } from 'ink';
import { renderMarkdown } from '../markdown.js';
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

  switch (msg.type) {
    case 'user':
      return (
        <Box flexDirection="column" marginTop={1}>
          <Text><Text color="cyan">›</Text> {msg.content}</Text>
        </Box>
      );

    case 'assistant': {
      // Render markdown with syntax highlighting
      const rendered = renderMarkdown(msg.content);
      // Collapse consecutive blank lines to single blank line
      const lines = rendered.split('\n').reduce((acc: string[], line) => {
        // Skip if this is a blank line following another blank line
        if (line === '' && acc.length > 0 && acc[acc.length - 1] === '') {
          return acc;
        }
        acc.push(line);
        return acc;
      }, []);
      return (
        <Box flexDirection="column" marginTop={1} marginBottom={1}>
          <Text color="cyan">✧ Calliope:</Text>
          {lines.map((line, i) => (
            <Text key={i}><Text color="blue">│</Text> {line}</Text>
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
        // Show collapsed single-line version
        const firstLine = msg.content.split('\n')[0].substring(0, 60);
        return (
          <Text dimColor>╰─ ▸ {firstLine}{msg.content.length > 60 ? '...' : ''}</Text>
        );
      }

      if (isToolCall) {
        const match = msg.content.match(/^⚡ (\w+): (.*)$/);
        if (match) {
          const [, toolName, preview] = match;
          const icon = TOOL_ICONS[toolName] || '⚙️';
          return (
            <Box flexDirection="column">
              <Text><Text dimColor>╭─</Text> {icon} <Text color="yellow">{toolName}</Text></Text>
              <Text><Text dimColor>│</Text>  <Text dimColor>{preview}</Text></Text>
            </Box>
          );
        }
      }

      // Check for diff output from write_file
      const isDiff = msg.content.startsWith('DIFF:');
      if (isDiff) {
        const lines = msg.content.split('\n');
        const header = lines[0];
        const isNewFile = header.includes('NEW_FILE:');
        const filePath = isNewFile
          ? header.replace('DIFF:NEW_FILE:', '')
          : header.replace('DIFF:', '');

        // Find summary line (starts with ⎿)
        const summaryLine = lines.find(l => l.startsWith('⎿'));
        const diffStartIdx = summaryLine ? lines.indexOf(summaryLine) + 1 : 1;
        const diffLines = lines.slice(diffStartIdx, diffStartIdx + 12);
        const hasMore = lines.length > diffStartIdx + 12;

        // Claude Code style diff display
        const action = isNewFile ? 'Write' : 'Update';
        return (
          <Box flexDirection="column">
            <Text>
              <Text color="cyan">{action}</Text>
              <Text dimColor>(</Text>
              <Text>{filePath}</Text>
              <Text dimColor>)</Text>
            </Text>
            {summaryLine && (
              <Text>  <Text dimColor>{summaryLine}</Text></Text>
            )}
            {diffLines.map((line, i) => {
              // Check for line number format: "  123 +  content" or "  123 -  content"
              const lineNumMatch = line.match(/^(\s*\d+)\s*([+-])\s{2}(.*)$/);
              if (lineNumMatch) {
                const [, lineNum, prefix, content] = lineNumMatch;
                const color = prefix === '+' ? 'green' : 'red';
                return (
                  <Text key={i}>
                    <Text dimColor>      {lineNum}</Text>
                    <Text color={color as 'green' | 'red'}> {prefix}</Text>
                    <Text color={color as 'green' | 'red'}>  {content.substring(0, 70)}</Text>
                  </Text>
                );
              }
              // Context line with line number: "  123    content"
              const contextMatch = line.match(/^(\s*\d+)\s{4}(.*)$/);
              if (contextMatch) {
                const [, lineNum, content] = contextMatch;
                return (
                  <Text key={i}>
                    <Text dimColor>      {lineNum}    {content.substring(0, 70)}</Text>
                  </Text>
                );
              }
              // Fallback for old format or other lines
              let color: string | undefined;
              if (line.includes(' + ') || line.startsWith('+ ')) color = 'green';
              else if (line.includes(' - ') || line.startsWith('- ')) color = 'red';
              return (
                <Text key={i}>
                  <Text color={color as 'green' | 'red' | undefined}>      {line.substring(0, 80)}</Text>
                </Text>
              );
            })}
            {hasMore && <Text dimColor>      ...</Text>}
          </Box>
        );
      }

      // Regular tool result with enhanced status detection
      const allLines = msg.content.split('\n');
      const lines = allLines.slice(0, 5);
      const totalLines = allLines.length;
      const hasMore = totalLines > 5;

      // Enhanced status detection
      const lowerContent = msg.content.toLowerCase();
      const hasError = lowerContent.includes('error') ||
                       lowerContent.includes('failed') ||
                       lowerContent.includes('permission denied') ||
                       lowerContent.includes('not found') ||
                       lowerContent.includes('exception');
      const hasWarning = lowerContent.includes('warning') ||
                         lowerContent.includes('deprecated') ||
                         lowerContent.includes('caution');

      // Determine status icon and color
      let statusIcon = '✓';
      let statusColor: 'green' | 'red' | 'yellow' = 'green';
      if (hasError) {
        statusIcon = '✗';
        statusColor = 'red';
      } else if (hasWarning) {
        statusIcon = '⚠';
        statusColor = 'yellow';
      }

      return (
        <Box flexDirection="column">
          {lines.map((line, i) => (
            <Text key={i}><Text dimColor>│</Text>  <Text dimColor>{line.substring(0, 100)}</Text></Text>
          ))}
          {hasMore && <Text><Text dimColor>│</Text>  <Text dimColor>... ({totalLines - 5} more lines)</Text></Text>}
          <Text><Text dimColor>╰─</Text> <Text color={statusColor}>{statusIcon}</Text></Text>
        </Box>
      );
    }

    case 'system':
      return <Text color="yellow">{msg.content}</Text>;

    case 'error':
      return <Text color="red">✗ {msg.content}</Text>;

    default:
      return <Text>{msg.content}</Text>;
  }
}

export function MessageHistory({ messages, collapseSettings }: { messages: UIMessage[]; collapseSettings: CollapseSettings }) {

  // Count tool messages for toolDisplayLimit calculation
  const toolMessages = messages.filter(m => m.type === 'tool');
  const totalTools = toolMessages.length;

  // Track tool index
  let toolIndex = 0;

  return (
    <Static items={messages}>
      {(msg) => {
        // For tool messages, pass index for collapse calculation
        const msgCollapseSettings = msg.type === 'tool'
          ? { ...collapseSettings, toolIndex: toolIndex++, totalTools }
          : collapseSettings;

        return (
          <Box key={msg.id}>
            <MessageItem msg={msg} collapse={msgCollapseSettings} />
          </Box>
        );
      }}
    </Static>
  );
}
