/**
 * UI Module - Status Bar
 *
 * Footer status bar showing provider, model, context, cost, mode,
 * circuit breaker health, and smart routing status.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { MODE_CONFIG } from '../types.js';
import type { LLMProvider, Mode } from '../types.js';
import { getModelContextLimit } from '../model-detection.js';
import { Separator } from './components.js';
import { getMoodText, getCurrentCompanion } from '../companions.js';
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
  breakerHealth,
  smartRouteActive,
  width,
}: {
  provider: string;
  model: string;
  stats: SessionStats;
  mode: Mode;
  contextTokens: number;
  breakerHealth?: 'ok' | 'warning' | 'tripped';
  smartRouteActive?: boolean;
  width?: number;
}) {
  const termWidth = width || process.stdout.columns || 80;
  const formatTokens = (n: number) => n >= 1000 ? `${(n/1000).toFixed(1)}K` : String(n);
  const formatCost = (c: number) => c < 0.01 ? '<$0.01' : `$${c.toFixed(2)}`;
  // Adaptive model name truncation based on terminal width
  const maxModelLen = termWidth < 80 ? 12 : termWidth < 120 ? 20 : 25;
  const displayModel = model.length > maxModelLen ? model.slice(0, maxModelLen - 3) + '...' : model;
  const modeConfig = MODE_CONFIG[mode];

  // Context usage indicator - uses model's actual context length from API
  const contextLimit = getModelContextLimit(provider as LLMProvider, model);
  const contextPct = Math.min(100, Math.round((contextTokens / contextLimit) * 100));
  const contextColor = contextPct > 80 ? 'red' : contextPct > 50 ? 'yellow' : 'green';

  // Circuit breaker health indicator
  const healthIndicator = breakerHealth === 'tripped'
    ? <Text color="red">[TRIP]</Text>
    : breakerHealth === 'warning'
    ? <Text color="yellow">[!]</Text>
    : <Text color="green">[OK]</Text>;

  // Compact mode for narrow terminals
  const isNarrow = termWidth < 80;

  return (
    <Box flexDirection="column">
      <Separator />
      <Text dimColor wrap="truncate-end">
        {modeConfig.icon} {modeConfig.label}
        {' │ '}
        {provider}:{displayModel}
        {' │ '}
        <Text color={contextColor}>{formatTokens(contextTokens)}/{formatTokens(contextLimit)}</Text>
        {isNarrow ? null : <>
          {' │ '}
          {formatTokens(stats.inputTokens + stats.outputTokens)} used
        </>}
        {' │ '}
        {formatCost(stats.cost)}
        {breakerHealth ? <>{' │ '}{healthIndicator}</> : null}
        {smartRouteActive ? <>{' │ '}<Text color="cyan">SMART</Text></> : null}
        {isNarrow ? null : <>
          {' │ '}
          <Text dimColor>{getMoodText()}</Text>
        </>}
      </Text>
    </Box>
  );
}
