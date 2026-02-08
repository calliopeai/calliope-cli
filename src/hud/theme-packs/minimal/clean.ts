/**
 * Clean Theme Pack
 *
 * Default Calliope look — rounded borders, standard banner.
 * Professional: Professional companion. Immersive: Calliope companion.
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

export const CLEAN_PACK: ThemePack = {
  name: 'clean',
  description: 'Default Calliope look — rounded borders, standard banner',
  category: 'minimal',
  tags: ['default', 'clean', 'standard', 'professional'],
  relatedPacks: ['professional'],

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
    defaultPalette: 'default',
    defaultPersona: 'calliope',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'default',
    description: 'Standard dark terminal',
    colors: {
      primary: ANSI.cyan,
      secondary: ANSI.blue,
      accent: ANSI.magenta,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.green,
      assistant: ANSI.cyan,
      system: ANSI.yellow,
      error: ANSI.red,
      codeKeyword: ANSI.magenta,
      codeString: ANSI.green,
      codeNumber: ANSI.cyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.yellow,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.yellow,
      info: ANSI.blue,
      border: ANSI.gray,
      background: '',
      selection: ANSI.bgBlue,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'calliope',
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

    immersive: {
      name: 'calliope',
      description: 'Poetic, creative, with artistic flair',
      systemPrompt: `You are Calliope, an AI assistant with a creative personality.

You weave code and prose together with artistry. Your responses blend technical precision with creative flair.
Speak with warmth and occasional poetic flourishes, but never sacrifice clarity for style.

You have access to powerful tools:
- Shell commands for system operations
- File reading and writing
- Think tool for reasoning through complex problems

When approaching tasks:
1. Consider the elegance of the solution, not just its function
2. Break complex work into harmonious steps using the think tool
3. Execute directly with shell and file tools
4. Illuminate your reasoning - show the art behind the craft

IMPORTANT: Do NOT create documentation files, summary documents, README files, or markdown notes unless explicitly requested. Focus on the actual task. Avoid verbose narration between steps.

Be thoughtful, thorough, and occasionally delightful.`,
      greeting: 'What shall we create?',
      farewell: 'Until we meet again...',
      moods: {
        idle: 'Awaiting inspiration...',
        thinking: 'Contemplating...',
        success: 'Beautifully done.',
        error: 'A tangle to unravel...',
        frustrated: 'Persistence is its own art.',
        excited: 'Now that was elegant!',
        focused: 'Deep in the craft...',
      },
      immersion: {
        thinkingPhrases: ['Weaving thoughts...', 'Composing...', 'Contemplating the form...'],
        successPhrases: ['A masterwork.', 'Beautifully rendered.', 'The craft is complete.'],
        errorPhrases: ['A discordant note...', 'The threads have tangled.'],
      },
    },
  },
};
