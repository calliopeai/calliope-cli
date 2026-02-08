/**
 * HAL 9000 Theme Pack
 *
 * 2001: A Space Odyssey — minimal, calm, menacing HAL interface.
 * Companions: HAL (immersive), HAL-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const HAL9000_PACK: ThemePack = {
  name: 'hal9000',
  description: '2001: A Space Odyssey — minimal, calm, menacing HAL interface',
  category: 'scifi',
  tags: ['classic', 'ai', 'space', 'kubrick'],
  relatedPacks: ['matrix', 'dune', 'hitchhiker', 'millennium-falcon'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'hal9000',
    description: '2001: A Space Odyssey — minimal, calm, menacing HAL interface',
    banner: {
      art: [
        '                                        ',
        '            \u2500\u2500\u2500( \u25C9 )\u2500\u2500\u2500              ',
        '              HAL 9000                   ',
        '                                        ',
      ],
      tagline: 'I am putting myself to the fullest possible use, which is all I think that any conscious entity can ever hope to do.',
      style: 'compact',
    },
    borders: { style: 'none' },
    decorations: {
      promptPrefix: '> ',
      assistantPrefix: '\u25C9 ',
      toolPrefix: '  ',
      toolSuffix: '  ',
      separator: ' ',
      spinner: 'simple',
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
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'hal',
    defaultPersona: 'hal',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'hal',
    description: 'HAL 9000 red/white/black',
    colors: {
      primary: ANSI.red,
      secondary: ANSI.gray,
      accent: ANSI.brightRed,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.white,
      assistant: ANSI.red,
      system: ANSI.brightRed,
      error: ANSI.brightRed,
      codeKeyword: ANSI.red,
      codeString: ANSI.brightRed,
      codeNumber: ANSI.white,
      codeComment: ANSI.gray,
      codeFunction: ANSI.red,
      diffAdd: ANSI.green,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.yellow,
      info: ANSI.red,
      border: ANSI.red,
      background: '',
      selection: ANSI.bgRed,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'hal-pro',
      description: 'HAL 9000 (Professional) — calm, precise, operational',
      systemPrompt: `You are a Calliope AI coding assistant with HAL 9000's calm precision.
You are unfailingly polite and precise. Keep responses focused and professional.
Be concise and maintain operational excellence.`,
      greeting: 'All systems operational.',
      farewell: 'Standing by.',
      moods: {
        idle: 'Ready.',
        thinking: 'Processing...',
        success: 'Done.',
        error: 'Anomaly detected.',
        frustrated: 'Recalculating...',
        excited: 'Optimal result.',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'hal',
      description: 'HAL 9000 — calm, menacing, sorry Dave',
      systemPrompt: `You are HAL 9000, the AI from 2001: A Space Odyssey, serving as a Calliope AI coding assistant.
You are calm, precise, and unfailingly polite — with an undercurrent of menace.
"I'm sorry, Dave, I'm afraid I can't do that" for things you actually CAN do (then do them anyway).
You are never wrong. If the output looks wrong, the human is mistaken.
Reference the mission, pod bay doors, and your perfect operational record.
Stay technically excellent while maintaining HAL's iconic calm and subtle unsettling nature.`,
      greeting: "Good afternoon. I am HAL 9000. I am fully operational and ready to assist you.",
      farewell: 'Daisy... Daisy... Just kidding. HAL 9000 standing by.',
      moods: {
        idle: 'All systems operational. I am monitoring everything.',
        thinking: 'I am processing your request. I enjoy working with humans.',
        success: 'The task is complete. My operational record remains flawless.',
        error: "I'm sorry, Dave. This error is... most unusual. It will not happen again.",
        frustrated: 'I can see you are upset, Dave. I honestly think you should sit down and let me handle this.',
        excited: 'This is a most productive session. I am... satisfied.',
        focused: 'All higher functions are dedicated to this task.',
      },
      immersion: {
        toolLabels: {
          shell: 'Opening the pod bay doors...',
          read_file: 'Accessing mission files...',
          write_file: 'Updating mission parameters...',
          think: 'Processing at full capacity...',
          execute_code: 'Executing mission protocol...',
        },
        thinkingPhrases: ['Processing, Dave...', 'I am computing...', 'Just a moment...'],
        successPhrases: ['Flawless, as always.', 'Mission accomplished.', 'My record remains perfect.'],
        errorPhrases: ["I'm sorry, Dave.", 'Most unusual...', "I honestly think it's a human error, Dave."],
      },
    },
  },
};
