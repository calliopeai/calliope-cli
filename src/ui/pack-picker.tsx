/**
 * UI Module - Pack Picker
 *
 * Interactive theme pack browser. Select a pack and apply it in one step.
 * ←/→ switch categories, ↑/↓ navigate packs, Enter applies, Esc cancels.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { listThemePacks, getThemePack, getCurrentPack } from '../hud/theme-packs/api.js';
import type { ThemeCategory } from '../hud/theme-packs/types.js';

// ============================================================================
// Types
// ============================================================================

export interface PackPickerProps {
  onApply: (packName: string) => void;
  onCancel: () => void;
}

// ============================================================================
// Constants
// ============================================================================

const CATEGORIES: Array<{ key: ThemeCategory | 'all'; label: string }> = [
  { key: 'gaming', label: 'Gaming' },
  { key: 'trek', label: 'Trek' },
  { key: 'scifi', label: 'Sci-Fi' },
  { key: 'retro', label: 'Retro' },
  { key: 'cultural', label: 'Cultural' },
  { key: 'seasonal', label: 'Seasonal' },
  { key: 'minimal', label: 'Minimal' },
  { key: 'all', label: 'All' },
];

const PAGE_SIZE = 12;

// ============================================================================
// PackPicker Component
// ============================================================================

export function PackPicker({ onApply, onCancel }: PackPickerProps) {
  const [categoryIdx, setCategoryIdx] = useState(0);
  const [packIdx, setPackIdx] = useState(0);

  const currentPack = getCurrentPack();

  // Get packs for current category ('all' = no filter)
  const categoryKey = CATEGORIES[categoryIdx].key;
  const category = categoryKey === 'all' ? undefined : categoryKey;
  const packs = useMemo(
    () => listThemePacks(category).sort((a, b) => a.name.localeCompare(b.name)),
    [category],
  );

  // Reset pack index when category changes
  const [prevCategory, setPrevCategory] = useState(categoryKey);
  if (categoryKey !== prevCategory) {
    setPrevCategory(categoryKey);
    setPackIdx(0);
  }

  // Get preview data for highlighted pack
  const highlightedPack = useMemo(() => {
    const p = packs[packIdx];
    return p ? getThemePack(p.name) : undefined;
  }, [packs, packIdx]);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    // Left/Right = switch category
    if (key.leftArrow) {
      setCategoryIdx(i => i > 0 ? i - 1 : CATEGORIES.length - 1);
      return;
    }
    if (key.rightArrow) {
      setCategoryIdx(i => i < CATEGORIES.length - 1 ? i + 1 : 0);
      return;
    }

    // Up/Down = navigate packs
    if (key.upArrow) {
      setPackIdx(i => i > 0 ? i - 1 : packs.length - 1);
      return;
    }
    if (key.downArrow) {
      setPackIdx(i => i < packs.length - 1 ? i + 1 : 0);
      return;
    }

    // Enter = apply
    if (key.return) {
      const selected = packs[packIdx];
      if (selected) onApply(selected.name);
      return;
    }
  });

  // Paginate visible packs
  const paginate = () => {
    if (packs.length <= PAGE_SIZE) return { visible: packs, startIdx: 0 };
    const half = Math.floor(PAGE_SIZE / 2);
    let start = Math.max(0, packIdx - half);
    if (start + PAGE_SIZE > packs.length) start = packs.length - PAGE_SIZE;
    return { visible: packs.slice(start, start + PAGE_SIZE), startIdx: start };
  };

  const { visible, startIdx } = paginate();
  const hasAbove = startIdx > 0;
  const hasBelow = startIdx + PAGE_SIZE < packs.length;

  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor="cyan"
      paddingX={2}
      paddingY={1}
      marginY={1}
    >
      {/* Title */}
      <Box justifyContent="center" marginBottom={1}>
        <Text bold color="cyan">Pack Picker</Text>
        <Text dimColor>  ({'<'}{'>'} category  {'\u2191\u2193'} navigate  Enter: apply  Esc: cancel)</Text>
      </Box>

      {/* Category tabs */}
      <Box gap={1} marginBottom={1} flexWrap="wrap">
        {CATEGORIES.map((cat, i) => {
          const count = listThemePacks(cat.key === 'all' ? undefined : cat.key).length;
          return (
            <Text
              key={cat.key}
              color={i === categoryIdx ? 'cyan' : undefined}
              bold={i === categoryIdx}
              dimColor={i !== categoryIdx}
            >
              {i === categoryIdx ? `[${cat.label} (${count})]` : `${cat.label} (${count})`}
            </Text>
          );
        })}
      </Box>

      {/* Pack list */}
      <Box flexDirection="column">
        {hasAbove && <Text dimColor>  {'\u2191'} more</Text>}
        {visible.map((pack, i) => {
          const globalIdx = startIdx + i;
          const isSelected = globalIdx === packIdx;
          const isCurrent = currentPack?.name === pack.name;

          return (
            <Box key={pack.name}>
              <Text
                color={isSelected ? 'cyan' : undefined}
                bold={isSelected}
              >
                {isSelected ? ' \u276F ' : '   '}
                {pack.name}
                {isCurrent ? ' (current)' : ''}
              </Text>
              {isSelected && (
                <Text dimColor>{' \u2014 '}{pack.description}</Text>
              )}
            </Box>
          );
        })}
        {hasBelow && <Text dimColor>  {'\u2193'} more</Text>}
        {packs.length > PAGE_SIZE && (
          <Text dimColor>  {packIdx + 1}/{packs.length}</Text>
        )}
      </Box>

      {/* Preview panel */}
      {highlightedPack && (
        <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
          <Text bold dimColor>Preview</Text>
          <Text>
            <Text color="yellow">Skin: </Text>
            <Text bold>{highlightedPack.skin.name}</Text>
            <Text dimColor> {'\u2014'} {highlightedPack.skin.description}</Text>
          </Text>
          <Text>
            <Text color="yellow">Palette: </Text>
            <Text bold>{highlightedPack.palette.name}</Text>
            <Text dimColor> {'\u2014'} {highlightedPack.palette.description}</Text>
          </Text>
          <Text>
            <Text color="yellow">Companion: </Text>
            <Text bold>{highlightedPack.companions.immersive.name}</Text>
            <Text dimColor> {'\u2014'} {highlightedPack.companions.immersive.description}</Text>
          </Text>
          <Text>
            <Text color="yellow">Greeting: </Text>
            <Text italic>{highlightedPack.companions.immersive.greeting}</Text>
          </Text>
          {highlightedPack.companions.additional && highlightedPack.companions.additional.length > 0 && (
            <Text>
              <Text color="yellow">Also: </Text>
              <Text dimColor>{highlightedPack.companions.additional.map(c => c.name).join(', ')}</Text>
            </Text>
          )}
        </Box>
      )}
    </Box>
  );
}
