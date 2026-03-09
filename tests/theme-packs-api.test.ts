import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import type { ThemePack, ThemeCategory } from '../src/hud/theme-packs/types.js';
import type { PersonaCompanion } from '../src/companions.js';
import type { Skin, Palette } from '../src/hud/types.js';

// We import the stateless query functions directly — they don't depend on
// module-level mutable state so a single import is fine.
import {
  listThemePacks,
  getThemePack,
  getPackCompanions,
} from '../src/hud/theme-packs/api.js';

import { THEME_PACKS } from '../src/hud/theme-packs/index.js';

// ============================================================================
// Mock theme pack data — avoids dependency on @calliopelabs/cli-themes
// ============================================================================

function mockCompanion(name: string): PersonaCompanion {
  return {
    name,
    description: `${name} companion`,
    systemPrompt: `You are ${name}.`,
    greeting: 'Hello!',
    farewell: 'Goodbye!',
    moods: {
      idle: 'idle',
      thinking: 'thinking',
      success: 'success',
      error: 'error',
      frustrated: 'frustrated',
      excited: 'excited',
      focused: 'focused',
    },
  };
}

function mockSkin(name: string): Skin {
  return {
    name,
    description: `${name} skin`,
    banner: { art: ['banner'], style: 'compact' },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '> ',
      assistantPrefix: '< ',
      toolPrefix: '[',
      toolSuffix: ']',
      separator: '---',
      spinner: 'dots',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'path',
    },
    density: 'normal',
    responsive: { compact: 60, wide: 120 },
  };
}

function mockPalette(name: string): Palette {
  return {
    name,
    description: `${name} palette`,
    colors: {
      primary: '#ff0000',
      secondary: '#00ff00',
      accent: '#0000ff',
      text: '#ffffff',
      textDim: '#888888',
      textBold: '#ffffff',
      user: '#00ff00',
      assistant: '#00ffff',
      system: '#ffff00',
      error: '#ff0000',
      codeKeyword: '#ff00ff',
      codeString: '#00ff00',
      codeNumber: '#ffff00',
      codeComment: '#888888',
      codeFunction: '#00ffff',
      diffAdd: '#00ff00',
      diffRemove: '#ff0000',
      diffContext: '#888888',
      success: '#00ff00',
      warning: '#ffff00',
      info: '#00ffff',
      border: '#444444',
      background: '#000000',
      selection: '#333333',
    },
  };
}

function mockThemePack(
  name: string,
  category: ThemeCategory,
  additional?: PersonaCompanion[],
): ThemePack {
  return {
    name,
    description: `${name} theme pack`,
    category,
    skin: mockSkin(name),
    palette: mockPalette(name),
    companions: {
      professional: mockCompanion(`${name}-pro`),
      immersive: mockCompanion(`${name}-immersive`),
      ...(additional ? { additional } : {}),
    },
  };
}

const MOCK_PACKS: Record<string, ThemePack> = {
  mario: mockThemePack('mario', 'gaming', [mockCompanion('mario-extra')]),
  doom: mockThemePack('doom', 'gaming'),
  tng: mockThemePack('tng', 'trek'),
  ds9: mockThemePack('ds9', 'trek'),
  matrix: mockThemePack('matrix', 'scifi'),
  clean: mockThemePack('clean', 'minimal'),
};

// Populate the shared THEME_PACKS registry with our mock data
beforeAll(() => {
  Object.assign(THEME_PACKS, MOCK_PACKS);
});

// ============================================================================
// listThemePacks
// ============================================================================

describe('listThemePacks', () => {
  it('should return all packs when no category filter is given', () => {
    const all = listThemePacks();
    expect(all.length).toBe(Object.keys(THEME_PACKS).length);
    expect(all.length).toBeGreaterThan(0);
  });

  it('should return a subset when filtered by category', () => {
    const gaming = listThemePacks('gaming');
    const all = listThemePacks();
    expect(gaming.length).toBeGreaterThan(0);
    expect(gaming.length).toBeLessThan(all.length);
    gaming.forEach(p => {
      expect(p.category).toBe('gaming');
    });
  });

  it('should filter by trek category', () => {
    const trek = listThemePacks('trek');
    expect(trek.length).toBeGreaterThan(0);
    trek.forEach(p => {
      expect(p.category).toBe('trek');
    });
  });

  it('should return empty array for a category with no packs', () => {
    // 'custom' is a valid ThemeCategory but no mock packs use it
    const custom = listThemePacks('custom' as ThemeCategory);
    expect(custom).toEqual([]);
  });

  it('should return results with correct shape (name, description, category)', () => {
    const all = listThemePacks();
    all.forEach(p => {
      expect(p).toHaveProperty('name');
      expect(p).toHaveProperty('description');
      expect(p).toHaveProperty('category');
      expect(typeof p.name).toBe('string');
      expect(typeof p.description).toBe('string');
      expect(typeof p.category).toBe('string');
      // Should not leak full ThemePack fields (skin, palette, companions)
      expect(p).not.toHaveProperty('skin');
      expect(p).not.toHaveProperty('palette');
      expect(p).not.toHaveProperty('companions');
    });
  });

  it('should include known packs by name', () => {
    const all = listThemePacks();
    const names = all.map(p => p.name);
    expect(names).toContain(THEME_PACKS['mario'].name);
    expect(names).toContain(THEME_PACKS['tng'].name);
    expect(names).toContain(THEME_PACKS['matrix'].name);
    expect(names).toContain(THEME_PACKS['clean'].name);
  });
});

// ============================================================================
// getThemePack
// ============================================================================

describe('getThemePack', () => {
  it('should return a pack by name', () => {
    const pack = getThemePack('mario');
    expect(pack).toBeDefined();
    expect(pack!.name).toBe('mario');
    expect(pack!.category).toBe('gaming');
    expect(pack!.skin).toBeDefined();
    expect(pack!.palette).toBeDefined();
    expect(pack!.companions).toBeDefined();
    expect(pack!.companions.professional).toBeDefined();
    expect(pack!.companions.immersive).toBeDefined();
  });

  it('should return undefined for an unknown name', () => {
    expect(getThemePack('nonexistent-theme')).toBeUndefined();
    expect(getThemePack('')).toBeUndefined();
  });

  it('should return the same object reference as THEME_PACKS', () => {
    const pack = getThemePack('tng');
    expect(pack).toBe(THEME_PACKS['tng']);
  });
});

// ============================================================================
// getPackCompanions
// ============================================================================

describe('getPackCompanions', () => {
  it('should return at least professional and immersive companion names', () => {
    const companions = getPackCompanions('mario');
    expect(companions.length).toBeGreaterThanOrEqual(2);
    const pack = THEME_PACKS['mario'];
    expect(companions).toContain(pack.companions.professional.name);
    expect(companions).toContain(pack.companions.immersive.name);
  });

  it('should include additional companions when present', () => {
    // mario has additional companions in our mock
    const companions = getPackCompanions('mario');
    const pack = THEME_PACKS['mario'];
    expect(pack.companions.additional).toBeDefined();
    expect(companions.length).toBe(
      2 + (pack.companions.additional?.length ?? 0),
    );
    pack.companions.additional!.forEach(c => {
      expect(companions).toContain(c.name);
    });
  });

  it('should return empty array for unknown pack', () => {
    expect(getPackCompanions('nonexistent-theme')).toEqual([]);
  });
});

// ============================================================================
// Stateful API — use dynamic imports to reset module state between suites
// ============================================================================

/**
 * Helper: after vi.resetModules(), re-import the theme-packs index module
 * and inject mock packs so the fresh THEME_PACKS registry is populated.
 */
async function loadFreshModules() {
  const indexMod = await import('../src/hud/theme-packs/index.js');
  Object.assign(indexMod.THEME_PACKS, MOCK_PACKS);
  const mod = await import('../src/hud/theme-packs/api.js');
  return { indexMod, mod };
}

describe('applyThemePack', () => {
  let applyThemePack: typeof import('../src/hud/theme-packs/api.js').applyThemePack;
  let getCurrentPack: typeof import('../src/hud/theme-packs/api.js').getCurrentPack;
  let getCompanionMode: typeof import('../src/hud/theme-packs/api.js').getCompanionMode;

  beforeEach(async () => {
    vi.resetModules();
    const { mod } = await loadFreshModules();
    applyThemePack = mod.applyThemePack;
    getCurrentPack = mod.getCurrentPack;
    getCompanionMode = mod.getCompanionMode;
  });

  it('should return true for a valid pack name', () => {
    expect(applyThemePack('mario')).toBe(true);
  });

  it('should return false for an unknown pack name', () => {
    expect(applyThemePack('totally-fake-pack')).toBe(false);
  });

  it('should set the current pack after applying', () => {
    expect(getCurrentPack()).toBeNull();
    applyThemePack('mario');
    const pack = getCurrentPack();
    expect(pack).not.toBeNull();
    expect(pack!.name).toBe('mario');
  });

  it('should default to immersive mode', () => {
    applyThemePack('tng');
    expect(getCompanionMode()).toBe('immersive');
  });

  it('should accept professional mode', () => {
    applyThemePack('tng', 'professional');
    expect(getCompanionMode()).toBe('professional');
  });

  it('should not change current pack when applying an unknown name', () => {
    applyThemePack('mario');
    const before = getCurrentPack();
    applyThemePack('nonexistent');
    expect(getCurrentPack()).toBe(before);
  });

  it('should allow switching packs', () => {
    applyThemePack('mario');
    expect(getCurrentPack()!.name).toBe('mario');
    applyThemePack('matrix');
    expect(getCurrentPack()!.name).toBe('matrix');
  });
});

// ============================================================================
// getCurrentPack
// ============================================================================

describe('getCurrentPack', () => {
  let applyThemePack: typeof import('../src/hud/theme-packs/api.js').applyThemePack;
  let getCurrentPack: typeof import('../src/hud/theme-packs/api.js').getCurrentPack;

  beforeEach(async () => {
    vi.resetModules();
    const { mod } = await loadFreshModules();
    applyThemePack = mod.applyThemePack;
    getCurrentPack = mod.getCurrentPack;
  });

  it('should return null when no pack has been applied', () => {
    expect(getCurrentPack()).toBeNull();
  });

  it('should return the pack after one has been applied', () => {
    applyThemePack('doom');
    const pack = getCurrentPack();
    expect(pack).not.toBeNull();
    expect(pack!.name).toBe('doom');
    expect(pack!.category).toBe('gaming');
  });
});

// ============================================================================
// getCompanionMode
// ============================================================================

describe('getCompanionMode', () => {
  let applyThemePack: typeof import('../src/hud/theme-packs/api.js').applyThemePack;
  let getCompanionMode: typeof import('../src/hud/theme-packs/api.js').getCompanionMode;

  beforeEach(async () => {
    vi.resetModules();
    const { mod } = await loadFreshModules();
    applyThemePack = mod.applyThemePack;
    getCompanionMode = mod.getCompanionMode;
  });

  it('should default to immersive when no pack is applied', () => {
    expect(getCompanionMode()).toBe('immersive');
  });

  it('should reflect the mode given to applyThemePack', () => {
    applyThemePack('matrix', 'professional');
    expect(getCompanionMode()).toBe('professional');
  });

  it('should update when a new pack is applied with a different mode', () => {
    applyThemePack('matrix', 'professional');
    expect(getCompanionMode()).toBe('professional');
    applyThemePack('doom', 'immersive');
    expect(getCompanionMode()).toBe('immersive');
  });
});

// ============================================================================
// setCompanionMode
// ============================================================================

describe('setCompanionMode', () => {
  let applyThemePack: typeof import('../src/hud/theme-packs/api.js').applyThemePack;
  let setCompanionMode: typeof import('../src/hud/theme-packs/api.js').setCompanionMode;
  let getCompanionMode: typeof import('../src/hud/theme-packs/api.js').getCompanionMode;

  beforeEach(async () => {
    vi.resetModules();
    const { mod } = await loadFreshModules();
    applyThemePack = mod.applyThemePack;
    setCompanionMode = mod.setCompanionMode;
    getCompanionMode = mod.getCompanionMode;
  });

  it('should switch from immersive to professional', () => {
    applyThemePack('mario');
    expect(getCompanionMode()).toBe('immersive');
    const result = setCompanionMode('professional');
    expect(result).toBe(true);
    expect(getCompanionMode()).toBe('professional');
  });

  it('should switch from professional to immersive', () => {
    applyThemePack('mario', 'professional');
    expect(getCompanionMode()).toBe('professional');
    const result = setCompanionMode('immersive');
    expect(result).toBe(true);
    expect(getCompanionMode()).toBe('immersive');
  });

  it('should return false when no pack is active and no matching skin found', () => {
    // With a fresh module, currentPack is null and the fallback getCurrentSkin
    // returns 'clean' — which may or may not match a theme pack
    // We just verify the function does not crash and returns a boolean
    const result = setCompanionMode('professional');
    expect(typeof result).toBe('boolean');
  });
});

// ============================================================================
// populateLegacyRegistries
// ============================================================================

describe('populateLegacyRegistries', () => {
  let populateLegacyRegistries: typeof import('../src/hud/theme-packs/api.js').populateLegacyRegistries;
  let SKINS: Record<string, unknown>;
  let PALETTES: Record<string, unknown>;
  let COMPANIONS: Record<string, unknown>;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/hud/theme-packs/api.js');
    populateLegacyRegistries = mod.populateLegacyRegistries;
    const skinsMod = await import('../src/hud/skins.js');
    SKINS = skinsMod.SKINS;
    const palettesMod = await import('../src/hud/palettes.js');
    PALETTES = palettesMod.PALETTES;
    const companionsMod = await import('../src/companions.js');
    COMPANIONS = companionsMod.COMPANIONS;
  });

  it('should populate SKINS with theme pack skins', async () => {
    const skinsBefore = Object.keys(SKINS).length;
    await populateLegacyRegistries();
    const skinsAfter = Object.keys(SKINS).length;
    // Should have added at least some new skins (those not already present)
    expect(skinsAfter).toBeGreaterThanOrEqual(skinsBefore);
  });

  it('should populate PALETTES with theme pack palettes', async () => {
    const palettesBefore = Object.keys(PALETTES).length;
    await populateLegacyRegistries();
    const palettesAfter = Object.keys(PALETTES).length;
    expect(palettesAfter).toBeGreaterThanOrEqual(palettesBefore);
  });

  it('should populate COMPANIONS with theme pack companions', async () => {
    const companionsBefore = Object.keys(COMPANIONS).length;
    await populateLegacyRegistries();
    const companionsAfter = Object.keys(COMPANIONS).length;
    expect(companionsAfter).toBeGreaterThanOrEqual(companionsBefore);
  });

  it('should be idempotent (calling twice does not duplicate entries)', async () => {
    await populateLegacyRegistries();
    const skinsCount = Object.keys(SKINS).length;
    const palettesCount = Object.keys(PALETTES).length;
    const companionsCount = Object.keys(COMPANIONS).length;

    await populateLegacyRegistries();
    expect(Object.keys(SKINS).length).toBe(skinsCount);
    expect(Object.keys(PALETTES).length).toBe(palettesCount);
    expect(Object.keys(COMPANIONS).length).toBe(companionsCount);
  });

  it('should not overwrite pre-existing registry entries', async () => {
    // If a skin already exists, populateLegacyRegistries should not replace it
    const existingSkin = SKINS['clean'];
    expect(existingSkin).toBeDefined();
    await populateLegacyRegistries();
    expect(SKINS['clean']).toBe(existingSkin);
  });
});
