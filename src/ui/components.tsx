/**
 * UI Module - Utility Components
 *
 * Animated thinking displays, state transitions, streaming indicators.
 * Colors sourced from active palette, animations from active skin.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text, useStdout } from 'ink';
import { getCurrentSkin, getSpinnerFrames, getInkColor } from '../hud/api.js';
import { getThinkingPhrase, getToolLabel, getMoodText } from '../companions.js';
import type { ThinkingState, ActivityState } from './types.js';

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
// Thinking Animation Patterns
// ============================================================================

type AnimationStyle = 'wave' | 'neural' | 'circuit' | 'dna' | 'pulse-bar' | 'orbit' | 'cascade' | 'minimal';

/** Characters for each animation style */
const WAVE_CHARS = '  ░▒▓█▓▒░  ';
const NEURAL_NODES = ['◇', '◆', '○', '●', '◎', '◉'];
const CIRCUIT_CHARS = ['─', '┐', '│', '└', '─', '┌', '│', '┘'];
const DNA_LEFT =  ['╭', '│', '╰', ' ', ' ', '╭', '│', '╰'];
const DNA_RIGHT = [' ', ' ', '╭', '│', '╰', ' ', ' ', '╭'];
const DNA_BASES = ['A', 'T', 'G', 'C'];
const ORBIT_CHARS = [
  '    ◠    ',
  '  ◜   ◝  ',
  ' ◜  ●  ◝ ',
  '  ◟   ◞  ',
  '    ◡    ',
];

/** Generate a wave animation line */
function waveFrame(tick: number, width: number): string {
  let line = '';
  for (let x = 0; x < width; x++) {
    const phase = (x * 0.3 + tick * 0.4) % WAVE_CHARS.length;
    line += WAVE_CHARS[Math.floor(phase)] || ' ';
  }
  return line;
}

/** Generate neural network activity */
function neuralFrame(tick: number, width: number): string {
  let line = '';
  for (let x = 0; x < width; x++) {
    if (x % 4 === 0) {
      const nodeIdx = (tick + x) % NEURAL_NODES.length;
      line += NEURAL_NODES[nodeIdx];
    } else if (x % 4 === 2) {
      const active = ((tick + x * 3) % 7) < 3;
      line += active ? '─' : ' ';
    } else {
      line += ' ';
    }
  }
  return line;
}

/** Generate circuit trace pattern */
function circuitFrame(tick: number, width: number): string {
  let line = '';
  const pulsePos = tick % width;
  for (let x = 0; x < width; x++) {
    const charIdx = (x + tick) % CIRCUIT_CHARS.length;
    const dist = Math.abs(x - pulsePos);
    if (dist < 3) {
      line += CIRCUIT_CHARS[charIdx];
    } else if (x % 5 === 0) {
      line += '·';
    } else {
      line += ' ';
    }
  }
  return line;
}

/** Generate DNA helix pattern (2 lines) */
function dnaFrame(tick: number, _width: number): string[] {
  const len = 24;
  let top = ' ';
  let bot = ' ';
  for (let x = 0; x < len; x++) {
    const phase = (x + tick) % 8;
    const lt = DNA_LEFT[phase];
    const rt = DNA_RIGHT[phase];
    if (lt !== ' ' && rt !== ' ') {
      // Crossover — show a base pair
      const base = DNA_BASES[(x + tick) % DNA_BASES.length];
      top += lt + base;
      bot += rt + base;
    } else {
      top += lt + ' ';
      bot += rt + ' ';
    }
  }
  return [top, bot];
}

/** Generate an animated pulse bar */
function pulseBarFrame(tick: number, width: number): string {
  const barWidth = Math.min(width - 4, 32);
  let bar = '│';
  for (let x = 0; x < barWidth; x++) {
    const intensity = Math.sin((x / barWidth) * Math.PI + tick * 0.3);
    if (intensity > 0.8) bar += '█';
    else if (intensity > 0.5) bar += '▓';
    else if (intensity > 0.2) bar += '▒';
    else if (intensity > -0.2) bar += '░';
    else bar += ' ';
  }
  bar += '│';
  return bar;
}

/** Generate cascade / waterfall pattern */
function cascadeFrame(tick: number, width: number): string[] {
  const lines: string[] = [];
  const cascadeWidth = Math.min(width - 2, 36);
  for (let row = 0; row < 3; row++) {
    let line = '';
    for (let x = 0; x < cascadeWidth; x++) {
      const drop = ((x * 7 + row * 13 + tick * 3) % 23);
      if (drop < 2) line += '│';
      else if (drop < 4) line += '┊';
      else if (drop < 6) line += '·';
      else line += ' ';
    }
    lines.push(line);
  }
  return lines;
}

/** Pick animation style from skin config or infer from skin name */
function getAnimationStyle(): AnimationStyle {
  const skin = getCurrentSkin();
  // Explicit skin preference wins
  if (skin.animations?.thinkingStyle) return skin.animations.thinkingStyle;

  const skinName = skin.name.toLowerCase();
  // Infer from skin name / vibe
  if (skinName.includes('matrix') || skinName.includes('neo') || skinName.includes('hack'))
    return 'cascade';
  if (skinName.includes('retro') || skinName.includes('basic') || skinName.includes('arcade'))
    return 'circuit';
  if (skinName.includes('sci') || skinName.includes('trek') || skinName.includes('space'))
    return 'neural';
  if (skinName.includes('bio') || skinName.includes('nature') || skinName.includes('organic'))
    return 'dna';
  if (skinName.includes('minimal') || skinName.includes('clean'))
    return 'minimal';
  return 'wave';
}

// ============================================================================
// State Transition System
// ============================================================================

type TransitionPhase = 'enter' | 'active' | 'exit';

function useTransition(isActive: boolean, enterMs = 300, exitMs = 200): { phase: TransitionPhase; progress: number } {
  const [phase, setPhase] = useState<TransitionPhase>(isActive ? 'active' : 'exit');
  const [progress, setProgress] = useState(isActive ? 1 : 0);
  const startTime = useRef(Date.now());

  useEffect(() => {
    if (isActive && phase !== 'active') {
      setPhase('enter');
      startTime.current = Date.now();
    } else if (!isActive && phase === 'active') {
      setPhase('exit');
      startTime.current = Date.now();
    }
  }, [isActive]);

  useEffect(() => {
    if (phase === 'enter' || phase === 'exit') {
      const duration = phase === 'enter' ? enterMs : exitMs;
      const timer = setInterval(() => {
        const elapsed = Date.now() - startTime.current;
        const p = Math.min(1, elapsed / duration);
        setProgress(phase === 'enter' ? p : 1 - p);
        if (p >= 1) {
          setPhase(phase === 'enter' ? 'active' : 'exit');
          setProgress(phase === 'enter' ? 1 : 0);
          clearInterval(timer);
        }
      }, 30);
      return () => clearInterval(timer);
    }
  }, [phase]);

  return { phase, progress };
}

/** Build a transition-in wipe line */
function transitionWipe(text: string, progress: number): string {
  const visibleChars = Math.floor(text.length * progress);
  return text.slice(0, visibleChars) + ' '.repeat(Math.max(0, text.length - visibleChars));
}

// ============================================================================
// Elapsed Time Visualization
// ============================================================================

function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

/** Tiny progress dots that grow with time */
function elapsedDots(seconds: number): string {
  const filled = Math.min(seconds, 20);
  const dots = '·'.repeat(Math.max(0, 20 - filled)) + '•'.repeat(Math.min(filled, 10));
  return dots.slice(0, 20);
}

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
  const [elapsed, setElapsed] = useState(0);
  const startTime = useRef(Date.now());
  const spinFrames = getStateSpinner('thinking');
  const [immersionPhrase] = useState(() => getThinkingPhrase());
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

  const displayStatus = immersionPhrase || state.status;
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
    animLines = [ORBIT_CHARS[orbitIdx]];
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
        {state.iteration != null && state.maxIterations && (
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

export function ProcessingIndicator({ label }: { label: string }) {
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

/** A subtle scanning line effect */
function scanLine(tick: number, width: number): string {
  const pos = tick % (width * 2);
  const actual = pos < width ? pos : width * 2 - pos;
  let line = '';
  for (let x = 0; x < width; x++) {
    const dist = Math.abs(x - actual);
    if (dist === 0) line += '█';
    else if (dist === 1) line += '▓';
    else if (dist === 2) line += '▒';
    else if (dist === 3) line += '░';
    else line += '·';
  }
  return line;
}

/** Brief splash overlay shown when switching themes (auto-dismisses) */
export function SplashOverlay({ art, color, onDone }: { art: string[]; color: string; onDone: () => void }) {
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

export function StreamingIndicator({ activity }: { activity?: ActivityState }) {
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

// ============================================================================
// State Transition Overlay
// ============================================================================

/**
 * Renders a brief transition effect between processing states.
 * Mount when transitioning, unmount after onComplete fires.
 */
export function StateTransition({ from, to, onComplete }: {
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
          onComplete();
          return f;
        }
        return f + 1;
      });
    }, 40);
    return () => clearInterval(timer);
  }, []);

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
