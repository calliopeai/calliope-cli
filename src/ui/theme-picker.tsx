/**
 * UI Module - Theme Picker (Wizard Style)
 *
 * Step-through picker: Layout → Skin → Palette → Companion → Apply.
 * Each step shows a scrollable list. Enter locks in the choice and advances.
 * On the final step, Enter applies all changes at once.
 * Escape cancels at any point. Backspace goes back a step.
 */

import React, { useState, useMemo } from 'react';
import { Box, Text, useInput } from 'ink';
import { listSkins, listPalettes, getSkin, getPalette } from '../hud/api.js';
import { listCompanions, getCompanion } from '../companions.js';

// ============================================================================
// Types
// ============================================================================

export interface ThemeSelection {
  layout: string;
  skin: string;
  palette: string;
  companion: string;
}

export interface ThemePickerProps {
  onApply: (selection: ThemeSelection) => void;
  onCancel: () => void;
  currentLayout: string;
  currentSkin: string;
  currentPalette: string;
  currentCompanion: string;
}

// ============================================================================
// Constants
// ============================================================================

const LAYOUTS = [
  { name: 'classic', description: 'Everything in chronological order' },
  { name: 'response-top', description: 'Response pinned at top, tools below' },
  { name: 'response-bottom', description: 'Tools scroll up, response at bottom' },
  { name: 'split', description: 'Side-by-side: tools left, response right' },
  { name: 'zen', description: 'Response only, tools hidden — distraction-free' },
  { name: 'focus', description: 'Latest response pinned top, compact tool log' },
  { name: 'dashboard', description: 'Three-panel: stats, response, tools' },
  { name: 'minimal', description: 'No decorations, raw text output' },
];

const STEPS = ['Layout', 'Skin', 'Palette', 'Companion', 'Confirm'] as const;
type Step = 0 | 1 | 2 | 3 | 4;

const PAGE_SIZE = 12;

// ============================================================================
// ThemePicker Component
// ============================================================================

export function ThemePicker({
  onApply,
  onCancel,
  currentLayout,
  currentSkin,
  currentPalette,
  currentCompanion,
}: ThemePickerProps) {
  const [step, setStep] = useState<Step>(0);

  // Locked-in selections (set when user presses Enter on each step)
  const [lockedLayout, setLockedLayout] = useState<string | null>(null);
  const [lockedSkin, setLockedSkin] = useState<string | null>(null);
  const [lockedPalette, setLockedPalette] = useState<string | null>(null);
  const [lockedCompanion, setLockedCompanion] = useState<string | null>(null);

  // Cursor positions per step
  const skins = useMemo(() => listSkins(), []);
  const palettes = useMemo(() => listPalettes(), []);
  const companions = useMemo(() => listCompanions(), []);

  const [layoutIdx, setLayoutIdx] = useState(() =>
    Math.max(0, LAYOUTS.findIndex(l => l.name === currentLayout))
  );
  const [skinIdx, setSkinIdx] = useState(() =>
    Math.max(0, skins.findIndex(s => s.name === currentSkin))
  );
  const [paletteIdx, setPaletteIdx] = useState(() =>
    Math.max(0, palettes.findIndex(p => p.name === currentPalette))
  );
  const [companionIdx, setCompanionIdx] = useState(() =>
    Math.max(0, companions.findIndex(c => c.name === currentCompanion))
  );

  // Get items and index for current step (sorted alphabetically)
  const sortByName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
  const stepItems: Array<{ name: string; description: string }>[] = [
    [...LAYOUTS].sort(sortByName),
    skins.map(s => ({ name: s.name, description: s.description })).sort(sortByName),
    palettes.map(p => ({ name: p.name, description: p.description })).sort(sortByName),
    companions.map(c => ({ name: c.name, description: c.description })).sort(sortByName),
  ];

  const stepIndices = [layoutIdx, skinIdx, paletteIdx, companionIdx];
  const stepSetters = [setLayoutIdx, setSkinIdx, setPaletteIdx, setCompanionIdx];
  const stepCurrents = [currentLayout, currentSkin, currentPalette, currentCompanion];

  // Resolve final selections for preview/confirm
  const finalLayout = lockedLayout ?? LAYOUTS[layoutIdx]?.name ?? 'classic';
  const finalSkin = lockedSkin ?? skins[skinIdx]?.name ?? 'clean';
  const finalPalette = lockedPalette ?? palettes[paletteIdx]?.name ?? 'default';
  const finalCompanion = lockedCompanion ?? companions[companionIdx]?.name ?? 'calliope';

  // Preview objects
  const previewSkin = useMemo(() => getSkin(step === 1 ? (skins[skinIdx]?.name ?? 'clean') : finalSkin), [step, skinIdx, finalSkin]);
  const previewPalette = useMemo(() => getPalette(step === 2 ? (palettes[paletteIdx]?.name ?? 'default') : finalPalette), [step, paletteIdx, finalPalette]);
  const previewCompanion = useMemo(() => getCompanion(step === 3 ? (companions[companionIdx]?.name ?? 'calliope') : finalCompanion), [step, companionIdx, finalCompanion]);

  useInput((_input, key) => {
    if (key.escape) {
      onCancel();
      return;
    }

    // Backspace / delete = go back a step
    if (key.backspace || key.delete) {
      if (step > 0) {
        const prev = (step - 1) as Step;
        // Unlock the previous step's choice
        if (prev === 0) setLockedLayout(null);
        if (prev === 1) setLockedSkin(null);
        if (prev === 2) setLockedPalette(null);
        if (prev === 3) setLockedCompanion(null);
        setStep(prev);
      }
      return;
    }

    if (step === 4) {
      // Confirm step
      if (key.return) {
        onApply({
          layout: finalLayout,
          skin: finalSkin,
          palette: finalPalette,
          companion: finalCompanion,
        });
      }
      return;
    }

    // Navigate list
    if (key.upArrow) {
      const items = stepItems[step];
      const idx = stepIndices[step];
      stepSetters[step](idx > 0 ? idx - 1 : items.length - 1);
      return;
    }
    if (key.downArrow) {
      const items = stepItems[step];
      const idx = stepIndices[step];
      stepSetters[step](idx < items.length - 1 ? idx + 1 : 0);
      return;
    }

    // Enter = lock in selection, advance to next step
    if (key.return) {
      const items = stepItems[step];
      const selected = items[stepIndices[step]]?.name;
      if (step === 0) setLockedLayout(selected);
      if (step === 1) setLockedSkin(selected);
      if (step === 2) setLockedPalette(selected);
      if (step === 3) setLockedCompanion(selected);
      setStep((step + 1) as Step);
      return;
    }
  });

  // Paginate visible items
  const paginate = (items: Array<{ name: string; description: string }>, selectedIdx: number) => {
    if (items.length <= PAGE_SIZE) return { visible: items, startIdx: 0 };
    const half = Math.floor(PAGE_SIZE / 2);
    let start = Math.max(0, selectedIdx - half);
    if (start + PAGE_SIZE > items.length) start = items.length - PAGE_SIZE;
    return { visible: items.slice(start, start + PAGE_SIZE), startIdx: start };
  };

  // Step progress bar
  const renderProgress = () => (
    <Box marginBottom={1} gap={1}>
      {STEPS.map((label, i) => {
        const isActive = i === step;
        const isDone = i < step;
        const lockedValues = [lockedLayout, lockedSkin, lockedPalette, lockedCompanion];
        const lockedVal = i < 4 ? lockedValues[i] : null;

        return (
          <Box key={label}>
            <Text
              color={isActive ? 'cyan' : isDone ? 'green' : 'gray'}
              bold={isActive}
            >
              {isDone ? '✓' : isActive ? '●' : '○'} {label}
              {isDone && lockedVal ? `: ${lockedVal}` : ''}
            </Text>
            {i < STEPS.length - 1 && <Text dimColor> → </Text>}
          </Box>
        );
      })}
    </Box>
  );

  // Render the list for the current step
  const renderList = () => {
    if (step === 4) return null;
    const items = stepItems[step];
    const idx = stepIndices[step];
    const currentVal = stepCurrents[step];
    const { visible, startIdx } = paginate(items, idx);
    const hasAbove = startIdx > 0;
    const hasBelow = startIdx + PAGE_SIZE < items.length;

    return (
      <Box flexDirection="column">
        <Text bold color="cyan">
          Select {STEPS[step]}:
        </Text>
        <Box height={1} />
        {hasAbove && <Text dimColor>  ↑ more</Text>}
        {visible.map((item, i) => {
          const globalIdx = startIdx + i;
          const isSelected = globalIdx === idx;
          const isCurrent = item.name === currentVal;

          return (
            <Box key={item.name}>
              <Text
                color={isSelected ? 'cyan' : undefined}
                bold={isSelected}
              >
                {isSelected ? ' ❯ ' : '   '}
                {item.name}
                {isCurrent ? ' (current)' : ''}
              </Text>
              {isSelected && (
                <Text dimColor> — {item.description}</Text>
              )}
            </Box>
          );
        })}
        {hasBelow && <Text dimColor>  ↓ more</Text>}
        {items.length > PAGE_SIZE && (
          <Text dimColor>  {idx + 1}/{items.length}</Text>
        )}
      </Box>
    );
  };

  // Render preview panel (shows what's been selected so far + current hover)
  const renderPreview = () => {
    const skinName = step === 1 ? (skins[skinIdx]?.name ?? 'clean') : finalSkin;
    const paletteName = step === 2 ? (palettes[paletteIdx]?.name ?? 'default') : finalPalette;
    const companionName = step === 3 ? (companions[companionIdx]?.name ?? 'calliope') : finalCompanion;
    const layoutName = step === 0 ? (LAYOUTS[layoutIdx]?.name ?? 'classic') : finalLayout;

    return (
      <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1} marginTop={1}>
        <Text bold dimColor>Preview</Text>
        <Box gap={2}>
          <Box flexDirection="column" width="50%">
            <Text>
              <Text color="yellow">Layout: </Text>
              <Text bold>{layoutName}</Text>
              <Text dimColor> — {LAYOUTS.find(l => l.name === layoutName)?.description ?? ''}</Text>
            </Text>
            <Text>
              <Text color="yellow">Skin: </Text>
              <Text bold>{previewSkin.name}</Text>
              <Text dimColor> — {previewSkin.description}</Text>
            </Text>
            <Text>
              <Text color="yellow">Prompt: </Text>
              <Text>{previewSkin.decorations.promptPrefix}</Text>
              <Text dimColor>your message here</Text>
            </Text>
          </Box>
          <Box flexDirection="column" width="50%">
            <Text>
              <Text color="yellow">Palette: </Text>
              <Text bold>{previewPalette.name}</Text>
              <Text dimColor> — {previewPalette.description}</Text>
            </Text>
            <Text>
              <Text color="yellow">Companion: </Text>
              <Text bold>{previewCompanion.name}</Text>
              <Text dimColor> — {previewCompanion.description}</Text>
            </Text>
            <Text>
              <Text color="yellow">Greeting: </Text>
              <Text italic>{previewCompanion.greeting}</Text>
            </Text>
          </Box>
        </Box>
      </Box>
    );
  };

  // Confirm screen
  const renderConfirm = () => {
    const changes: string[] = [];
    if (finalLayout !== currentLayout) changes.push(`Layout: ${currentLayout} → ${finalLayout}`);
    if (finalSkin !== currentSkin) changes.push(`Skin: ${currentSkin} → ${finalSkin}`);
    if (finalPalette !== currentPalette) changes.push(`Palette: ${currentPalette} → ${finalPalette}`);
    if (finalCompanion !== currentCompanion) changes.push(`Companion: ${currentCompanion} → ${finalCompanion}`);

    return (
      <Box flexDirection="column">
        <Text bold color="cyan">Apply these changes?</Text>
        <Box height={1} />
        {changes.length === 0 ? (
          <Text dimColor>No changes selected.</Text>
        ) : (
          changes.map((c, i) => (
            <Text key={i}>  <Text color="green">✓</Text> {c}</Text>
          ))
        )}
        <Box height={1} />
        <Text dimColor>
          {changes.length > 0
            ? 'Press Enter to apply, Backspace to go back, Escape to cancel.'
            : 'Press Backspace to go back, or Escape to cancel.'}
        </Text>
      </Box>
    );
  };

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
        <Text bold color="cyan">Theme Picker</Text>
        <Text dimColor>  (↑↓ navigate  Enter: select  Backspace: back  Esc: cancel)</Text>
      </Box>

      {/* Progress bar */}
      {renderProgress()}

      {/* Current step content */}
      {step < 4 ? renderList() : renderConfirm()}

      {/* Live preview */}
      {renderPreview()}
    </Box>
  );
}
