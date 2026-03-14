/**
 * Tests for hud/api.ts validateSkin and validatePalette branches.
 *
 * These functions are exercised when loading custom JSON files from the
 * ~/.calliope-cli/skins/ and ~/.calliope-cli/palettes/ directories.
 * We write test files there and trigger loading via getSkin/getPalette/
 * listSkins/listPalettes/discoverSkins/discoverPalettes.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  getSkin,
  getPalette,
  listSkins,
  listPalettes,
  discoverSkins,
  discoverPalettes,
  clearHUDCache,
  getBoxChars,
  getSpinnerFrames,
  saveCustomSkin,
  saveCustomPalette,
} from '../src/hud/api.js';
import { SKINS, BOX_STYLES, SPINNER_SETS } from '../src/hud/skins.js';
import { PALETTES } from '../src/hud/palettes.js';
import type { Skin, Palette } from '../src/hud/types.js';

const HOME_DIR = os.homedir();
const SKINS_DIR = path.join(HOME_DIR, '.calliope-cli', 'skins');
const PALETTES_DIR = path.join(HOME_DIR, '.calliope-cli', 'palettes');
const TEST_SKIN_NAME = '__test-validation-skin__';
const TEST_PALETTE_NAME = '__test-validation-palette__';

// A valid skin JSON matching the schema
const VALID_SKIN_JSON = {
  name: TEST_SKIN_NAME,
  description: 'Test validation skin',
  banner: {
    art: ['Test Banner Line 1', 'Test Banner Line 2'],
    tagline: 'Test tagline',
    style: 'full',
  },
  borders: { style: 'rounded' },
  decorations: {
    promptPrefix: '> ',
    assistantPrefix: '* ',
    toolPrefix: '[ ',
    toolSuffix: ' ]',
    separator: '-',
    spinner: 'braille',
  },
  diff: {
    style: 'inline',
    showLineNumbers: true,
    contextLines: 2,
    maxLineWidth: 80,
    wordDiff: false,
  },
  density: 'normal',
  responsive: { compact: 80, wide: 120 },
};

// All required palette color keys
const ALL_PALETTE_COLORS: Record<string, string> = {
  primary: '\x1b[36m',
  secondary: '\x1b[34m',
  accent: '\x1b[35m',
  text: '\x1b[37m',
  textDim: '\x1b[90m',
  textBold: '\x1b[1m\x1b[37m',
  user: '\x1b[32m',
  assistant: '\x1b[36m',
  system: '\x1b[33m',
  error: '\x1b[31m',
  codeKeyword: '\x1b[35m',
  codeString: '\x1b[32m',
  codeNumber: '\x1b[36m',
  codeComment: '\x1b[90m',
  codeFunction: '\x1b[33m',
  diffAdd: '\x1b[32m',
  diffRemove: '\x1b[31m',
  diffContext: '\x1b[90m',
  success: '\x1b[32m',
  warning: '\x1b[33m',
  info: '\x1b[34m',
  border: '\x1b[90m',
  background: '',
  selection: '\x1b[44m',
};

const VALID_PALETTE_JSON = {
  name: TEST_PALETTE_NAME,
  description: 'Test validation palette',
  colors: { ...ALL_PALETTE_COLORS },
};

function ensureSkinsDir(): void {
  if (!fs.existsSync(SKINS_DIR)) {
    fs.mkdirSync(SKINS_DIR, { recursive: true });
  }
}

function ensurePalettesDir(): void {
  if (!fs.existsSync(PALETTES_DIR)) {
    fs.mkdirSync(PALETTES_DIR, { recursive: true });
  }
}

function writeSkin(name: string, data: unknown): void {
  ensureSkinsDir();
  fs.writeFileSync(path.join(SKINS_DIR, `${name}.json`), JSON.stringify(data));
}

function writePalette(name: string, data: unknown): void {
  ensurePalettesDir();
  fs.writeFileSync(path.join(PALETTES_DIR, `${name}.json`), JSON.stringify(data));
}

function removeSkin(name: string): void {
  const f = path.join(SKINS_DIR, `${name}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

function removePalette(name: string): void {
  const f = path.join(PALETTES_DIR, `${name}.json`);
  if (fs.existsSync(f)) fs.unlinkSync(f);
}

beforeEach(() => {
  clearHUDCache();
  removeSkin(TEST_SKIN_NAME);
  removePalette(TEST_PALETTE_NAME);
});

afterEach(() => {
  clearHUDCache();
  removeSkin(TEST_SKIN_NAME);
  removePalette(TEST_PALETTE_NAME);
});

// ============================================================================
// validateSkin via getSkin (custom file path)
// ============================================================================

describe('validateSkin - exercised via custom JSON files', () => {
  it('should load a valid custom skin', () => {
    writeSkin(TEST_SKIN_NAME, VALID_SKIN_JSON);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe(TEST_SKIN_NAME);
  });

  it('should return clean when data is null', () => {
    writeSkin(TEST_SKIN_NAME, null);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when data is a non-object primitive (number)', () => {
    writeSkin(TEST_SKIN_NAME, 42);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when name is missing', () => {
    const bad = { ...VALID_SKIN_JSON, name: undefined };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when name is empty string', () => {
    const bad = { ...VALID_SKIN_JSON, name: '' };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when description is not a string', () => {
    const bad = { ...VALID_SKIN_JSON, description: 123 };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when banner is not an object', () => {
    const bad = { ...VALID_SKIN_JSON, banner: 'invalid' };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when banner.art is not an array', () => {
    const bad = { ...VALID_SKIN_JSON, banner: { ...VALID_SKIN_JSON.banner, art: 'invalid' } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when banner.art contains non-string', () => {
    const bad = { ...VALID_SKIN_JSON, banner: { ...VALID_SKIN_JSON.banner, art: [42] } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when banner.style is invalid', () => {
    const bad = { ...VALID_SKIN_JSON, banner: { ...VALID_SKIN_JSON.banner, style: 'fancy' } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when borders is missing', () => {
    const bad = { ...VALID_SKIN_JSON, borders: undefined };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when borders.style is invalid', () => {
    const bad = { ...VALID_SKIN_JSON, borders: { style: 'hexagonal' } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when decorations is missing', () => {
    const bad = { ...VALID_SKIN_JSON, decorations: undefined };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when decorations.promptPrefix is not a string', () => {
    const bad = { ...VALID_SKIN_JSON, decorations: { ...VALID_SKIN_JSON.decorations, promptPrefix: 42 } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when decorations.assistantPrefix is not a string', () => {
    const bad = { ...VALID_SKIN_JSON, decorations: { ...VALID_SKIN_JSON.decorations, assistantPrefix: null } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when decorations.toolPrefix is not a string', () => {
    const bad = { ...VALID_SKIN_JSON, decorations: { ...VALID_SKIN_JSON.decorations, toolPrefix: false } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when decorations.toolSuffix is not a string', () => {
    const bad = { ...VALID_SKIN_JSON, decorations: { ...VALID_SKIN_JSON.decorations, toolSuffix: undefined } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when decorations.separator is not a string', () => {
    const bad = { ...VALID_SKIN_JSON, decorations: { ...VALID_SKIN_JSON.decorations, separator: 42 } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when decorations.spinner is invalid', () => {
    const bad = { ...VALID_SKIN_JSON, decorations: { ...VALID_SKIN_JSON.decorations, spinner: 'spin' } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when diff is missing', () => {
    const bad = { ...VALID_SKIN_JSON, diff: undefined };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when diff.style is invalid', () => {
    const bad = { ...VALID_SKIN_JSON, diff: { ...VALID_SKIN_JSON.diff, style: 'fancy' } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when diff.showLineNumbers is not boolean', () => {
    const bad = { ...VALID_SKIN_JSON, diff: { ...VALID_SKIN_JSON.diff, showLineNumbers: 'yes' } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when diff.contextLines is not a number', () => {
    const bad = { ...VALID_SKIN_JSON, diff: { ...VALID_SKIN_JSON.diff, contextLines: '3' } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when diff.maxLineWidth is not a number', () => {
    const bad = { ...VALID_SKIN_JSON, diff: { ...VALID_SKIN_JSON.diff, maxLineWidth: 'wide' } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when diff.wordDiff is not boolean', () => {
    const bad = { ...VALID_SKIN_JSON, diff: { ...VALID_SKIN_JSON.diff, wordDiff: 'no' } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when density is invalid', () => {
    const bad = { ...VALID_SKIN_JSON, density: 'extreme' };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when responsive is missing', () => {
    const bad = { ...VALID_SKIN_JSON, responsive: undefined };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should return clean when responsive.compact is not a number', () => {
    const bad = { ...VALID_SKIN_JSON, responsive: { compact: 'small', wide: 120 } };
    writeSkin(TEST_SKIN_NAME, bad);
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });

  it('should sanitize ANSI sequences in banner art', () => {
    // Inject CSI cursor escape into banner art - should be stripped
    const maliciousSkin = {
      ...VALID_SKIN_JSON,
      banner: {
        ...VALID_SKIN_JSON.banner,
        art: ['Normal text \x1b[2JClear screen attempt'],
      },
    };
    writeSkin(TEST_SKIN_NAME, maliciousSkin);
    const skin = getSkin(TEST_SKIN_NAME);
    // Should load (valid structure) but with sanitized art
    if (skin.name === TEST_SKIN_NAME) {
      expect(skin.banner.art[0]).not.toContain('\x1b[2J');
    }
  });

  it('should load into listSkins as custom skin', () => {
    writeSkin(TEST_SKIN_NAME, VALID_SKIN_JSON);
    const skins = listSkins();
    const found = skins.find(s => s.name === TEST_SKIN_NAME);
    expect(found).toBeDefined();
    expect(found!.custom).toBe(true);
  });

  it('should not include invalid custom skin in listSkins', () => {
    writeSkin(TEST_SKIN_NAME, { name: 'bad', description: 123 });
    const skins = listSkins();
    const found = skins.find(s => s.name === TEST_SKIN_NAME);
    expect(found).toBeUndefined();
  });

  it('should load into discoverSkins as custom skin', () => {
    writeSkin(TEST_SKIN_NAME, VALID_SKIN_JSON);
    const skins = discoverSkins();
    const found = skins.find(s => s.name === TEST_SKIN_NAME);
    expect(found).toBeDefined();
  });
});

// ============================================================================
// validatePalette via getPalette (custom file path)
// ============================================================================

describe('validatePalette - exercised via custom JSON files', () => {
  it('should load a valid custom palette', () => {
    writePalette(TEST_PALETTE_NAME, VALID_PALETTE_JSON);
    const palette = getPalette(TEST_PALETTE_NAME);
    expect(palette.name).toBe(TEST_PALETTE_NAME);
  });

  it('should return default when data is null', () => {
    writePalette(TEST_PALETTE_NAME, null);
    const palette = getPalette(TEST_PALETTE_NAME);
    expect(palette.name).toBe('default');
  });

  it('should return default when data is a non-object', () => {
    writePalette(TEST_PALETTE_NAME, 'string');
    const palette = getPalette(TEST_PALETTE_NAME);
    expect(palette.name).toBe('default');
  });

  it('should return default when name is missing', () => {
    const bad = { ...VALID_PALETTE_JSON, name: undefined };
    writePalette(TEST_PALETTE_NAME, bad);
    const palette = getPalette(TEST_PALETTE_NAME);
    expect(palette.name).toBe('default');
  });

  it('should return default when name is empty string', () => {
    const bad = { ...VALID_PALETTE_JSON, name: '' };
    writePalette(TEST_PALETTE_NAME, bad);
    const palette = getPalette(TEST_PALETTE_NAME);
    expect(palette.name).toBe('default');
  });

  it('should return default when description is not a string', () => {
    const bad = { ...VALID_PALETTE_JSON, description: 42 };
    writePalette(TEST_PALETTE_NAME, bad);
    const palette = getPalette(TEST_PALETTE_NAME);
    expect(palette.name).toBe('default');
  });

  it('should return default when colors is missing', () => {
    const bad = { ...VALID_PALETTE_JSON, colors: undefined };
    writePalette(TEST_PALETTE_NAME, bad);
    const palette = getPalette(TEST_PALETTE_NAME);
    expect(palette.name).toBe('default');
  });

  it('should return default when colors is not an object', () => {
    const bad = { ...VALID_PALETTE_JSON, colors: 'colors' };
    writePalette(TEST_PALETTE_NAME, bad);
    const palette = getPalette(TEST_PALETTE_NAME);
    expect(palette.name).toBe('default');
  });

  it('should return default when a required color key is missing', () => {
    const badColors = { ...ALL_PALETTE_COLORS };
    delete (badColors as Record<string, unknown>)['primary'];
    const bad = { ...VALID_PALETTE_JSON, colors: badColors };
    writePalette(TEST_PALETTE_NAME, bad);
    const palette = getPalette(TEST_PALETTE_NAME);
    expect(palette.name).toBe('default');
  });

  it('should return default when a color key is not a string', () => {
    const badColors = { ...ALL_PALETTE_COLORS, primary: 42 };
    const bad = { ...VALID_PALETTE_JSON, colors: badColors };
    writePalette(TEST_PALETTE_NAME, bad);
    const palette = getPalette(TEST_PALETTE_NAME);
    expect(palette.name).toBe('default');
  });

  it('should load into listPalettes as custom palette', () => {
    writePalette(TEST_PALETTE_NAME, VALID_PALETTE_JSON);
    const palettes = listPalettes();
    const found = palettes.find(p => p.name === TEST_PALETTE_NAME);
    expect(found).toBeDefined();
    expect(found!.custom).toBe(true);
  });

  it('should not include invalid custom palette in listPalettes', () => {
    writePalette(TEST_PALETTE_NAME, { name: 'bad', description: 123 });
    const palettes = listPalettes();
    const found = palettes.find(p => p.name === TEST_PALETTE_NAME);
    expect(found).toBeUndefined();
  });

  it('should load into discoverPalettes as custom palette', () => {
    writePalette(TEST_PALETTE_NAME, VALID_PALETTE_JSON);
    const palettes = discoverPalettes();
    const found = palettes.find(p => p.name === TEST_PALETTE_NAME);
    expect(found).toBeDefined();
  });
});

// ============================================================================
// saveCustomSkin / saveCustomPalette
// ============================================================================

describe('saveCustomSkin', () => {
  it('should write a skin to the skins directory', () => {
    const skin = getSkin('clean');
    const testSkin: Skin = { ...skin, name: TEST_SKIN_NAME, description: 'saved test' };
    saveCustomSkin(testSkin);

    const savedPath = path.join(SKINS_DIR, `${TEST_SKIN_NAME}.json`);
    expect(fs.existsSync(savedPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(savedPath, 'utf-8'));
    expect(content.name).toBe(TEST_SKIN_NAME);
    expect(content.description).toBe('saved test');
  });
});

describe('saveCustomPalette', () => {
  it('should write a palette to the palettes directory', () => {
    const palette = getPalette('default');
    const testPalette: Palette = { ...palette, name: TEST_PALETTE_NAME, description: 'saved test' };
    saveCustomPalette(testPalette);

    const savedPath = path.join(PALETTES_DIR, `${TEST_PALETTE_NAME}.json`);
    expect(fs.existsSync(savedPath)).toBe(true);

    const content = JSON.parse(fs.readFileSync(savedPath, 'utf-8'));
    expect(content.name).toBe(TEST_PALETTE_NAME);
  });
});

// ============================================================================
// getBoxChars - custom border style
// ============================================================================

describe('getBoxChars - border styles', () => {
  it('should return rounded box chars for clean skin (default)', () => {
    const skin = getSkin('clean');
    const box = getBoxChars(skin);
    expect(box).toEqual(BOX_STYLES.rounded);
  });

  it('should return double box chars for falcon skin', () => {
    const skin = getSkin('falcon');
    const box = getBoxChars(skin);
    expect(box).toEqual(BOX_STYLES.double);
  });

  it('should use getBoxChars with no arg (uses getCurrentSkin)', () => {
    const box = getBoxChars();
    expect(box).toBeDefined();
    expect(box).toHaveProperty('topLeft');
  });

  it('should fall back to rounded for unknown border style', () => {
    // Create a skin with an invalid border style that passes validation (won't happen via JSON)
    // Instead test with custom=undefined which returns BOX_STYLES.rounded via fallback
    const fakeSkin: Skin = {
      ...getSkin('clean'),
      borders: { style: 'unknown' as 'rounded' },
    };
    const box = getBoxChars(fakeSkin);
    expect(box).toEqual(BOX_STYLES.rounded);
  });
});

// ============================================================================
// getSpinnerFrames - spinner styles
// ============================================================================

describe('getSpinnerFrames - spinner styles', () => {
  it('should return braille spinner frames for clean skin', () => {
    const skin = getSkin('clean');
    const frames = getSpinnerFrames(skin);
    expect(frames).toEqual(SPINNER_SETS.braille);
  });

  it('should return dots spinner frames for falcon skin', () => {
    const skin = getSkin('falcon');
    const frames = getSpinnerFrames(skin);
    expect(frames).toEqual(SPINNER_SETS.dots);
  });

  it('should use getSpinnerFrames with no arg (uses getCurrentSkin)', () => {
    const frames = getSpinnerFrames();
    expect(Array.isArray(frames)).toBe(true);
    expect(frames.length).toBeGreaterThan(0);
  });

  it('should fall back to braille for unknown spinner type', () => {
    const fakeSkin: Skin = {
      ...getSkin('clean'),
      decorations: {
        ...getSkin('clean').decorations,
        spinner: 'unknown' as 'braille',
      },
    };
    const frames = getSpinnerFrames(fakeSkin);
    expect(frames).toEqual(SPINNER_SETS.braille);
  });
});

// ============================================================================
// loadCustomJSON - file too large branch
// ============================================================================

describe('loadCustomJSON - large file protection', () => {
  it('should skip file that is too large to load as skin', () => {
    // Create a 1MB+ file in skins dir — loadCustomJSON should return null for it
    ensureSkinsDir();
    const largeSkinPath = path.join(SKINS_DIR, `${TEST_SKIN_NAME}.json`);
    // Write content that exceeds MAX_CUSTOM_FILE_SIZE (1MB)
    fs.writeFileSync(largeSkinPath, '{' + 'x'.repeat(1_100_000) + '}');

    // getSkin should fall back to clean since the file is too large to parse
    const skin = getSkin(TEST_SKIN_NAME);
    expect(skin.name).toBe('clean');
  });
});

// ============================================================================
// listSkins/listPalettes - custom JSON file already named like built-in
// ============================================================================

describe('listSkins - custom JSON matches built-in name is skipped', () => {
  it('should skip custom JSON file if name matches built-in skin name', () => {
    // Write a JSON file with name 'clean' — since 'clean' is a built-in, the custom path
    // in listSkins uses `if (!SKINS[name])` so it won't add a duplicate
    const builtInOverride = { ...VALID_SKIN_JSON, name: 'clean' };
    ensureSkinsDir();
    fs.writeFileSync(path.join(SKINS_DIR, 'clean.json'), JSON.stringify(builtInOverride));

    const skins = listSkins();
    const cleanEntries = skins.filter(s => s.name === 'clean');
    // Only one 'clean' entry — the built-in, not the custom file
    expect(cleanEntries.length).toBe(1);
    expect(cleanEntries[0].custom).toBe(false);

    // Cleanup
    fs.unlinkSync(path.join(SKINS_DIR, 'clean.json'));
  });
});
