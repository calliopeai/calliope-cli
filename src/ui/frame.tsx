/**
 * UI Module - HUD Frame
 *
 * Wraps the entire UI in a themed border frame with optional title bar,
 * corner decorations, and ambient animations.
 */

import React, { useState, useEffect } from 'react';
import { Box, Text, useStdout } from 'ink';
import type { BoxProps } from 'ink';
import { getCurrentSkin, getInkBorderStyle, getInkColor } from '../hud.js';
import { getCurrentCompanion } from '../companions.js';
import type { SkinFrame } from '../hud.js';

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

  // No frame configured — render children directly
  if (!frame?.enabled || frame.style === 'none') {
    return <>{children}</>;
  }

  const { stdout } = useStdout();
  const termWidth = width || stdout?.columns || 80;

  // Resolve border style
  const borderColor = getInkColor('border');
  const bStyle = getInkBorderStyle(skin) as BoxProps['borderStyle'];

  // Resolve title bar content
  const titleText = resolveTitleText(frame);
  const showTitleTop = frame.titleBar?.enabled && frame.titleBar.position !== 'bottom';
  const showTitleBottom = frame.titleBar?.enabled && frame.titleBar.position === 'bottom';

  // Ambient animation state
  const [ambientColor, setAmbientColor] = useState(borderColor);
  const animations = skin.animations;

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

  const effectiveBorderColor = animations?.ambient === 'pulse-border' ? ambientColor : borderColor;

  // Frame style determines which borders to render
  const frameBox = (content: React.ReactNode) => {
    switch (frame.style) {
      case 'full':
        return (
          <Box flexDirection="column" width={termWidth}
            borderStyle={bStyle} borderColor={effectiveBorderColor}>
            {content}
          </Box>
        );
      case 'top-bottom':
        return (
          <Box flexDirection="column" width={termWidth}
            borderStyle={bStyle} borderColor={effectiveBorderColor}
            borderLeft={false} borderRight={false}>
            {content}
          </Box>
        );
      case 'sides':
        return (
          <Box flexDirection="column" width={termWidth}
            borderStyle={bStyle} borderColor={effectiveBorderColor}
            borderTop={false} borderBottom={false}>
            {content}
          </Box>
        );
      default:
        return <Box flexDirection="column" width={termWidth}>{content}</Box>;
    }
  };

  return frameBox(
    <>
      {/* Title bar at top */}
      {showTitleTop && titleText && (
        <TitleBar text={titleText} alignment={frame.titleBar?.alignment || 'center'} width={termWidth - 2} />
      )}

      {/* Main content */}
      {children}

      {/* Title bar at bottom (above status bar) */}
      {showTitleBottom && titleText && (
        <TitleBar text={titleText} alignment={frame.titleBar?.alignment || 'center'} width={termWidth - 2} />
      )}
    </>
  );
}

// ============================================================================
// TitleBar Sub-component
// ============================================================================

function TitleBar({ text, alignment, width }: { text: string; alignment: 'left' | 'center' | 'right'; width: number }) {
  const accentColor = getInkColor('accent');
  const borderColor = getInkColor('border');

  // Build title string with decorative separators
  const maxTitleLen = Math.min(text.length, width - 6);
  const displayTitle = text.length > maxTitleLen ? text.slice(0, maxTitleLen - 1) + '\u2026' : text;

  let justifyContent: BoxProps['justifyContent'] = 'center';
  if (alignment === 'left') justifyContent = 'flex-start';
  if (alignment === 'right') justifyContent = 'flex-end';

  return (
    <Box justifyContent={justifyContent} paddingX={1}>
      <Text color={borderColor} dimColor>\u2500\u2500 </Text>
      <Text color={accentColor} bold>{displayTitle}</Text>
      <Text color={borderColor} dimColor> \u2500\u2500</Text>
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
    case 'companion-name':
      return getCurrentCompanion().name;
    case 'custom':
      return frame.titleBar.customText || '';
    default:
      return getCurrentSkin().name;
  }
}
