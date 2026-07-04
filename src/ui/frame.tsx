/**
 * UI Module - HUD Frame
 *
 * Wraps the entire UI in a themed border frame with optional title bar,
 * corner decorations, and ambient animations.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { BoxProps } from 'ink';
import { getCurrentSkin, getInkColor } from '../hud/api.js';
import type { SkinFrame } from '../hud/types.js';

// ============================================================================
// HUDFrame Component
// ============================================================================

export interface HUDFrameProps {
  children: React.ReactNode;
  width?: number;
}

export function HUDFrame({ children, width }: HUDFrameProps) {
  const skin = getCurrentSkin();
  const frame = skin.frame;
  const frameEnabled = !!(frame?.enabled && frame.style !== 'none');

  // All hooks must be called before any conditional returns (React rules of hooks)
  const { stdout } = useStdout();
  const termWidth = width || stdout?.columns || 80;

  const borderColor = getInkColor('border');
  const animations = skin.animations;
  const [ambientColor, setAmbientColor] = useState(borderColor);

  useEffect(() => {
    if (animations?.ambient === 'pulse-border') {
      const accentColor = getInkColor('accent');
      let toggle = false;
      const timer = setInterval(() => {
        toggle = !toggle;
        setAmbientColor(toggle ? accentColor : borderColor);
      }, 2500);
      return () => clearInterval(timer);
    }
  }, [animations?.ambient]);

  // No frame configured — render children directly
  if (!frameEnabled) {
    return <>{children}</>;
  }

  // Resolve title bar content
  const titleText = resolveTitleText(frame);
  const showTitleTop = frame.titleBar?.enabled && frame.titleBar.position !== 'bottom';
  const showTitleBottom = frame.titleBar?.enabled && frame.titleBar.position === 'bottom';

  const effectiveBorderColor = animations?.ambient === 'pulse-border' ? ambientColor : borderColor;

  // NOTE: We intentionally do NOT wrap content in a bordered <Box>.
  // Ink re-renders by clearing and rewriting visible lines, but bordered boxes
  // that scroll off-screen leave artifacts in the scrollback buffer, causing
  // repeated frame borders. Instead, decorative elements are rendered inline.

  return (
    <>
      {/* Title bar at top */}
      {showTitleTop && titleText && (
        <TitleBar
          text={titleText}
          alignment={frame.titleBar?.alignment || 'center'}
          width={termWidth}
          borderColor={effectiveBorderColor}
          cornerDecor={frame.cornerDecor}
          frameStyle={frame.style}
        />
      )}

      {/* Main content — no border wrapping */}
      {children}

      {/* Title bar at bottom (above status bar) */}
      {showTitleBottom && titleText && (
        <TitleBar
          text={titleText}
          alignment={frame.titleBar?.alignment || 'center'}
          width={termWidth}
          borderColor={effectiveBorderColor}
          cornerDecor={frame.cornerDecor}
          frameStyle={frame.style}
        />
      )}
    </>
  );
}

// ============================================================================
// TitleBar Sub-component
// ============================================================================

interface TitleBarProps {
  text: string;
  alignment: 'left' | 'center' | 'right';
  width: number;
  borderColor: string;
  cornerDecor?: SkinFrame['cornerDecor'];
  frameStyle: string;
}

function TitleBar({ text, alignment, width, borderColor: bColor, cornerDecor, frameStyle }: TitleBarProps) {
  const accentColor = getInkColor('accent');

  // Build title string with decorative separators
  const maxTitleLen = Math.min(text.length, width - 6);
  const displayTitle = text.length > maxTitleLen ? text.slice(0, maxTitleLen - 1) + '\u2026' : text;

  let justifyContent: BoxProps['justifyContent'] = 'center';
  if (alignment === 'left') justifyContent = 'flex-start';
  if (alignment === 'right') justifyContent = 'flex-end';

  // Frame style influences the decorators around the title
  const leftDecor = frameStyle === 'hud-overlay'
    ? (cornerDecor?.topLeft || '[')
    : frameStyle === 'accent-bar'
      ? '\u2503 '
      : '\u2500\u2500 ';
  const rightDecor = frameStyle === 'hud-overlay'
    ? (cornerDecor?.topRight || ']')
    : frameStyle === 'accent-bar'
      ? ''
      : ' \u2500\u2500';
  const decorColor = frameStyle === 'accent-bar' ? accentColor : bColor;

  return (
    <Box justifyContent={justifyContent} paddingX={1}>
      <Text color={decorColor} dimColor>{leftDecor}</Text>
      <Text color={accentColor} bold>{displayTitle}</Text>
      {rightDecor && <Text color={decorColor} dimColor>{rightDecor}</Text>}
    </Box>
  );
}

// ============================================================================
// Helpers
// ============================================================================

function resolveTitleText(frame: SkinFrame): string {
  if (!frame.titleBar?.enabled) return '';

  switch (frame.titleBar.content) {
    case 'skin-name':
      return getCurrentSkin().name;
    case 'custom':
      return frame.titleBar.customText || '';
    default:
      return getCurrentSkin().name;
  }
}
