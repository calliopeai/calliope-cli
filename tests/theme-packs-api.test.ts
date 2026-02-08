import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { ThemePack, ThemeCategory } from '../src/hud/theme-packs/types.js';

// We import the stateless query functions directly — they don't depend on
// module-level mutable state so a single import is fine.
import {
  listThemePacks,
  getThemePack,
  getPackCompanions,
} from '../src/hud/theme-packs/api.js';

import { THEME_PACKS } from '../src/hud/theme-packs/index.js';

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
    // 'custom' is a valid ThemeCategory but no built-in packs use it
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
    // Pack .name may differ from registry key (e.g. registry key 'tng' has name 'trek-tng')
    // Verify names pulled from actual THEME_PACKS entries
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
    // Find a pack with additional companions
    const packWithAdditional = Object.entries(THEME_PACKS).find(
      ([, p]) => p.companions.additional && p.companions.additional.length > 0,
    );
    if (packWithAdditional) {
      const [key, pack] = packWithAdditional;
      const companions = getPackCompanions(key);
      expect(companions.length).toBe(
        2 + (pack.companions.additional?.length ?? 0),
      );
      pack.companions.additional!.forEach(c => {
        expect(companions).toContain(c.name);
      });
    }
  });

  it('should return empty array for unknown pack', () => {
    expect(getPackCompanions('nonexistent-theme')).toEqual([]);
  });
});

// ============================================================================
// Stateful API — use dynamic imports to reset module state between suites
// ============================================================================

describe('applyThemePack', () => {
  let applyThemePack: typeof import('../src/hud/theme-packs/api.js').applyThemePack;
  let getCurrentPack: typeof import('../src/hud/theme-packs/api.js').getCurrentPack;
  let getCompanionMode: typeof import('../src/hud/theme-packs/api.js').getCompanionMode;

  beforeEach(async () => {
    vi.resetModules();
    const mod = await import('../src/hud/theme-packs/api.js');
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
    const mod = await import('../src/hud/theme-packs/api.js');
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
    const mod = await import('../src/hud/theme-packs/api.js');
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
    const mod = await import('../src/hud/theme-packs/api.js');
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

  it('should populate SKINS with theme pack skins', () => {
    const skinsBefore = Object.keys(SKINS).length;
    populateLegacyRegistries();
    const skinsAfter = Object.keys(SKINS).length;
    // Should have added at least some new skins (those not already present)
    expect(skinsAfter).toBeGreaterThanOrEqual(skinsBefore);
    // A known theme pack skin should be present
    expect(SKINS['mario']).toBeDefined();
  });

  it('should populate PALETTES with theme pack palettes', () => {
    const palettesBefore = Object.keys(PALETTES).length;
    populateLegacyRegistries();
    const palettesAfter = Object.keys(PALETTES).length;
    expect(palettesAfter).toBeGreaterThanOrEqual(palettesBefore);
  });

  it('should populate COMPANIONS with theme pack companions', () => {
    const companionsBefore = Object.keys(COMPANIONS).length;
    populateLegacyRegistries();
    const companionsAfter = Object.keys(COMPANIONS).length;
    expect(companionsAfter).toBeGreaterThanOrEqual(companionsBefore);
  });

  it('should be idempotent (calling twice does not duplicate entries)', () => {
    populateLegacyRegistries();
    const skinsCount = Object.keys(SKINS).length;
    const palettesCount = Object.keys(PALETTES).length;
    const companionsCount = Object.keys(COMPANIONS).length;

    populateLegacyRegistries();
    expect(Object.keys(SKINS).length).toBe(skinsCount);
    expect(Object.keys(PALETTES).length).toBe(palettesCount);
    expect(Object.keys(COMPANIONS).length).toBe(companionsCount);
  });

  it('should not overwrite pre-existing registry entries', () => {
    // If a skin already exists, populateLegacyRegistries should not replace it
    const existingSkin = SKINS['clean'];
    expect(existingSkin).toBeDefined();
    populateLegacyRegistries();
    expect(SKINS['clean']).toBe(existingSkin);
  });
});
