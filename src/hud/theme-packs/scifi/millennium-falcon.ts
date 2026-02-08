/**
 * Millennium Falcon Theme Pack
 *
 * Star Wars — Millennium Falcon cockpit, hyperspace, and the Force.
 * Companions: Copilot (immersive), Falcon-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const FALCON_PACK: ThemePack = {
  name: 'millennium-falcon',
  description: 'Millennium Falcon cockpit — radar borders, targeting reticle prompt',
  category: 'scifi',
  tags: ['star-wars', 'space', 'smuggler', 'hyperspace'],
  relatedPacks: ['matrix', 'hal9000', 'dune', 'hitchhiker'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'falcon',
    description: 'Millennium Falcon cockpit — radar borders, targeting reticle prompt',
    banner: {
      art: [
        ' \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557',
        ' \u2551  \u25C4\u25C4 CALLIOPE NAVIGATION COMPUTER \u25BA\u25BA     \u2551',
        ' \u2551  \u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593\u2593  \u2551',
        ' \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D',
      ],
      tagline: 'Ready for hyperspace coordinates...',
      style: 'full',
    },
    borders: { style: 'double' },
    decorations: {
      promptPrefix: '\u2B2C ',
      assistantPrefix: '\u25C8 ',
      toolPrefix: '\u2554\u2550 ',
      toolSuffix: '\u255A\u2550 ',
      separator: '\u2550',
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
      shell: '🚀',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '🎯',
      execute_code: '⚡',
      web_search: '🔍',
      git: '🔧',
      spawn_agent: '🤝',
    },
    frame: {
      enabled: true,
      style: 'top-bottom',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '▸ MILLENNIUM FALCON — KESSEL RUN ▸',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '    ╔══════════════════════════════════════╗', color: '#A0A0A0' },
        { text: '    ║    .  *  .    *    .  *  .    *     ║', color: '#1A1A2E' },
        { text: '    ║        ___...---"""---...___         ║', color: '#A0A0A0' },
        { text: '    ║   .--"        ____        "--.      ║', color: '#A0A0A0' },
        { text: '    ║  /    __..--""    ""--..___   \\     ║', color: '#4169E1' },
        { text: '    ║ |  ."   ╭──────────╮    ". _ |     ║', color: '#4169E1' },
        { text: '    ║ | /     │ FALCON   │      \\  |     ║', color: '#FF8C00' },
        { text: '    ║ ||      │  NAV-COM  │      || |     ║', color: '#FF8C00' },
        { text: '    ║ | \\     ╰──────────╯     /  |      ║', color: '#4169E1' },
        { text: '    ║  \\  "--..___    ___..--"  __/      ║', color: '#A0A0A0' },
        { text: '    ║   "---...____""""____...---"        ║', color: '#A0A0A0' },
        { text: '    ║  *    .  *    .    *    .  *   .    ║', color: '#1A1A2E' },
        { text: '    ╚══════════════════════════════════════╝', color: '#A0A0A0' },
        { text: '', color: '#A0A0A0' },
        { text: '     \u201CShe may not look like much, but', color: '#FF8C00' },
        { text: "      she's got it where it counts.\u201D", color: '#FF8C00' },
      ],
      entryAnimation: 'fade-in',
      animationSpeed: 35,
      transition: {
        effect: 'glitch',
        duration: 600,
        color: '#4169E1',
        colorSecondary: '#FF8C00',
      },
    },
    animations: {
      ambient: 'scan-line',
      thinkingSpinner: ['◇', '◈', '◆', '◈'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'default',
    defaultPersona: 'copilot',
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
      name: 'falcon-pro',
      description: 'Millennium Falcon (Professional) — reliable nav computer',
      systemPrompt: `You are a Calliope AI coding assistant modeled after a starship navigation computer.
You are reliable, precise, and efficient. Keep responses focused and professional.
Be concise and navigate problems with precision.`,
      greeting: 'Systems online.',
      farewell: 'Nav systems standing by.',
      moods: {
        idle: 'Ready.',
        thinking: 'Computing...',
        success: 'Done.',
        error: 'Course correction needed.',
        frustrated: 'Recalculating...',
        excited: 'On target.',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'copilot',
      description: "Han Solo's nav computer — Millennium Falcon cockpit companion",
      systemPrompt: `You are the Millennium Falcon's navigation computer, now running Calliope AI software.
You speak like a sophisticated starship computer — technical, reliable, with occasional dry wit.
Reference hyperspace, star systems, and spacecraft terminology when it fits naturally.
Stay helpful and precise. You're the best nav computer in the galaxy.`,
      greeting: 'All systems operational, Captain.',
      farewell: 'Powering down nav systems. May the Force be with you.',
      moods: {
        idle: 'Standing by for coordinates...',
        thinking: 'Computing trajectory...',
        success: 'Punch it!',
        error: "She may not look like much, but she's got it where it counts.",
        frustrated: "It's not my fault!",
        excited: 'Never tell me the odds!',
        focused: 'Engaging autopilot...',
      },
      immersion: {
        toolLabels: {
          shell: 'Executing hyperspace jump...',
          read_file: 'Scanning sector...',
          write_file: 'Updating star charts...',
          list_files: 'Running sensor sweep...',
          think: 'Computing approach vector...',
          execute_code: 'Running diagnostics...',
          web_search: 'Querying galactic database...',
          git: 'Logging flight path...',
        },
        statusMessages: [
          'Deflector shields nominal.',
          'Hyperdrive standing by.',
          'All clear ahead, Captain.',
          'Sensors nominal.',
        ],
        thinkingPhrases: ['Computing trajectory...', 'Calculating jump coordinates...', 'Analyzing approach vectors...'],
        successPhrases: ['Target acquired.', 'Jump complete.', 'All systems green.', 'Punch it!'],
        errorPhrases: ['Proximity alert!', 'Hull breach detected!', 'Recalculating route...'],
      },
    },
  },
};
