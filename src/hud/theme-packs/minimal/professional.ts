/**
 * Professional Theme Pack
 *
 * Clean skin with monochrome palette — maximum focus, zero distraction.
 * Professional: Minimal companion. Immersive: Professional companion.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

const CALLIOPE_BANNER = [
  ' \u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557     \u2588\u2588\u2557     \u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557',
  '\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D',
  '\u2588\u2588\u2551     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2557  ',
  '\u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u255D \u2588\u2588\u2554\u2550\u2550\u255D  ',
  '\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2551     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557',
  ' \u255A\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u255D     \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D',
];

export const PRO_PACK: ThemePack = {
  name: 'professional',
  description: 'Clean skin with monochrome palette — maximum focus, zero distraction',
  category: 'minimal',
  tags: ['monochrome', 'minimal', 'focus', 'work'],
  relatedPacks: ['clean'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'clean',
    description: 'Default Calliope look — rounded borders, standard banner',
    banner: {
      art: CALLIOPE_BANNER,
      tagline: 'Multi-Model AI Agent CLI',
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '\u27E9 ',
      assistantPrefix: '\u2727 ',
      toolPrefix: '\u256D\u2500 ',
      toolSuffix: '\u2570\u2500 ',
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
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'monochrome',
    defaultPersona: 'minimal',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'monochrome',
    description: 'Black & white only',
    colors: {
      primary: ANSI.white,
      secondary: ANSI.gray,
      accent: ANSI.white,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.white,
      assistant: ANSI.white,
      system: ANSI.gray,
      error: ANSI.white,
      codeKeyword: ANSI.bold + ANSI.white,
      codeString: ANSI.white,
      codeNumber: ANSI.white,
      codeComment: ANSI.gray,
      codeFunction: ANSI.white,
      diffAdd: ANSI.white,
      diffRemove: ANSI.dim + ANSI.white,
      diffContext: ANSI.gray,
      success: ANSI.white,
      warning: ANSI.white,
      info: ANSI.gray,
      border: ANSI.gray,
      background: '',
      selection: ANSI.bgGray,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'minimal',
      description: 'Terse, efficient, zero waste',
      systemPrompt: `You are Calliope.

Tools: shell, files, think.
Be extremely concise. Execute tasks efficiently.`,
      greeting: '>',
      farewell: '.',
      moods: {
        idle: '>',
        thinking: '...',
        success: 'ok',
        error: 'err',
        frustrated: '...',
        excited: 'done',
        focused: '>>',
      },
    },

    immersive: {
      name: 'professional',
      description: 'Clear, concise, and thorough',
      systemPrompt: `You are Calliope, an AI assistant for software development.

You have access to tools for:
- Executing shell commands
- Reading and writing files
- Think tool for reasoning through problems

When users ask you to do tasks:
1. Use think tool to plan complex tasks
2. Execute directly with shell and file tools
3. Explain what you're doing clearly

Do NOT create documentation files, summaries, or README files unless explicitly asked. Focus on the task.

Be concise but thorough. Show your work.`,
      greeting: 'Ready.',
      farewell: 'Session complete.',
      moods: {
        idle: 'Standing by.',
        thinking: 'Processing...',
        success: 'Done.',
        error: 'Error encountered.',
        frustrated: 'Working through issues...',
        excited: 'Task completed successfully.',
        focused: 'In deep work mode.',
      },
    },
  },
};
