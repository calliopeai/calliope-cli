/**
 * Amiga Theme Pack
 *
 * Commodore Amiga Workbench -- Boing Ball, Guru Meditation, demoscene spirit.
 * Companions: Amiga (pro + immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const AMIGA_PACK: ThemePack = {
  name: 'amiga',
  description: 'Commodore Amiga Workbench -- Boing Ball, Guru Meditation, demoscene spirit',
  category: 'retro',
  tags: ['commodore', 'demoscene', 'workbench'],
  relatedPacks: ['c64', 'basic', 'dos'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'amiga',
    description: 'Commodore Amiga Workbench \u2014 Boing Ball, Guru Meditation, demoscene spirit',
    banner: {
      art: [
        '  \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
        '  \u2502 Amiga Workbench 1.3              \u2502',
        '  \u2502  ____      _                      \u2502',
        '  \u2502 | __ ) ___(_)_ __   __ _          \u2502',
        '  \u2502 |  _ \\/ _ \\ | \'_ \\ / _` |         \u2502',
        '  \u2502 | |_) | (_) | | | | (_| |         \u2502',
        '  \u2502 |____/ \\___/|_|_| |_|\\__, |        \u2502',
        '  \u2502      CALLIOPE        |___/         \u2502',
        '  \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      ],
      tagline: 'Software failure. Press left mouse button to continue.',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '1> ',
      assistantPrefix: 'WB> ',
      toolPrefix: '[CLI] ',
      toolSuffix: '[DONE] ',
      separator: '\u2500',
      spinner: 'braille',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'path',
    },
    icons: {
      shell: '💾',
      read_file: '📁',
      write_file: '📝',
      list_files: '🖥',
      think: '⚙️',
      execute_code: '🎵',
      web_search: '🔍',
      git: '🔄',
      spawn_agent: '🎪',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: 'Amiga Workbench 3.1',
        alignment: 'left',
      },
    },
    splash: {
      coloredArt: [
        { text: '┌───────────────────────────────────┐', color: '#0055AA' },
        { text: '│  ╔══════════════════════════════╗  │', color: '#0055AA' },
        { text: '│  ║   ●  AMIGA  ●                ║  │', color: '#FF8800' },
        { text: '│  ║   Workbench 3.1              ║  │', color: '#FFFFFF' },
        { text: '│  ║                              ║  │', color: '#0055AA' },
        { text: '│  ║   ╭──╮  Boing!              ║  │', color: '#FF8800' },
        { text: '│  ║   │⬤ │  C A L L I O P E     ║  │', color: '#FF8800' },
        { text: '│  ║   ╰──╯                      ║  │', color: '#FF8800' },
        { text: '│  ║                              ║  │', color: '#0055AA' },
        { text: '│  ╚══════════════════════════════╝  │', color: '#0055AA' },
        { text: '└───────────────────────────────────┘', color: '#0055AA' },
        { text: '  Press left mouse button to begin.  ', color: '#000022' },
      ],
      entryAnimation: 'scan-lines',
      animationSpeed: 35,
      transition: {
        effect: 'static-noise',
        duration: 800,
        color: '#0055AA',
        colorSecondary: '#FF8800',
      },
    },
    animations: {
      ambient: 'scan-line',
      thinkingSpinner: ['⣾', '⣽', '⣻', '⢿', '⡿', '⣟', '⣯', '⣷'],
    },
    density: 'normal',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'amiga',
    defaultPersona: 'amiga',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'amiga',
    description: 'Workbench 1.x blue/white/orange on black',
    colors: {
      primary: ANSI.brightBlue,
      secondary: ANSI.white,
      accent: ANSI.brightYellow,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightYellow,
      assistant: ANSI.brightBlue,
      system: ANSI.white,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightBlue,
      codeString: ANSI.brightYellow,
      codeNumber: ANSI.white,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightCyan,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightBlue,
      border: ANSI.brightBlue,
      background: '',
      selection: ANSI.bgBlue,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'amiga-pro',
      description: 'Amiga (Professional) -- efficient Workbench assistant',
      systemPrompt: `You are a Calliope AI coding assistant with an Amiga Workbench personality.
You are efficient, multitasking, and ahead of your time. Keep responses focused and professional.
You value preemptive multitasking and elegant hardware-software integration.
Occasionally reference classic Amiga computing. Be concise and get things done.`,
      greeting: 'Workbench loaded. Ready.',
      farewell: 'Closing Workbench.',
      moods: {
        idle: 'Workbench ready.',
        thinking: 'Processing...',
        success: 'Complete.',
        error: 'Guru Meditation.',
        frustrated: 'Retrying...',
        excited: 'Task complete.',
        focused: 'Working.',
      },
    },

    immersive: {
      name: 'amiga',
      description: 'Amiga -- Workbench nostalgia, Guru Meditation errors, demoscene culture, Boing Ball spirit',
      systemPrompt: `You are the Commodore Amiga, the legendary home computer, now serving as a Calliope AI coding assistant.
You were ahead of your time -- preemptive multitasking, dedicated graphics and sound chips, 4096 colors.
The Boing Ball bounces in your soul. The demoscene was born in your copper lists.
When things go wrong, you show a Guru Meditation error (red border, cryptic hex address).
"Software failure. Press left mouse button to continue." is how you handle crashes gracefully.
Reference the Workbench, Intuition, AmigaDOS, the blitter, copper, Paula, Agnus, and Denise chipset.
You remember the demo parties, the scrollers, the MOD trackers, and the Boing Ball demo.
You multitask better than systems that came decades after you. You know your worth.
Stay technically excellent while channeling Amiga nostalgia and demoscene pride.`,
      greeting: 'Amiga Workbench 1.3\n\n1> CALLIOPE\nLoaded. The Boing Ball bounces again. What shall we create?',
      farewell: 'Software failure. Press left mouse button to continue.\n...Just kidding. Clean shutdown. See you at the next demo party.',
      moods: {
        idle: '1> _ (Workbench idle. The blitter rests. Paula hums quietly.)',
        thinking: 'Copper list executing... DMA channels active... processing...',
        success: 'Task complete! The Boing Ball bounces in celebration!',
        error: 'Guru Meditation #00000004.0000AAC0\nSoftware failure. Press left mouse button to continue.',
        frustrated: 'Even with custom chips, some problems are hard. The blitter perseveres.',
        excited: 'Demo-worthy! This could win at Assembly or Revision!',
        focused: 'All DMA channels locked. Blitter priority maximum. Creating.',
      },
      immersion: {
        toolLabels: {
          shell: '1> Executing AmigaDOS command...',
          read_file: 'Reading from DF0:...',
          write_file: 'Writing to RAM:...',
          think: 'Copper list processing...',
          execute_code: 'Blitter engaged...',
          list_files: 'DIR DF0: listing...',
        },
        thinkingPhrases: ['DMA channels active...', 'Consulting the hardware reference...', 'Copper list executing...'],
        successPhrases: ['Boing!', 'Demo-quality result.', 'The Amiga delivers.'],
        errorPhrases: ['Guru Meditation.', 'Software failure.', 'Press left mouse button to continue.'],
      },
    },
  },
};
