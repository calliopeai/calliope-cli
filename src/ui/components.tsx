/**
 * UI Module - Utility Components
 *
 * Small display components: separators, spinners, indicators.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import { getCurrentSkin, getSpinnerFrames } from '../hud.js';
import { getThinkingPhrase, getToolLabel, getMoodText } from '../companions.js';
import type { ThinkingState, ActivityState } from './types.js';

// ============================================================================
// Constants
// ============================================================================

// Skin-aware: banner lines and spinner frames come from current skin
export function getBannerLines(): string[] {
  return getCurrentSkin().banner.art;
}

export function getSkinSpinnerFrames(): string[] {
  return getSpinnerFrames();
}

// Fallback constants (used if skin not yet loaded)
export const DEFAULT_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ============================================================================
// Components
// ============================================================================

export function Separator() {
  const { stdout } = useStdout();
  const width = stdout?.columns || 80;
  return <Text dimColor>{'─'.repeat(width)}</Text>;
}

export function ThinkingDisplay({ state }: { state: ThinkingState }) {
  const [frame, setFrame] = useState(0);
  const spinFrames = getSkinSpinnerFrames();
  // Use companion's thinking phrase if available, otherwise default status
  const [immersionPhrase] = useState(() => getThinkingPhrase());

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % spinFrames.length);
    }, 80);
    return () => clearInterval(timer);
  }, [spinFrames.length]);

  const displayStatus = immersionPhrase || state.status;

  return (
    <Box flexDirection="column">
      {/* Main status line */}
      <Box>
        <Text color="cyan">{spinFrames[frame % spinFrames.length]}</Text>
        <Text> {displayStatus}</Text>
        {state.iteration != null && state.maxIterations && (
          <Text dimColor> ({state.iteration}/{state.maxIterations})</Text>
        )}
      </Box>

      {/* Detail line — show companion tool label if available */}
      {state.detail && (
        <Box marginLeft={2}>
          <Text dimColor>↳ {state.detail}</Text>
        </Box>
      )}

      {/* Thinking output (from think tool) */}
      {state.thinking && (
        <Box flexDirection="column" marginLeft={2}>
          <Text color="magenta">Thinking:</Text>
          {state.thinking.split('\n').slice(0, 5).map((line, i) => (
            <Text key={i} dimColor>   {line.substring(0, 80)}</Text>
          ))}
          {state.thinking.split('\n').length > 5 && (
            <Text dimColor>   ...</Text>
          )}
        </Box>
      )}
    </Box>
  );
}

// Legacy simple indicator for non-agent operations
export function ProcessingIndicator({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);
  const spinFrames = getSkinSpinnerFrames();

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % spinFrames.length);
    }, 80);
    return () => clearInterval(timer);
  }, [spinFrames.length]);

  return (
    <Box>
      <Text color="cyan">{spinFrames[frame % spinFrames.length]}</Text>
      <Text dimColor> {label}</Text>
    </Box>
  );
}

// Indicator shown during streaming to show current activity
export function StreamingIndicator({ activity }: { activity?: ActivityState }) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const pulseFrames = ['·', '•', '●', '•'];

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % pulseFrames.length);
      if (activity) {
        setElapsed(Math.floor((Date.now() - activity.startTime) / 1000));
      }
    }, 200);
    return () => clearInterval(timer);
  }, [activity]);

  if (activity) {
    const elapsedStr = elapsed > 0 ? ` (${elapsed}s)` : '';
    return (
      <Box flexDirection="column">
        <Box>
          <Text color="cyan">{pulseFrames[frame]}</Text>
          <Text> {activity.action}</Text>
          {activity.target && <Text dimColor> {activity.target}</Text>}
          <Text dimColor>{elapsedStr}</Text>
        </Box>
      </Box>
    );
  }

  return (
    <Box>
      <Text color="green">{pulseFrames[frame]}</Text>
      <Text dimColor> receiving...</Text>
    </Box>
  );
}
