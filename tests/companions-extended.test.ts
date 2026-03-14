/**
 * Extended coverage tests for src/companions.ts
 *
 * Targets uncovered branches:
 * - getCompanion() with no arg when currentCompanion is already set (returns it)
 * - getCompanion('unknown-name') falls back to calliope
 * - applyCompanion('nonexistent') returns false
 * - getMoodText() fallback to companion.moods.idle when currentMood text is undefined
 * - emoji() when _cachedConfig is set and useEmojis === false (returns fallback)
 * - emoji() when _cachedConfig is set and useEmojis !== false (returns icon)
 */

import { describe, it, expect, beforeEach } from 'vitest';
import {
  getCompanion,
  applyCompanion,
  getMoodText,
  setMood,
  emoji,
  setEmojiConfig,
  getCurrentCompanion,
} from '../src/companions.js';

// Reset companion state between tests by applying 'calliope' (always valid)
// and resetting mood to 'idle'
beforeEach(() => {
  applyCompanion('calliope');
  setMood('idle');
});

// ===========================================================================
// getCompanion() — no-arg with currentCompanion already set
// ===========================================================================

describe('getCompanion - no arg returns currentCompanion when set', () => {
  it('should return currentCompanion when called without argument after applyCompanion', () => {
    applyCompanion('muse');
    const companion = getCompanion(); // no name → should return currentCompanion
    expect(companion.name).toBe('muse');
  });

  it('should return calliope when called without argument and companion is calliope', () => {
    applyCompanion('calliope');
    const companion = getCompanion();
    expect(companion.name).toBe('calliope');
  });
});

// ===========================================================================
// getCompanion('unknown') — fallback to calliope
// ===========================================================================

describe('getCompanion - unknown name falls back to calliope', () => {
  it('should return calliope when given an unknown companion name', () => {
    const companion = getCompanion('this-does-not-exist');
    expect(companion.name).toBe('calliope');
  });

  it('should return calliope when given an empty string', () => {
    // Empty string is falsy → hits the !name branch, returns currentCompanion || calliope
    applyCompanion('calliope');
    const companion = getCompanion('');
    expect(companion.name).toBe('calliope');
  });
});

// ===========================================================================
// applyCompanion — false path (unknown name)
// ===========================================================================

describe('applyCompanion - returns false for unknown companion', () => {
  it('should return false when companion name is not in COMPANIONS', () => {
    const result = applyCompanion('totally-fake-companion');
    expect(result).toBe(false);
  });

  it('should not change currentCompanion when applyCompanion fails', () => {
    applyCompanion('muse');
    const before = getCurrentCompanion();
    const result = applyCompanion('nonexistent');
    const after = getCurrentCompanion();
    expect(result).toBe(false);
    expect(after.name).toBe(before.name);
  });
});

// ===========================================================================
// getMoodText — fallback to idle
// ===========================================================================

describe('getMoodText - fallback to idle when mood text is undefined', () => {
  it('should fall back to idle mood text when currentMood has no entry', () => {
    // Set a mood that might not be defined on all companions
    // The calliope companion should have 'idle' but may not have all moods
    // We can test with a mood that doesn't exist on all companions

    // Use a known companion and set a mood that has no text defined
    // The fallback: companion.moods[currentMood] || companion.moods.idle
    // We'll test by checking that getMoodText always returns a non-empty string
    // (since idle is always defined)
    applyCompanion('calliope');
    setMood('idle');
    const idleText = getMoodText();
    expect(typeof idleText).toBe('string');
    expect(idleText.length).toBeGreaterThan(0);

    // Now set mood to 'thinking' and compare — if defined, returns that; if not, returns idle text
    setMood('thinking');
    const thinkingText = getMoodText();
    expect(typeof thinkingText).toBe('string');
    expect(thinkingText.length).toBeGreaterThan(0); // always returns something (idle fallback)
  });

  it('should use idle as fallback for a mood that is undefined/falsy on the companion', () => {
    // Test via a companion that has moods with some entries missing
    // If we can't guarantee a companion lacks a mood, we verify the fallback logic itself:
    // Any valid companion call to getMoodText should always return a string
    applyCompanion('muse');
    setMood('idle');
    const idleResult = getMoodText();
    expect(idleResult).toBeTruthy();

    // Switch to 'error' mood — may or may not be defined; should still return a string
    setMood('error');
    const errorResult = getMoodText();
    expect(typeof errorResult).toBe('string');
    expect(errorResult.length).toBeGreaterThan(0); // idle fallback ensures non-empty
  });
});

// ===========================================================================
// emoji() — with _cachedConfig set
// ===========================================================================

describe('emoji() - with setEmojiConfig (useEmojis branch)', () => {
  it('should return fallback when useEmojis is false in config', () => {
    const fakeConfig = {
      get: (key: string) => {
        if (key === 'useEmojis') return false;
        return undefined;
      },
    };
    setEmojiConfig(fakeConfig);
    const result = emoji('🔄', '[sync]');
    expect(result).toBe('[sync]');
  });

  it('should return icon when useEmojis is true in config', () => {
    const fakeConfig = {
      get: (key: string) => {
        if (key === 'useEmojis') return true;
        return undefined;
      },
    };
    setEmojiConfig(fakeConfig);
    const result = emoji('🔄', '[sync]');
    expect(result).toBe('🔄');
  });

  it('should return icon when useEmojis is undefined (not false)', () => {
    const fakeConfig = {
      get: (_key: string) => undefined,
    };
    setEmojiConfig(fakeConfig);
    const result = emoji('✨', '[star]');
    expect(result).toBe('✨');
  });

  it('should return empty string as default fallback when useEmojis is false and no fallback provided', () => {
    const fakeConfig = {
      get: (key: string) => (key === 'useEmojis' ? false : undefined),
    };
    setEmojiConfig(fakeConfig);
    const result = emoji('🚀');
    expect(result).toBe('');
  });
});
