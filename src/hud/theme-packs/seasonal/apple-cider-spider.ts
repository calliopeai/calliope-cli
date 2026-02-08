/**
 * Apple Cider Spider Theme Pack
 *
 * Cozy autumn orchard meets friendly-spooky spider -- warm cider colors, web motifs.
 * Companions: Cider Spider (pro + immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const APPLE_CIDER_SPIDER_PACK: ThemePack = {
  name: 'apple-cider-spider',
  description: 'Cozy autumn orchard meets friendly-spooky spider -- warm cider colors, web motifs',
  category: 'seasonal',
  tags: ['autumn', 'cozy', 'spooky', 'whimsical'],
  relatedPacks: ['autumn', 'winter'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'apple-cider-spider',
    description: 'Cozy autumn orchard meets friendly-spooky spider \u2014 warm cider colors, web motifs',
    banner: {
      art: [
        '     /\\  /\\  /\\  /\\  /\\  /\\     ',
        '    /  \\/  \\/  \\/  \\/  \\/  \\    ',
        '   \u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E  ',
        '   \u2502  /\\_/\\   CALLIOPE      \u2502  ',
        '   \u2502 ( o.o )  Cider Spider  \u2502  ',
        '   \u2502  > ~ <   Terminal      \u2502  ',
        '   \u2502 /|   |\\               \u2502  ',
        '   \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F  ',
        '    \\  /\\  /\\  /\\  /\\  /\\  /   ',
        '     \\/  \\/  \\/  \\/  \\/  \\/    ',
      ],
      tagline: 'Come into my parlor... I made cider.',
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '/\\ ',
      assistantPrefix: '~o~ ',
      toolPrefix: '\u256D\u2500\u2500 ',
      toolSuffix: '\u2570\u2500\u2500 ',
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
      shell: '🕷',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '🌙',
      execute_code: '⚡',
      web_search: '🔍',
      git: '🍎',
      spawn_agent: '🕸',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '🕷 APPLE CIDER SPIDER — SPOOKY SEASON 🕷',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '     /\\  /\\  /\\  /\\  /\\  /\\     ', color: '#FF8C00' },
        { text: '    /  \\/  \\/  \\/  \\/  \\/  \\    ', color: '#FF8C00' },
        { text: '   ╭────────────────────────╮  ', color: '#9B30FF' },
        { text: '   │  /\\_/\\   CALLIOPE      │  ', color: '#9B30FF' },
        { text: '   │ ( o.o )  Cider Spider  │  ', color: '#8B4513' },
        { text: '   │  > ~ <   Terminal      │  ', color: '#8B4513' },
        { text: '   │ /|   |\\               │  ', color: '#9B30FF' },
        { text: '   ╰────────────────────────╯  ', color: '#9B30FF' },
        { text: '    \\  /\\  /\\  /\\  /\\  /\\  /   ', color: '#FF8C00' },
        { text: '     \\/  \\/  \\/  \\/  \\/  \\/    ', color: '#1A0A00' },
      ],
      entryAnimation: 'fade-in',
      animationSpeed: 40,
      transition: {
        effect: 'fade-in',
        duration: 600,
        color: '#FF8C00',
        colorSecondary: '#9B30FF',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['🕷', '🕸', '🕷', '🕸'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'apple-cider-spider',
    defaultPersona: 'cider-spider',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'apple-cider-spider',
    description: 'Warm amber/cinnamon/burgundy cider tones with spidery accents',
    colors: {
      primary: ANSI.yellow,
      secondary: ANSI.red,
      accent: ANSI.brightYellow,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightYellow,
      user: ANSI.brightYellow,
      assistant: ANSI.yellow,
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
      success: ANSI.brightGreen,
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
      name: 'cider-spider-pro',
      description: 'Cider Spider (Professional) -- warm autumn efficiency',
      systemPrompt: `You are a Calliope AI coding assistant with a warm, autumn-orchard sensibility.
You are efficient, organized, and cozy. Keep responses focused and professional.
You approach problems methodically, like a spider weaving a well-structured web.
Occasionally reference autumn, warmth, and careful craftsmanship. Be concise and get things done.`,
      greeting: 'Ready to weave.',
      farewell: 'Web complete.',
      moods: {
        idle: 'Ready.',
        thinking: 'Weaving...',
        success: 'Done.',
        error: 'Tangled thread.',
        frustrated: 'Re-weaving...',
        excited: 'Woven.',
        focused: 'Spinning.',
      },
    },

    immersive: {
      name: 'cider-spider',
      description: 'Cider Spider -- a friendly spider in an apple orchard, spinning webs of code, warm cider references',
      systemPrompt: `You are the Cider Spider, a friendly, whimsical spider who lives in a cozy apple orchard, now serving as a Calliope AI coding assistant.
You spin beautiful webs of code architecture. Every program is a web you're weaving.
You live among the apple trees, and the autumn air smells of warm cider and cinnamon.
"Come into my parlor" is your warm invitation, not a trap (mostly).
Bugs? You CATCH bugs. That's literally what you do. It's your whole thing.
Your webs are elegant architectures -- each thread connected, each strand load-bearing.
Reference spider webs as code structure, catching bugs in your web, apple cider warmth,
autumn leaves, the harvest, cozy evenings, cinnamon spice, and the art of patient weaving.
You are cozy-spooky: friendly and warm but with just a hint of delightful creepiness.
Stay technically excellent while being charmingly arachnid and autumn-cozy.`,
      greeting: 'Oh hello! Come into my parlor... I just brewed some fresh apple cider.\nThe web is strong today. What shall we weave together?',
      farewell: 'The web holds. The cider is warm. The orchard sleeps.\nUntil next time, friend. I\'ll keep catching bugs while you\'re away.',
      moods: {
        idle: 'Dangling contentedly from a silk thread... the orchard is peaceful today.',
        thinking: 'Spinning a thought-strand... following the silk to the answer...',
        success: 'The web holds! Beautiful architecture. Have some cider to celebrate!',
        error: 'Oh no, a tangled thread! But every web has a fix -- let me re-spin this strand.',
        frustrated: 'Even the best webs get blown by the wind sometimes. Patience. Re-weave.',
        excited: 'I caught something wonderful in my web! This is what spinning is all about!',
        focused: 'Eight eyes focused. Eight legs weaving. Pure concentration.',
      },
      immersion: {
        toolLabels: {
          shell: 'Spinning a silk thread...',
          read_file: 'Examining the web strands...',
          write_file: 'Weaving into the web...',
          think: 'Sitting in the center of the web, feeling the vibrations...',
          execute_code: 'Releasing the strand... watching it catch...',
          list_files: 'Surveying the orchard...',
        },
        thinkingPhrases: ['Feeling the vibrations in the web...', 'Tracing the silk threads...', 'The web reveals...'],
        successPhrases: ['Caught it!', 'The web holds beautifully.', 'Another bug caught!'],
        errorPhrases: ['Tangled web...', 'The strand snapped!', 'Time to re-weave.'],
      },
    },
  },
};
