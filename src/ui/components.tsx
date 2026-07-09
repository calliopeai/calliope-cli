/**
 * UI Module - Utility Components
 *
 * Animated thinking displays, state transitions, streaming indicators.
 * Colors sourced from active palette, animations from active skin. Pure frame
 * generators and the transition hook live in animations.ts.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useStdout } from 'ink';
import { getCurrentSkin, getSpinnerFrames, getInkColor } from '../hud/api.js';
import type { ThinkingState, ActivityState } from './types.js';
import {
  waveFrame, neuralFrame, circuitFrame, dnaFrame, pulseBarFrame, cascadeFrame,
  scanLine, getAnimationStyle, useTransition, transitionWipe, formatElapsed,
  elapsedDots, ORBIT_CHARS,
} from './animations.js';

// ============================================================================
// Constants & Helpers
// ============================================================================

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
  return state === 'streaming' ? DEFAULT_PULSE : getSpinnerFrames();
}

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

function ThinkingDisplayInner({ state }: { state: ThinkingState }) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const startTime = useRef(Date.now());
  const spinFrames = getStateSpinner('thinking');
  const [animStyle] = useState(() => getAnimationStyle());
  const { stdout } = useStdout();
  const termWidth = stdout?.columns || 80;
  const primaryColor = getInkColor('primary');
  const accentColor = getInkColor('accent');
  const secondaryColor = getInkColor('secondary');
  const { phase, progress } = useTransition(true);

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => f + 1);
      setElapsed(Math.floor((Date.now() - startTime.current) / 1000));
    }, 80);
    return () => clearInterval(timer);
  }, []);

  const displayStatus = state.status;
  const animWidth = Math.min(termWidth - 4, 40);

  // Build animation lines based on style
  let animLines: string[] = [];
  if (animStyle === 'wave') {
    animLines = [waveFrame(frame, animWidth)];
  } else if (animStyle === 'neural') {
    animLines = [neuralFrame(frame, animWidth)];
  } else if (animStyle === 'circuit') {
    animLines = [circuitFrame(frame, animWidth)];
  } else if (animStyle === 'dna') {
    animLines = dnaFrame(frame, animWidth);
  } else if (animStyle === 'pulse-bar') {
    animLines = [pulseBarFrame(frame, animWidth)];
  } else if (animStyle === 'cascade') {
    animLines = cascadeFrame(frame, animWidth);
  } else if (animStyle === 'orbit') {
    const orbitIdx = frame % ORBIT_CHARS.length;
    animLines = [ORBIT_CHARS[orbitIdx]!];
  }
  // 'minimal' — no animation lines

  // Apply enter transition (wipe in)
  if (phase === 'enter') {
    animLines = animLines.map(l => transitionWipe(l, progress));
  }

  return (
    <Box flexDirection="column">
      {/* Main spinner + status line */}
      <Box>
        <Text color={primaryColor}>{spinFrames[frame % spinFrames.length]}</Text>
        <Text color={primaryColor} bold> {displayStatus}</Text>
        {state.iteration != null && state.maxIterations && Number.isFinite(state.maxIterations) && (
          <Text dimColor> ({state.iteration}/{state.maxIterations})</Text>
        )}
        {elapsed > 0 && (
          <Text dimColor> {formatElapsed(elapsed)}</Text>
        )}
      </Box>

      {/* Animation visualization */}
      {animStyle !== 'minimal' && animLines.length > 0 && (
        <Box flexDirection="column" marginLeft={2}>
          {animLines.map((line, i) => (
            <Text key={i} color={secondaryColor} dimColor>{line}</Text>
          ))}
        </Box>
      )}

      {/* Elapsed progress dots */}
      {elapsed > 2 && (
        <Box marginLeft={2}>
          <Text color={accentColor} dimColor>{elapsedDots(elapsed)}</Text>
        </Box>
      )}

      {/* Detail line */}
      {state.detail && (
        <Box marginLeft={2}>
          <Text dimColor>↳ {state.detail}</Text>
        </Box>
      )}

      {/* Think tool output */}
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

// Memoized so unrelated parent re-renders (streaming chunks, stats ticks) don't
// re-run the animation build between its own timer frames.
export const ThinkingDisplay = React.memo(ThinkingDisplayInner);

function ProcessingIndicatorInner({ label }: { label: string }) {
  const [frame, setFrame] = useState(0);
  const spinFrames = getStateSpinner('processing');
  const primaryColor = getInkColor('primary');
  const secondaryColor = getInkColor('secondary');

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => f + 1);
    }, 80);
    return () => clearInterval(timer);
  }, []);

  // Animated ellipsis
  const dots = '.'.repeat((frame % 12) < 3 ? 1 : (frame % 12) < 6 ? 2 : (frame % 12) < 9 ? 3 : 0);

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={primaryColor}>{spinFrames[frame % spinFrames.length]}</Text>
        <Text dimColor> {label}{dots}</Text>
      </Box>
      {/* Subtle scan line */}
      <Box marginLeft={2}>
        <Text color={secondaryColor} dimColor>{scanLine(frame, 24)}</Text>
      </Box>
    </Box>
  );
}

export const ProcessingIndicator = React.memo(ProcessingIndicatorInner);

/** Brief splash overlay shown when switching themes (auto-dismisses) */
function SplashOverlayInner({ art, color, onDone }: { art: string[]; color: string; onDone: () => void }) {
  const [visibleLines, setVisibleLines] = useState(0);

  useEffect(() => {
    // Typewriter entry: reveal one line at a time
    if (visibleLines < art.length) {
      const timer = setTimeout(() => setVisibleLines(v => v + 1), 60);
      return () => clearTimeout(timer);
    }
    // Hold then dismiss
    const timer = setTimeout(onDone, 800);
    return () => clearTimeout(timer);
  }, [visibleLines, art.length, onDone]);

  return (
    <Box flexDirection="column" justifyContent="center" alignItems="center" marginY={1}>
      {art.slice(0, visibleLines).map((line, i) => (
        <Text key={i} color={color}>{line}</Text>
      ))}
    </Box>
  );
}

export const SplashOverlay = React.memo(SplashOverlayInner);

function StreamingIndicatorInner({ activity }: { activity?: ActivityState }) {
  const [frame, setFrame] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const pulseFrames = getStateSpinner('streaming');
  const primaryColor = getInkColor('primary');
  const successColor = getInkColor('success');
  const accentColor = getInkColor('accent');

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => f + 1);
      if (activity) {
        setElapsed(Math.floor((Date.now() - activity.startTime) / 1000));
      }
    }, 150);
    return () => clearInterval(timer);
  }, [activity]);

  // Flowing stream visualization
  const streamChars = '─═─═─═─═─═─═─═─═─═─═';
  const streamPos = frame % streamChars.length;
  const streamVis = streamChars.slice(streamPos, streamPos + 12).padEnd(12, '─');

  if (activity) {
    const elapsedStr = elapsed > 0 ? ` ${formatElapsed(elapsed)}` : '';
    return (
      <Box flexDirection="column">
        <Box>
          <Text color={primaryColor}>{pulseFrames[frame % pulseFrames.length]}</Text>
          <Text bold> {activity.action}</Text>
          {activity.target && <Text dimColor> {activity.target}</Text>}
          <Text dimColor>{elapsedStr}</Text>
        </Box>
        {/* Stream flow visualization */}
        <Box marginLeft={2}>
          <Text color={accentColor} dimColor>{streamVis}</Text>
        </Box>
        {activity.detail && <Text dimColor>  {activity.detail}</Text>}
      </Box>
    );
  }

  return (
    <Box flexDirection="column">
      <Box>
        <Text color={successColor}>{pulseFrames[frame % pulseFrames.length]}</Text>
        <Text dimColor> receiving</Text>
        <Text color={accentColor} dimColor> {streamVis}</Text>
      </Box>
    </Box>
  );
}

export const StreamingIndicator = React.memo(StreamingIndicatorInner);

// ============================================================================
// State Transition Overlay
// ============================================================================

/**
 * Renders a brief transition effect between processing states.
 * Mount when transitioning, unmount after onComplete fires.
 */
function StateTransitionInner({ from, to, onComplete }: {
  from: 'idle' | 'thinking' | 'streaming' | 'done';
  to: 'idle' | 'thinking' | 'streaming' | 'done';
  onComplete: () => void;
}) {
  const [frame, setFrame] = useState(0);
  const totalFrames = 8;
  const primaryColor = getInkColor('primary');
  const successColor = getInkColor('success');

  useEffect(() => {
    const timer = setInterval(() => {
      setFrame(f => {
        if (f + 1 >= totalFrames) {
          clearInterval(timer);
          return totalFrames;
        }
        return f + 1;
      });
    }, 40);
    return () => clearInterval(timer);
  }, []);

  // Call onComplete after frame state settles (not inside updater — avoids setState-during-render)
  useEffect(() => {
    if (frame >= totalFrames) {
      onComplete();
    }
  }, [frame]);

  const progress = frame / totalFrames;
  const width = 24;

  // Different transition effects based on state change
  if (to === 'thinking') {
    // Expand-in: growing bar
    const filled = Math.floor(width * progress);
    const bar = '▓'.repeat(filled) + '░'.repeat(width - filled);
    return (
      <Box>
        <Text color={primaryColor}>{bar}</Text>
      </Box>
    );
  }

  if (to === 'streaming') {
    // Dissolve: thinking pattern breaks apart
    let line = '';
    for (let x = 0; x < width; x++) {
      const dissolve = Math.random() < progress;
      line += dissolve ? '·' : '▒';
    }
    return (
      <Box>
        <Text color={primaryColor} dimColor>{line}</Text>
      </Box>
    );
  }

  if (to === 'done') {
    // Flash success
    const flash = progress < 0.5 ? '✓'.padStart(Math.floor(width / 2)) : '';
    return (
      <Box>
        <Text color={successColor} bold>{flash}</Text>
      </Box>
    );
  }

  // Fade out (to idle)
  const opacity = 1 - progress;
  const fadeBar = opacity > 0.5 ? '─'.repeat(width) : opacity > 0.2 ? '·'.repeat(width) : '';
  return (
    <Box>
      <Text dimColor>{fadeBar}</Text>
    </Box>
  );
}

export const StateTransition = React.memo(StateTransitionInner);
