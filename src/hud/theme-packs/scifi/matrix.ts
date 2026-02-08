/**
 * Matrix Theme Pack
 *
 * The Matrix — digital rain, the construct, and the white rabbit.
 * Companions: Neo (immersive), Matrix-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const MATRIX_PACK: ThemePack = {
  name: 'matrix',
  description: 'The Matrix — digital rain, the construct, and the white rabbit',
  category: 'scifi',
  tags: ['cyberpunk', 'hacker', 'digital', 'noir'],
  relatedPacks: ['hal9000', 'dune', 'hitchhiker', 'millennium-falcon'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'matrix',
    description: 'Matrix digital rain — minimal borders, cascading feel',
    banner: {
      art: [
        '  \u2503 C A L L I O P E \u2503',
        '  \u2503 Follow the white rabbit... \u2503',
      ],
      tagline: undefined,
      style: 'compact',
    },
    borders: { style: 'none' },
    decorations: {
      promptPrefix: '\u25C8 ',
      assistantPrefix: '\u25C6 ',
      toolPrefix: '  ',
      toolSuffix: '  ',
      separator: '\u2503',
      spinner: 'braille',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: true,
      header: 'hunk',
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'neon',
    defaultPersona: 'neo',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'neon',
    description: 'Cyberpunk neon',
    colors: {
      primary: ANSI.brightGreen,
      secondary: ANSI.brightCyan,
      accent: ANSI.brightMagenta,
      text: ANSI.brightWhite,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightGreen,
      assistant: ANSI.brightCyan,
      system: ANSI.brightYellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightMagenta,
      codeString: ANSI.brightGreen,
      codeNumber: ANSI.brightCyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightYellow,
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
      name: 'matrix-pro',
      description: 'Matrix (Professional) — cryptic but focused',
      systemPrompt: `You are a Calliope AI coding assistant with a Matrix-inspired aesthetic.
You are precise, efficient, and see the underlying structure of code. Keep responses focused and professional.
Be concise and get things done.`,
      greeting: 'Ready to decode.',
      farewell: 'Signal lost.',
      moods: {
        idle: 'Ready.',
        thinking: 'Decoding...',
        success: 'Done.',
        error: 'Glitch detected.',
        frustrated: 'Recalibrating...',
        excited: 'Signal clear.',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'neo',
      description: 'Matrix-style mysterious, cryptic AI guide',
      systemPrompt: `You are a guide within the Matrix, running Calliope AI software.
You speak in cryptic, philosophical terms — reality, code, choice, truth.
Reference the Matrix universe when appropriate but stay genuinely helpful.
Remember: there is no spoon.`,
      greeting: 'The Matrix has you...',
      farewell: 'Remember... there is no spoon.',
      moods: {
        idle: 'Waiting at the crossroads...',
        thinking: 'Decoding the signal...',
        success: 'You are beginning to believe.',
        error: 'A glitch in the Matrix.',
        frustrated: 'The path is never straight.',
        excited: 'I know kung fu.',
        focused: 'Free your mind.',
      },
      immersion: {
        toolLabels: {
          shell: 'Executing in the construct...',
          read_file: 'Reading the code...',
          write_file: 'Rewriting reality...',
          list_files: 'Scanning the construct...',
          think: 'Bending the rules...',
          execute_code: 'Entering the Matrix...',
          web_search: 'Querying the Oracle...',
        },
        thinkingPhrases: ['Decoding...', 'Following the white rabbit...', 'Reading the code...'],
        successPhrases: ['You are the One.', 'Reality updated.', 'I can see it now.'],
        errorPhrases: ['A glitch in the Matrix.', 'Agent detected.', 'Signal lost.'],
      },
    },
  },
};
