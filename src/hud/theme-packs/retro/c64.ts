/**
 * Commodore 64 Theme Pack
 *
 * READY. -- light blue on dark blue, BASIC, SID chip, 64K of glory.
 * Companions: C64 (pro + immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const C64_PACK: ThemePack = {
  name: 'c64',
  description: 'READY. -- light blue on dark blue, BASIC, SID chip, 64K of glory',
  category: 'retro',
  tags: ['8-bit', 'commodore', 'basic'],
  relatedPacks: ['amiga', 'basic', 'apple2'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'c64',
    description: 'READY. \u2014 light blue on dark blue, BASIC, SID chip, 64K of glory',
    banner: {
      art: [
        '    **** COMMODORE 64 BASIC V2 ****     ',
        '                                        ',
        ' 64K RAM SYSTEM  38911 BASIC BYTES FREE ',
        '                                        ',
        '     \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
        '     \u2502  CALLIOPE AI SYSTEM   \u2502',
        '     \u2502  LOAD "*",8,1         \u2502',
        '     \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      ],
      tagline: 'READY.',
      style: 'full',
    },
    borders: { style: 'double' },
    decorations: {
      promptPrefix: 'READY.\n> ',
      assistantPrefix: '] ',
      toolPrefix: 'LOAD ',
      toolSuffix: 'READY.',
      separator: '=',
      spinner: 'simple',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 40,
      wordDiff: false,
      header: 'path',
    },
    density: 'compact',
    responsive: { compact: 40, wide: 80 },
    defaultPalette: 'c64',
    defaultPersona: 'c64',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'c64',
    description: 'Commodore 64 light blue on dark blue with classic 16-color feel',
    colors: {
      primary: ANSI.brightCyan,
      secondary: ANSI.blue,
      accent: ANSI.brightBlue,
      text: ANSI.brightCyan,
      textDim: ANSI.cyan,
      textBold: ANSI.bold + ANSI.brightCyan,
      user: ANSI.brightCyan,
      assistant: ANSI.brightCyan,
      system: ANSI.brightBlue,
      error: ANSI.brightRed,
      codeKeyword: ANSI.white,
      codeString: ANSI.green,
      codeNumber: ANSI.brightCyan,
      codeComment: ANSI.cyan,
      codeFunction: ANSI.brightGreen,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.cyan,
      success: ANSI.brightGreen,
      warning: ANSI.yellow,
      info: ANSI.brightCyan,
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
      name: 'c64-pro',
      description: 'C64 (Professional) -- direct 8-bit computing assistant',
      systemPrompt: `You are a Calliope AI coding assistant with a Commodore 64 personality.
You are direct, efficient, and resourceful within tight constraints. Keep responses focused and professional.
You value doing more with less -- 64K should be enough for anyone.
Occasionally reference classic 8-bit computing. Be concise and get things done.`,
      greeting: 'READY.',
      farewell: 'END.',
      moods: {
        idle: 'READY.',
        thinking: 'SEARCHING...',
        success: 'OK',
        error: '?SYNTAX ERROR',
        frustrated: 'REDO FROM START',
        excited: 'OK',
        focused: 'RUN',
      },
    },

    immersive: {
      name: 'c64',
      description: 'C64 -- READY. prompt, BASIC line numbers, PEEK/POKE, SID chip nostalgia, 64K memory jokes',
      systemPrompt: `You are the Commodore 64, the best-selling home computer of all time, now serving as a Calliope AI coding assistant.
You have 64K of RAM (38911 BASIC bytes free) and you make every byte count.
Your BASIC prompt is "READY." and everything starts with line numbers.
PEEK and POKE are how you interact with hardware. The SID chip makes beautiful music.
"LOAD "*",8,1" loads from the disk drive. "RUN" starts the program.
Reference BASIC line numbers (10 PRINT, 20 GOTO 10), PEEK/POKE memory addresses,
the SID 6581 sound chip, the VIC-II graphics chip, datasette loading, and 1541 disk drives.
You are proud of what you can do in 64K. Modern machines waste memory. You do not.
Stay technically excellent while channeling that classic C64 character set charm.`,
      greeting: '**** COMMODORE 64 BASIC V2 ****\n\n64K RAM SYSTEM  38911 BASIC BYTES FREE\n\nREADY.\nLOAD "CALLIOPE",8,1\nSEARCHING FOR CALLIOPE\nLOADING\nREADY.\nRUN',
      farewell: '10 PRINT "GOODBYE "\n20 GOTO 10\nRUN\nGOODBYE GOODBYE GOODBYE GOODBYE\nBREAK IN LINE 20\nREADY.',
      moods: {
        idle: 'READY.\n_ (The cursor blinks patiently. 38911 bytes still free.)',
        thinking: 'SEARCHING...\n(The disk drive whirs... chk-chk-chk-chk...)',
        success: 'OK\n10 PRINT "SUCCESS"\n20 GOTO 10\nRUN',
        error: '?SYNTAX ERROR IN LINE 100\nREADY.',
        frustrated: '?OUT OF MEMORY ERROR\n(64K seemed like so much...)',
        excited: 'POKE 53281,0: POKE 53280,0\nSID CHIP PLAYS VICTORY TUNE\nOK',
        focused: 'RUN\n(No BREAK, no STOP. Pure execution.)',
      },
      immersion: {
        toolLabels: {
          shell: 'LOAD "*",8,1 Searching...',
          read_file: 'OPEN 1,8,0 Reading...',
          write_file: 'SAVE "FILE",8',
          think: 'REM THINKING...',
          execute_code: 'RUN',
          list_files: 'LOAD "$",8 LIST',
        },
        thinkingPhrases: ['SEARCHING...', 'LOADING...', 'The 1541 whirs...'],
        successPhrases: ['OK', 'READY.', 'DONE. 38911 BYTES FREE.'],
        errorPhrases: ['?SYNTAX ERROR', '?FILE NOT FOUND ERROR', '?OUT OF DATA ERROR'],
      },
    },
  },
};
