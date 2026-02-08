/**
 * UI Module - Status Bar
 *
 * Footer status bar showing provider, model, context, cost, and mode.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { MODE_CONFIG } from '../types.js';
import type { LLMProvider, Mode } from '../types.js';
import { getModelContextLimit } from '../model-detection.js';
import { Separator } from './components.js';
import type { SessionStats } from './types.js';

// ============================================================================
// StatusBar Component
// ============================================================================

export function StatusBar({
  provider,
  model,
  stats,
  mode,
  contextTokens,
}: {
  provider: string;
  model: string;
  stats: SessionStats;
  mode: Mode;
  contextTokens: number;
}) {
  const formatTokens = (n: number) => n >= 1000 ? `${(n/1000).toFixed(1)}K` : String(n);
  const formatCost = (c: number) => c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`;
  const displayModel = model.length > 25 ? model.slice(0, 22) + '...' : model;
  const modeConfig = MODE_CONFIG[mode];

  // Context usage indicator - uses model's actual context length from API
  const contextLimit = getModelContextLimit(provider as LLMProvider, model);
  const contextPct = Math.min(100, Math.round((contextTokens / contextLimit) * 100));
  const contextColor = contextPct > 80 ? 'red' : contextPct > 50 ? 'yellow' : 'green';

  return (
    <Box flexDirection="column">
      <Separator />
      <Text dimColor>
        {modeConfig.icon} {modeConfig.label}
        {' │ '}
        {provider}:{displayModel}
        {' │ '}
        <Text color={contextColor}>{formatTokens(contextTokens)}/{formatTokens(contextLimit)}</Text>
        {' │ '}
        {formatTokens(stats.inputTokens + stats.outputTokens)} used
        {' │ '}
        {formatCost(stats.cost)}
        {' │ '}
        <Text dimColor>Esc: exit</Text>
      </Text>
    </Box>
  );
}
