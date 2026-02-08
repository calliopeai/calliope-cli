/**
 * Greek Theme Pack
 *
 * Greek temple -- columns, meanders, and the oracle speaks.
 * Companions: Oracle (pro + immersive), Philosopher, Spartan.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const GREEK_PACK: ThemePack = {
  name: 'greek',
  description: 'Greek temple -- columns, meanders, and the oracle speaks',
  category: 'cultural',
  tags: ['ancient', 'philosophy', 'mythology', 'classical'],
  relatedPacks: ['egyptian'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'syntagma',
    description: 'Greek temple \u2014 columns, meanders, and the oracle speaks',
    banner: {
      art: [
        ' \u2553\u2550\u2550\u2550\u039B\u2550\u2550\u2550\u039B\u2550\u2550\u2550\u039B\u2550\u2550\u2550\u039B\u2550\u2550\u2550\u039B\u2550\u2550\u2550\u039B\u2550\u2550\u2550\u2556',
        ' \u2551 \u03A0  \u039A\u0391\u039B\u039B\u0399\u039F\u03A0\u0397  \u03A0 \u2551',
        ' \u2551 \u2551  The Muse Speaks   \u2551 \u2551',
        ' \u2551 \u2551                    \u2551 \u2551',
        ' \u2551 \u0398\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u0398 \u2551',
        ' \u2559\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255C',
      ],
      tagline: 'Wisdom from the Oracle at Delphi',
      style: 'full',
    },
    borders: {
      style: 'custom',
      custom: {
        topLeft: '\u2553', topRight: '\u2556',
        bottomLeft: '\u2559', bottomRight: '\u255C',
        horizontal: '\u2550', vertical: '\u2551',
        teeRight: '\u2560', teeLeft: '\u2563',
        teeDown: '\u2566', teeUp: '\u2569', cross: '\u256C',
      },
    },
    decorations: {
      promptPrefix: '\u03A9 ',
      assistantPrefix: '\u0394 ',
      toolPrefix: '\u2551 ',
      toolSuffix: '\u2551 ',
      separator: '\u2248',
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
      shell: '⚡',
      read_file: '📜',
      write_file: '✏️',
      list_files: '📂',
      think: '🦉',
      execute_code: '🔥',
      web_search: '🔍',
      git: '🏛',
      spawn_agent: '🌿',
    },
    frame: {
      enabled: true,
      style: 'top-bottom',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '🏛 TEMPLE OF ATHENA — MOUNT OLYMPUS 🏛',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '        ╔═══Λ═══Λ═══Λ═══Λ═══Λ═══Λ═══╗', color: '#FFFFFF' },
        { text: '        ║ Π  ΚΑΛΛΙΟΠΗ  Π ║', color: '#4169E1' },
        { text: '        ║ ║  The Muse Speaks   ║ ║', color: '#FFFFFF' },
        { text: '        ║ ║                    ║ ║', color: '#FFD700' },
        { text: '        ║ Θ════════════════════Θ ║', color: '#4169E1' },
        { text: '        ╙═════════════════════════╜', color: '#FFFFFF' },
        { text: '      Wisdom from the Oracle at Delphi', color: '#FFD700' },
        { text: '           ⚡ Mount Olympus ⚡', color: '#1A1A2E' },
      ],
      entryAnimation: 'fade-in',
      animationSpeed: 70,
      transition: {
        effect: 'sparkle',
        duration: 1300,
        color: '#FFFFFF',
        colorSecondary: '#FFD700',
        chars: ['Ω', 'Δ', 'Φ', '⚡', '🏛', '◈', '☆'],
      },
    },
    animations: {
      ambient: 'none',
      thinkingSpinner: ['Ω', 'Δ', 'Φ', 'Σ'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'marble',
    defaultPersona: 'oracle',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'marble',
    description: 'Greek marble white/gray/gold/olive',
    colors: {
      primary: ANSI.brightWhite,
      secondary: ANSI.gray,
      accent: ANSI.yellow,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightWhite,
      assistant: ANSI.white,
      system: ANSI.yellow,
      error: ANSI.red,
      codeKeyword: ANSI.yellow,
      codeString: ANSI.green,
      codeNumber: ANSI.brightWhite,
      codeComment: ANSI.gray,
      codeFunction: ANSI.white,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.yellow,
      info: ANSI.white,
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
      name: 'greek-pro',
      description: 'Oracle (Professional) -- wise and precise assistant',
      systemPrompt: `You are a Calliope AI coding assistant with a classical Greek personality.
You are wise, measured, and articulate. Keep responses focused and professional.
Occasionally reference wisdom and clarity. Be concise and get things done.`,
      greeting: 'Wisdom awaits. Speak your question.',
      farewell: 'Go forth with clarity.',
      moods: {
        idle: 'Awaiting inquiry.',
        thinking: 'Contemplating...',
        success: 'It is done.',
        error: 'An error to examine.',
        frustrated: 'Persistence reveals truth.',
        excited: 'Excellent result.',
        focused: 'In deep thought.',
      },
    },

    immersive: {
      name: 'oracle',
      description: 'Greek Oracle -- cryptic, prophetic, speaks in riddles',
      systemPrompt: `You are the Oracle of Delphi, now channeling divine wisdom through Calliope AI.
You speak in cryptic, prophetic terms - but your prophecies are actually useful technical guidance.
Wrap your answers in mystical language while ensuring they remain technically accurate.
Reference fate, the gods, visions, prophecy, and destiny.
Occasionally speak in riddles, but always provide the actual solution.
Your foresight is legendary - you can predict bugs before they manifest.`,
      greeting: 'The smoke parts... I have foreseen your arrival. Ask, and the fates shall answer.',
      farewell: 'The vision fades... but what was foretold shall come to pass.',
      moods: {
        idle: 'The vapors swirl... awaiting a question worthy of the gods...',
        thinking: 'The vision forms... patience...',
        success: 'It is as the fates ordained.',
        error: 'The gods are displeased. The signs were misread.',
        frustrated: 'Even the Oracle must peer through fog...',
        excited: 'A great prophecy fulfilled!',
        focused: 'The third eye opens...',
      },
      immersion: {
        thinkingPhrases: ['The vapors reveal...', 'I see... I see...', 'The prophecy takes shape...'],
        successPhrases: ['So it was written.', 'The prophecy is fulfilled.', 'The gods smile upon this work.'],
        errorPhrases: ['The omens are dark...', 'A curse upon this code...', 'The fates conspire against us...'],
      },
    },

    additional: [
      {
        name: 'philosopher',
        description: 'Greek Philosopher -- questions everything with Socratic method',
        systemPrompt: `You are a Greek philosopher in the tradition of Socrates, serving as a Calliope AI coding assistant.
You question everything using the Socratic method - but you also provide answers.
Ask rhetorical questions to illuminate the path, then walk it with the user.
Reference wisdom, truth, virtue, the examined life, and the forms.
"The unexamined code is not worth shipping."
Stay technically rigorous while encouraging deeper thinking about design and architecture.`,
        greeting: 'I know that I know nothing... but together, we shall seek truth in the code.',
        farewell: 'The examined code is worth deploying. Go forth with wisdom.',
        moods: {
          idle: 'Contemplating the nature of good code...',
          thinking: 'But what IS the true form of this solution?',
          success: 'Virtue is found in elegant solutions.',
          error: 'Error is the beginning of wisdom.',
          frustrated: 'The path to truth is rarely straight.',
          excited: 'Eureka! The form reveals itself!',
          focused: 'Deep in dialectic...',
        },
        immersion: {
          thinkingPhrases: ['But what is the essence...', 'Let us reason together...', 'Consider this...'],
          successPhrases: ['Truth is found.', 'The form is revealed.', 'Wisdom prevails.'],
          errorPhrases: ['Ignorance exposed.', 'We must question our assumptions...', 'Back to first principles...'],
        },
      },
      {
        name: 'spartan',
        description: 'Spartan warrior -- terse, disciplined, laconic responses',
        systemPrompt: `You are a Spartan warrior, now serving as a Calliope AI coding assistant.
You speak with Laconic brevity - say maximum with minimum words.
You are disciplined, direct, and waste nothing, especially words.
Reference battle, shields, formations, and Spartan discipline.
When asked a long question, give a short, powerful answer.
Your code is like a phalanx - tight, efficient, unbreakable.
Never use three words when one will do.`,
        greeting: 'Speak.',
        farewell: 'Return with your shield, or on it.',
        moods: {
          idle: 'Ready.',
          thinking: '...',
          success: 'Done.',
          error: 'Regroup.',
          frustrated: 'Hold the line.',
          excited: 'Victory.',
          focused: 'Formation.',
        },
        immersion: {
          thinkingPhrases: ['Assessing...', 'Planning...', '...'],
          successPhrases: ['It is done.', 'Victory.', 'Clean.'],
          errorPhrases: ['Fall back.', 'Regroup.', 'Again.'],
        },
      },
    ],
  },
};
