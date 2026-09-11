import React, { useEffect, useState } from 'react';
import { Box, Text } from 'ink';
import type { ActivityState } from '../types.js';
export function ToolActivity({ activity }: { activity: ActivityState }) {
  const [now, setNow] = useState(Date.now);
  useEffect(() => { const timer = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(timer); }, []);
  return <Box flexDirection="column">
    <Text color="cyan">Status · {activity.action}</Text>
    {activity.tools?.map(tool => <Text key={tool.id}>{tool.name} · {tool.phase === 'pending' ? 'checking permission' : tool.phase} · {Math.max(0, Math.floor((now - tool.startTime) / 1000))}s{tool.detail ? ` · ${tool.detail}` : ''}</Text>)}
    {!!activity.omittedTools && <Text dimColor>{activity.omittedTools} more active tools</Text>}
  </Box>;
}
