/**
 * Terminal Image & Banner Rendering
 *
 * Provides terminal capability detection and text-based banner rendering
 * with ANSI colors. No external image processing dependencies required.
 *
 * Extracted from scripts/image-poc.mjs detection logic, adapted for
 * integration with the HUD skin system.
 *
 * @see scripts/image-poc.mjs - Full image rendering POC (requires sharp)
 */

// ============================================================================
// Types
// ============================================================================

/**
 * Terminal image rendering mode, ordered by fidelity (highest to lowest).
 *
 * - iterm2:    iTerm2 inline image protocol (pixel-perfect)
 * - kitty:     Kitty graphics protocol (pixel-perfect)
 * - halfblock: Unicode half-block chars with truecolor (best text-based)
 * - braille:   Braille dot patterns with truecolor (2x resolution)
 * - ascii:     Colored ASCII art (widest compatibility)
 * - none:      No image rendering capability
 */
export type ImageMode = 'iterm2' | 'kitty' | 'halfblock' | 'braille' | 'ascii' | 'none';

export interface TerminalImageInfo {
  mode: ImageMode;
  truecolor: boolean;
  width: number;
}

// ============================================================================
// Terminal Capability Detection
// ============================================================================

/**
 * Detect the best image rendering mode for the current terminal.
 *
 * Detection rules (in priority order):
 * 1. ITERM_SESSION_ID / LC_TERMINAL=iTerm2 / TERM_PROGRAM=iTerm.app|WezTerm -> iterm2
 * 2. KITTY_PID / TERM=xterm-kitty / GHOSTTY_RESOURCES_DIR -> kitty
 * 3. COLORTERM=truecolor|24bit -> halfblock
 * 4. Otherwise -> ascii
 */
export function detectBestMode(): ImageMode {
  const env = process.env;

  // iTerm2 protocol support
  if (
    env.ITERM_SESSION_ID ||
    env.LC_TERMINAL === 'iTerm2' ||
    env.TERM_PROGRAM === 'iTerm.app' ||
    env.TERM_PROGRAM === 'WezTerm'
  ) {
    return 'iterm2';
  }

  // Kitty graphics protocol
  if (
    env.KITTY_PID ||
    env.TERM === 'xterm-kitty' ||
    env.GHOSTTY_RESOURCES_DIR
  ) {
    return 'kitty';
  }

  // Truecolor support -> half-block rendering
  if (env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit') {
    return 'halfblock';
  }

  // Fallback to ASCII
  return 'ascii';
}

/**
 * Returns terminal image capabilities summary.
 */
export function getTerminalImageInfo(): TerminalImageInfo {
  const env = process.env;
  return {
    mode: detectBestMode(),
    truecolor: env.COLORTERM === 'truecolor' || env.COLORTERM === '24bit',
    width: parseInt(env.COLUMNS || '', 10) || process.stdout.columns || 80,
  };
}

// ============================================================================
// ANSI Color Helpers
// ============================================================================

const ESC = '\x1b[';
const RESET = `${ESC}0m`;

/** Apply 256-color or truecolor foreground based on hex string (#RRGGBB) */
export function colorFg(text: string, hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return text;
  return `${ESC}38;2;${rgb.r};${rgb.g};${rgb.b}m${text}${RESET}`;
}

/** Apply truecolor background based on hex string (#RRGGBB) */
export function colorBg(text: string, hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return text;
  return `${ESC}48;2;${rgb.r};${rgb.g};${rgb.b}m${text}${RESET}`;
}

/** Bold text */
export function bold(text: string): string {
  return `${ESC}1m${text}${RESET}`;
}

/** Dim text */
export function dim(text: string): string {
  return `${ESC}2m${text}${RESET}`;
}

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const match = hex.match(/^#?([0-9a-fA-F]{2})([0-9a-fA-F]{2})([0-9a-fA-F]{2})$/);
  if (!match) return null;
  return {
    r: parseInt(match[1], 16),
    g: parseInt(match[2], 16),
    b: parseInt(match[3], 16),
  };
}

// ============================================================================
// Banner Rendering
// ============================================================================

/**
 * Render a text-based decorative banner using box-drawing characters.
 *
 * Uses the detected terminal mode to choose appropriate decoration level:
 * - iterm2/kitty/halfblock: Full Unicode box drawing with color
 * - ascii: Simple ASCII borders
 * - none: Just the text
 */
export function renderBanner(text: string, mode?: ImageMode): string {
  const m = mode ?? detectBestMode();
  const lines: string[] = [];

  if (m === 'none') {
    lines.push(text);
    return lines.join('\n');
  }

  const isUnicode = m !== 'ascii';
  const h = isUnicode ? '\u2500' : '-';
  const v = isUnicode ? '\u2502' : '|';
  const tl = isUnicode ? '\u256D' : '+';
  const tr = isUnicode ? '\u256E' : '+';
  const bl = isUnicode ? '\u2570' : '+';
  const br = isUnicode ? '\u256F' : '+';
  const dh = isUnicode ? '\u2550' : '=';

  const width = Math.max(text.length + 4, 40);
  const padding = width - text.length - 2;
  const padLeft = Math.floor(padding / 2);
  const padRight = padding - padLeft;

  // Top border with decorative double line
  lines.push(`  ${tl}${dh}${h.repeat(width - 2)}${dh}${tr}`);

  // Content line
  lines.push(`  ${v}${' '.repeat(padLeft)} ${text} ${' '.repeat(padRight)}${v}`);

  // Bottom border
  lines.push(`  ${bl}${dh}${h.repeat(width - 2)}${dh}${br}`);

  return lines.join('\n');
}

/**
 * Render pre-formatted ASCII art lines with optional per-line color function.
 *
 * @param art - Array of pre-formatted ASCII art lines
 * @param colorFn - Optional function to apply ANSI color to each line
 * @returns Rendered string with newlines
 */
export function renderAsciiArt(art: string[], colorFn?: (line: string, index: number) => string): string {
  if (!art.length) return '';
  const lines = art.map((line, i) => colorFn ? colorFn(line, i) : line);
  return lines.join('\n');
}

/**
 * Render a skin's banner art with full decorative frame and ANSI colors.
 *
 * This is the main function used by the /banner command. It takes banner art
 * lines, wraps them in a frame appropriate for the terminal mode, and applies
 * the given palette color.
 *
 * @param art - Banner art lines from skin.banner.art
 * @param color - Hex color for the banner frame (from palette)
 * @param tagline - Optional tagline to display below the art
 * @param mode - Override image mode detection
 */
export function renderSkinBanner(
  art: string[],
  color?: string,
  tagline?: string,
  mode?: ImageMode,
): string {
  const m = mode ?? detectBestMode();
  const lines: string[] = [];
  const isUnicode = m !== 'ascii' && m !== 'none';

  // Determine max width from art
  const artWidths = art.map(line => stripAnsi(line).length);
  const maxArtWidth = Math.max(...artWidths, 30);
  const frameWidth = maxArtWidth + 4;

  // Box chars
  const h = isUnicode ? '\u2500' : '-';
  const v = isUnicode ? '\u2502' : '|';
  const tl = isUnicode ? '\u256D' : '+';
  const tr = isUnicode ? '\u256E' : '+';
  const bl = isUnicode ? '\u2570' : '+';
  const br = isUnicode ? '\u256F' : '+';

  const applyColor = (text: string) => color ? colorFg(text, color) : text;

  // Top frame
  lines.push(applyColor(`${tl}${h.repeat(frameWidth)}${tr}`));

  // Empty line for spacing
  lines.push(applyColor(`${v}${' '.repeat(frameWidth)}${v}`));

  // Art lines (centered in frame)
  for (const artLine of art) {
    const visLen = stripAnsi(artLine).length;
    const totalPad = frameWidth - visLen;
    const padL = Math.floor(totalPad / 2);
    const padR = totalPad - padL;
    lines.push(applyColor(v) + ' '.repeat(padL) + artLine + ' '.repeat(padR) + applyColor(v));
  }

  // Empty line for spacing
  lines.push(applyColor(`${v}${' '.repeat(frameWidth)}${v}`));

  // Tagline if present
  if (tagline) {
    const tagVisLen = tagline.length;
    const totalPad = frameWidth - tagVisLen;
    const padL = Math.floor(totalPad / 2);
    const padR = totalPad - padL;
    lines.push(applyColor(v) + ' '.repeat(padL) + dim(tagline) + ' '.repeat(padR) + applyColor(v));
    lines.push(applyColor(`${v}${' '.repeat(frameWidth)}${v}`));
  }

  // Bottom frame
  lines.push(applyColor(`${bl}${h.repeat(frameWidth)}${br}`));

  return lines.join('\n');
}

/**
 * Get a human-readable label for an image mode.
 */
export function getImageModeLabel(mode: ImageMode): string {
  const labels: Record<ImageMode, string> = {
    iterm2: 'iTerm2 Inline Image',
    kitty: 'Kitty Graphics Protocol',
    halfblock: 'Unicode Half-Block',
    braille: 'Braille Dots',
    ascii: 'ASCII',
    none: 'None',
  };
  return labels[mode];
}

// ============================================================================
// Utility
// ============================================================================

/** Strip ANSI escape sequences from a string for measuring visible width */
function stripAnsi(str: string): string {
  // eslint-disable-next-line no-control-regex
  return str.replace(/\x1b\[[0-9;]*m/g, '').replace(/\x1b[\\_\]][^\x07\x1b]*[\x07\x1b\\]?/g, '');
}
