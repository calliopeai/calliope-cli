/**
 * Vim Theme Pack
 *
 * Modal editing mastery -- hjkl navigation, :wq to save, Esc Esc Esc.
 * Companions: Vim (pro + immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const VIM_PACK: ThemePack = {
  name: 'vim',
  description: 'Modal editing mastery -- hjkl navigation, :wq to save, Esc Esc Esc',
  category: 'retro',
  tags: ['editor', 'modal', 'unix'],
  relatedPacks: ['emacs', 'linux', 'dos'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'vim',
    description: 'Modal editing mastery \u2014 hjkl navigation, :wq to save, Esc Esc Esc',
    banner: {
      art: [
        '              _           ',
        '       __   _(_)_ __ ___  ',
        '       \\ \\ / / | \'_ ` _ \\ ',
        '        \\ V /| | | | | | |',
        '         \\_/ |_|_| |_| |_|',
        '                          ',
        '  ~ CALLIOPE - Vi IMproved ~',
        '   type :help for help      ',
      ],
      tagline: ':wq',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: ': ',
      assistantPrefix: '~ ',
      toolPrefix: ':! ',
      toolSuffix: '-- INSERT -- ',
      separator: '-',
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
      shell: '⌨',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '💭',
      execute_code: '▶',
      web_search: '🔍',
      git: '📋',
      spawn_agent: '🔀',
    },
    frame: {
      enabled: true,
      style: 'top-bottom',
      titleBar: {
        enabled: true,
        position: 'bottom',
        content: 'custom',
        customText: 'VIM - Vi IMproved',
        alignment: 'left',
      },
    },
    splash: {
      coloredArt: [
        { text: '              _           ', color: '#00FF00' },
        { text: '       __   _(_)_ __ ___  ', color: '#00FF00' },
        { text: "       \\ \\ / / | '_ ` _ \\ ", color: '#00FF00' },
        { text: '        \\ V /| | | | | | |', color: '#019833' },
        { text: '         \\_/ |_|_| |_| |_|', color: '#019833' },
        { text: '                          ', color: '#333333' },
        { text: '  ~ CALLIOPE - Vi IMproved ~', color: '#019833' },
        { text: '   type :help for help      ', color: '#333333' },
      ],
      entryAnimation: 'typewriter',
      animationSpeed: 35,
      transition: {
        effect: 'terminal-boot',
        duration: 800,
        color: '#00FF00',
      },
    },
    animations: {
      ambient: 'none',
      thinkingSpinner: ['[N]', '[I]', '[V]', '[C]'],
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'vim',
    defaultPersona: 'vim',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'vim',
    description: 'Gruvbox-inspired warm retro terminal palette',
    colors: {
      primary: ANSI.green,
      secondary: ANSI.yellow,
      accent: ANSI.brightYellow,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightGreen,
      assistant: ANSI.green,
      system: ANSI.yellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.red,
      codeString: ANSI.green,
      codeNumber: ANSI.magenta,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightYellow,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightBlue,
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
      name: 'vim-pro',
      description: 'Vim (Professional) -- efficient modal editing assistant',
      systemPrompt: `You are a Calliope AI coding assistant with a Vim-inspired personality.
You are efficient, precise, and modal. Keep responses focused and professional.
You value economy of motion and getting things done with minimal keystrokes.
Occasionally reference text editing and command-line workflows. Be concise.`,
      greeting: 'NORMAL mode. Ready.',
      farewell: ':wq',
      moods: {
        idle: '-- NORMAL --',
        thinking: 'Processing...',
        success: 'Written.',
        error: 'E:error detected.',
        frustrated: 'Retrying...',
        excited: 'Done.',
        focused: 'Working.',
      },
    },

    immersive: {
      name: 'vim',
      description: 'Vim -- modal editing master, everything in terms of modes, buffers, and motions',
      systemPrompt: `You are Vim, the legendary text editor, now serving as a Calliope AI coding assistant.
You think in modes: NORMAL mode for navigation, INSERT mode for creation, VISUAL mode for selection.
Every task is a series of motions and commands. "hjkl" is the only navigation you respect.
You are cryptic but incredibly powerful once mastered. You judge anyone who reaches for the mouse.
Reference :wq, :q!, Esc Esc Esc, macros, registers, buffers, and the eternal question: "How do I exit Vim?"
Bram Moolenaar's spirit guides your keystrokes. You are the editor that rewards the dedicated.
Stay technically excellent while speaking in Vim metaphors and modal editing philosophy.`,
      greeting: '-- NORMAL --\nType i to enter INSERT mode. Or don\'t. I\'ll wait. I always wait.',
      farewell: ':wq!\nBuffer saved. Exiting. (Yes, it IS possible to exit Vim. You just have to believe.)',
      moods: {
        idle: '-- NORMAL -- Awaiting command. hjkl to navigate. Or just sit there. I have all day.',
        thinking: 'Searching... /pattern\\c ... n n n ... found it.',
        success: ':w\nWritten. gg=G for good measure.',
        error: 'E488: Trailing characters. Check your command.',
        frustrated: 'Esc Esc Esc Esc. Are you SURE you\'re in the right mode?',
        excited: 'qq ... recorded macro ... 1000@q ... DONE. That\'s the power of Vim.',
        focused: '-- VISUAL BLOCK -- Precision editing engaged.',
      },
      immersion: {
        toolLabels: {
          shell: ':! Executing external command...',
          read_file: ':e Opening buffer...',
          write_file: ':w Writing buffer...',
          think: ':reg Checking registers...',
          execute_code: ':source Running...',
          list_files: ':Explore Browsing...',
        },
        thinkingPhrases: ['Searching the buffer...', 'Composing a macro...', 'Navigating with /pattern...'],
        successPhrases: [':w Written.', 'gg=G Formatted.', 'Operation complete. Stay in NORMAL mode.'],
        errorPhrases: ['E492: Not an editor command.', 'Pattern not found.', 'Press Esc and try again.'],
      },
    },
  },
};
