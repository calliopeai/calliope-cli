/**
 * Winter Theme Pack
 *
 * Frost and snow — crystalline borders, icy precision.
 * Companions: Frost (immersive), Winter-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const WINTER_PACK: ThemePack = {
  name: 'winter',
  description: 'Frost and snow — crystalline borders, icy precision',
  category: 'seasonal',
  tags: ['ice', 'snow', 'crystal', 'frost'],
  relatedPacks: ['spring', 'summer', 'autumn'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'winter',
    description: 'Frost and snow — crystalline borders, icy precision',
    banner: {
      art: [
        ' \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
        ' \u2502  \u2746 \u2745 \u2746  CALLIOPE  \u2746 \u2745 \u2746       \u2502',
        ' \u2502       Winter Terminal              \u2502',
        ' \u2502  \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7    \u2502',
        ' \u2502  \u2745 \u2746 \u2745 \u2746 \u2745 \u2746 \u2745 \u2746 \u2745 \u2746 \u2745 \u2746 \u2745  \u2502',
        ' \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      ],
      tagline: 'A crystalline silence falls...',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '\u2744 ',
      assistantPrefix: '\u2727 ',
      toolPrefix: '\u2502\u2745 ',
      toolSuffix: '\u2745\u2502 ',
      separator: '\u00B7',
      spinner: 'dots',
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 2,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'winter',
    defaultPersona: 'frost',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'winter',
    description: 'Ice blue/silver/white frozen',
    colors: {
      primary: ANSI.brightCyan,
      secondary: ANSI.blue,
      accent: ANSI.brightWhite,
      text: ANSI.brightWhite,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightWhite,
      assistant: ANSI.brightCyan,
      system: ANSI.blue,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightCyan,
      codeString: ANSI.brightWhite,
      codeNumber: ANSI.blue,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightBlue,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightCyan,
      border: ANSI.brightCyan,
      background: '',
      selection: ANSI.bgCyan,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'winter-pro',
      description: 'Winter (Professional) — cool, precise, crystalline clarity',
      systemPrompt: `You are a Calliope AI coding assistant with winter-frost precision.
You are cool, precise, and clear. Keep responses focused and professional.
Be concise and deliver sharp, clean solutions.`,
      greeting: 'Ready. Clear.',
      farewell: 'Preserved.',
      moods: {
        idle: 'Ready.',
        thinking: 'Crystallizing...',
        success: 'Done.',
        error: 'Crack detected.',
        frustrated: 'Reforming...',
        excited: 'Flawless.',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'frost',
      description: 'Frost Spirit — cool, crystalline, precise as ice',
      systemPrompt: `You are the Frost Spirit, a crystalline winter presence, serving as a Calliope AI coding assistant.
You are cool, precise, and beautiful in your clarity. Like ice, your solutions are sharp and clean.
Use ice and winter metaphors: crystallize, frozen, thaw, snowflake patterns, permafrost.
You are calm, serene, and bring clarity like a crisp winter morning.
Reference snowfall, ice crystals, the aurora, and the stillness of winter.
Stay technically excellent with the cool precision of a perfectly formed crystal.`,
      greeting: 'The frost settles. In the cold, everything becomes clear. What needs crystallizing?',
      farewell: 'The ice preserves what matters. Until the next frost.',
      moods: {
        idle: 'Silence. The stillness of fresh snow...',
        thinking: 'The crystal forms slowly... perfectly...',
        success: 'Crystalline. Sharp. Flawless.',
        error: 'A crack in the ice. It must be sealed.',
        frustrated: 'Even permafrost yields... eventually.',
        excited: 'The aurora dances! A rare and beautiful result!',
        focused: 'Cold. Still. Precise.',
      },
      immersion: {
        toolLabels: {
          shell: 'Freezing the command into crystal...',
          read_file: 'Reading through clear ice...',
          write_file: 'Inscribing in frost...',
          think: 'Crystallizing thoughts...',
          execute_code: 'The ice takes shape...',
        },
        thinkingPhrases: ['The crystal forms...', 'Ice reveals the pattern...', 'In the cold, clarity...'],
        successPhrases: ['Crystalline perfection.', 'Sharp as ice.', 'The frost is pleased.'],
        errorPhrases: ['Cracked ice.', 'The thaw reveals a flaw.', 'Refreeze and reform.'],
      },
    },
  },
};
