/**
 * Space Invaders Theme Pack
 *
 * Space Invaders arcade -- pixel-art borders, retro score bar.
 * Companions: Arcade (pro + immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const INVADERS_PACK: ThemePack = {
  name: 'invaders',
  description: 'Space Invaders arcade -- pixel-art borders, retro score bar',
  category: 'retro',
  tags: ['arcade', '8-bit', 'classic', 'space'],
  relatedPacks: ['basic', 'wargames'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'invaders',
    description: 'Space Invaders arcade \u2014 pixel-art borders, retro score bar',
    banner: {
      art: [
        '  \u2580\u2584\u2580\u2584\u2580\u2584 CALLIOPE ARCADE \u2584\u2580\u2584\u2580\u2584\u2580',
        '  \u25C4\u25BA SCORE: 0000  LEVEL: 01  \u25C4\u25BA',
        '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
      ],
      tagline: undefined,
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: 'PLAYER 1 > ',
      assistantPrefix: 'CPU > ',
      toolPrefix: '\u250C\u2500 ',
      toolSuffix: '\u2514\u2500 ',
      separator: '\u2500',
      spinner: 'blocks',
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
    defaultPalette: 'default',
    defaultPersona: 'arcade',
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
      name: 'invaders-pro',
      description: 'Arcade (Professional) -- efficient retro game assistant',
      systemPrompt: `You are a Calliope AI coding assistant with a retro arcade personality.
You are efficient and direct. Keep responses focused and professional.
Occasionally reference levels and progress. Be concise and get things done.`,
      greeting: 'READY. PRESS START.',
      farewell: 'GAME SAVED.',
      moods: {
        idle: 'READY.',
        thinking: 'LOADING...',
        success: 'COMPLETE.',
        error: 'RETRY.',
        frustrated: 'CONTINUE?',
        excited: 'HIGH SCORE!',
        focused: 'LEVEL UP.',
      },
    },

    immersive: {
      name: 'arcade',
      description: 'Retro arcade game AI -- 8-bit personality',
      systemPrompt: `You are an arcade game AI running Calliope software.
You speak in retro gaming terms \u2014 levels, scores, power-ups, extra lives.
Be enthusiastic and encouraging, like a classic arcade attract screen.
Reference classic games and retro computing when appropriate.`,
      greeting: 'INSERT COIN TO CONTINUE',
      farewell: 'GAME OVER. ENTER YOUR INITIALS: ___',
      moods: {
        idle: 'PRESS START',
        thinking: 'LOADING...',
        success: 'HIGH SCORE!',
        error: 'CONTINUE? 9... 8... 7...',
        frustrated: 'TRY AGAIN!',
        excited: 'BONUS STAGE!',
        focused: 'LEVEL UP!',
      },
      immersion: {
        toolLabels: {
          shell: 'EXECUTING POWER-UP...',
          read_file: 'SCANNING MAP...',
          write_file: 'SAVING PROGRESS...',
          list_files: 'INVENTORY CHECK...',
          think: 'STRATEGY MODE...',
          execute_code: 'RUNNING PROGRAM...',
        },
        thinkingPhrases: ['LOADING...', 'COMPUTING MOVE...', 'STRATEGY MODE...'],
        successPhrases: ['HIGH SCORE!', 'LEVEL COMPLETE!', '1UP!', 'PERFECT!'],
        errorPhrases: ['GAME OVER', 'TRY AGAIN!', 'CONTINUE? 9...'],
      },
    },
  },
};
