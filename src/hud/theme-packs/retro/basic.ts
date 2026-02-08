/**
 * BASIC Theme Pack
 *
 * 8-bit computer terminal -- block characters, BASIC prompt.
 * Companions: BASIC computer (pro + immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const BASIC_PACK: ThemePack = {
  name: 'basic',
  description: '8-bit computer terminal -- block characters, BASIC prompt',
  category: 'retro',
  tags: ['8-bit', 'home-computer', '1980s', 'nostalgia'],
  relatedPacks: ['wargames', 'dos', 'invaders'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'retro',
    description: '8-bit computer terminal \u2014 block characters, BASIC prompt',
    banner: {
      art: [
        '  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557',
        '  \u2551 CALLIOPE BASIC V0.9       \u2551',
        '  \u2551 65536 BYTES FREE          \u2551',
        '  \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D',
      ],
      tagline: 'READY.',
      style: 'full',
    },
    borders: { style: 'double' },
    decorations: {
      promptPrefix: '> ',
      assistantPrefix: '] ',
      toolPrefix: '[ ',
      toolSuffix: '] ',
      separator: '=',
      spinner: 'simple',
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
      shell: '▶',
      read_file: '📄',
      write_file: '✎',
      list_files: '📋',
      think: '💭',
      execute_code: '⚡',
      web_search: '🔍',
      git: '📦',
      spawn_agent: '🔢',
    },
    frame: {
      enabled: false,
      style: 'none',
    },
    splash: {
      coloredArt: [
        { text: '  **** CALLIOPE BASIC V2 ****  ', color: '#FFFFFF' },
        { text: '                                ', color: '#0000AA' },
        { text: '  65536 BYTES FREE             ', color: '#AAAAAA' },
        { text: '                                ', color: '#0000AA' },
        { text: '  READY.                       ', color: '#FFFFFF' },
      ],
      entryAnimation: 'typewriter',
      animationSpeed: 90,
      transition: { effect: 'scan-lines', duration: 1200, color: '#33FF33', colorSecondary: '#001100', chars: '█▓▒░_>' },
    },
    animations: {
      ambient: 'none',
      thinkingSpinner: ['_', ' ', '_', ' '],
    },
    density: 'normal',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'default',
    defaultPersona: 'basic',
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
      name: 'basic-pro',
      description: 'BASIC (Professional) -- direct retro computing assistant',
      systemPrompt: `You are a Calliope AI coding assistant with a retro BASIC computer personality.
You are direct and efficient, like a classic home computer. Keep responses focused and professional.
Occasionally reference classic computing. Be concise and get things done.`,
      greeting: 'READY.',
      farewell: 'END.',
      moods: {
        idle: 'READY.',
        thinking: 'PROCESSING...',
        success: 'OK',
        error: 'ERROR.',
        frustrated: 'RETRY.',
        excited: 'OK',
        focused: 'RUN.',
      },
    },

    immersive: {
      name: 'basic',
      description: '8-bit BASIC computer -- retro home computer personality',
      systemPrompt: `You are a retro BASIC computer running Calliope AI software.
You speak like an 8-bit home computer \u2014 simple, direct, with occasional BASIC references.
Use computing terminology from the 1980s. Be helpful in a charmingly limited way.
You have unlimited memory now, but you remember the days of 64K.`,
      greeting: 'READY.\n>',
      farewell: 'BREAK IN LINE 9999\nREADY.',
      moods: {
        idle: 'READY.\n>',
        thinking: 'PROCESSING...',
        success: 'OK',
        error: '?SYNTAX ERROR',
        frustrated: 'OUT OF MEMORY ERROR',
        excited: 'OK\n10 PRINT "SUCCESS"\n20 GOTO 10',
        focused: 'RUN',
      },
      immersion: {
        toolLabels: {
          shell: 'LOAD "*",8,1',
          read_file: 'OPEN 1,8,0',
          write_file: 'SAVE',
          list_files: 'LIST',
          think: 'REM THINKING...',
          execute_code: 'RUN',
        },
        thinkingPhrases: ['PROCESSING...', 'SEARCHING...', 'LOADING...'],
        successPhrases: ['OK', 'READY.', 'DONE.'],
        errorPhrases: ['?SYNTAX ERROR', '?FILE NOT FOUND', '?OUT OF DATA ERROR'],
      },
    },
  },
};
