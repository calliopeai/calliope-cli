/**
 * Calliope CLI - Theme System
 *
 * Color themes for terminal output.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ============================================================================
// Types
// ============================================================================

export interface Theme {
  name: string;
  description?: string;
  colors: {
    // Primary UI
    primary: string;
    secondary: string;
    accent: string;

    // Text
    text: string;
    textDim: string;
    textBold: string;

    // Messages
    user: string;
    assistant: string;
    system: string;
    error: string;

    // Code
    codeKeyword: string;
    codeString: string;
    codeNumber: string;
    codeComment: string;
    codeFunction: string;

    // Diff
    diffAdd: string;
    diffRemove: string;
    diffContext: string;

    // Status
    success: string;
    warning: string;
    info: string;

    // UI elements
    border: string;
    background: string;
    selection: string;
  };
}

// ============================================================================
// ANSI Color Codes
// ============================================================================

const ANSI = {
  // Reset
  reset: '\x1b[0m',

  // Styles
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  underline: '\x1b[4m',

  // Foreground colors
  black: '\x1b[30m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  gray: '\x1b[90m',

  // Bright foreground
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
};

// ============================================================================
// Built-in Themes
// ============================================================================

export const THEMES: Record<string, Theme> = {
  default: {
    name: 'default',
    description: 'Default dark theme',
    colors: {
      primary: ANSI.cyan,
      secondary: ANSI.blue,
      accent: ANSI.magenta,

      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,

      user: ANSI.green,
      assistant: ANSI.cyan,
      system: ANSI.yellow,
      error: ANSI.red,

      codeKeyword: ANSI.magenta,
      codeString: ANSI.green,
      codeNumber: ANSI.cyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.yellow,

      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,

      success: ANSI.green,
      warning: ANSI.yellow,
      info: ANSI.blue,

      border: ANSI.gray,
      background: '',
      selection: ANSI.bgBlue,
    },
  },

  light: {
    name: 'light',
    description: 'Light theme for bright terminals',
    colors: {
      primary: ANSI.blue,
      secondary: ANSI.cyan,
      accent: ANSI.magenta,

      text: ANSI.black,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.black,

      user: ANSI.blue,
      assistant: ANSI.magenta,
      system: ANSI.gray,
      error: ANSI.red,

      codeKeyword: ANSI.magenta,
      codeString: ANSI.green,
      codeNumber: ANSI.blue,
      codeComment: ANSI.gray,
      codeFunction: ANSI.cyan,

      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,

      success: ANSI.green,
      warning: ANSI.yellow,
      info: ANSI.blue,

      border: ANSI.gray,
      background: '',
      selection: ANSI.bgCyan,
    },
  },

  monokai: {
    name: 'monokai',
    description: 'Monokai-inspired dark theme',
    colors: {
      primary: ANSI.brightMagenta,
      secondary: ANSI.brightCyan,
      accent: ANSI.brightYellow,

      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,

      user: ANSI.brightGreen,
      assistant: ANSI.brightCyan,
      system: ANSI.yellow,
      error: ANSI.brightRed,

      codeKeyword: ANSI.brightMagenta,
      codeString: ANSI.brightYellow,
      codeNumber: ANSI.brightMagenta,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightGreen,

      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,

      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightCyan,

      border: ANSI.gray,
      background: '',
      selection: ANSI.bgGray,
    },
  },

  nord: {
    name: 'nord',
    description: 'Nord-inspired arctic theme',
    colors: {
      primary: ANSI.brightCyan,
      secondary: ANSI.blue,
      accent: ANSI.brightMagenta,

      text: ANSI.brightWhite,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,

      user: ANSI.brightCyan,
      assistant: ANSI.brightBlue,
      system: ANSI.yellow,
      error: ANSI.brightRed,

      codeKeyword: ANSI.brightMagenta,
      codeString: ANSI.brightGreen,
      codeNumber: ANSI.brightMagenta,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightCyan,

      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,

      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightBlue,

      border: ANSI.blue,
      background: '',
      selection: ANSI.bgBlue,
    },
  },

  minimal: {
    name: 'minimal',
    description: 'Minimal monochrome theme',
    colors: {
      primary: ANSI.white,
      secondary: ANSI.gray,
      accent: ANSI.white,

      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,

      user: ANSI.white,
      assistant: ANSI.white,
      system: ANSI.gray,
      error: ANSI.white,

      codeKeyword: ANSI.bold + ANSI.white,
      codeString: ANSI.white,
      codeNumber: ANSI.white,
      codeComment: ANSI.gray,
      codeFunction: ANSI.white,

      diffAdd: ANSI.white,
      diffRemove: ANSI.dim + ANSI.white,
      diffContext: ANSI.gray,

      success: ANSI.white,
      warning: ANSI.white,
      info: ANSI.gray,

      border: ANSI.gray,
      background: '',
      selection: ANSI.bgGray,
    },
  },
};

// ============================================================================
// Theme Management
// ============================================================================

const THEMES_DIR = path.join(os.homedir(), '.calliope-cli', 'themes');
const THEME_FILE = path.join(THEMES_DIR, 'current.txt');

function ensureThemesDir(): void {
  if (!fs.existsSync(THEMES_DIR)) {
    fs.mkdirSync(THEMES_DIR, { recursive: true });
  }
}

/**
 * Get current theme name
 */
export function getCurrentThemeName(): string {
  ensureThemesDir();
  if (fs.existsSync(THEME_FILE)) {
    const name = fs.readFileSync(THEME_FILE, 'utf-8').trim();
    if (THEMES[name] || fs.existsSync(path.join(THEMES_DIR, `${name}.json`))) {
      return name;
    }
  }
  return 'default';
}

/**
 * Set current theme
 */
export function setCurrentTheme(name: string): boolean {
  if (!THEMES[name] && !fs.existsSync(path.join(THEMES_DIR, `${name}.json`))) {
    return false;
  }
  ensureThemesDir();
  fs.writeFileSync(THEME_FILE, name);
  return true;
}

/**
 * Get current theme
 */
export function getCurrentTheme(): Theme {
  const name = getCurrentThemeName();

  // Check built-in themes
  if (THEMES[name]) {
    return THEMES[name];
  }

  // Check custom themes
  const customPath = path.join(THEMES_DIR, `${name}.json`);
  if (fs.existsSync(customPath)) {
    try {
      return JSON.parse(fs.readFileSync(customPath, 'utf-8'));
    } catch {
      // Fall back to default
    }
  }

  return THEMES.default;
}

/**
 * List available themes
 */
export function listThemes(): Array<{ name: string; description?: string; custom: boolean }> {
  const themes: Array<{ name: string; description?: string; custom: boolean }> = [];

  // Built-in themes
  for (const [name, theme] of Object.entries(THEMES)) {
    themes.push({ name, description: theme.description, custom: false });
  }

  // Custom themes
  ensureThemesDir();
  const files = fs.readdirSync(THEMES_DIR);
  for (const file of files) {
    if (file.endsWith('.json')) {
      const name = file.slice(0, -5);
      if (!THEMES[name]) {
        try {
          const theme = JSON.parse(fs.readFileSync(path.join(THEMES_DIR, file), 'utf-8'));
          themes.push({ name, description: theme.description, custom: true });
        } catch {
          // Skip invalid files
        }
      }
    }
  }

  return themes;
}

/**
 * Save a custom theme
 */
export function saveCustomTheme(theme: Theme): void {
  ensureThemesDir();
  fs.writeFileSync(
    path.join(THEMES_DIR, `${theme.name}.json`),
    JSON.stringify(theme, null, 2)
  );
}

// ============================================================================
// Color Helpers
// ============================================================================

let currentTheme: Theme | null = null;

/**
 * Get cached theme (for performance)
 */
export function getTheme(): Theme {
  if (!currentTheme) {
    currentTheme = getCurrentTheme();
  }
  return currentTheme;
}

/**
 * Clear theme cache (call after changing theme)
 */
export function clearThemeCache(): void {
  currentTheme = null;
}

/**
 * Apply color to text
 */
export function colorize(text: string, colorKey: keyof Theme['colors']): string {
  const theme = getTheme();
  const color = theme.colors[colorKey];
  return `${color}${text}${ANSI.reset}`;
}

/**
 * Create a color function for a specific color
 */
export function createColorFn(colorKey: keyof Theme['colors']): (text: string) => string {
  return (text: string) => colorize(text, colorKey);
}

// Export ANSI codes for direct use
export { ANSI };
