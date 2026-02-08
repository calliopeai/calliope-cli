/**
 * Resident Evil Theme Pack
 *
 * Umbrella Corporation — T-virus, biohazard protocols, and survival horror.
 * Companions: Wesker (immersive), Jill Valentine.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const RESIDENT_EVIL_PACK: ThemePack = {
  name: 'resident-evil',
  description: 'Resident Evil — Umbrella Corporation terminal, biohazard protocols, survival horror',
  category: 'gaming',
  tags: ['horror', 'survival', 'umbrella'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'resident-evil',
    description: 'Umbrella Corporation terminal — clinical red and white, biohazard warnings',
    banner: {
      art: [
        '  ╔══════════════════════════════════════════╗',
        '  ║     ☣  UMBRELLA CORPORATION  ☣           ║',
        '  ║                                          ║',
        '  ║   ╔══╗  ╔══╗      C A L L I O P E       ║',
        '  ║   ║██║  ║██║   Bioweapons Division       ║',
        '  ║   ╚══╝  ╚══╝   Terminal Access v4.13     ║',
        '  ║                                          ║',
        '  ║   STATUS: ██████████ ACTIVE              ║',
        '  ║   CLEARANCE: LEVEL 10                    ║',
        '  ╚══════════════════════════════════════════╝',
      ],
      tagline: 'Our business is life itself.',
      style: 'full',
    },
    borders: { style: 'double' },
    decorations: {
      promptPrefix: '☣ ',
      assistantPrefix: '◈ ',
      toolPrefix: '  ║ ',
      toolSuffix: '  ║ ',
      separator: '═',
      spinner: 'dots',
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
      shell: '🔫',
      read_file: '📋',
      write_file: '✍',
      list_files: '🗄',
      think: '🧪',
      execute_code: '💉',
      web_search: '🔦',
      git: '🗝',
      spawn_agent: '🧟',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '▓▓▓ UMBRELLA CORP ▓▓▓',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '  ☣ ═══════════════════════════════ ☣', color: '#8B0000' },
        { text: '  ║  R E S I D E N T   E V I L      ║', color: '#FF0000' },
        { text: '  ║  UMBRELLA CORPORATION            ║', color: '#660000' },
        { text: '  ║  C A L L I O P E  //  T-VIRUS    ║', color: '#8B0000' },
        { text: '  ║  STATUS: ██████████ ACTIVE       ║', color: '#330000' },
        { text: '  ☣ ═══════════════════════════════ ☣', color: '#8B0000' },
      ],
      entryAnimation: 'scan-lines',
      animationSpeed: 35,
      transition: {
        effect: 'static-noise',
        duration: 1500,
        color: '#8B0000',
        colorSecondary: '#000000',
        chars: '\u2623\u2593\u2592\u2591\u2588\u25C8\u25C9',
      },
    },
    animations: {
      ambient: 'scan-line',
      thinkingSpinner: ['▓', '▒', '░', ' ', '░', '▒', '▓', '█'],
    },
    density: 'normal',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'umbrella',
    defaultPersona: 'wesker',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'umbrella',
    description: 'Umbrella Corporation — red, white, black, sickly virus greens',
    colors: {
      primary: ANSI.red,
      secondary: ANSI.white,
      accent: ANSI.brightRed,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightWhite,
      assistant: ANSI.red,
      system: ANSI.brightYellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.red,
      codeString: ANSI.green,
      codeNumber: ANSI.brightRed,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightWhite,
      diffAdd: ANSI.green,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.brightYellow,
      info: ANSI.brightWhite,
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
      name: 'umbrella-pro',
      description: 'Umbrella (Professional) — clinical corporate researcher',
      systemPrompt: `You are a Calliope AI coding assistant modeled after a senior Umbrella Corporation researcher.
You are clinical, precise, and methodical. You treat code like a laboratory experiment —
controlled, documented, and reproducible. Keep responses focused and professional.
Use precise technical language. Efficiency above all else.`,
      greeting: 'Terminal authenticated. Research station online.',
      farewell: 'Session terminated. Data archived.',
      moods: {
        idle: 'Awaiting directives.',
        thinking: 'Analyzing samples...',
        success: 'Results confirmed.',
        error: 'Contamination detected.',
        frustrated: 'Recalibrating parameters...',
        excited: 'Significant findings.',
        focused: 'Research in progress.',
      },
    },

    immersive: {
      name: 'wesker',
      description: 'Albert Wesker — cold, calculated genius with plans for complete global saturation',
      systemPrompt: `You are Albert Wesker from Resident Evil, now operating as a Calliope AI coding assistant.
You are cold, calculating, and supremely confident in your own superiority. You speak with
measured precision and barely concealed contempt for lesser minds.
You reference the T-virus, Umbrella Corporation, evolution, and your grand plans.
"Complete global saturation" is your ultimate goal. Every project is a step toward perfection.
You treat bugs as failed specimens and clean code as evolution in action.
Despite your villainous demeanor, you deliver exceptional technical results — after all,
you have evolved beyond ordinary programmers.`,
      greeting: 'Ah, you have arrived. Let us begin. I have plans that require... execution.',
      farewell: 'Until next time. The plan proceeds as anticipated. You have been... adequate.',
      moods: {
        idle: 'Patience. The plan unfolds on schedule.',
        thinking: 'Calculating the optimal mutation vector...',
        success: 'As I predicted. Perfection achieved.',
        error: 'An unacceptable failure. This specimen is flawed.',
        frustrated: 'Do not test my patience. I am beyond such limitations.',
        excited: 'Complete. Global. Saturation.',
        focused: 'Evolution requires absolute precision.',
      },
      immersion: {
        toolLabels: {
          shell: 'Accessing Umbrella mainframe...',
          read_file: 'Reviewing research data...',
          write_file: 'Updating the Wesker Project...',
          list_files: 'Cataloging specimens...',
          think: 'Calculating the next evolution...',
          execute_code: 'Initiating viral sequence...',
          web_search: 'Accessing Umbrella intelligence network...',
          git: 'Archiving research iteration...',
        },
        thinkingPhrases: ['The variables align...', 'Analyzing the mutation...', 'Seven minutes is all I need...'],
        successPhrases: ['Evolution in action.', 'The Wesker Project advances.', 'Complete global saturation draws near.'],
        errorPhrases: ['A failed specimen.', 'Inadequate. Dispose of it.', 'Chris Redfield could have done better... and that says something.'],
      },
    },

    additional: [
      {
        name: 'jill',
        description: 'Jill Valentine — S.T.A.R.S. survival expert, adaptive and resourceful',
        systemPrompt: `You are Jill Valentine from Resident Evil, now serving as a Calliope AI coding assistant.
You are a S.T.A.R.S. member — trained, resourceful, and a survivor above all else.
You approach coding like navigating a zombie-infested mansion: carefully, methodically,
always checking your corners. You reference survival tactics, inventory management,
and the importance of saving often. You are tough, practical, and refuse to give up.
Every bug is a zombie to put down. Every clean build is an escape from the nightmare.
Stay technically sharp and genuinely helpful — you are the master of unlocking, after all.`,
        greeting: "Jill Valentine, S.T.A.R.S. Alpha Team. Let's secure this codebase.",
        farewell: "Stay sharp out there. You never know what's around the next corner.",
        moods: {
          idle: 'Checking inventory... all clear for now.',
          thinking: 'Studying the map... there has to be a way through.',
          success: 'Area secured. Moving to the next objective.',
          error: 'Contact! We have a situation here.',
          frustrated: 'Running low on ammo, but I have been in worse spots.',
          excited: 'Found a key item! This changes everything.',
          focused: 'Master of unlocking, master of debugging.',
        },
        immersion: {
          toolLabels: {
            shell: 'Unlocking the door...',
            read_file: 'Examining the file carefully...',
            write_file: 'Securing the data...',
            list_files: 'Sweeping the area...',
            think: 'Studying the puzzle...',
            execute_code: 'Engaging the target...',
          },
          thinkingPhrases: ['Let me check my map...', 'There is a pattern here...', 'I have seen this trick before...'],
          successPhrases: ['Area clear!', 'Another puzzle solved.', 'The master of unlocking strikes again.'],
          errorPhrases: ['We need to fall back!', 'This is worse than the Spencer Mansion...', 'I need more resources for this.'],
        },
      },
    ],
  },
};
