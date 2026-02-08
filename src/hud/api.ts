/**
 * HUD API
 *
 * State management, discovery, and helper functions.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { colors as ANSI } from '../styles.js';
import type { Skin, Palette, BoxChars, SemanticColorKey } from './types.js';
import { SKINS, BOX_STYLES, SPINNER_SETS } from './skins.js';
import { PALETTES } from './palettes.js';

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
    try {
      return JSON.parse(fs.readFileSync(customPath, 'utf-8')) as Skin;
    } catch {
      // Fall through
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
          try {
            const skin = JSON.parse(fs.readFileSync(path.join(SKINS_DIR, file), 'utf-8')) as Skin;
            result.push({ name, description: skin.description || '', custom: true });
          } catch {
            // Skip invalid
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
    try {
      return JSON.parse(fs.readFileSync(customPath, 'utf-8')) as Palette;
    } catch {
      // Fall through
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
          try {
            const palette = JSON.parse(fs.readFileSync(path.join(PALETTES_DIR, file), 'utf-8')) as Palette;
            result.push({ name, description: palette.description || '', custom: true });
          } catch {
            // Skip invalid
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
        try {
          const skin = JSON.parse(fs.readFileSync(path.join(SKINS_DIR, file), 'utf-8')) as Skin;
          if (skin.name && !SKINS[skin.name]) {
            result.push(skin);
          }
        } catch {
          // Skip invalid
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
        try {
          const palette = JSON.parse(fs.readFileSync(path.join(PALETTES_DIR, file), 'utf-8')) as Palette;
          if (palette.name && !PALETTES[palette.name]) {
            result.push(palette);
          }
        } catch {
          // Skip invalid
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
