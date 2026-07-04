/**
 * UI Module - Status Bar
 *
 * Footer status bar showing provider, model, context, cost, mode,
 * circuit breaker health, and smart routing status.
 * Colors sourced from active palette.
 */

import React from 'react';
import { Box, Text } from 'ink';
import { MODE_CONFIG } from '../types.js';
import type { LLMProvider, Mode } from '../types.js';
import { getModelContextLimit } from '../model-detection.js';
import { Separator } from './components.js';
import { getInkColor } from '../hud/api.js';
import { getGitStatus } from '../git-status.js';
import type { SessionStats } from './types.js';

// ============================================================================
// Token Count Formatter
// ============================================================================

export function formatTokenCount(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

// ============================================================================
// StatusBar Component
// ============================================================================

function StatusBarInner({
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
  const maxModelLen = termWidth < 80 ? 12 : termWidth < 120 ? 20 : 25;
  const displayModel = model.length > maxModelLen ? model.slice(0, maxModelLen - 3) + '...' : model;
  const modeConfig = MODE_CONFIG[mode];

  // Palette colors
  const successColor = getInkColor('success');
  const warningColor = getInkColor('warning');
  const errorColor = getInkColor('error');
  const accentColor = getInkColor('accent');
  const primaryColor = getInkColor('primary');

  // Context usage indicator
  const contextLimit = getModelContextLimit(provider as LLMProvider, model);
  const contextPct = Math.min(100, Math.round((contextTokens / contextLimit) * 100));
  const contextColor = contextPct > 80 ? errorColor : contextPct > 50 ? warningColor : successColor;

  // Circuit breaker health indicator
  const healthIndicator = breakerHealth === 'tripped'
    ? <Text color={errorColor}>[TRIP]</Text>
    : breakerHealth === 'warning'
    ? <Text color={warningColor}>[!]</Text>
    : <Text color={successColor}>[OK]</Text>;

  const isNarrow = termWidth < 80;

  // Git status (cached, only computed when not narrow)
  const gitInfo = !isNarrow ? getGitStatus() : null;
  const gitBranch = gitInfo?.branch ?? null;

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
          {formatTokenCount(stats.inputTokens)}↑ {formatTokenCount(stats.outputTokens)}↓
        </>}
        {' │ '}
        {formatCost(stats.cost)}
        {gitBranch ? <>{' │ '}<Text dimColor>{gitBranch}{gitInfo!.dirty ? '*' : ''}</Text></> : null}
        {breakerHealth ? <>{' │ '}{healthIndicator}</> : null}
        {smartRouteActive ? <>{' │ '}<Text color={accentColor}>SMART</Text></> : null}
      </Text>
    </Box>
  );
}

// Memoized so input keystrokes don't re-render the status bar. Git/stats refresh
// when any prop (most commonly stats) ticks during agent activity.
export const StatusBar = React.memo(StatusBarInner);
