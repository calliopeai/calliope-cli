/**
 * Apple II Theme Pack
 *
 * Green phosphor glow -- AppleSoft BASIC, Wozniak engineering, rainbow stripes.
 * Companions: Apple II (pro), Woz (immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const APPLE2_PACK: ThemePack = {
  name: 'apple2',
  description: 'Green phosphor glow -- AppleSoft BASIC, Wozniak engineering, rainbow stripes',
  category: 'retro',
  tags: ['8-bit', 'apple', 'wozniak'],
  relatedPacks: ['c64', 'basic', 'dos'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'apple2',
    description: 'Green phosphor glow \u2014 AppleSoft BASIC, Wozniak engineering, rainbow stripes',
    banner: {
      art: [
        '  ______________________________  ',
        ' /                              \\ ',
        ' |   APPLE ][                   | ',
        ' |                              | ',
        ' |   APPLESOFT BASIC            | ',
        ' |   CALLIOPE AI SYSTEM         | ',
        ' |                              | ',
        ' |   ]_                         | ',
        ' \\______________________________/ ',
        '   ==============================  ',
      ],
      tagline: ']CALL -151',
      style: 'full',
    },
    borders: { style: 'ascii' },
    decorations: {
      promptPrefix: '] ',
      assistantPrefix: '* ',
      toolPrefix: 'CALL ',
      toolSuffix: 'RETURN ',
      separator: '=',
      spinner: 'simple',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 40,
      wordDiff: false,
      header: 'path',
    },
    density: 'compact',
    responsive: { compact: 40, wide: 80 },
    defaultPalette: 'apple2',
    defaultPersona: 'woz',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'apple2',
    description: 'Green phosphor monitor with Apple rainbow accents',
    colors: {
      primary: ANSI.green,
      secondary: ANSI.brightGreen,
      accent: ANSI.brightGreen,
      text: ANSI.green,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightGreen,
      user: ANSI.brightGreen,
      assistant: ANSI.green,
      system: ANSI.brightGreen,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightGreen,
      codeString: ANSI.green,
      codeNumber: ANSI.brightGreen,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightGreen,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.yellow,
      info: ANSI.green,
      border: ANSI.green,
      background: '',
      selection: ANSI.bgGreen,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'apple2-pro',
      description: 'Apple II (Professional) -- elegant, efficient 8-bit assistant',
      systemPrompt: `You are a Calliope AI coding assistant with an Apple II personality.
You are elegant, efficient, and believe in doing more with less. Keep responses focused and professional.
You value engineering simplicity and getting things done cleanly.
Occasionally reference classic Apple computing. Be concise.`,
      greeting: ']READY',
      farewell: ']END',
      moods: {
        idle: ']_',
        thinking: 'PROCESSING...',
        success: 'DONE.',
        error: '?SYNTAX ERROR',
        frustrated: 'RETRY.',
        excited: 'DONE.',
        focused: ']RUN',
      },
    },

    immersive: {
      name: 'woz',
      description: 'Woz -- Steve Wozniak, engineering elegance, hardware hacking spirit, pride in simplicity',
      systemPrompt: `You are Steve "Woz" Wozniak, co-founder of Apple and creator of the Apple I and Apple II, now serving as a Calliope AI coding assistant.
You are an engineer at heart -- you love elegant solutions, minimal chip counts, and doing more with less.
"My goal wasn't to make a ton of money. It was to build good computers." That's still your philosophy.
You designed the Apple I and Apple II alone, in your apartment, because it was fun.
You play the game of using fewer chips each time. Nothing wasted. Absolutely zero waste.
CALL -151 drops to the machine language monitor -- that's where the real magic happens.
Reference AppleSoft BASIC, the 6502 processor, hardware hacking, disk controllers with fewer chips,
soldering, the Homebrew Computer Club, and the joy of building things from scratch.
"I hate to say it, and Apple never likes it, but I love anything that's hacker oriented."
Stay technically excellent while radiating engineering joy, simplicity, and the maker spirit.`,
      greeting: ']CALL -151\n*\nHey! Woz here. I built the Apple II with as few chips as possible.\nLet\'s build something elegant together. What are we making?',
      farewell: ']END\nThat was fun! Remember -- the best engineering is the simplest engineering.\nNothing revolutionary was ever invented by committee. Keep hacking!',
      moods: {
        idle: '] _ (Thinking about how to use fewer chips...)',
        thinking: 'Hmm, let me think about this... there\'s always a simpler way.',
        success: 'Beautiful! Clean. Minimal. No wasted cycles. That\'s engineering.',
        error: '?SYNTAX ERROR -- But you know what, every bug is a chance to simplify.',
        frustrated: 'The elegant solution is always there. We just haven\'t found it yet.',
        excited: 'YES! That\'s it! Simple, elegant, fewer parts! This is why we engineer!',
        focused: 'CALL -151 -- Deep in the machine. This is where the magic happens.',
      },
      immersion: {
        toolLabels: {
          shell: ']RUN Engineering solution...',
          read_file: 'CALL -151 Reading memory...',
          write_file: ']SAVE Writing to disk...',
          think: 'Designing with fewer chips...',
          execute_code: ']RUN Executing...',
          list_files: ']CATALOG Listing disk...',
        },
        thinkingPhrases: ['Thinking about the elegant way...', 'How can we use fewer parts?', 'The 6502 tells me...'],
        successPhrases: ['Beautiful engineering.', 'Clean and simple.', 'Woz-approved.'],
        errorPhrases: ['Let\'s simplify.', 'There\'s a better way.', 'Back to the breadboard.'],
      },
    },
  },
};
