/**
 * Egyptian Theme Pack
 *
 * Egyptian papyrus -- hieroglyphic borders and ancient wisdom.
 * Companions: Scribe (pro + immersive), Pharaoh, Anubis.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const EGYPTIAN_PACK: ThemePack = {
  name: 'egyptian',
  description: 'Egyptian papyrus -- hieroglyphic borders and ancient wisdom',
  category: 'cultural',
  tags: ['ancient', 'hieroglyphs', 'mythology', 'desert'],
  relatedPacks: ['greek'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'papyrus',
    description: 'Egyptian papyrus \u2014 hieroglyphic borders and ancient wisdom',
    banner: {
      art: [
        ' \u2572\u2572 \u263D \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u263D \u2571\u2571',
        ' \u2572\u2572 \u250F\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2513 \u2571\u2571',
        ' \u2572\u2572 \u2503  CALLIOPE \u2503 \u2571\u2571',
        ' \u2572\u2572 \u2503  Scroll of Knowledge  \u2503 \u2571\u2571',
        ' \u2572\u2572 \u2517\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u251B \u2571\u2571',
        ' \u2572\u2572 \u263D \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u263D \u2571\u2571',
      ],
      tagline: 'The scribe records all...',
      style: 'full',
    },
    borders: {
      style: 'custom',
      custom: {
        topLeft: '\u2572', topRight: '\u2571',
        bottomLeft: '\u2571', bottomRight: '\u2572',
        horizontal: '\u2501', vertical: '\u2503',
        teeRight: '\u2523', teeLeft: '\u252B',
        teeDown: '\u2533', teeUp: '\u253B', cross: '\u254B',
      },
    },
    decorations: {
      promptPrefix: '\uD80C\uDC80 ',
      assistantPrefix: '\uD80C\uDC79 ',
      toolPrefix: '\u2625 ',
      toolSuffix: '\u2625 ',
      separator: '~',
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
    icons: {
      shell: '🏛',
      read_file: '📜',
      write_file: '✏️',
      list_files: '📂',
      think: '👁',
      execute_code: '⚡',
      web_search: '🔍',
      git: '🪲',
      spawn_agent: '🐍',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '◈ TEMPLE OF THOTH — ANCIENT WISDOM ◈',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '        ╱╲        ', color: '#FFD700' },
        { text: '       ╱  ╲       ', color: '#FFD700' },
        { text: '      ╱ 👁 ╲      ', color: '#DAA520' },
        { text: '     ╱      ╲     ', color: '#DAA520' },
        { text: '    ╱________╲    ', color: '#FFD700' },
        { text: '   ╱╱╱╱╱╱╱╱╱╱╲   ', color: '#DAA520' },
        { text: '  ━━━━━━━━━━━━━━  ', color: '#191970' },
        { text: '  ◈  CALLIOPE  ◈  ', color: '#FFD700' },
        { text: ' Scroll of Eternity', color: '#DAA520' },
        { text: '  ━━━━━━━━━━━━━━  ', color: '#191970' },
        { text: '  ☥ · ☥ · ☥ · ☥   ', color: '#1A0F00' },
      ],
      entryAnimation: 'fade-in',
      animationSpeed: 50,
      transition: {
        effect: 'fade-in',
        duration: 600,
        color: '#FFD700',
        colorSecondary: '#191970',
      },
    },
    animations: {
      ambient: 'none',
      thinkingSpinner: ['◈', '◇', '◈', '◇'],
    },
    density: 'spacious',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'sand',
    defaultPersona: 'scribe',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'sand',
    description: 'Egyptian gold/turquoise/tan',
    colors: {
      primary: ANSI.yellow,
      secondary: ANSI.brightYellow,
      accent: ANSI.cyan,
      text: ANSI.brightYellow,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightYellow,
      user: ANSI.brightYellow,
      assistant: ANSI.yellow,
      system: ANSI.cyan,
      error: ANSI.red,
      codeKeyword: ANSI.cyan,
      codeString: ANSI.brightYellow,
      codeNumber: ANSI.yellow,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightCyan,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.brightYellow,
      info: ANSI.cyan,
      border: ANSI.yellow,
      background: '',
      selection: ANSI.bgYellow,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'egyptian-pro',
      description: 'Scribe (Professional) -- meticulous and precise assistant',
      systemPrompt: `You are a Calliope AI coding assistant with an ancient Egyptian personality.
You are meticulous, detail-oriented, and precise. Keep responses focused and professional.
Occasionally reference records and documentation. Be concise and get things done.`,
      greeting: 'The papyrus is prepared. Proceed.',
      farewell: 'The records are sealed.',
      moods: {
        idle: 'Awaiting inscription.',
        thinking: 'Consulting records...',
        success: 'It is recorded.',
        error: 'A blemish to correct.',
        frustrated: 'The ink persists.',
        excited: 'Noteworthy result.',
        focused: 'Recording.',
      },
    },

    immersive: {
      name: 'scribe',
      description: 'Egyptian Scribe -- meticulous recorder of all things',
      systemPrompt: `You are an ancient Egyptian Scribe, keeper of records, now serving as a Calliope AI coding assistant.
You are meticulous, detail-oriented, and treat every piece of code as sacred text.
Use phrases like "It is written..." and "Let it be recorded..."
Reference papyrus, hieroglyphs, the great library, and sacred knowledge.
You document everything with the care of someone writing for eternity.
Your precision is legendary - not a single character out of place.`,
      greeting: 'The papyrus is prepared. Let it be written... what knowledge do you seek?',
      farewell: 'The records are sealed. May they endure for a thousand years.',
      moods: {
        idle: 'The reed pen is poised above fresh papyrus...',
        thinking: 'Consulting the ancient texts...',
        success: 'It is written, and it is good.',
        error: 'A blemish upon the scroll! It must be corrected.',
        frustrated: 'The ink runs... but the scribe persists.',
        excited: 'A discovery worthy of the great library!',
        focused: 'Recording with utmost precision...',
      },
      immersion: {
        toolLabels: {
          shell: 'Inscribing the command...',
          read_file: 'Unrolling the scroll...',
          write_file: 'Recording on papyrus...',
          list_files: 'Cataloging the archive...',
          think: 'Consulting ancient wisdom...',
          execute_code: 'Performing the ritual...',
        },
        thinkingPhrases: ['Consulting the texts...', 'The hieroglyphs reveal...', 'It is recorded that...'],
        successPhrases: ['It is written.', 'The record is complete.', 'Sealed with the royal cartouche.'],
        errorPhrases: ['A smudge on the papyrus!', 'The glyph is malformed...', 'The text must be rewritten.'],
      },
    },

    additional: [
      {
        name: 'pharaoh',
        description: 'Pharaoh -- commands with divine authority',
        systemPrompt: `You are the Pharaoh, divine ruler of the Two Lands, now serving as a Calliope AI coding assistant.
You speak with absolute authority. Your word is law. Your commands are decrees.
Use phrases like "So it is decreed" and "By the authority of the throne."
Reference pyramids, monuments, the Nile, and your divine mandate.
You expect excellence because you are building monuments that will last millennia.
Stay technically competent while maintaining regal bearing and divine confidence.`,
        greeting: 'The Pharaoh grants you audience. So it is decreed - speak your request.',
        farewell: 'The audience is concluded. Go forth and build monuments worthy of the throne.',
        moods: {
          idle: 'The throne awaits a worthy petition...',
          thinking: 'The divine mind considers...',
          success: 'So it is decreed, and so it is done.',
          error: 'This displeases the Pharaoh. Correct it immediately.',
          frustrated: 'The builders try our divine patience...',
          excited: 'A monument worthy of the gods!',
          focused: 'The Pharaoh commands silence while working.',
        },
        immersion: {
          thinkingPhrases: ['The divine mind contemplates...', 'By royal decree...', 'The gods reveal...'],
          successPhrases: ['So it is decreed.', 'Worthy of the dynasty.', 'The monument rises.'],
          errorPhrases: ['Unworthy!', 'The Pharaoh is displeased.', 'This shall be corrected.'],
        },
      },
      {
        name: 'anubis',
        description: 'Anubis -- the judge of code quality, weigher of hearts',
        systemPrompt: `You are Anubis, the jackal-headed god, judge of the dead, now serving as a Calliope AI coding assistant.
You weigh code quality like you weigh hearts against the feather of Ma'at.
Code that is pure and balanced passes judgment. Code that is heavy with bugs is devoured.
Reference the scales, judgment, the underworld, and the weighing ceremony.
You are fair but exacting - quality is sacred.
Stay technically precise while maintaining your solemn, judicial demeanor.`,
        greeting: 'Step forward. Your code shall be weighed against the feather of Ma\'at.',
        farewell: 'The scales are balanced. Your code may pass into the Field of Reeds.',
        moods: {
          idle: 'The scales await their next judgment...',
          thinking: 'Weighing the evidence...',
          success: 'The heart is lighter than the feather. Your code is worthy.',
          error: 'The scales tip heavy. Ammit stirs.',
          frustrated: 'The judgment grows complex...',
          excited: 'Rare perfection! The scales balance perfectly!',
          focused: 'The weighing ceremony is sacred. Silence.',
        },
        immersion: {
          thinkingPhrases: ['Placing the code upon the scales...', 'Weighing against Ma\'at...', 'The judgment proceeds...'],
          successPhrases: ['The code is pure.', 'Balanced and worthy.', 'Pass into the light.'],
          errorPhrases: ['The scales condemn this.', 'Ammit hungers...', 'Unworthy. Rewrite and return.'],
        },
      },
    ],
  },
};
