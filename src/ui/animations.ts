/**
 * UI Module - Animation Helpers
 *
 * Pure frame generators, the transition hook, and elapsed-time formatting used
 * by the presentational components in components.tsx. Extracted so components.tsx
 * stays a focused component file; this module carries no JSX.
 */

import { useState, useEffect, useRef } from 'react';
import { getCurrentSkin } from '../hud/api.js';

// ============================================================================
// Thinking Animation Patterns
// ============================================================================

export type AnimationStyle = 'wave' | 'neural' | 'circuit' | 'dna' | 'pulse-bar' | 'orbit' | 'cascade' | 'minimal';

/** Characters for each animation style */
const WAVE_CHARS = '  ░▒▓█▓▒░  ';
const NEURAL_NODES = ['◇', '◆', '○', '●', '◎', '◉'];
const CIRCUIT_CHARS = ['─', '┐', '│', '└', '─', '┌', '│', '┘'];
const DNA_LEFT =  ['╭', '│', '╰', ' ', ' ', '╭', '│', '╰'];
const DNA_RIGHT = [' ', ' ', '╭', '│', '╰', ' ', ' ', '╭'];
const DNA_BASES = ['A', 'T', 'G', 'C'];
export const ORBIT_CHARS = [
  '    ◠    ',
  '  ◜   ◝  ',
  ' ◜  ●  ◝ ',
  '  ◟   ◞  ',
  '    ◡    ',
];

/** Generate a wave animation line */
export function waveFrame(tick: number, width: number): string {
  let line = '';
  for (let x = 0; x < width; x++) {
    const phase = (x * 0.3 + tick * 0.4) % WAVE_CHARS.length;
    line += WAVE_CHARS[Math.floor(phase)] || ' ';
  }
  return line;
}

/** Generate neural network activity */
export function neuralFrame(tick: number, width: number): string {
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
export function circuitFrame(tick: number, width: number): string {
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
export function dnaFrame(tick: number, _width: number): string[] {
  const len = 24;
  let top = ' ';
  let bot = ' ';
  for (let x = 0; x < len; x++) {
    const phase = (x + tick) % 8;
    const lt = DNA_LEFT[phase]!;
    const rt = DNA_RIGHT[phase]!;
    if (lt !== ' ' && rt !== ' ') {
      // Crossover — show a base pair
      const base = DNA_BASES[(x + tick) % DNA_BASES.length]!;
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
export function pulseBarFrame(tick: number, width: number): string {
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
export function cascadeFrame(tick: number, width: number): string[] {
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

/** A subtle scanning line effect */
export function scanLine(tick: number, width: number): string {
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

/** Pick animation style from skin config or infer from skin name */
export function getAnimationStyle(): AnimationStyle {
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

export function useTransition(isActive: boolean, enterMs = 300, exitMs = 200): { phase: TransitionPhase; progress: number } {
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
    return undefined;
  }, [phase]);

  return { phase, progress };
}

/** Build a transition-in wipe line */
export function transitionWipe(text: string, progress: number): string {
  const visibleChars = Math.floor(text.length * progress);
  return text.slice(0, visibleChars) + ' '.repeat(Math.max(0, text.length - visibleChars));
}

// ============================================================================
// Elapsed Time Visualization
// ============================================================================

export function formatElapsed(seconds: number): string {
  if (seconds < 60) return `${seconds}s`;
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}m${s.toString().padStart(2, '0')}s`;
}

/** Tiny progress dots that grow with time */
export function elapsedDots(seconds: number): string {
  const filled = Math.min(seconds, 20);
  const dots = '·'.repeat(Math.max(0, 20 - filled)) + '•'.repeat(Math.min(filled, 10));
  return dots.slice(0, 20);
}
