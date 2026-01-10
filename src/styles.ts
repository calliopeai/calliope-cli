/**
 * Calliope CLI - Shared Styles
 *
 * Centralized styling constants for consistent UI across CLI and Ink interfaces.
 */

// ============================================================================
// ANSI Colors (for legacy CLI)
// ============================================================================

export const ANSI = {
  reset: '\x1b[0m',
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
  brightBlack: '\x1b[90m',
  brightRed: '\x1b[91m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightBlue: '\x1b[94m',
  brightMagenta: '\x1b[95m',
  brightCyan: '\x1b[96m',
  brightWhite: '\x1b[97m',
  
  // Background colors
  bgRed: '\x1b[41m',
  bgGreen: '\x1b[42m',
  bgYellow: '\x1b[43m',
  bgBlue: '\x1b[44m',
} as const;

/**
 * Apply ANSI color to text
 */
export function ansi(text: string, ...styles: (keyof typeof ANSI)[]): string {
  const codes = styles.map(s => ANSI[s]).join('');
  return `${codes}${text}${ANSI.reset}`;
}

// ============================================================================
// Icons
// ============================================================================

export const ICONS = {
  // Tools
  shell: '⚡',
  read_file: '📄',
  write_file: '✍️',
  list_files: '📁',
  think: '💭',
  execute_code: '▶️',
  web_search: '🔍',
  git: '🔀',
  mermaid: '📊',
  
  // Status
  success: '✓',
  error: '✗',
  warning: '⚠️',
  info: 'ℹ️',
  
  // UI
  spinner: ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'],
  prompt: '›',
  calliope: '✧',
  
  // Risk levels
  riskNone: '░░░░░',
  riskLow: '█░░░░',
  riskMedium: '███░░',
  riskHigh: '████░',
  riskCritical: '█████',
  
  // Modes
  modePlan: '📋',
  modeHybrid: '🔄',
  modeWork: '🔧',
  
  // Branches
  branchLine: '│',
  branchCorner: '╰─',
  branchTee: '├─',
  branchTop: '╭─',
} as const;

/**
 * Get icon for a tool
 */
export function getToolIcon(toolName: string): string | readonly string[] {
  return ICONS[toolName as keyof typeof ICONS] || '⚙️';
}

// ============================================================================
// Box Drawing
// ============================================================================

export const BOX = {
  // Single line
  horizontal: '─',
  vertical: '│',
  topLeft: '╭',
  topRight: '╮',
  bottomLeft: '╰',
  bottomRight: '╯',
  teeRight: '├',
  teeLeft: '┤',
  teeDown: '┬',
  teeUp: '┴',
  cross: '┼',
  
  // Double line
  doubleHorizontal: '═',
  doubleVertical: '║',
  doubleTopLeft: '╔',
  doubleTopRight: '╗',
  doubleBottomLeft: '╚',
  doubleBottomRight: '╝',
} as const;

/**
 * Create a horizontal separator
 */
export function separator(width: number, char = BOX.horizontal): string {
  return char.repeat(width);
}

// ============================================================================
// Banner
// ============================================================================

export const BANNER_LINES = [
  ' ██████╗ █████╗ ██╗     ██╗     ██╗ ██████╗ ██████╗ ███████╗',
  '██╔════╝██╔══██╗██║     ██║     ██║██╔═══██╗██╔══██╗██╔════╝',
  '██║     ███████║██║     ██║     ██║██║   ██║██████╔╝█████╗  ',
  '██║     ██╔══██║██║     ██║     ██║██║   ██║██╔═══╝ ██╔══╝  ',
  '╚██████╗██║  ██║███████╗███████╗██║╚██████╔╝██║     ███████╗',
  ' ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝     ╚══════╝',
] as const;

export const TAGLINE = 'The Muse of Digital Eloquence';

/**
 * Print the banner with ANSI colors
 */
export function printBanner(): void {
  console.log();
  console.log(ansi(BANNER_LINES[0], 'brightCyan'));
  console.log(ansi(BANNER_LINES[1], 'brightCyan'));
  console.log(ansi(BANNER_LINES[2], 'cyan'));
  console.log(ansi(BANNER_LINES[3], 'cyan'));
  console.log(ansi(BANNER_LINES[4], 'brightCyan'));
  console.log(ansi(BANNER_LINES[5], 'cyan'));
  console.log();
  console.log(ansi(`        ${TAGLINE}`, 'dim'));
  console.log();
}

// ============================================================================
// Formatting Utilities
// ============================================================================

/**
 * Format a key-value pair for display
 */
export function formatKV(key: string, value: string, keyColor: keyof typeof ANSI = 'dim'): string {
  return `${ansi(key + ':', keyColor)} ${value}`;
}

/**
 * Format a number with K/M suffix
 */
export function formatNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return String(n);
}

/**
 * Format currency
 */
export function formatCost(cost: number): string {
  if (cost < 0.01) return '<$0.01';
  if (cost < 1) return `$${cost.toFixed(2)}`;
  return `$${cost.toFixed(2)}`;
}

/**
 * Truncate text with ellipsis
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return text.slice(0, maxLength - 3) + '...';
}

/**
 * Indent text
 */
export function indent(text: string, spaces: number = 2): string {
  const prefix = ' '.repeat(spaces);
  return text.split('\n').map(line => prefix + line).join('\n');
}

// ============================================================================
// Color Schemes
// ============================================================================

export const COLOR_SCHEMES = {
  default: {
    primary: 'cyan',
    secondary: 'blue',
    success: 'green',
    warning: 'yellow',
    error: 'red',
    muted: 'dim',
  },
  monochrome: {
    primary: 'white',
    secondary: 'brightWhite',
    success: 'white',
    warning: 'white',
    error: 'white',
    muted: 'dim',
  },
  warm: {
    primary: 'yellow',
    secondary: 'magenta',
    success: 'green',
    warning: 'brightYellow',
    error: 'red',
    muted: 'dim',
  },
} as const;

export type ColorScheme = keyof typeof COLOR_SCHEMES;

let currentScheme: ColorScheme = 'default';

export function setColorScheme(scheme: ColorScheme): void {
  currentScheme = scheme;
}

export function getColor(role: keyof typeof COLOR_SCHEMES.default): keyof typeof ANSI {
  return COLOR_SCHEMES[currentScheme][role] as keyof typeof ANSI;
}
