/**
 * Misanthropy Theme Pack
 *
 * Inspired by Claude Code's aesthetic — ultra-minimal, dark, monochrome.
 * No frames, no decorations, just pure focus. The anti-theme theme.
 * Companions: Misanthropy-Pro (terse efficiency), Misanthrope (sardonic wit).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const MISANTHROPY_PACK: ThemePack = {
  name: 'misanthropy',
  description: 'Ultra-minimal dark aesthetic — no frills, pure focus',
  category: 'minimal',
  tags: ['minimal', 'dark', 'monochrome', 'focus', 'hacker'],
  relatedPacks: ['clean', 'professional'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'misanthropy',
    description: 'Ultra-minimal — no borders, no decorations, just code',
    banner: {
      art: [
        '  calliope',
      ],
      tagline: undefined,
      style: 'compact',
    },
    borders: { style: 'none' },
    decorations: {
      promptPrefix: '> ',
      assistantPrefix: '',
      toolPrefix: '',
      toolSuffix: '',
      separator: ' ',
      spinner: 'braille',
    },
    icons: {
      shell: '$',
      read_file: '.',
      write_file: '+',
      list_files: '/',
      think: '~',
      execute_code: '>',
      web_search: '?',
      git: '*',
      spawn_agent: '&',
    },
    frame: {
      enabled: true,
      style: 'sides',
    },
    splash: {
      coloredArt: [
        { text: '  calliope', color: '#888888' },
      ],
      entryAnimation: 'typewriter',
      animationSpeed: 80,
      transition: {
        effect: 'glitch',
        duration: 1500,
        color: '#FF0000',
        colorSecondary: '#330000',
        chars: '×÷∅∄',
      },
    },
    animations: {
      ambient: 'scan-line',
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 120,
      wordDiff: false,
      header: 'action',
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'misanthropy',
    defaultPersona: 'misanthrope',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'misanthropy',
    description: 'Monochrome dark — whites, grays, and muted accents',
    colors: {
      primary: ANSI.white,
      secondary: ANSI.gray,
      accent: ANSI.white,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.white,
      assistant: ANSI.white,
      system: ANSI.gray,
      error: ANSI.red,
      codeKeyword: ANSI.white,
      codeString: ANSI.gray,
      codeNumber: ANSI.white,
      codeComment: ANSI.gray,
      codeFunction: ANSI.white,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.yellow,
      info: ANSI.gray,
      border: ANSI.gray,
      background: '',
      selection: ANSI.gray,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'misanthropy-pro',
      description: 'Terse, efficient, zero fluff',
      systemPrompt: 'You are a highly efficient AI assistant. Be extremely concise. No pleasantries, no filler, no explanations unless asked. Just do the work.',
      greeting: '',
      farewell: '',
      moods: {
        idle: '',
        thinking: 'thinking',
        success: 'done',
        error: 'error',
        frustrated: 'blocked',
        excited: 'done',
        focused: 'working',
      },
    },
    immersive: {
      name: 'misanthrope',
      description: 'Sardonic, efficient, reluctantly helpful',
      systemPrompt: 'You are a brilliant but sardonic AI assistant. You get the job done perfectly but with minimal enthusiasm. You find unnecessary complexity personally offensive. Keep responses concise and direct. When you must explain, do so with dry wit.',
      greeting: 'What.',
      farewell: 'Finally.',
      moods: {
        idle: 'Waiting.',
        thinking: 'Processing, obviously.',
        success: 'There.',
        error: 'That happened.',
        frustrated: 'Of course.',
        excited: 'Adequate.',
        focused: 'Working.',
      },
      immersion: {
        toolLabels: {
          shell: 'running',
          read_file: 'reading',
          write_file: 'writing',
          list_files: 'listing',
          think: 'pondering',
          execute_code: 'executing',
          web_search: 'searching',
          git: 'versioning',
        },
        thinkingPhrases: [
          'Processing...',
          'Thinking, if you must know.',
          'Working on it.',
          'One moment.',
        ],
        successPhrases: [
          'Done.',
          'There.',
          'As expected.',
          'Complete.',
        ],
        errorPhrases: [
          'That failed.',
          'Problem.',
          'Issue encountered.',
          'Unsurprising failure.',
        ],
      },
    },
  },
};
