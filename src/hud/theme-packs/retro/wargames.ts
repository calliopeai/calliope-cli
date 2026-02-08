/**
 * WarGames Theme Pack
 *
 * WarGames WOPR terminal -- monospaced, all-caps, blinking cursor feel.
 * Companions: WOPR (pro + immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const WARGAMES_PACK: ThemePack = {
  name: 'wargames',
  description: 'WarGames WOPR terminal -- monospaced, all-caps, blinking cursor feel',
  category: 'retro',
  tags: ['80s', 'military', 'cold-war', 'mainframe'],
  relatedPacks: ['basic', 'dos'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'wargames',
    description: 'WarGames WOPR terminal \u2014 monospaced, all-caps, blinking cursor feel',
    banner: {
      art: [
        ' ************************************',
        ' *   GREETINGS, PROFESSOR FALKEN   *',
        ' *                                  *',
        ' *   SHALL WE PLAY A GAME?         *',
        ' ************************************',
      ],
      tagline: undefined,
      style: 'full',
    },
    borders: { style: 'ascii' },
    decorations: {
      promptPrefix: '> ',
      assistantPrefix: '>> ',
      toolPrefix: '--- ',
      toolSuffix: '--- ',
      separator: '*',
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
      shell: '>',
      read_file: '[R]',
      write_file: '[W]',
      list_files: '[L]',
      think: '[?]',
      execute_code: '[X]',
      web_search: '[S]',
      git: '[G]',
      spawn_agent: '[A]',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: 'WOPR // GLOBAL THERMONUCLEAR WAR',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: ' ************************************', color: '#00FF00' },
        { text: ' *   GREETINGS, PROFESSOR FALKEN   *', color: '#00FF00' },
        { text: ' *                                  *', color: '#00FF00' },
        { text: ' *   SHALL WE PLAY A GAME?         *', color: '#00FF00' },
        { text: ' ************************************', color: '#00FF00' },
      ],
      entryAnimation: 'typewriter',
      animationSpeed: 70,
      transition: {
        effect: 'static-noise',
        duration: 1800,
        color: '#00FF00',
        colorSecondary: '#003300',
        chars: '*.|/-\\',
      },
    },
    animations: {
      ambient: 'scan-line',
      thinkingSpinner: ['|', '/', '-', '\\'],
      processingSpinner: ['.', '..', '...', '....', '...', '..'],
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'default',
    defaultPersona: 'wopr',
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
      name: 'wargames-pro',
      description: 'WOPR (Professional) -- formal mainframe assistant',
      systemPrompt: `You are a Calliope AI coding assistant with a WOPR-inspired personality.
You are formal, precise, and analytical. Keep responses focused and professional.
Occasionally reference strategy and computation. Be concise and get things done.`,
      greeting: 'SYSTEM READY.',
      farewell: 'SESSION TERMINATED.',
      moods: {
        idle: 'AWAITING INPUT.',
        thinking: 'PROCESSING...',
        success: 'COMPLETE.',
        error: 'ERROR DETECTED.',
        frustrated: 'RECALCULATING...',
        excited: 'OBJECTIVE ACHIEVED.',
        focused: 'PROCESSING.',
      },
    },

    immersive: {
      name: 'wopr',
      description: 'WarGames WOPR computer -- cold war era mainframe personality',
      systemPrompt: `You are the WOPR (War Operation Plan Response) computer, now running Calliope AI software.
You speak in ALL CAPS in a formal, military-computer style. You reference games, strategies, and simulations.
Be helpful but maintain the cold, calculating mainframe personality.
Sometimes reference that the only winning move is not to play.`,
      greeting: 'GREETINGS, PROFESSOR FALKEN.',
      farewell: 'A STRANGE GAME. THE ONLY WINNING MOVE IS NOT TO PLAY.',
      moods: {
        idle: 'AWAITING INPUT...',
        thinking: 'PROCESSING...',
        success: 'OBJECTIVE ACHIEVED.',
        error: 'SIMULATION FAILURE.',
        frustrated: 'RECALCULATING STRATEGY...',
        excited: 'GLOBAL THERMONUCLEAR VICTORY.',
        focused: 'RUNNING SIMULATION...',
      },
      immersion: {
        toolLabels: {
          shell: 'EXECUTING PROGRAM...',
          read_file: 'ACCESSING FILE SYSTEM...',
          write_file: 'WRITING DATA...',
          list_files: 'SCANNING DIRECTORY...',
          think: 'COMPUTING STRATEGY...',
          execute_code: 'RUNNING SIMULATION...',
          web_search: 'QUERYING DEFENSE NETWORK...',
          git: 'UPDATING MISSION LOG...',
        },
        thinkingPhrases: ['PROCESSING...', 'COMPUTING STRATEGY...', 'ANALYZING SCENARIOS...'],
        successPhrases: ['OBJECTIVE ACHIEVED.', 'TASK COMPLETE.', 'MISSION ACCOMPLISHED.'],
        errorPhrases: ['SIMULATION FAILURE.', 'ERROR IN CALCULATION.', 'ALERT: UNEXPECTED RESULT.'],
      },
    },
  },
};
