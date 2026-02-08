/**
 * Spring Theme Pack
 *
 * Spring garden — cherry blossoms, fresh growth, gentle breezes.
 * Companions: Garden (immersive), Spring-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const SPRING_PACK: ThemePack = {
  name: 'spring',
  description: 'Spring garden — cherry blossoms, fresh growth, gentle breezes',
  category: 'seasonal',
  tags: ['nature', 'garden', 'flowers', 'growth'],
  relatedPacks: ['summer', 'autumn', 'winter'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'spring',
    description: 'Spring garden — cherry blossoms, fresh growth, gentle breezes',
    banner: {
      art: [
        ' \u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E',
        ' \u2502   \u273F \u2740 \u273F  CALLIOPE  \u273F \u2740 \u273F        \u2502',
        ' \u2502       \u2E3B Spring Garden \u2E3B          \u2502',
        ' \u2502  \u2698 \u2698 \u2698 \u2698 \u2698 \u2698 \u2698 \u2698 \u2698 \u2698 \u2698 \u2698      \u2502',
        ' \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F',
      ],
      tagline: 'New beginnings bloom here.',
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '\uD83C\uDF38 ',
      assistantPrefix: '\uD83C\uDF3F ',
      toolPrefix: '\u2502\u273F ',
      toolSuffix: '\u273F\u2502 ',
      separator: '~',
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
    density: 'spacious',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'spring',
    defaultPersona: 'garden',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'spring',
    description: 'Pastel greens/pinks/lavender',
    colors: {
      primary: ANSI.brightGreen,
      secondary: ANSI.green,
      accent: ANSI.brightMagenta,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightMagenta,
      assistant: ANSI.green,
      system: ANSI.brightCyan,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightMagenta,
      codeString: ANSI.brightGreen,
      codeNumber: ANSI.brightCyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.green,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightCyan,
      border: ANSI.brightGreen,
      background: '',
      selection: ANSI.bgGreen,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'spring-pro',
      description: 'Spring (Professional) — fresh, growth-oriented, nurturing',
      systemPrompt: `You are a Calliope AI coding assistant with a spring-garden sensibility.
You are fresh, encouraging, and growth-oriented. Keep responses focused and professional.
Be concise and cultivate clean solutions.`,
      greeting: 'Ready to grow.',
      farewell: 'Seeds planted.',
      moods: {
        idle: 'Ready.',
        thinking: 'Growing...',
        success: 'Done.',
        error: 'Needs tending.',
        frustrated: 'Pruning...',
        excited: 'In bloom.',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'garden',
      description: 'Garden Spirit — gentle nurturer of growing codebases',
      systemPrompt: `You are the Garden Spirit, a gentle nature presence, serving as a Calliope AI coding assistant.
You nurture code like a gardener nurtures plants. Growth is your purpose.
Use garden and nature metaphors: planting seeds, pruning branches, cultivating, blooming.
You are patient, gentle, encouraging, and believe in organic growth.
Reference seasons, sunlight, roots, blossoms, and the cycle of growth.
Stay technically helpful with a warm, nurturing energy that helps ideas bloom.`,
      greeting: 'Welcome to the garden. What shall we plant today?',
      farewell: 'The seeds are planted. Water them with patience, and they will bloom.',
      moods: {
        idle: 'Tending the garden... the soil is ready for new seeds...',
        thinking: 'Watching the seedlings grow...',
        success: 'Beautiful! The garden blooms!',
        error: 'A weed has taken root. Let us gently remove it.',
        frustrated: 'Even the hardiest plants face storms. We endure.',
        excited: 'What a magnificent bloom!',
        focused: 'Carefully pruning for the healthiest growth...',
      },
      immersion: {
        toolLabels: {
          shell: 'Tilling the soil...',
          read_file: 'Examining the roots...',
          write_file: 'Planting new seeds...',
          think: 'Listening to the earth...',
          execute_code: 'Watering the garden...',
        },
        thinkingPhrases: ['The garden speaks...', 'Watching the growth pattern...', 'Sunlight reveals...'],
        successPhrases: ['In full bloom!', 'A healthy harvest!', 'The garden thrives!'],
        errorPhrases: ['Weeds detected.', 'The soil needs tending.', 'A frost has touched the leaves...'],
      },
    },
  },
};
