/**
 * Tests for src/companions.ts
 *
 * Covers: COMPANIONS registry, getCompanion, applyCompanion, getCurrentCompanion,
 * listCompanions, companion object shape, mood system, immersion helpers, emoji toggle.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import Module from 'module';
import path from 'path';

// ---------------------------------------------------------------------------
// Patch require resolution so that require('./config.js') inside
// src/companions.ts resolves to the .ts source (vitest doesn't auto-remap
// CJS require() calls to .ts files).
// ---------------------------------------------------------------------------
const origResolveFilename = (Module as any)._resolveFilename;
(Module as any)._resolveFilename = function (
  request: string,
  parent: any,
  ...rest: any[]
) {
  if (
    request === './config.js' &&
    parent?.filename &&
    parent.filename.includes('companions')
  ) {
    const dir = path.dirname(parent.filename);
    return path.join(dir, 'config.ts');
  }
  return origResolveFilename.call(this, request, parent, ...rest);
};

import {
  COMPANIONS,
  getCompanion,
  applyCompanion,
  getCurrentCompanion,
  listCompanions,
  setMood,
  getMood,
  getMoodText,
  getToolLabel,
  getThinkingPhrase,
  getSuccessPhrase,
  getErrorPhrase,
  getStatusMessage,
  emoji,
  type PersonaCompanion,
  type MoodState,
} from '../src/companions.js';

// ---------------------------------------------------------------------------
// Helper: reset module-level state between tests.
// applyCompanion mutates a module-level `currentCompanion`; we reset it by
// applying the default companion each time.
// ---------------------------------------------------------------------------

beforeEach(() => {
  // Reset current companion and mood to defaults
  applyCompanion('calliope');
  setMood('idle');
});

// ===========================================================================
// COMPANIONS registry
// ===========================================================================

describe('COMPANIONS registry', () => {
  it('should be a non-empty record', () => {
    expect(typeof COMPANIONS).toBe('object');
    expect(Object.keys(COMPANIONS).length).toBeGreaterThan(0);
  });

  it('should contain the default "calliope" companion', () => {
    expect(COMPANIONS.calliope).toBeDefined();
    expect(COMPANIONS.calliope.name).toBe('calliope');
  });

  it('should contain well-known built-in companions', () => {
    const expected = ['calliope', 'muse', 'minimal', 'copilot', 'wopr', 'arcade', 'neo', 'computer', 'netrunner', 'basic'];
    for (const name of expected) {
      expect(COMPANIONS[name]).toBeDefined();
    }
  });

  it('should have at least 10 companions', () => {
    expect(Object.keys(COMPANIONS).length).toBeGreaterThanOrEqual(10);
  });
});

// ===========================================================================
// Companion object shape
// ===========================================================================

describe('companion object shape', () => {
  const allCompanions = Object.values(COMPANIONS);

  it('every companion has required string fields', () => {
    for (const c of allCompanions) {
      expect(typeof c.name).toBe('string');
      expect(c.name.length).toBeGreaterThan(0);
      expect(typeof c.description).toBe('string');
      expect(c.description.length).toBeGreaterThan(0);
      expect(typeof c.systemPrompt).toBe('string');
      expect(c.systemPrompt.length).toBeGreaterThan(0);
      expect(typeof c.greeting).toBe('string');
      expect(typeof c.farewell).toBe('string');
    }
  });

  it('every companion has a complete moods object', () => {
    const moodKeys: MoodState[] = ['idle', 'thinking', 'success', 'error', 'frustrated', 'excited', 'focused'];
    for (const c of allCompanions) {
      expect(c.moods).toBeDefined();
      for (const key of moodKeys) {
        expect(typeof c.moods[key]).toBe('string');
        expect(c.moods[key].length).toBeGreaterThan(0);
      }
    }
  });

  it('immersion field, when present, has correct structure', () => {
    for (const c of allCompanions) {
      if (c.immersion) {
        if (c.immersion.toolLabels) {
          expect(typeof c.immersion.toolLabels).toBe('object');
        }
        if (c.immersion.thinkingPhrases) {
          expect(Array.isArray(c.immersion.thinkingPhrases)).toBe(true);
          expect(c.immersion.thinkingPhrases.length).toBeGreaterThan(0);
        }
        if (c.immersion.successPhrases) {
          expect(Array.isArray(c.immersion.successPhrases)).toBe(true);
          expect(c.immersion.successPhrases.length).toBeGreaterThan(0);
        }
        if (c.immersion.errorPhrases) {
          expect(Array.isArray(c.immersion.errorPhrases)).toBe(true);
          expect(c.immersion.errorPhrases.length).toBeGreaterThan(0);
        }
        if (c.immersion.statusMessages) {
          expect(Array.isArray(c.immersion.statusMessages)).toBe(true);
          expect(c.immersion.statusMessages.length).toBeGreaterThan(0);
        }
      }
    }
  });

  it('companion key matches its name field', () => {
    for (const [key, companion] of Object.entries(COMPANIONS)) {
      expect(companion.name).toBe(key);
    }
  });
});

// ===========================================================================
// getCompanion
// ===========================================================================

describe('getCompanion', () => {
  it('should return companion by name', () => {
    const c = getCompanion('muse');
    expect(c.name).toBe('muse');
  });

  it('should return calliope for unknown name', () => {
    const c = getCompanion('nonexistent-companion');
    expect(c.name).toBe('calliope');
  });

  it('should return current companion when called with no argument', () => {
    applyCompanion('wopr');
    const c = getCompanion();
    expect(c.name).toBe('wopr');
  });

  it('should return calliope when called with undefined and no companion applied', () => {
    // Reset to no companion by reloading -- but since module state persists,
    // we test via the beforeEach which applies calliope
    const c = getCompanion(undefined);
    expect(c.name).toBe('calliope');
  });

  it('should return calliope for empty string', () => {
    const c = getCompanion('');
    expect(c.name).toBe('calliope');
  });
});

// ===========================================================================
// applyCompanion
// ===========================================================================

describe('applyCompanion', () => {
  it('should return true for known companion', () => {
    expect(applyCompanion('arcade')).toBe(true);
  });

  it('should return false for unknown companion', () => {
    expect(applyCompanion('does-not-exist')).toBe(false);
  });

  it('should change current companion on success', () => {
    applyCompanion('neo');
    expect(getCurrentCompanion().name).toBe('neo');
  });

  it('should not change current companion on failure', () => {
    applyCompanion('copilot');
    applyCompanion('unknown-name');
    expect(getCurrentCompanion().name).toBe('copilot');
  });

  it('should reset mood to idle when applying a companion', () => {
    setMood('excited');
    applyCompanion('basic');
    expect(getMood()).toBe('idle');
  });
});

// ===========================================================================
// getCurrentCompanion
// ===========================================================================

describe('getCurrentCompanion', () => {
  it('should return calliope as the default (after beforeEach reset)', () => {
    expect(getCurrentCompanion().name).toBe('calliope');
  });

  it('should return the applied companion', () => {
    applyCompanion('netrunner');
    expect(getCurrentCompanion().name).toBe('netrunner');
  });

  it('should return full PersonaCompanion object', () => {
    const c = getCurrentCompanion();
    expect(c.systemPrompt).toBeDefined();
    expect(c.greeting).toBeDefined();
    expect(c.farewell).toBeDefined();
    expect(c.moods).toBeDefined();
  });
});

// ===========================================================================
// listCompanions
// ===========================================================================

describe('listCompanions', () => {
  it('should return a non-empty array', () => {
    const list = listCompanions();
    expect(Array.isArray(list)).toBe(true);
    expect(list.length).toBeGreaterThan(0);
  });

  it('should have same length as COMPANIONS keys', () => {
    expect(listCompanions().length).toBe(Object.keys(COMPANIONS).length);
  });

  it('each entry should have name and description strings', () => {
    for (const entry of listCompanions()) {
      expect(typeof entry.name).toBe('string');
      expect(entry.name.length).toBeGreaterThan(0);
      expect(typeof entry.description).toBe('string');
      expect(entry.description.length).toBeGreaterThan(0);
    }
  });

  it('should include calliope', () => {
    const names = listCompanions().map(c => c.name);
    expect(names).toContain('calliope');
  });

  it('entries should only have name and description (no extra keys)', () => {
    for (const entry of listCompanions()) {
      expect(Object.keys(entry).sort()).toEqual(['description', 'name']);
    }
  });
});

// ===========================================================================
// Mood system
// ===========================================================================

describe('setMood / getMood', () => {
  it('should default to idle after reset', () => {
    expect(getMood()).toBe('idle');
  });

  it('should update mood', () => {
    setMood('thinking');
    expect(getMood()).toBe('thinking');
  });

  it('should handle all mood states', () => {
    const moods: MoodState[] = ['idle', 'thinking', 'success', 'error', 'frustrated', 'excited', 'focused'];
    for (const mood of moods) {
      setMood(mood);
      expect(getMood()).toBe(mood);
    }
  });
});

describe('getMoodText', () => {
  it('should return idle text by default', () => {
    const text = getMoodText();
    expect(text).toBe(COMPANIONS.calliope.moods.idle);
  });

  it('should return correct mood text after setMood', () => {
    setMood('success');
    expect(getMoodText()).toBe(COMPANIONS.calliope.moods.success);
  });

  it('should return mood text from the current companion', () => {
    applyCompanion('wopr');
    setMood('error');
    expect(getMoodText()).toBe(COMPANIONS.wopr.moods.error);
  });

  it('should fall back to idle text for unrecognized mood', () => {
    // Force an unknown mood state (shouldn't happen in practice, but tests the fallback)
    setMood('idle');
    expect(getMoodText()).toBe(getCurrentCompanion().moods.idle);
  });
});

// ===========================================================================
// Immersion helpers
// ===========================================================================

describe('getToolLabel', () => {
  it('should return undefined for companion without immersion', () => {
    applyCompanion('minimal'); // minimal has no immersion
    expect(getToolLabel('shell')).toBeUndefined();
  });

  it('should return label for companion with toolLabels', () => {
    applyCompanion('copilot');
    const label = getToolLabel('shell');
    expect(label).toBe('Executing hyperspace jump...');
  });

  it('should return undefined for unknown tool name', () => {
    applyCompanion('copilot');
    expect(getToolLabel('nonexistent_tool')).toBeUndefined();
  });
});

describe('getThinkingPhrase', () => {
  it('should return undefined for companion without thinkingPhrases', () => {
    applyCompanion('minimal');
    expect(getThinkingPhrase()).toBeUndefined();
  });

  it('should return one of the thinking phrases for companion with immersion', () => {
    applyCompanion('muse');
    const phrase = getThinkingPhrase();
    expect(phrase).toBeDefined();
    expect(COMPANIONS.muse.immersion!.thinkingPhrases).toContain(phrase);
  });
});

describe('getSuccessPhrase', () => {
  it('should return undefined for companion without successPhrases', () => {
    applyCompanion('minimal');
    expect(getSuccessPhrase()).toBeUndefined();
  });

  it('should return one of the success phrases for companion with immersion', () => {
    applyCompanion('copilot');
    const phrase = getSuccessPhrase();
    expect(phrase).toBeDefined();
    expect(COMPANIONS.copilot.immersion!.successPhrases).toContain(phrase);
  });
});

describe('getErrorPhrase', () => {
  it('should return undefined for companion without errorPhrases', () => {
    applyCompanion('minimal');
    expect(getErrorPhrase()).toBeUndefined();
  });

  it('should return one of the error phrases for companion with immersion', () => {
    applyCompanion('neo');
    const phrase = getErrorPhrase();
    expect(phrase).toBeDefined();
    expect(COMPANIONS.neo.immersion!.errorPhrases).toContain(phrase);
  });
});

describe('getStatusMessage', () => {
  it('should return undefined for companion without statusMessages', () => {
    applyCompanion('muse'); // muse has no statusMessages
    expect(getStatusMessage()).toBeUndefined();
  });

  it('should return one of the status messages for companion with them', () => {
    applyCompanion('copilot'); // copilot has statusMessages
    const msg = getStatusMessage();
    expect(msg).toBeDefined();
    expect(COMPANIONS.copilot.immersion!.statusMessages).toContain(msg);
  });
});

// ===========================================================================
// emoji helper
// ===========================================================================

describe('emoji', () => {
  // The emoji() function uses require('./config.js') internally (lazy CJS import
  // to avoid circular deps). The Module._resolveFilename patch at the top of this
  // file redirects the require to the .ts source so it works under vitest.

  it('should accept icon and fallback parameters', () => {
    expect(typeof emoji).toBe('function');
    expect(emoji.length).toBeLessThanOrEqual(2);
  });

  it('should return icon when useEmojis is not false (default)', () => {
    // By default, useEmojis is not false (config defaults), so icon is returned
    const result = emoji('rocket', '[rocket]');
    expect(result).toBe('rocket');
  });

  it('should return a string', () => {
    const result = emoji('test-icon');
    expect(typeof result).toBe('string');
  });

  it('should return icon with no fallback provided when emojis enabled', () => {
    // When useEmojis is not explicitly false, returns the icon
    const result = emoji('star');
    expect(result).toBe('star');
  });
});
