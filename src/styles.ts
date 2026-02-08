/**
 * Calliope CLI - Shared Styling
 *
 * Centralized colors, icons, and formatting utilities.
 * Extended with semantic color support and skin-aware box styles.
 */

// ============================================================================
// Semantic Color Type (all 26 palette keys)
// ============================================================================

export type SemanticColor =
  | 'primary' | 'secondary' | 'accent'
  | 'text' | 'textDim' | 'textBold'
  | 'user' | 'assistant' | 'system' | 'error'
  | 'codeKeyword' | 'codeString' | 'codeNumber' | 'codeComment' | 'codeFunction'
  | 'diffAdd' | 'diffRemove' | 'diffContext'
  | 'success' | 'warning' | 'info'
  | 'border' | 'background' | 'selection';

export type StyleName = ColorName | SemanticColor;

// ============================================================================
// ANSI Color Codes
// ============================================================================

export const colors = {
  // Reset
  reset: '\x1b[0m',

  // Modifiers
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Standard colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',

  // Bright colors
  gray: '\x1b[90m',
  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',

  // Background colors
  bgBlack: '\x1b[40m',
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
  bgMagenta: '\x1b[45m',
  bgCyan: '\x1b[46m',
  bgWhite: '\x1b[47m',
  bgGray: '\x1b[100m',
} as const;

export type ColorName = keyof typeof colors;

/**
 * Apply color to text (with auto-reset)
 */
export function color(text: string, ...styles: ColorName[]): string {
  if (styles.length === 0) return text;
  const codes = styles.map(s => colors[s]).join('');
  return `${codes}${text}${colors.reset}`;
}

/**
 * Apply color only if terminal supports it
 */
export function colorIf(condition: boolean, text: string, ...styles: ColorName[]): string {
  return condition ? color(text, ...styles) : text;
}

// ============================================================================
// Tool Icons
// ============================================================================

export const TOOL_ICONS: Record<string, string> = {
  // File operations
  read_file: '📄',
  write_file: '✍️',
  list_files: '📁',

  // Execution
  shell: '⚡',
  execute_code: '▶️',

  // Search & analysis
  web_search: '🔍',
  think: '💭',

  // Version control
  git: '🔀',

  // Diagrams
  mermaid: '📊',

  // Default
  default: '⚙️',
} as const;

export function getToolIcon(toolName: string): string {
  return TOOL_ICONS[toolName] || TOOL_ICONS.default;
}

// ============================================================================
// Status Icons
// ============================================================================

export const STATUS_ICONS = {
  success: '✓',
  error: '✗',
  warning: '⚠️',
  info: 'ℹ️',
  pending: '○',
  complete: '●',
  blocked: '🛑',
  thinking: '💭',
  running: '⚡',
} as const;

// ============================================================================
// Risk Level Display
// ============================================================================

export const RISK_COLORS: Record<string, ColorName> = {
  none: 'green',
  low: 'green',
  medium: 'yellow',
  high: 'red',
  critical: 'red',
};

export const RISK_ICONS: Record<string, string> = {
  none: '',
  low: '░',
  medium: '▒',
  high: '▓',
  critical: '█',
};

// ============================================================================
// Spinner Frames
// ============================================================================

export const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;

export const SPINNER_DOTS = ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'] as const;

export const SPINNER_SIMPLE = ['|', '/', '-', '\\'] as const;

// ============================================================================
// Box Drawing Characters
// ============================================================================

export const BOX = {
  // Corners
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',

  // Lines
  horizontal: '─',
  vertical: '│',

  // Connectors
  teeRight: '├',
  teeLeft: '┤',
  teeDown: '┬',
  teeUp: '┴',
  cross: '┼',

  // Heavy variants
  heavyHorizontal: '━',
  heavyVertical: '┃',
} as const;

// ============================================================================
// Formatting Utilities
// ============================================================================

/**
 * Create a horizontal separator line
 */
export function separator(width: number = 80, char: string = BOX.horizontal): string {
  return char.repeat(width);
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, maxLength: number, suffix: string = '...'): string {
  if (text.length <= maxLength) return text;
  return text.substring(0, maxLength - suffix.length) + suffix;
}

/**
 * Pad text to a fixed width
 */
export function pad(text: string, width: number, align: 'left' | 'right' | 'center' = 'left'): string {
  if (text.length >= width) return text;
  const padding = width - text.length;
  switch (align) {
    case 'right':
      return ' '.repeat(padding) + text;
    case 'center':
      const left = Math.floor(padding / 2);
      const right = padding - left;
      return ' '.repeat(left) + text + ' '.repeat(right);
    default:
      return text + ' '.repeat(padding);
  }
}

/**
 * Format a number with K/M suffixes
 */
export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Format bytes with appropriate unit
 */
export function formatBytes(bytes: number): string {
  if (bytes >= 1_000_000_000) return `${(bytes / 1_000_000_000).toFixed(1)} GB`;
  if (bytes >= 1_000_000) return `${(bytes / 1_000_000).toFixed(1)} MB`;
  if (bytes >= 1_000) return `${(bytes / 1_000).toFixed(1)} KB`;
  return `${bytes} B`;
}

/**
 * Format duration in human-readable form
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ${Math.floor((ms % 60000) / 1000)}s`;
  return `${Math.floor(ms / 3600000)}h ${Math.floor((ms % 3600000) / 60000)}m`;
}

/**
 * Format cost in dollars
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) return '<$0.01';
  if (cost < 1) return `$${cost.toFixed(3)}`;
  return `$${cost.toFixed(2)}`;
}

// ============================================================================
// Pre-built Styled Elements
// ============================================================================

/**
 * Create a styled box header
 */
export function boxHeader(title: string, width: number = 60): string {
  const padded = ` ${title} `;
  const sideWidth = Math.floor((width - padded.length - 2) / 2);
  return `${BOX.topLeft}${BOX.horizontal.repeat(sideWidth)}${padded}${BOX.horizontal.repeat(width - sideWidth - padded.length - 2)}${BOX.topRight}`;
}

/**
 * Create a styled box footer
 */
export function boxFooter(width: number = 60): string {
  return `${BOX.bottomLeft}${BOX.horizontal.repeat(width - 2)}${BOX.bottomRight}`;
}

/**
 * Indent text
 */
export function indent(text: string, spaces: number = 2): string {
  const prefix = ' '.repeat(spaces);
  return text.split('\n').map(line => prefix + line).join('\n');
}

// ============================================================================
// Semantic Color Resolver (lazy to avoid circular deps with hud.ts)
// ============================================================================

/**
 * Resolve a StyleName to an ANSI code.
 * Accepts both raw ColorName ('cyan', 'red') and SemanticColor ('primary', 'diffAdd').
 * Semantic colors are resolved lazily from the current palette.
 */
export function resolveColor(name: StyleName): string {
  // Try raw ANSI color first
  if (name in colors) {
    return colors[name as ColorName];
  }

  // Lazy resolve semantic color from palette
  try {
    // Dynamic import to avoid circular dependency at module load time
    const { getCurrentPalette } = require('./hud/api.js');
    const palette = getCurrentPalette();
    const value = palette.colors[name as SemanticColor];
    if (value) return value;
  } catch {
    // hud/api.js not loaded yet — fall through
  }

  return '';
}

/**
 * Apply a semantic or raw color to text
 */
export function styledColor(text: string, name: StyleName): string {
  const code = resolveColor(name);
  if (!code) return text;
  return `${code}${text}${colors.reset}`;
}

// ============================================================================
// Skin-Aware Box Styles
// ============================================================================

export interface BoxStyleChars {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
}

export const BOX_STYLE_VARIANTS: Record<string, BoxStyleChars> = {
  rounded: {
    topLeft: '\u256D', topRight: '\u256E',
    bottomLeft: '\u2570', bottomRight: '\u256F',
    horizontal: '\u2500', vertical: '\u2502',
  },
  sharp: {
    topLeft: '\u250C', topRight: '\u2510',
    bottomLeft: '\u2514', bottomRight: '\u2518',
    horizontal: '\u2500', vertical: '\u2502',
  },
  double: {
    topLeft: '\u2554', topRight: '\u2557',
    bottomLeft: '\u255A', bottomRight: '\u255D',
    horizontal: '\u2550', vertical: '\u2551',
  },
  ascii: {
    topLeft: '+', topRight: '+',
    bottomLeft: '+', bottomRight: '+',
    horizontal: '-', vertical: '|',
  },
  none: {
    topLeft: ' ', topRight: ' ',
    bottomLeft: ' ', bottomRight: ' ',
    horizontal: ' ', vertical: ' ',
  },
};

/**
 * Get box style characters for the current skin (or a given style name)
 */
export function getBoxStyle(styleName?: string): BoxStyleChars {
  if (styleName && BOX_STYLE_VARIANTS[styleName]) {
    return BOX_STYLE_VARIANTS[styleName];
  }

  // Default: try to read from current skin
  try {
    const { getCurrentSkin } = require('./hud/api.js');
    const skin = getCurrentSkin();
    const name = skin.borders.style;
    if (name === 'custom' && skin.borders.custom) {
      return skin.borders.custom;
    }
    return BOX_STYLE_VARIANTS[name] || BOX_STYLE_VARIANTS.rounded;
  } catch {
    return BOX_STYLE_VARIANTS.rounded;
  }
}
