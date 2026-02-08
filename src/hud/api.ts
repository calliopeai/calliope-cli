/**
 * HUD API
 *
 * State management, discovery, and helper functions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { colors as ANSI } from '../styles.js';
import type { Skin, Palette, BoxChars, SemanticColorKey, PaletteColors } from './types.js';
import { SKINS, BOX_STYLES, SPINNER_SETS } from './skins.js';
import { PALETTES } from './palettes.js';

// ============================================================================
// Schema Validation
// ============================================================================

/** Maximum size for a custom JSON file (1MB) */
const MAX_CUSTOM_FILE_SIZE = 1_048_576;
/** Maximum number of banner art lines */
const MAX_BANNER_ART_LINES = 100;
/** Maximum length of any single string field */
const MAX_STRING_LENGTH = 1000;

/**
 * Strip ANSI escape sequences that could manipulate terminal state
 * beyond standard color codes (CSI sequences for cursor movement, screen clear, etc.)
 */
function sanitizeString(s: string): string {
  // Remove OSC (Operating System Command) sequences - potential for title/clipboard injection
  // Remove CSI sequences for cursor movement, erase, scroll (but keep SGR color codes \e[...m)
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '') // OSC sequences
    .replace(/\x1b\[[\d;]*[ABCDEFGHJKSTfnsu]/g, '')    // CSI cursor/erase sequences
    .replace(/\x1b\[\?[\d;]*[hl]/g, '');                 // CSI private mode set/reset
}

/**
 * Validate and sanitize a loaded custom Skin JSON object.
 * Returns a validated Skin or null if the data is invalid.
 */
function validateSkin(data: unknown): Skin | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;

  // Required string fields
  if (typeof d.name !== 'string' || d.name.length === 0 || d.name.length > MAX_STRING_LENGTH) return null;
  if (typeof d.description !== 'string' || d.description.length > MAX_STRING_LENGTH) return null;

  // banner
  if (typeof d.banner !== 'object' || d.banner === null) return null;
  const banner = d.banner as Record<string, unknown>;
  if (!Array.isArray(banner.art)) return null;
  if (banner.art.length > MAX_BANNER_ART_LINES) return null;
  for (let i = 0; i < banner.art.length; i++) {
    if (typeof banner.art[i] !== 'string') return null;
    if ((banner.art[i] as string).length > MAX_STRING_LENGTH) return null;
    banner.art[i] = sanitizeString(banner.art[i] as string);
  }
  const validBannerStyles = ['full', 'compact', 'none'];
  if (typeof banner.style !== 'string' || !validBannerStyles.includes(banner.style)) return null;

  // borders
  if (typeof d.borders !== 'object' || d.borders === null) return null;
  const borders = d.borders as Record<string, unknown>;
  const validBorderStyles = ['rounded', 'sharp', 'double', 'ascii', 'custom', 'none'];
  if (typeof borders.style !== 'string' || !validBorderStyles.includes(borders.style)) return null;

  // decorations
  if (typeof d.decorations !== 'object' || d.decorations === null) return null;
  const decorations = d.decorations as Record<string, unknown>;
  if (typeof decorations.promptPrefix !== 'string') return null;
  if (typeof decorations.assistantPrefix !== 'string') return null;
  if (typeof decorations.toolPrefix !== 'string') return null;
  if (typeof decorations.toolSuffix !== 'string') return null;
  if (typeof decorations.separator !== 'string') return null;
  const validSpinners = ['braille', 'dots', 'simple', 'blocks', 'custom'];
  if (typeof decorations.spinner !== 'string' || !validSpinners.includes(decorations.spinner)) return null;

  // Sanitize decoration strings
  decorations.promptPrefix = sanitizeString(decorations.promptPrefix as string);
  decorations.assistantPrefix = sanitizeString(decorations.assistantPrefix as string);
  decorations.toolPrefix = sanitizeString(decorations.toolPrefix as string);
  decorations.toolSuffix = sanitizeString(decorations.toolSuffix as string);
  decorations.separator = sanitizeString(decorations.separator as string);

  // diff
  if (typeof d.diff !== 'object' || d.diff === null) return null;
  const diff = d.diff as Record<string, unknown>;
  const validDiffStyles = ['inline', 'unified', 'side-by-side'];
  if (typeof diff.style !== 'string' || !validDiffStyles.includes(diff.style)) return null;
  if (typeof diff.showLineNumbers !== 'boolean') return null;
  if (typeof diff.contextLines !== 'number') return null;
  if (typeof diff.maxLineWidth !== 'number') return null;
  if (typeof diff.wordDiff !== 'boolean') return null;

  // density
  const validDensities = ['normal', 'compact', 'spacious'];
  if (typeof d.density !== 'string' || !validDensities.includes(d.density)) return null;

  // responsive
  if (typeof d.responsive !== 'object' || d.responsive === null) return null;
  const responsive = d.responsive as Record<string, unknown>;
  if (typeof responsive.compact !== 'number' || typeof responsive.wide !== 'number') return null;

  return data as Skin;
}

/** Required keys for a PaletteColors object */
const PALETTE_COLOR_KEYS: (keyof PaletteColors)[] = [
  'primary', 'secondary', 'accent',
  'text', 'textDim', 'textBold',
  'user', 'assistant', 'system', 'error',
  'codeKeyword', 'codeString', 'codeNumber', 'codeComment', 'codeFunction',
  'diffAdd', 'diffRemove', 'diffContext',
  'success', 'warning', 'info',
  'border', 'background', 'selection',
];

/**
 * Validate and sanitize a loaded custom Palette JSON object.
 * Returns a validated Palette or null if the data is invalid.
 */
function validatePalette(data: unknown): Palette | null {
  if (typeof data !== 'object' || data === null) return null;
  const d = data as Record<string, unknown>;

  if (typeof d.name !== 'string' || d.name.length === 0 || d.name.length > MAX_STRING_LENGTH) return null;
  if (typeof d.description !== 'string' || d.description.length > MAX_STRING_LENGTH) return null;

  if (typeof d.colors !== 'object' || d.colors === null) return null;
  const colors = d.colors as Record<string, unknown>;

  // Validate all required color keys exist and are strings (ANSI codes)
  for (const key of PALETTE_COLOR_KEYS) {
    if (typeof colors[key] !== 'string') return null;
    if ((colors[key] as string).length > MAX_STRING_LENGTH) return null;
    // Sanitize color values
    colors[key] = sanitizeString(colors[key] as string);
  }

  return data as Palette;
}

/**
 * Safely load and validate a custom JSON file with size limits.
 */
function loadCustomJSON(filePath: string): unknown | null {
  try {
    const stat = fs.statSync(filePath);
    if (stat.size > MAX_CUSTOM_FILE_SIZE) {
      console.warn(`Custom theme file too large (${stat.size} bytes, max ${MAX_CUSTOM_FILE_SIZE}): ${filePath}`);
      return null;
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch {
    return null;
  }
}

// ============================================================================
// State
// ============================================================================

let currentSkin: Skin | null = null;
let currentPalette: Palette | null = null;

// ============================================================================
// Directories
// ============================================================================

const HUD_DIR = path.join(os.homedir(), '.calliope-cli');
const SKINS_DIR = path.join(HUD_DIR, 'skins');
const PALETTES_DIR = path.join(HUD_DIR, 'palettes');

function ensureDir(dir: string): void {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

// ============================================================================
// Skin Management
// ============================================================================

export function getSkin(name?: string): Skin {
  if (!name) {
    if (currentSkin) return currentSkin;
    return SKINS.clean;
  }

  if (SKINS[name]) return SKINS[name];

  // Check custom skins directory
  ensureDir(SKINS_DIR);
  const customPath = path.join(SKINS_DIR, `${name}.json`);
  if (fs.existsSync(customPath)) {
    const raw = loadCustomJSON(customPath);
    if (raw) {
      const validated = validateSkin(raw);
      if (validated) return validated;
      console.warn(`Custom skin "${name}" failed schema validation — using default`);
    }
  }

  return SKINS.clean;
}

export function applySkin(name: string): boolean {
  const skin = getSkin(name);
  if (skin.name === name || SKINS[name]) {
    currentSkin = skin;
    return true;
  }
  return false;
}

export function getCurrentSkin(): Skin {
  return currentSkin || SKINS.clean;
}

export function listSkins(): Array<{ name: string; description: string; custom: boolean }> {
  const result: Array<{ name: string; description: string; custom: boolean }> = [];

  for (const [name, skin] of Object.entries(SKINS)) {
    result.push({ name, description: skin.description, custom: false });
  }

  ensureDir(SKINS_DIR);
  try {
    const files = fs.readdirSync(SKINS_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const name = file.slice(0, -5);
        if (!SKINS[name]) {
          const raw = loadCustomJSON(path.join(SKINS_DIR, file));
          if (raw) {
            const skin = validateSkin(raw);
            if (skin) {
              result.push({ name, description: skin.description || '', custom: true });
            }
          }
        }
      }
    }
  } catch {
    // Directory read failed
  }

  return result;
}

// ============================================================================
// Palette Management
// ============================================================================

export function getPalette(name?: string): Palette {
  if (!name) {
    if (currentPalette) return currentPalette;
    return PALETTES.default;
  }

  if (PALETTES[name]) return PALETTES[name];

  // Check custom palettes directory
  ensureDir(PALETTES_DIR);
  const customPath = path.join(PALETTES_DIR, `${name}.json`);
  if (fs.existsSync(customPath)) {
    const raw = loadCustomJSON(customPath);
    if (raw) {
      const validated = validatePalette(raw);
      if (validated) return validated;
      console.warn(`Custom palette "${name}" failed schema validation — using default`);
    }
  }

  return PALETTES.default;
}

export function applyPalette(name: string): boolean {
  const palette = getPalette(name);
  if (palette.name === name || PALETTES[name]) {
    currentPalette = palette;
    return true;
  }
  return false;
}

export function getCurrentPalette(): Palette {
  return currentPalette || PALETTES.default;
}

export function listPalettes(): Array<{ name: string; description: string; custom: boolean }> {
  const result: Array<{ name: string; description: string; custom: boolean }> = [];

  for (const [name, palette] of Object.entries(PALETTES)) {
    result.push({ name, description: palette.description, custom: false });
  }

  ensureDir(PALETTES_DIR);
  try {
    const files = fs.readdirSync(PALETTES_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const name = file.slice(0, -5);
        if (!PALETTES[name]) {
          const raw = loadCustomJSON(path.join(PALETTES_DIR, file));
          if (raw) {
            const palette = validatePalette(raw);
            if (palette) {
              result.push({ name, description: palette.description || '', custom: true });
            }
          }
        }
      }
    }
  } catch {
    // Directory read failed
  }

  return result;
}

// ============================================================================
// HUD Apply
// ============================================================================

export function applyHUD(skinName: string, paletteName: string, _companionName?: string): void {
  applySkin(skinName);
  applyPalette(paletteName);
}

// ============================================================================
// Discovery
// ============================================================================

export function discoverSkins(): Skin[] {
  const result: Skin[] = Object.values(SKINS);

  ensureDir(SKINS_DIR);
  try {
    const files = fs.readdirSync(SKINS_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const raw = loadCustomJSON(path.join(SKINS_DIR, file));
        if (raw) {
          const skin = validateSkin(raw);
          if (skin && skin.name && !SKINS[skin.name]) {
            result.push(skin);
          }
        }
      }
    }
  } catch {
    // Directory read failed
  }

  return result;
}

export function discoverPalettes(): Palette[] {
  const result: Palette[] = Object.values(PALETTES);

  ensureDir(PALETTES_DIR);
  try {
    const files = fs.readdirSync(PALETTES_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        const raw = loadCustomJSON(path.join(PALETTES_DIR, file));
        if (raw) {
          const palette = validatePalette(raw);
          if (palette && palette.name && !PALETTES[palette.name]) {
            result.push(palette);
          }
        }
      }
    }
  } catch {
    // Directory read failed
  }

  return result;
}

// ============================================================================
// Helpers
// ============================================================================

export function getBoxChars(skin?: Skin): BoxChars {
  const s = skin || getCurrentSkin();
  if (s.borders.style === 'custom' && s.borders.custom) {
    return s.borders.custom;
  }
  return BOX_STYLES[s.borders.style] || BOX_STYLES.rounded;
}

export function getSpinnerFrames(skin?: Skin): string[] {
  const s = skin || getCurrentSkin();
  if (s.decorations.spinner === 'custom' && s.decorations.customSpinner) {
    return s.decorations.customSpinner;
  }
  return SPINNER_SETS[s.decorations.spinner] || SPINNER_SETS.braille;
}

export function getPaletteColor(key: SemanticColorKey): string {
  const palette = getCurrentPalette();
  return palette.colors[key] || '';
}

export function paletteColorize(text: string, key: SemanticColorKey): string {
  const color = getPaletteColor(key);
  return `${color}${text}${ANSI.reset}`;
}

export function getInkColor(key: SemanticColorKey): string {
  const ansiCode = getPaletteColor(key);
  return ansiToInkColor(ansiCode);
}

const ANSI_TO_INK: Record<string, string> = {
  [ANSI.black]: 'black',
  [ANSI.red]: 'red',
  [ANSI.green]: 'green',
  [ANSI.yellow]: 'yellow',
  [ANSI.blue]: 'blue',
  [ANSI.magenta]: 'magenta',
  [ANSI.cyan]: 'cyan',
  [ANSI.white]: 'white',
  [ANSI.gray]: 'gray',
  [ANSI.brightRed]: 'redBright',
  [ANSI.brightGreen]: 'greenBright',
  [ANSI.brightYellow]: 'yellowBright',
  [ANSI.brightBlue]: 'blueBright',
  [ANSI.brightMagenta]: 'magentaBright',
  [ANSI.brightCyan]: 'cyanBright',
  [ANSI.brightWhite]: 'whiteBright',
};

function ansiToInkColor(ansiCode: string): string {
  const stripped = ansiCode.replace(/\x1b\[(1|2|3|4)m/g, '');
  return ANSI_TO_INK[stripped] || 'white';
}

export function getInkBorderStyle(skin?: Skin): string {
  const s = skin || getCurrentSkin();
  const map: Record<string, string> = {
    rounded: 'round',
    sharp: 'single',
    double: 'double',
    ascii: 'classic',
    none: 'single',
  };
  return map[s.borders.style] || 'round';
}

// ============================================================================
// Save custom skin/palette
// ============================================================================

export function saveCustomSkin(skin: Skin): void {
  ensureDir(SKINS_DIR);
  fs.writeFileSync(
    path.join(SKINS_DIR, `${skin.name}.json`),
    JSON.stringify(skin, null, 2)
  );
}

export function saveCustomPalette(palette: Palette): void {
  ensureDir(PALETTES_DIR);
  fs.writeFileSync(
    path.join(PALETTES_DIR, `${palette.name}.json`),
    JSON.stringify(palette, null, 2)
  );
}

export function clearHUDCache(): void {
  currentSkin = null;
  currentPalette = null;
}
