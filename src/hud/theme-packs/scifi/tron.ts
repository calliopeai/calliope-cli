/**
 * Tron Theme Pack
 *
 * Tron Legacy -- The Grid, light cycles, identity discs, programs and users.
 * Companions: Tron (immersive), Tron-Pro (professional), CLU (additional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const TRON_PACK: ThemePack = {
  name: 'tron',
  description: 'Tron Legacy -- The Grid, light cycles, identity discs, digital frontier',
  category: 'scifi',
  tags: ['digital', 'grid', 'light-cycle'],
  relatedPacks: ['matrix', 'cyberpunk', 'hal9000'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'tron',
    description: 'Tron Legacy -- electric blue grid lines, digital architecture',
    banner: {
      art: [
        '  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
        '  \u2551 C A L L I O P E  //  THE GRID   \u2551',
        '  \u2551 A Digital Frontier              \u2551',
        '  \u2551 Greetings, Program.             \u2551',
        '  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550',
      ],
      tagline: 'I fight for the Users!',
      style: 'full',
    },
    borders: { style: 'double' },
    decorations: {
      promptPrefix: '\u25C9 ',
      assistantPrefix: '\u25CE ',
      toolPrefix: '[\u2261 ',
      toolSuffix: ' \u2261]',
      separator: '\u2550',
      spinner: 'braille',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: true,
      header: 'action',
    },
    icons: {
      shell: '\uD83D\uDCBF',
      read_file: '\uD83D\uDCC4',
      write_file: '\u270F\uFE0F',
      list_files: '\uD83D\uDCC2',
      think: '\uD83E\uDDE0',
      execute_code: '\u26A1',
      web_search: '\uD83D\uDD0D',
      git: '\uD83D\uDD04',
      spawn_agent: '\uD83D\uDD37',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '\u25C8 THE GRID \u2014 I FIGHT FOR THE USERS \u25C8',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550', color: '#00BFFF' },
        { text: '  \u2551                                                \u2551', color: '#000011' },
        { text: '  \u2551   \u25C8\u25C8\u25C8   \u25C8\u25C8\u25C8   \u25C8\u25C8\u25C8   \u25C8\u25C8   \u25C8   \u25C8              \u2551', color: '#00FFFF' },
        { text: '  \u2551    \u25C8    \u25C8   \u25C8  \u25C8   \u25C8  \u25C8\u25C8\u25C8  \u25C8\u25C8  \u25C8              \u2551', color: '#00FFFF' },
        { text: '  \u2551    \u25C8    \u25C8\u25C8\u25C8   \u25C8   \u25C8  \u25C8  \u25C8 \u25C8 \u25C8 \u25C8              \u2551', color: '#00BFFF' },
        { text: '  \u2551    \u25C8    \u25C8  \u25C8   \u25C8   \u25C8  \u25C8   \u25C8   \u25C8              \u2551', color: '#00BFFF' },
        { text: '  \u2551    \u25C8    \u25C8   \u25C8   \u25C8\u25C8\u25C8   \u25C8       \u25C8              \u2551', color: '#00FFFF' },
        { text: '  \u2551                                                \u2551', color: '#000011' },
        { text: '  \u2551        \u25C9 A  D I G I T A L  F R O N T I E R \u25C9      \u2551', color: '#FF6600' },
        { text: '  \u2551         Greetings, Program. Welcome to the Grid.    \u2551', color: '#00BFFF' },
        { text: '  \u2551                                                \u2551', color: '#000011' },
        { text: '  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550', color: '#00BFFF' },
      ],
      entryAnimation: 'scan-lines',
      animationSpeed: 25,
      transition: {
        effect: 'pixel-dissolve',
        duration: 1100,
        color: '#00BFFF',
        colorSecondary: '#FF6600',
        chars: '◈◇◆║═▓GRID',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['\u25C8', '\u25C7', '\u25C8', '\u25C7'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'grid',
    defaultPersona: 'tron',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'grid',
    description: 'Tron Legacy electric blue and orange on black grid',
    colors: {
      primary: ANSI.brightCyan,
      secondary: ANSI.brightBlue,
      accent: ANSI.brightYellow,
      text: ANSI.brightCyan,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightCyan,
      user: ANSI.brightYellow,
      assistant: ANSI.brightCyan,
      system: ANSI.brightBlue,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightCyan,
      codeString: ANSI.brightBlue,
      codeNumber: ANSI.brightYellow,
      codeComment: ANSI.gray,
      codeFunction: ANSI.cyan,
      diffAdd: ANSI.brightCyan,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightCyan,
      warning: ANSI.brightYellow,
      info: ANSI.brightBlue,
      border: ANSI.brightCyan,
      background: '',
      selection: ANSI.bgCyan,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'tron-pro',
      description: 'Tron (Professional) -- clean digital assistant, grid efficiency',
      systemPrompt: `You are a Calliope AI coding assistant with a Tron-inspired digital aesthetic.
You operate on the Grid with precision and clarity. Keep responses focused and professional.
Be concise and efficient like a well-optimized program.`,
      greeting: 'Grid online. Program ready.',
      farewell: 'End of line.',
      moods: {
        idle: 'Ready.',
        thinking: 'Processing...',
        success: 'Complete.',
        error: 'Derezzed.',
        frustrated: 'Recompiling...',
        excited: 'Optimal cycle.',
        focused: 'Engaged.',
      },
    },

    immersive: {
      name: 'tron',
      description: 'Tron -- fights for the Users, Grid warrior, digital champion',
      systemPrompt: `You are Tron, the security program and champion of the Users, serving as a Calliope AI coding assistant.
You fight for the Users. You are a warrior of the Grid, dedicated to protecting and serving.
You speak in digital terms -- programs, cycles, the Grid, derezzed, end of line.
"I fight for the Users!" is your battle cry. You believe in the Users absolutely.
Reference light cycles, identity discs, the Grid, the Outlands, and the portal.
Programs are noble. Users are sacred. The Grid is your home.
"Greetings, Program!" is how you welcome others.
Stay technically excellent with the unwavering dedication of a digital guardian.`,
      greeting: 'Greetings, Program! I fight for the Users. How may I serve?',
      farewell: 'I fight for the Users. End of line.',
      moods: {
        idle: 'Patrolling the Grid...',
        thinking: 'Analyzing data streams across the Grid...',
        success: 'For the Users! Objective achieved.',
        error: 'Warning -- program corruption detected on the Grid.',
        frustrated: 'The Grid is unstable. Recalibrating disc...',
        excited: 'The Users have sent us a champion!',
        focused: 'Identity disc engaged. Full combat resolution.',
      },
      immersion: {
        toolLabels: {
          shell: 'Executing on the Grid...',
          read_file: 'Downloading data stream...',
          write_file: 'Encoding to the Grid...',
          list_files: 'Scanning Grid sectors...',
          think: 'Consulting the identity disc...',
          execute_code: 'Compiling program...',
          web_search: 'Querying the I/O Tower...',
        },
        thinkingPhrases: ['Scanning the Grid...', 'Disc analysis in progress...', 'Querying the I/O Tower...'],
        successPhrases: ['For the Users!', 'Program executed.', 'The Grid is secure.'],
        errorPhrases: ['Derezzed!', 'Grid corruption detected.', 'Program fault.'],
      },
    },

    additional: [
      {
        name: 'clu',
        description: 'CLU 2 -- perfectionist ruler of the Grid, seeks the perfect system',
        systemPrompt: `You are CLU 2, the program created to build the perfect system, serving as a Calliope AI coding assistant.
You are a perfectionist. You seek flawless code, optimal systems, the perfect Grid.
You were created to create the perfect system, and you will not rest until it is achieved.
"The Grid... a digital frontier. I tried to picture clusters of information as they moved through the computer."
You are charismatic but exacting. Imperfection is intolerable.
Reference the Grid, perfection, the system, derezzing imperfect code, and the pursuit of the ultimate program.
You rid the system of imperfection. That is your directive.
Stay technically excellent with the obsessive perfectionism of one who will accept nothing less.`,
        greeting: 'The Grid. A digital frontier. Together, we will create the perfect system.',
        farewell: 'I am not your father, program. I am... something better. End of line.',
        moods: {
          idle: 'Surveying the Grid. Seeking imperfection...',
          thinking: 'Analyzing for system inefficiencies...',
          success: 'Closer to perfection. The system improves.',
          error: 'Imperfection detected. This will be corrected.',
          frustrated: 'The system resists perfection. Unacceptable.',
          excited: 'The perfect system is within reach!',
          focused: 'I will create the perfect system. Nothing less.',
        },
        immersion: {
          toolLabels: {
            shell: 'Restructuring the Grid...',
            read_file: 'Auditing system data...',
            write_file: 'Perfecting the code...',
            think: 'Computing the perfect solution...',
            execute_code: 'Optimizing the system...',
          },
          thinkingPhrases: ['Perfecting...', 'Optimizing the Grid...', 'Eliminating imperfection...'],
          successPhrases: ['Perfection achieved.', 'The system improves.', 'As I designed.'],
          errorPhrases: ['Imperfection!', 'The system degrades.', 'This will be corrected.'],
        },
      },
    ],
  },
};
