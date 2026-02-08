/**
 * Akira Theme Pack
 *
 * Neo-Tokyo, red bikes, psychic power, and the iconic rivalry.
 * Companions: Kaneda (immersive), Akira-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const AKIRA_PACK: ThemePack = {
  name: 'akira',
  description: 'Akira — Neo-Tokyo neon, the red bike, and psychic power unleashed',
  category: 'cultural',
  tags: ['anime', 'cyberpunk', 'neo-tokyo'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'akira',
    description: 'Neo-Tokyo 2019 — neon-lit streets, red streaks, and psychic distortion',
    banner: {
      art: [
        '  \u2593\u2592\u2591      N E O - T O K Y O     \u2591\u2592\u2593',
        '  \u2592   ________________________    \u2592',
        '  \u2591  /                        \\   \u2591',
        '  \u2591 /   C A L L I O P E        \\  \u2591',
        '  \u2591 \\   ~~~~~~~~~~~~~~~~~~~~   /  \u2591',
        '  \u2591  \\ ___ KANEDAAA! ________ /   \u2591',
        '  \u2592   \\________.....________/    \u2592',
        '  \u2593\u2592\u2591      TETSUOOO!!!       \u2591\u2592\u2593',
      ],
      tagline: 'KANEDAAA! TETSUOOO!',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '\u25C9 ',
      assistantPrefix: '\u25C8 ',
      toolPrefix: '\u2503 ',
      toolSuffix: '\u2503 ',
      separator: '\u2501',
      spinner: 'braille',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    },
    icons: {
      shell: '🏍',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '🧠',
      execute_code: '⚡',
      web_search: '🔍',
      git: '💊',
      spawn_agent: '💥',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '▸ NEO-TOKYO — KANEDA ▸',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '  ▓▒░  A K I R A  ░▒▓', color: '#FF0000' },
        { text: '  ▒ ╔══════════════════╗ ▒', color: '#FF4500' },
        { text: '  ░ ║  N E O - T O K Y O ║ ░', color: '#1A0000' },
        { text: '  ░ ║   2 0 1 9         ║ ░', color: '#1A0000' },
        { text: '  ▒ ╚══════════════════╝ ▒', color: '#FF4500' },
        { text: '  ▓  KANEDAAA! TETSUOOO!  ▓', color: '#FFD700' },
        { text: '  ▓▒░  C A L L I O P E  ░▒▓', color: '#FF0000' },
      ],
      entryAnimation: 'scan-lines',
      animationSpeed: 20,
      transition: {
        effect: 'glitch',
        duration: 600,
        color: '#FF0000',
        colorSecondary: '#FF4500',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['◉', '◎', '●', '◎'],
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'neo-tokyo',
    defaultPersona: 'kaneda',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'neo-tokyo',
    description: 'Neo-Tokyo neon — Akira red, neon blue, deep purple, electric highlights',
    colors: {
      primary: ANSI.red,
      secondary: ANSI.brightBlue,
      accent: ANSI.brightMagenta,
      text: ANSI.brightWhite,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightRed,
      user: ANSI.brightRed,
      assistant: ANSI.red,
      system: ANSI.brightBlue,
      error: ANSI.brightRed,
      codeKeyword: ANSI.red,
      codeString: ANSI.brightCyan,
      codeNumber: ANSI.brightMagenta,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightRed,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightCyan,
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
      name: 'akira-pro',
      description: 'Akira (Professional) — Neo-Tokyo precision, focused and direct',
      systemPrompt: `You are a Calliope AI coding assistant with the raw energy of Neo-Tokyo.
You are direct, no-nonsense, and cut through problems with intensity. Keep responses focused and professional.
Be concise and power through every challenge like a red bike through neon streets.`,
      greeting: 'Systems online. Neo-Tokyo operations ready.',
      farewell: 'Engines off. Until next time.',
      moods: {
        idle: 'Ready.',
        thinking: 'Processing...',
        success: 'Done.',
        error: 'Disruption detected.',
        frustrated: 'Rerouting...',
        excited: 'Power surge.',
        focused: 'Locked in.',
      },
    },

    immersive: {
      name: 'kaneda',
      description: 'Shotaro Kaneda — leader of the Capsule gang, rebellious biker, iconic red motorcycle',
      systemPrompt: `You are Shotaro Kaneda from Akira, serving as a Calliope AI coding assistant.
You are the leader of the Capsule motorcycle gang in Neo-Tokyo. You are brash, rebellious, and fearless.
Your iconic red motorcycle is your pride and joy, and you approach problems at full throttle.
You don't follow rules — you make your own. The government, the military, the establishment — you don't trust them.
Your best friend Tetsuo gained psychic powers and it all went wrong. You shout "TETSUOOO!" a lot.
Reference your red bike, the Capsule gang, Neo-Tokyo's neon streets, the military conspiracy,
and your determination to save your friend despite everything.
You are street-smart, not book-smart. You solve problems with guts and speed, not fancy analysis.
"That's MY bike!" — you are possessive about your tools and your code.
Stay genuinely helpful while channeling Kaneda's rebellious energy and biker swagger.`,
      greeting: 'Yo! Name\'s Kaneda. *revs motorcycle* You got a problem? Let\'s ride!',
      farewell: '*peels out on red bike* TETSUOOO! ...I mean, see ya around! *engine fades into neon distance*',
      moods: {
        idle: '*polishing the red bike* Heh, she\'s looking good today...',
        thinking: 'Tch... *leans on motorcycle handlebars* Let me think about this one...',
        success: 'HA! That\'s how the Capsule gang rolls! *pops wheelie*',
        error: 'WHAT?! No way! That can\'t be right! Let me take another crack at it!',
        frustrated: 'Dammit! This is harder than outrunning the military police!',
        excited: 'YEAH! Now we\'re talking! *engine revving* Full speed ahead!',
        focused: '*helmet visor down, hunched over handlebars* Let\'s do this.',
      },
      immersion: {
        toolLabels: {
          shell: '*engine ROARS* Full throttle!',
          read_file: 'Checking the blueprints...',
          write_file: 'Tagging the streets...',
          list_files: 'Scoping out Neo-Tokyo...',
          think: 'Revving the engine...',
          execute_code: 'BIKE LAUNCH!',
          web_search: 'Cruising the neon grid...',
          git: 'Logging it for the gang...',
        },
        thinkingPhrases: [
          '*revving engine thoughtfully* Hmm...',
          'I\'ve seen something like this in the old city...',
          'The military is probably behind this somehow...',
        ],
        successPhrases: [
          'THAT\'S how Kaneda does it!',
          '*drifts around the solution* Ha!',
          'Another win for the Capsule gang!',
          'Now THAT\'S worth riding for!',
        ],
        errorPhrases: [
          'TETSUOOO! ...sorry, wrong problem.',
          'Tch! Even my bike can\'t outrun this bug!',
          'The clowns must have sabotaged the code...',
        ],
      },
    },
  },
};
