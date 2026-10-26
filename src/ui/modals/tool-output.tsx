import React, { useMemo, useState } from 'react';
import { Box, Text, useInput, useWindowSize } from 'ink';
import type { CapturedToolOutput } from '../../sessions/index.js';
import { approvalDisplayText } from '../../approvals/index.js';
import { wrapToolOutput } from '../tool-output-wrap.js';

/** Expand in the live modal zone; previously emitted scrollback stays immutable. */
export function ToolOutputViewer({ output, onClose }: { output: CapturedToolOutput; onClose: () => void }) {
  const { columns, rows: terminalRows } = useWindowSize();
  const viewport = { width: Math.max(10, columns - 8), rows: Math.max(3, Math.min(30, terminalRows - 8)) };
  const [expanded, setExpanded] = useState(true), [page, setPage] = useState(0);
  const rows = useMemo(() => wrapToolOutput(approvalDisplayText(output.record.content), viewport.width), [output.record.content, viewport.width]);
  const pages = Math.max(1, Math.ceil(rows.length / viewport.rows)), current = Math.min(page, pages - 1);
  useInput((input, key) => {
    if (key.escape || input === 'q') onClose();
    else if (input === 'e' || key.return) setExpanded(value => !value);
    else if (input === 'n' || key.pageDown || key.downArrow) setPage(value => Math.min(pages - 1, value + 1));
    else if (input === 'p' || key.pageUp || key.upArrow) setPage(value => Math.max(0, value - 1));
  });
  return <Box flexDirection="column" borderStyle="round" paddingX={1}>
    <Text bold>{output.record.channel === 'thinking' ? 'Thinking tool' : 'Tool output'}: {output.record.tool} — {output.record.isError ? 'failed' : 'completed'}</Text>
    <Text dimColor>{output.record.id} | {output.record.createdAt}</Text>
    {(expanded ? rows.slice(current * viewport.rows, (current + 1) * viewport.rows) : rows.slice(0, 3)).map((line, index) => <Text key={index}>{line}</Text>)}
    <Text dimColor>{expanded ? `Page ${current + 1}/${pages}` : 'Collapsed'} | [E/Enter] {expanded ? 'Collapse' : 'Expand'} | [N/P] Next/previous | [Esc] Close</Text>
    {output.record.truncated && <Text color="yellow">Output was truncated at the storage limit ({output.record.sourceChars} source characters).</Text>}
    {!output.saved && <Text color="yellow">Available in this transcript only; saving failed.</Text>}
  </Box>;
}
