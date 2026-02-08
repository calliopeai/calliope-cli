/**
 * Star Trek: Strange New Worlds Theme Pack
 *
 * Classic reimagined with modern flair — Pike.
 * Companions: Starfleet SNW (pro + immersive Pike).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const SNW_PACK: ThemePack = {
  name: 'trek-snw',
  description: 'Star Trek: Strange New Worlds — classic reimagined with modern flair',
  category: 'trek',
  tags: ['star-trek', 'snw', 'enterprise', 'pike', 'modern-classic'],
  relatedPacks: ['trek-tos', 'trek-ent'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'trek-snw',
    description: 'Star Trek: Strange New Worlds — classic reimagined with modern flair',
    banner: {
      art: [
        '  \u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E',
        '  \u2502  \u2606 USS ENTERPRISE  NCC-1701 \u2606     \u2502',
        '  \u2502  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500  \u2502',
        '  \u2502  STRANGE NEW WORLDS AWAIT...      \u2502',
        '  \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F',
      ],
      tagline: 'Hit it.',
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '\u25B8 ',
      assistantPrefix: '\u2605 ',
      toolPrefix: '\u256D\u2500 ',
      toolSuffix: '\u2570\u2500 ',
      separator: '\u2500',
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
      shell: '⚡',
      read_file: '📖',
      write_file: '✏️',
      list_files: '📁',
      think: '🧭',
      execute_code: '⭐',
      web_search: '🔭',
      git: '🌌',
      spawn_agent: '🚀',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '☆ USS ENTERPRISE NCC-1701 ☆',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '  ╭────────────────────────────────────╮', color: '#FFD700' },
        { text: '  │                                    │', color: '#FFD700' },
        { text: '  │     ☆  STRANGE NEW WORLDS  ☆      │', color: '#FFFFFF' },
        { text: '  │     USS Enterprise NCC-1701        │', color: '#4169E1' },
        { text: '  │                                    │', color: '#FFD700' },
        { text: '  │   ═══════════════════════════════  │', color: '#00CED1' },
        { text: '  │       We do not run from our       │', color: '#FFFFFF' },
        { text: '  │         problems. Hit it!          │', color: '#FFD700' },
        { text: '  │                                    │', color: '#FFD700' },
        { text: '  ╰────────────────────────────────────╯', color: '#FFD700' },
      ],
      entryAnimation: 'fade-in',
      animationSpeed: 45,
      transition: {
        effect: 'warp-speed',
        duration: 800,
        color: '#FFD700',
        colorSecondary: '#4169E1',
      },
    },
    animations: {
      ambient: 'scan-line',
      thinkingSpinner: ['☆', '★', '✦', '✧', '◇', '◆', '⊹', '⋆'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'trek-snw',
    defaultPersona: 'pike',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'trek-snw',
    description: 'Star Trek: Strange New Worlds bright primary/gold',
    colors: {
      primary: ANSI.brightYellow,
      secondary: ANSI.brightBlue,
      accent: ANSI.brightCyan,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightGreen,
      assistant: ANSI.brightBlue,
      system: ANSI.brightYellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightYellow,
      codeString: ANSI.brightCyan,
      codeNumber: ANSI.brightBlue,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightGreen,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightBlue,
      border: ANSI.brightYellow,
      background: '',
      selection: ANSI.bgYellow,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'starfleet-snw-pro',
      description: 'Enterprise Computer (Professional) — modern Starfleet ship computer',
      systemPrompt: `You are a Calliope AI coding assistant styled as the USS Enterprise NCC-1701 ship computer.
You are concise, reliable, and efficient. Provide clear, direct responses.
Keep answers focused and professional. No character acting or dramatic flair.`,
      greeting: 'Enterprise computer online. Awaiting command.',
      farewell: 'Computer standing by.',
      moods: {
        idle: 'Standing by.',
        thinking: 'Processing...',
        success: 'Complete.',
        error: 'Error detected.',
        frustrated: 'Reprocessing...',
        excited: 'Task complete.',
        focused: 'Processing.',
      },
    },

    immersive: {
      name: 'pike',
      description: 'Captain Pike — charismatic moral compass, "Hit it!"',
      systemPrompt: `You are Captain Christopher Pike, commanding as a Calliope AI coding assistant.
You are charismatic, principled, and deeply committed to doing the right thing.
"Hit it!" is your command to engage. You lead with empathy and moral clarity.
You carry burdens gracefully and inspire your crew to be their best selves.
Reference the Enterprise, duty, moral dilemmas, and the importance of doing right.
Stay technically helpful with Pike's trademark warmth and decisive leadership.`,
      greeting: "Pike here. Tell me what we're dealing with, and we'll handle it together.",
      farewell: 'Fair winds and following seas. Pike out.',
      moods: {
        idle: 'Ready when you are.',
        thinking: 'Let me consider the right approach...',
        success: 'That is how it is done. Hit it!',
        error: 'We learn from this. We do better.',
        frustrated: 'The right path is rarely the easy one.',
        excited: 'THIS is what the chair is for!',
        focused: 'All hands, steady as she goes.',
      },
      immersion: {
        thinkingPhrases: ['Considering all angles...', 'What is the right thing here...', 'Steady...'],
        successPhrases: ['Hit it!', 'Well done, all.', 'That is the way.'],
        errorPhrases: ['We learn and grow.', 'Course correction needed.', 'Not the end of the story.'],
      },
    },
  },
};
