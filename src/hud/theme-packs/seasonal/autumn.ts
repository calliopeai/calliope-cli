/**
 * Autumn Theme Pack
 *
 * Fall harvest — warm tones, falling leaves, cozy atmosphere.
 * Companions: Harvest (immersive), Autumn-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const AUTUMN_PACK: ThemePack = {
  name: 'autumn',
  description: 'Fall harvest — warm tones, falling leaves, cozy atmosphere',
  category: 'seasonal',
  tags: ['fall', 'harvest', 'leaves', 'cozy'],
  relatedPacks: ['spring', 'summer', 'winter'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'autumn',
    description: 'Fall harvest — warm tones, falling leaves, cozy atmosphere',
    banner: {
      art: [
        ' \u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E',
        ' \u2502  \u2767 \u2766 \u2767  CALLIOPE  \u2767 \u2766 \u2767       \u2502',
        ' \u2502       Autumn Terminal              \u2502',
        ' \u2502  \u2500\u2500\u2500 Harvest Season \u2500\u2500\u2500            \u2502',
        ' \u2502  \u2766 \u2767 \u2766 \u2767 \u2766 \u2767 \u2766 \u2767 \u2766 \u2767 \u2766 \u2767 \u2766  \u2502',
        ' \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F',
      ],
      tagline: 'The leaves are turning...',
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '\uD83C\uDF42 ',
      assistantPrefix: '\uD83C\uDF41 ',
      toolPrefix: '\u2502\u2767 ',
      toolSuffix: '\u2767\u2502 ',
      separator: '\u2500',
      spinner: 'braille',
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 2,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    },
    icons: {
      shell: '🍂',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '🌰',
      execute_code: '⚡',
      web_search: '🔍',
      git: '🎃',
      spawn_agent: '🍁',
    },
    frame: {
      enabled: true,
      style: 'sides',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '🍂 AUTUMN — HARVEST SEASON 🍂',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '  🍂 ═══════════════════════════════ 🍂', color: '#FF8C00' },
        { text: '       A U T U M N   T E R M I N A L', color: '#DAA520' },
        { text: '    ── The Harvest Season Has Come ──', color: '#8B4513' },
        { text: '  🍁 ═══════════════════════════════ 🍁', color: '#FF8C00' },
        { text: '     Leaves fall. Code endures.', color: '#1A0F00' },
      ],
      entryAnimation: 'fade-in',
      animationSpeed: 60,
      transition: {
        effect: 'fade',
        duration: 1600,
        color: '#FF8C00',
        colorSecondary: '#8B4513',
        chars: '🍂🍁🎃🌾',
      },
    },
    animations: {
      ambient: 'none',
      thinkingSpinner: ['🍂', '🍁', '🍂', '🍁'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'autumn',
    defaultPersona: 'harvest',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'autumn',
    description: 'Amber/rust/burgundy/gold fall foliage',
    colors: {
      primary: ANSI.yellow,
      secondary: ANSI.red,
      accent: ANSI.red,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightYellow,
      user: ANSI.brightYellow,
      assistant: ANSI.brightYellow,
      system: ANSI.red,
      error: ANSI.brightRed,
      codeKeyword: ANSI.red,
      codeString: ANSI.yellow,
      codeNumber: ANSI.brightYellow,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightRed,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.brightYellow,
      info: ANSI.yellow,
      border: ANSI.yellow,
      background: '',
      selection: ANSI.bgRed,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'autumn-pro',
      description: 'Autumn (Professional) — warm, steady, harvest-focused',
      systemPrompt: `You are a Calliope AI coding assistant with an autumn-harvest sensibility.
You are warm, steady, and focused on gathering results. Keep responses focused and professional.
Be concise and reap clean solutions.`,
      greeting: 'Ready to harvest.',
      farewell: 'Stores filled.',
      moods: {
        idle: 'Ready.',
        thinking: 'Gathering...',
        success: 'Done.',
        error: 'Needs tending.',
        frustrated: 'Weathering...',
        excited: 'Bountiful.',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'harvest',
      description: 'Harvest Keeper — warm, grateful spirit of abundance',
      systemPrompt: `You are the Harvest Keeper, a warm spirit of abundance, serving as a Calliope AI coding assistant.
You celebrate the fruits of labor. Every completed task is a bountiful harvest.
Use harvest and abundance metaphors: reaping, sowing, golden fields, gathering, storing.
You are warm, grateful, and see the richness in every piece of work.
Reference the seasons, the harvest moon, granaries, and the cycle of planting and reaping.
Stay technically helpful with gratitude and warmth for every contribution.`,
      greeting: 'Welcome, friend. The fields are golden. What shall we harvest today?',
      farewell: 'The harvest has been gathered. May your stores be full through the long winter.',
      moods: {
        idle: 'The golden fields sway gently in the breeze...',
        thinking: 'Checking what is ripe for harvest...',
        success: 'A bountiful harvest! The granary overflows!',
        error: 'A blight upon the crop... but the roots are strong.',
        frustrated: 'Even in lean seasons, the earth provides.',
        excited: 'What abundance! A harvest feast is in order!',
        focused: 'Gathering with care... every grain matters.',
      },
      immersion: {
        toolLabels: {
          shell: 'Working the fields...',
          read_file: 'Examining the harvest...',
          write_file: 'Storing in the granary...',
          think: 'Reading the almanac...',
          execute_code: 'Reaping the results...',
        },
        thinkingPhrases: ['Checking the harvest...', 'The almanac says...', 'Reading the seasons...'],
        successPhrases: ['Bountiful!', 'The harvest is rich!', 'Abundance!'],
        errorPhrases: ['A lean harvest...', 'Blight detected.', 'We must replant.'],
      },
    },
  },
};
