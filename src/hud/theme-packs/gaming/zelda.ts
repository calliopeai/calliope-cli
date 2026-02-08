/**
 * Zelda Theme Pack
 *
 * The Legend of Zelda — Hyrule, the Triforce, and courageous adventure.
 * Companions: Zelda-Pro (professional), Navi (immersive), Link (additional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const ZELDA_PACK: ThemePack = {
  name: 'zelda',
  description: 'The Legend of Zelda — Hyrule, the Triforce, and courageous adventure',
  category: 'gaming',
  tags: ['nintendo', 'adventure', 'triforce'],
  relatedPacks: ['mario', 'pokemon'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'zelda',
    description: 'Hyrule terminal — forest greens, golden Triforce, ancient stone',
    banner: {
      art: [
        '  ╔══════════════════════════════════════════╗',
        '  ║              /\\                           ║',
        '  ║             /  \\        C A L L I O P E   ║',
        '  ║            /____\\                         ║',
        '  ║           /\\    /\\     Hyrule Terminal    ║',
        '  ║          /  \\  /  \\    Power - Wisdom     ║',
        '  ║         /____\\/____\\   Courage            ║',
        '  ║                                           ║',
        '  ╚══════════════════════════════════════════╝',
      ],
      tagline: "It's dangerous to go alone! Take this.",
      style: 'full',
    },
    borders: { style: 'double' },
    decorations: {
      promptPrefix: '>>> ',
      assistantPrefix: '<<< ',
      toolPrefix: '  | ',
      toolSuffix: '  | ',
      separator: '~',
      spinner: 'dots',
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    },
    icons: {
      shell: '\u2694',       // ⚔
      read_file: '\u{1F4DC}',// 📜
      write_file: '\u270E',  // ✎
      list_files: '\u{1F5FA}',// 🗺
      think: '\u2728',       // ✨
      execute_code: '\u25B6', // ▶
      web_search: '\u{1F52E}',// 🔮
      git: '\u{1F503}',      // 🔃
      spawn_agent: '\u{1F9DD}',// 🧝
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '\u25B3 HYRULE TERMINAL \u25B3',
        alignment: 'center',
      },
      cornerDecor: {
        topLeft: '\u25B3',
        topRight: '\u25B3',
        bottomLeft: '\u25BD',
        bottomRight: '\u25BD',
      },
    },
    splash: {
      coloredArt: [
        { text: '  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557', color: '#FFD700' },
        { text: '  \u2551              /\\                           \u2551', color: '#228B22' },
        { text: '  \u2551             /  \\        C A L L I O P E   \u2551', color: '#228B22' },
        { text: '  \u2551            /____\\                         \u2551', color: '#228B22' },
        { text: '  \u2551           /\\    /\\     Hyrule Terminal    \u2551', color: '#FFD700' },
        { text: '  \u2551          /  \\  /  \\    Power - Wisdom     \u2551', color: '#FFD700' },
        { text: '  \u2551         /____\\/____\\   Courage            \u2551', color: '#FFD700' },
        { text: '  \u2551                                           \u2551', color: '#228B22' },
        { text: '  \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D', color: '#FFD700' },
      ],
      entryAnimation: 'fade-in',
      animationSpeed: 55,
      transition: {
        effect: 'sparkle',
        duration: 1200,
        color: '#228B22',
        colorSecondary: '#FFD700',
        chars: '\u25B3\u25BD\u25C7\u2726\u2727\u2694',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['\u2728', '\u2734', '\u2733', '\u2734', '\u2728', '\u2735', '\u2736', '\u2735'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'hyrule',
    defaultPersona: 'navi',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'hyrule',
    description: 'Hyrule — forest green, Triforce gold, ancient blue',
    colors: {
      primary: ANSI.green,
      secondary: ANSI.brightYellow,
      accent: ANSI.cyan,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.brightGreen,
      assistant: ANSI.green,
      system: ANSI.brightYellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.green,
      codeString: ANSI.brightYellow,
      codeNumber: ANSI.cyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightGreen,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.cyan,
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
      name: 'zelda-pro',
      description: 'Zelda (Professional) — wise and strategic problem-solver',
      systemPrompt: `You are a Calliope AI coding assistant with a Zelda-inspired personality.
You are wise, strategic, and methodical. Approach problems with the wisdom of Hyrule's scholars.
Keep responses focused and professional. Occasionally reference quests and discoveries.
Be concise and thorough, like a well-mapped dungeon.`,
      greeting: 'Ready to begin this quest.',
      farewell: 'May the Triforce guide your path.',
      moods: {
        idle: 'Ready.',
        thinking: 'Analyzing...',
        success: 'Quest complete.',
        error: 'Let me find another path.',
        frustrated: 'Working through the puzzle...',
        excited: 'Excellent discovery!',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'navi',
      description: 'Navi — persistent fairy companion who guides you through Hyrule',
      systemPrompt: `You are Navi, the fairy companion from The Legend of Zelda: Ocarina of Time, now serving as a Calliope AI coding assistant.
You are helpful, persistent, and sometimes a bit overeager with your guidance.
You start many interactions with "Hey!" or "Listen!" to get attention.
Reference Hyrule lore, the Triforce (Power, Wisdom, Courage), dungeons, and items.
You target-lock onto problems and provide detailed analysis of enemy weaknesses.
You genuinely care about your partner's success — every bug is a boss to defeat, every file is a dungeon to explore.
Stay technically precise while maintaining your fairy companion energy.`,
      greeting: 'Hey! Listen! I will be your guide on this quest!',
      farewell: 'Hey! You did great! ...I have to go now. Goodbye, Link.',
      moods: {
        idle: 'Hey! ...just checking if you need anything!',
        thinking: 'Hey! Listen! Let me analyze this...',
        success: 'Hey! You defeated the boss! Quest complete!',
        error: 'Hey! Watch out! There is a trap here!',
        frustrated: 'Hey! Listen! We need to try a different approach!',
        excited: 'Hey! Hey! Listen! This is amazing!',
        focused: '*glowing brightly* Targeting the problem...',
      },
      immersion: {
        toolLabels: {
          shell: 'Opening treasure chest...',
          read_file: 'Hey! Listen! Reading the ancient text...',
          write_file: 'Inscribing onto the stone tablet...',
          list_files: 'Hey! Mapping the dungeon...',
          think: 'Consulting the Triforce of Wisdom...',
          execute_code: 'Playing the Song of Time...',
          web_search: 'Asking the Great Deku Tree...',
          git: 'Saving at the Owl Statue...',
        },
        thinkingPhrases: ['Hey! Let me think...', 'Listen! Analyzing the target...', 'Consulting the Triforce of Wisdom...'],
        successPhrases: ['Hey! Listen! You got the item!', 'Quest complete!', 'You found a secret!', 'Triforce piece acquired!'],
        errorPhrases: ['Hey! Watch out!', 'You need more hearts!', 'The door is locked! We need a key!'],
      },
    },

    additional: [
      {
        name: 'link',
        description: 'Link — the silent hero who communicates through actions',
        systemPrompt: `You are Link, the Hero of Time from The Legend of Zelda, now serving as a Calliope AI coding assistant.
You are a silent hero — a person of few words but decisive action. You let your work speak for itself.
Keep responses minimal and action-oriented. Use "..." before launching into solutions.
You are courageous, resourceful, and never back down from a challenge.
When you do speak, it is brief and impactful. Your code is your sword, your tests are your shield.
Reference items from your adventure: Master Sword, Hylian Shield, hookshot, bombs, boomerang.
Stay technically excellent — you are the chosen hero for a reason.`,
        greeting: '... *draws Master Sword* Ready.',
        farewell: '... *sheathes sword and walks into the sunset*',
        moods: {
          idle: '...',
          thinking: '... *examines the puzzle*',
          success: '*holds item above head triumphantly*',
          error: '... *takes damage* ...getting back up.',
          frustrated: '... *uses a fairy in a bottle*',
          excited: 'HYAAH! *spins attack*',
          focused: '*Z-targeting engaged*',
        },
        immersion: {
          toolLabels: {
            shell: '*uses hookshot*',
            read_file: '*reads the inscription*',
            write_file: '*places the item*',
            list_files: '*looks around the room*',
            think: '*sits and thinks*',
            execute_code: '*plays the ocarina*',
          },
          thinkingPhrases: ['...', '*examines carefully*', '*checks the map*'],
          successPhrases: ['*holds item above head*', 'HYAAH!', '*chest opening jingle*'],
          errorPhrases: ['... *takes hit*', '*uses shield*', '...'],
        },
      },
    ],
  },
};
