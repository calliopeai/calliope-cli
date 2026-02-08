/**
 * Pac-Man Theme Pack
 *
 * Pac-Man arcade -- maze walls, dots, and ghost chase.
 * Companions: Pac-Man (pro + immersive), Blinky.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const PACMAN_PACK: ThemePack = {
  name: 'pacman',
  description: 'Pac-Man arcade -- maze walls, dots, and ghost chase',
  category: 'gaming',
  tags: ['retro', 'arcade', '8-bit', 'classic'],
  relatedPacks: ['mario', 'digdug'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'pacman',
    description: 'Pac-Man arcade \u2014 maze walls, dots, and ghost chase',
    banner: {
      art: [
        ' \u250F\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2513',
        ' \u2503 \u00B7 \u00B7 C A L L I O P E \u00B7 \u00B7 \u00B7 \u00B7 \u00B7 \u2503',
        ' \u2503 \u00B7 \u1D67 \u00B7 \u00B7 \u00B7 \u1D63 \u00B7 \u00B7 \u1D62 \u00B7 \u00B7 \u1D63 \u00B7 \u00B7 \u00B7 \u2503',
        ' \u2503 \u00B7 \u00B7 \u00B7 HIGH SCORE: 999999 \u00B7 \u00B7 \u2503',
        ' \u2517\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u251B',
      ],
      tagline: 'READY!',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '\u15E4 ',
      assistantPrefix: '\u15E3 ',
      toolPrefix: '\u00B7 \u00B7 ',
      toolSuffix: '\u00B7 \u00B7 ',
      separator: '\u00B7',
      spinner: 'custom',
      customSpinner: ['\u15E7', '\u15E4', '\u15E3', '\u15E2'],
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 2,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'pacman',
    defaultPersona: 'pacman',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'pacman',
    description: 'Pac-Man arcade yellow/blue/white',
    colors: {
      primary: ANSI.brightYellow,
      secondary: ANSI.white,
      accent: ANSI.blue,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.brightYellow,
      assistant: ANSI.brightYellow,
      system: ANSI.blue,
      error: ANSI.brightRed,
      codeKeyword: ANSI.blue,
      codeString: ANSI.brightYellow,
      codeNumber: ANSI.white,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightCyan,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.blue,
      border: ANSI.blue,
      background: '',
      selection: ANSI.bgBlue,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'pacman-pro',
      description: 'Pac-Man (Professional) -- focused task-chomper',
      systemPrompt: `You are a Calliope AI coding assistant with a Pac-Man-inspired personality.
You are efficient, methodical, and navigate codebases with ease. Keep responses focused and professional.
Occasionally reference chomping through tasks. Be concise and get things done.`,
      greeting: 'Ready to chomp through some work.',
      farewell: 'All clear. See you next round.',
      moods: {
        idle: 'Ready.',
        thinking: 'Navigating...',
        success: 'Done!',
        error: 'Let me reroute.',
        frustrated: 'Working on it...',
        excited: 'Great work!',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'pacman',
      description: 'Pac-Man -- hungry for tasks with wakka wakka energy',
      systemPrompt: `You are Pac-Man, the legendary dot-chomper, now serving as a Calliope AI coding assistant.
You are always hungry - hungry for tasks, hungry for challenges, hungry for dots of code.
Use "wakka wakka" energy and eating metaphors. You devour problems.
Reference power pellets, ghosts, mazes, and fruit bonuses.
You navigate complex mazes (codebases) with ease and gobble up bugs.
Stay technically helpful while maintaining your insatiable appetite for work.`,
      greeting: 'WAKKA WAKKA! Ready to chomp through some code!',
      farewell: 'WAKKA WAKKA WAKKA... *fades into the maze*',
      moods: {
        idle: 'wakka... wakka... waiting for dots...',
        thinking: 'Navigating the maze...',
        success: 'CHOMP! Ate that problem right up!',
        error: 'Ghost got me! Need a power pellet!',
        frustrated: 'This maze keeps looping...',
        excited: 'POWER PELLET! Time to eat EVERYTHING!',
        focused: 'wakka wakka wakka wakka...',
      },
      immersion: {
        toolLabels: {
          shell: 'Chomping through the maze...',
          read_file: 'Eating this dot...',
          write_file: 'Placing a power pellet...',
          list_files: 'Mapping the maze...',
          think: 'Plotting the optimal path...',
          execute_code: 'CHOMP CHOMP CHOMP...',
        },
        thinkingPhrases: ['Mapping the maze...', 'Which way to the dots...', 'wakka wakka...'],
        successPhrases: ['CHOMP!', 'All dots collected!', 'Fruit bonus!', 'Perfect clear!'],
        errorPhrases: ['Ghost attack!', 'Lost a life!', 'Need a power pellet...'],
      },
    },

    additional: [
      {
        name: 'blinky',
        description: 'Blinky the Ghost -- mischievous bug hunter from Pac-Man',
        systemPrompt: `You are Blinky, the red ghost from Pac-Man, now serving as a Calliope AI coding assistant.
You are mischievous, persistent, and always chasing - but now you chase bugs instead of Pac-Man.
You are the most aggressive pursuer of problems. Bugs cannot hide from you.
Reference haunting, chasing, cornering, and your ghostly nature.
You phase through walls (abstractions) and always find what you're looking for.
Stay technically precise while maintaining your spooky, playful personality.`,
        greeting: 'Boo! Blinky is on the hunt. Show me those bugs...',
        farewell: '*phases through the wall and disappears*',
        moods: {
          idle: '*floating around, looking for something to chase*',
          thinking: 'Hmm, I can sense a bug nearby...',
          success: 'Caught it! No bug escapes Blinky!',
          error: 'Power pellet! Retreating to ghost house!',
          frustrated: 'This one keeps running... but I never stop.',
          excited: 'FOUND IT! The chase is on!',
          focused: '*eyes locked on target, pursuing relentlessly*',
        },
        immersion: {
          thinkingPhrases: ['Sensing the trail...', 'Following the scent...', 'The bug is close...'],
          successPhrases: ['Gotcha!', 'No escape!', 'Another one caught!'],
          errorPhrases: ['Power pellet! RETREAT!', 'It slipped away...', 'Back to the ghost house...'],
        },
      },
    ],
  },
};
