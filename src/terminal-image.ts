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
 * Render a skin's banner using coloredArt from splash config.
 * Each line gets its own hex color. Falls back to single-color rendering.
 *
 * @param coloredArt - Array of {text, color} objects
 * @param tagline - Optional tagline
 * @param mode - Override image mode detection
 */
export function renderColoredBanner(
  coloredArt: Array<{ text: string; color: string }>,
  tagline?: string,
  mode?: ImageMode,
): string {
  const m = mode ?? detectBestMode();
  const lines: string[] = [];
  const isUnicode = m !== 'ascii' && m !== 'none';

  // Determine max width from art
  const artWidths = coloredArt.map(line => stripAnsi(line.text).length);
  const maxArtWidth = Math.max(...artWidths, 30);
  const frameWidth = maxArtWidth + 4;

  const h = isUnicode ? '\u2500' : '-';
  const v = isUnicode ? '\u2502' : '|';
  const tl = isUnicode ? '\u256D' : '+';
  const tr = isUnicode ? '\u256E' : '+';
  const bl = isUnicode ? '\u2570' : '+';
  const br = isUnicode ? '\u256F' : '+';

  // Use the first line's color for the frame, or white
  const frameColor = coloredArt[0]?.color;
  const applyFrame = (text: string) => frameColor ? colorFg(text, frameColor) : text;

  // Top frame
  lines.push(applyFrame(`${tl}${h.repeat(frameWidth)}${tr}`));
  lines.push(applyFrame(`${v}${' '.repeat(frameWidth)}${v}`));

  // Art lines with per-line color
  for (const { text, color } of coloredArt) {
    const visLen = stripAnsi(text).length;
    const totalPad = frameWidth - visLen;
    const padL = Math.floor(totalPad / 2);
    const padR = totalPad - padL;
    lines.push(applyFrame(v) + ' '.repeat(padL) + colorFg(text, color) + ' '.repeat(padR) + applyFrame(v));
  }

  lines.push(applyFrame(`${v}${' '.repeat(frameWidth)}${v}`));

  if (tagline) {
    const tagVisLen = tagline.length;
    const totalPad = frameWidth - tagVisLen;
    const padL = Math.floor(totalPad / 2);
    const padR = totalPad - padL;
    lines.push(applyFrame(v) + ' '.repeat(padL) + dim(tagline) + ' '.repeat(padR) + applyFrame(v));
    lines.push(applyFrame(`${v}${' '.repeat(frameWidth)}${v}`));
  }

  lines.push(applyFrame(`${bl}${h.repeat(frameWidth)}${br}`));

  return lines.join('\n');
}

/**
 * Render a splash animation to stdout (pre-Ink, raw terminal output).
 * Returns a promise that resolves when animation completes.
 * Skippable by any keypress if process.stdin is available.
 */
export async function renderSplashAnimation(
  art: string[],
  animation: 'typewriter' | 'fade-in' | 'scan-lines' | 'drop-in',
  speed: number = 50,
  color?: string,
): Promise<void> {
  const applyColor = (text: string) => color ? colorFg(text, color) : text;

  switch (animation) {
    case 'scan-lines': {
      // Reveal line by line from top
      for (const line of art) {
        console.log(applyColor(line));
        await delay(speed);
      }
      break;
    }

    case 'typewriter': {
      // Type each line character by character
      for (const line of art) {
        const colored = applyColor(line);
        process.stdout.write(colored);
        process.stdout.write('\n');
        await delay(speed);
      }
      break;
    }

    case 'fade-in': {
      // Show dim first, then bright
      const dimCode = '\x1b[2m';
      const resetCode = '\x1b[0m';

      // First pass: dim
      const dimLines: string[] = [];
      for (const line of art) {
        const dimLine = `${dimCode}${line}${resetCode}`;
        dimLines.push(dimLine);
        console.log(dimLine);
      }
      await delay(speed * 3);

      // Move cursor up and overwrite with bright
      process.stdout.write(`\x1b[${art.length}A`);
      for (const line of art) {
        console.log(applyColor(line));
      }
      break;
    }

    case 'drop-in': {
      // Lines appear one at a time with a slight bounce effect
      for (const line of art) {
        console.log(applyColor(line));
        await delay(speed);
      }
      break;
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================================================
// Theme Transition Effects
// ============================================================================

export interface TransitionConfig {
  effect: string;
  duration?: number;
  color?: string;
  colorSecondary?: string;
  chars?: string | string[];
}

/**
 * Run a full-screen theme transition effect.
 * Fills the terminal with a brief animation, then clears for the new theme.
 * All effects are pre-Ink (raw stdout) and self-cleaning.
 */
export async function renderTransition(config: TransitionConfig): Promise<void> {
  if (!process.stdout.isTTY || config.effect === 'none') return;

  const cols = process.stdout.columns || 80;
  const rows = process.stdout.rows || 24;
  const duration = config.duration ?? 1500;
  const color = config.color ?? '#00FF00';
  const colorSec = config.colorSecondary ?? '#003300';

  // Hide cursor during animation
  process.stdout.write('\x1b[?25l');

  try {
    switch (config.effect) {
      case 'matrix-rain':
        await matrixRain(cols, rows, duration, color, colorSec, config.chars);
        break;
      case 'warp-speed':
        await warpSpeed(cols, rows, duration, color);
        break;
      case 'glitch':
        await glitchEffect(cols, rows, duration, color, colorSec);
        break;
      case 'terminal-boot':
        await terminalBoot(cols, rows, duration, color);
        break;
      case 'pixel-dissolve':
        await pixelDissolve(cols, rows, duration, color);
        break;
      case 'sparkle':
        await sparkleEffect(cols, rows, duration, color, colorSec);
        break;
      case 'rainbow-wave':
        await rainbowWave(cols, rows, duration);
        break;
      case 'static-noise':
        await staticNoise(cols, rows, duration);
        break;
      case 'fade':
      case 'fade-in':
        await fadeEffect(cols, rows, duration, color);
        break;
      case 'scan-lines':
        await scanLinesEffect(cols, rows, duration, color, colorSec);
        break;
      case 'digital-rain':
        await matrixRain(cols, rows, duration, color, colorSec, config.chars);
        break;
    }
  } finally {
    // Show cursor, clear screen
    process.stdout.write('\x1b[?25h');
    process.stdout.write('\x1b[2J\x1b[H');
  }
}

// --- Matrix Digital Rain ---
async function matrixRain(
  cols: number, rows: number, duration: number,
  color: string, colorDim: string, chars?: string | string[],
): Promise<void> {
  const defaultChars = '\u30A2\u30A4\u30A6\u30A8\u30AA\u30AB\u30AD\u30AF\u30B1\u30B3\u30B5\u30B7\u30B9\u30BB\u30BD\u30BF\u30C1\u30C4\u30C6\u30C80123456789';
  const charArr = Array.isArray(chars) ? chars : [...(chars || defaultChars)];
  const randChar = () => charArr[Math.floor(Math.random() * charArr.length)];

  // Column state: each column has a "drop" position that falls
  const drops: number[] = new Array(cols).fill(0).map(() => Math.floor(Math.random() * -rows));
  const speeds: number[] = new Array(cols).fill(0).map(() => 0.5 + Math.random() * 1.5);

  const frameTime = 50;
  const frames = Math.floor(duration / frameTime);

  // Clear screen
  process.stdout.write('\x1b[2J\x1b[H');

  for (let f = 0; f < frames; f++) {
    // Build frame buffer
    let output = '\x1b[H'; // Move to top-left

    for (let y = 0; y < Math.min(rows - 1, 30); y++) {
      let line = '';
      for (let x = 0; x < Math.min(cols, 120); x += 2) { // Skip every other col for performance
        const dropY = Math.floor(drops[x]);
        const dist = y - dropY;

        if (dist === 0) {
          // Leading character — bright
          line += colorFg(randChar(), '#FFFFFF');
        } else if (dist > 0 && dist < 8) {
          // Trail — primary color, fading
          const fade = 1 - (dist / 8);
          const r = Math.floor(parseInt(color.slice(1, 3), 16) * fade);
          const g = Math.floor(parseInt(color.slice(3, 5), 16) * fade);
          const b = Math.floor(parseInt(color.slice(5, 7), 16) * fade);
          const hex = `#${r.toString(16).padStart(2, '0')}${g.toString(16).padStart(2, '0')}${b.toString(16).padStart(2, '0')}`;
          line += colorFg(randChar(), hex);
        } else if (dist > 0 && dist < 15 && Math.random() > 0.7) {
          // Sparse background rain
          line += colorFg(randChar(), colorDim);
        } else {
          line += ' ';
        }
      }
      output += line + '\n';
    }

    process.stdout.write(output);

    // Advance drops
    for (let x = 0; x < cols; x += 2) {
      drops[x] += speeds[x];
      if (drops[x] > rows + 10) {
        drops[x] = Math.floor(Math.random() * -8);
        speeds[x] = 0.5 + Math.random() * 1.5;
      }
    }

    await delay(frameTime);
  }
}

// --- Warp Speed (Star Trek style) ---
async function warpSpeed(cols: number, rows: number, duration: number, color: string): Promise<void> {
  const frameTime = 60;
  const frames = Math.floor(duration / frameTime);
  const centerX = Math.floor(cols / 2);
  const centerY = Math.floor(Math.min(rows - 1, 25) / 2);

  // Stars that streak outward from center
  interface Star { x: number; y: number; vx: number; vy: number; char: string }
  const stars: Star[] = [];
  const starChars = ['.', '*', '+', '\u2022', '\u2219', '\u00B7'];

  process.stdout.write('\x1b[2J\x1b[H');

  for (let f = 0; f < frames; f++) {
    // Spawn new stars from center
    const spawnCount = Math.min(3, Math.floor(f / 3) + 1);
    for (let i = 0; i < spawnCount; i++) {
      const angle = Math.random() * Math.PI * 2;
      const speed = 0.5 + Math.random() * 2;
      stars.push({
        x: centerX, y: centerY,
        vx: Math.cos(angle) * speed,
        vy: Math.sin(angle) * speed * 0.5, // Squish vertically for terminal aspect
        char: starChars[Math.floor(Math.random() * starChars.length)],
      });
    }

    // Build frame
    const grid: string[][] = Array.from({ length: Math.min(rows - 1, 25) }, () =>
      new Array(Math.min(cols, 120)).fill(' ')
    );

    // Update and render stars
    for (let i = stars.length - 1; i >= 0; i--) {
      const s = stars[i];
      s.x += s.vx;
      s.y += s.vy;
      // Accelerate as they move outward (warp stretch)
      s.vx *= 1.08;
      s.vy *= 1.08;

      const sx = Math.floor(s.x);
      const sy = Math.floor(s.y);

      if (sx < 0 || sx >= Math.min(cols, 120) || sy < 0 || sy >= Math.min(rows - 1, 25)) {
        stars.splice(i, 1);
        continue;
      }

      // Streak effect — draw a line from current to previous position
      const dist = Math.sqrt(s.vx * s.vx + s.vy * s.vy);
      const streakChar = dist > 3 ? '\u2500' : dist > 1.5 ? '\u2022' : s.char;
      grid[sy][sx] = streakChar;
    }

    let output = '\x1b[H';
    for (const row of grid) {
      output += colorFg(row.join(''), color) + '\n';
    }
    process.stdout.write(output);

    // Keep star count manageable
    while (stars.length > 200) stars.shift();

    await delay(frameTime);
  }
}

// --- Glitch Effect (Cyberpunk) ---
async function glitchEffect(
  cols: number, rows: number, duration: number,
  color: string, colorSec: string,
): Promise<void> {
  const frameTime = 80;
  const frames = Math.floor(duration / frameTime);
  const glitchChars = '\u2588\u2593\u2592\u2591\u2580\u2584\u258C\u2590/\\|#@$%&';
  const glitchArr = [...glitchChars];
  const w = Math.min(cols, 120);
  const h = Math.min(rows - 1, 25);

  process.stdout.write('\x1b[2J\x1b[H');

  for (let f = 0; f < frames; f++) {
    let output = '\x1b[H';
    const glitchIntensity = Math.sin((f / frames) * Math.PI); // Peaks in middle

    for (let y = 0; y < h; y++) {
      let line = '';
      if (Math.random() < glitchIntensity * 0.4) {
        // Glitch line — random block characters
        const offset = Math.floor(Math.random() * 10) - 5;
        const spaces = ' '.repeat(Math.max(0, offset));
        for (let x = 0; x < w - Math.abs(offset); x++) {
          if (Math.random() < glitchIntensity * 0.6) {
            const c = Math.random() > 0.5 ? color : colorSec;
            line += colorFg(glitchArr[Math.floor(Math.random() * glitchArr.length)], c);
          } else {
            line += ' ';
          }
        }
        line = spaces + line;
      } else {
        // Mostly empty with sparse glitch
        for (let x = 0; x < w; x++) {
          if (Math.random() < glitchIntensity * 0.05) {
            line += colorFg(glitchArr[Math.floor(Math.random() * glitchArr.length)], color);
          } else {
            line += ' ';
          }
        }
      }
      output += line.slice(0, w) + '\n';
    }

    process.stdout.write(output);
    await delay(frameTime);
  }
}

// --- Terminal Boot (WarGames / Retro) ---
async function terminalBoot(cols: number, rows: number, duration: number, color: string): Promise<void> {
  const bootLines = [
    'INITIALIZING SYSTEM...',
    'LOADING KERNEL... OK',
    'MEMORY CHECK... 640K OK',
    'LOADING DRIVERS...',
    '  [OK] TERMINAL',
    '  [OK] NETWORK',
    '  [OK] AI SUBSYSTEM',
    '',
    'SYSTEM READY.',
    '',
    'WELCOME TO CALLIOPE',
    '',
  ];

  process.stdout.write('\x1b[2J\x1b[H');

  const timePerLine = Math.floor(duration / bootLines.length);

  for (const line of bootLines) {
    if (line === '') {
      console.log();
      await delay(timePerLine / 2);
      continue;
    }
    // Typewriter effect per character
    const colored = colorFg(line, color);
    process.stdout.write(colored);
    process.stdout.write('\n');
    await delay(timePerLine);
  }
}

// --- Pixel Dissolve ---
async function pixelDissolve(cols: number, rows: number, duration: number, color: string): Promise<void> {
  const frameTime = 60;
  const frames = Math.floor(duration / frameTime);
  const w = Math.min(cols, 120);
  const h = Math.min(rows - 1, 25);
  const blockChars = ['\u2588', '\u2593', '\u2592', '\u2591', ' '];

  process.stdout.write('\x1b[2J\x1b[H');

  for (let f = 0; f < frames; f++) {
    const progress = f / frames; // 0 → 1
    let output = '\x1b[H';

    for (let y = 0; y < h; y++) {
      let line = '';
      for (let x = 0; x < w; x++) {
        // Dissolve from full → empty, with some randomness
        const threshold = progress + (Math.random() * 0.3 - 0.15);
        if (threshold < 0.3) {
          line += colorFg('\u2588', color);
        } else if (threshold < 0.5) {
          line += colorFg('\u2593', color);
        } else if (threshold < 0.7) {
          line += colorFg('\u2592', color);
        } else if (threshold < 0.85) {
          line += colorFg('\u2591', color);
        } else {
          line += ' ';
        }
      }
      output += line + '\n';
    }

    process.stdout.write(output);
    await delay(frameTime);
  }
}

// --- Sparkle (Zelda / Fantasy) ---
async function sparkleEffect(
  cols: number, rows: number, duration: number,
  color: string, colorSec: string,
): Promise<void> {
  const frameTime = 80;
  const frames = Math.floor(duration / frameTime);
  const sparkleChars = ['\u2728', '\u2727', '\u2726', '\u2735', '\u2734', '\u2733', '\u00B7', ' '];
  const w = Math.min(cols, 120);
  const h = Math.min(rows - 1, 25);

  process.stdout.write('\x1b[2J\x1b[H');

  for (let f = 0; f < frames; f++) {
    const intensity = Math.sin((f / frames) * Math.PI); // Peak in middle
    let output = '\x1b[H';

    for (let y = 0; y < h; y++) {
      let line = '';
      for (let x = 0; x < w; x++) {
        if (Math.random() < intensity * 0.15) {
          const c = Math.random() > 0.5 ? color : colorSec;
          line += colorFg(sparkleChars[Math.floor(Math.random() * 4)], c);
        } else if (Math.random() < intensity * 0.05) {
          line += colorFg('\u00B7', color);
        } else {
          line += ' ';
        }
      }
      output += line + '\n';
    }

    process.stdout.write(output);
    await delay(frameTime);
  }
}

// --- Rainbow Wave (Saggitaria) ---
async function rainbowWave(cols: number, rows: number, duration: number): Promise<void> {
  const frameTime = 60;
  const frames = Math.floor(duration / frameTime);
  const w = Math.min(cols, 120);
  const h = Math.min(rows - 1, 25);
  const waveChars = ['\u2588', '\u2593', '\u2592', '\u2591'];
  const colors = ['#FF6B6B', '#FFE66D', '#4ECDC4', '#45B7D1', '#96CEB4', '#FFEAA7', '#DDA0DD', '#FF6B6B'];

  process.stdout.write('\x1b[2J\x1b[H');

  for (let f = 0; f < frames; f++) {
    let output = '\x1b[H';
    const phase = (f / frames) * Math.PI * 4;

    for (let y = 0; y < h; y++) {
      let line = '';
      for (let x = 0; x < w; x++) {
        const wave = Math.sin(phase + x * 0.1 + y * 0.2);
        const colorIdx = Math.floor(((wave + 1) / 2) * (colors.length - 1));
        const charIdx = Math.floor(((wave + 1) / 2) * (waveChars.length - 1));

        if (Math.abs(wave) > 0.3) {
          line += colorFg(waveChars[charIdx], colors[colorIdx]);
        } else {
          line += ' ';
        }
      }
      output += line + '\n';
    }

    process.stdout.write(output);
    await delay(frameTime);
  }
}

// --- Static Noise ---
async function staticNoise(cols: number, rows: number, duration: number): Promise<void> {
  const frameTime = 50;
  const frames = Math.floor(duration / frameTime);
  const noiseChars = '\u2588\u2593\u2592\u2591 ';
  const noiseArr = [...noiseChars];
  const w = Math.min(cols, 120);
  const h = Math.min(rows - 1, 25);

  process.stdout.write('\x1b[2J\x1b[H');

  for (let f = 0; f < frames; f++) {
    const fadeOut = 1 - (f / frames); // Fade to black
    let output = '\x1b[H';

    for (let y = 0; y < h; y++) {
      let line = '';
      for (let x = 0; x < w; x++) {
        if (Math.random() < fadeOut * 0.5) {
          const gray = Math.floor(Math.random() * 200 * fadeOut);
          const hex = `#${gray.toString(16).padStart(2, '0')}${gray.toString(16).padStart(2, '0')}${gray.toString(16).padStart(2, '0')}`;
          line += colorFg(noiseArr[Math.floor(Math.random() * noiseArr.length)], hex);
        } else {
          line += ' ';
        }
      }
      output += line + '\n';
    }

    process.stdout.write(output);
    await delay(frameTime);
  }
}

// --- Fade Effect ---
async function fadeEffect(cols: number, rows: number, duration: number, color: string): Promise<void> {
  const frameTime = 60;
  const frames = Math.floor(duration / frameTime);
  const w = Math.min(cols, 120);
  const h = Math.min(rows - 1, 25);
  const blockChars = [' ', '\u2591', '\u2592', '\u2593', '\u2588', '\u2593', '\u2592', '\u2591', ' '];

  process.stdout.write('\x1b[2J\x1b[H');

  for (let f = 0; f < frames; f++) {
    const progress = f / frames;
    // Fade in then out: peak at 0.5
    const intensity = Math.sin(progress * Math.PI);
    const charIdx = Math.floor(intensity * (blockChars.length - 1));
    const ch = blockChars[charIdx];

    // Parse base color and scale brightness by intensity
    const r = parseInt(color.slice(1, 3), 16);
    const g = parseInt(color.slice(3, 5), 16);
    const b = parseInt(color.slice(5, 7), 16);
    const cr = Math.floor(r * intensity);
    const cg = Math.floor(g * intensity);
    const cb = Math.floor(b * intensity);
    const hex = `#${cr.toString(16).padStart(2, '0')}${cg.toString(16).padStart(2, '0')}${cb.toString(16).padStart(2, '0')}`;

    let output = '\x1b[H';
    const line = colorFg(ch.repeat(w), hex);
    for (let y = 0; y < h; y++) {
      output += line + '\n';
    }

    process.stdout.write(output);
    await delay(frameTime);
  }
}

// --- Scan Lines Effect ---
async function scanLinesEffect(
  cols: number, rows: number, duration: number,
  color: string, colorSec: string,
): Promise<void> {
  const frameTime = 50;
  const frames = Math.floor(duration / frameTime);
  const w = Math.min(cols, 120);
  const h = Math.min(rows - 1, 25);

  process.stdout.write('\x1b[2J\x1b[H');

  for (let f = 0; f < frames; f++) {
    const scanY = Math.floor((f / frames) * h * 2) % h;
    let output = '\x1b[H';

    for (let y = 0; y < h; y++) {
      const dist = Math.abs(y - scanY);
      if (dist === 0) {
        // Bright scan line
        output += colorFg('\u2588'.repeat(w), '#FFFFFF') + '\n';
      } else if (dist <= 2) {
        // Near glow
        output += colorFg('\u2593'.repeat(w), color) + '\n';
      } else if (dist <= 4) {
        // Dim trail
        output += colorFg('\u2591'.repeat(w), colorSec) + '\n';
      } else {
        output += ' '.repeat(w) + '\n';
      }
    }

    process.stdout.write(output);
    await delay(frameTime);
  }
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
