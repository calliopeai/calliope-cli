/**
 * UI Module - Utility Components
 *
 * Small display components: separators, spinners, indicators.
 * Colors sourced from active palette.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import { getCurrentSkin, getSpinnerFrames, getInkColor } from '../hud/api.js';
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

const DEFAULT_PULSE = ['·', '•', '●', '•'];

/** Get spinner frames for a specific state, falling back to skin default */
export function getStateSpinner(state: 'thinking' | 'processing' | 'streaming'): string[] {
  const skin = getCurrentSkin();
  const anims = skin.animations;
  if (state === 'thinking' && anims?.thinkingSpinner?.length) return anims.thinkingSpinner;
  if (state === 'processing' && anims?.processingSpinner?.length) return anims.processingSpinner;
  if (state === 'streaming' && anims?.streamingPulse?.length) return anims.streamingPulse;
  // Streaming uses pulse pattern by default, others use skin spinner
  return state === 'streaming' ? DEFAULT_PULSE : getSpinnerFrames();
}

// Fallback constants (used if skin not yet loaded)
export const DEFAULT_SPINNER = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

// ============================================================================
// Components
// ============================================================================

export function Separator() {
  const { stdout } = useStdout();
  const width = stdout?.columns || 80;
  const borderColor = getInkColor('border');
  return <Text color={borderColor} dimColor>{'─'.repeat(width)}</Text>;
}

export function ThinkingDisplay({ state }: { state: ThinkingState }) {
  const [frame, setFrame] = useState(0);
  const spinFrames = getStateSpinner('thinking');
  const [immersionPhrase] = useState(() => getThinkingPhrase());
  const primaryColor = getInkColor('primary');
  const accentColor = getInkColor('accent');

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % spinFrames.length);
    }, 80);
    return () => clearInterval(timer);
  }, [spinFrames.length]);

  const displayStatus = immersionPhrase || state.status;

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={primaryColor}>{spinFrames[frame % spinFrames.length]}</Text>
        <Text> {displayStatus}</Text>
        {state.iteration != null && state.maxIterations && (
          <Text dimColor> ({state.iteration}/{state.maxIterations})</Text>
        )}
      </Box>
      {state.detail && (
        <Box marginLeft={2}>
          <Text dimColor>↳ {state.detail}</Text>
        </Box>
      )}
      {state.thinking && (
        <Box flexDirection="column" marginLeft={2}>
          <Text color={accentColor}>Thinking:</Text>
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

export function ProcessingIndicator({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);
  const spinFrames = getStateSpinner('processing');
  const primaryColor = getInkColor('primary');

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => (f + 1) % spinFrames.length);
    }, 80);
    return () => clearInterval(timer);
  }, [spinFrames.length]);

  return (
    <Box>
      <Text color={primaryColor}>{spinFrames[frame % spinFrames.length]}</Text>
      <Text dimColor> {label}</Text>
    </Box>
  );
}

/** Brief splash overlay shown when switching themes (auto-dismisses) */
export function SplashOverlay({ art, color, onDone }: { art: string[]; color: string; onDone: () => void }) {
  useEffect(() => {
    const timer = setTimeout(onDone, 1200);
    return () => clearTimeout(timer);
  }, [onDone]);

  return (
    <Box flexDirection="column" justifyContent="center" alignItems="center" marginY={1}>
      {art.map((line, i) => (
        <Text key={i} color={color}>{line}</Text>
      ))}
    </Box>
  );
}

export function StreamingIndicator({ activity }: { activity?: ActivityState }) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const pulseFrames = getStateSpinner('streaming');
  const primaryColor = getInkColor('primary');
  const successColor = getInkColor('success');

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
          <Text color={primaryColor}>{pulseFrames[frame]}</Text>
          <Text> {activity.action}</Text>
          {activity.target && <Text dimColor> {activity.target}</Text>}
          <Text dimColor>{elapsedStr}</Text>
        </Box>
        {activity.detail && <Text dimColor>  {activity.detail}</Text>}
      </Box>
    );
  }

  return (
    <Box>
      <Text color={successColor}>{pulseFrames[frame]}</Text>
      <Text dimColor> receiving...</Text>
    </Box>
  );
}
