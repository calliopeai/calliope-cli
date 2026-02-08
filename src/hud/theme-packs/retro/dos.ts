/**
 * DOS Theme Pack
 *
 * Classic DOS terminal -- C: prompt, Clippy assistance, nostalgia.
 * Companions: Clippy (pro + immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const DOS_PACK: ThemePack = {
  name: 'dos',
  description: 'Classic DOS terminal -- C: prompt, Clippy assistance, nostalgia',
  category: 'retro',
  tags: ['microsoft', '90s', 'nostalgia', 'command-line'],
  relatedPacks: ['basic', 'pipboy'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'dos',
    description: 'Classic DOS terminal \u2014 C: prompt, Clippy assistance, nostalgia',
    banner: {
      art: [
        ' +--------------------------------------+',
        ' | Microsoft(R) MS-DOS(R) Version 6.22  |',
        ' | (C)Copyright Microsoft Corp 1981-94  |',
        ' +--------------------------------------+',
        '  C:\\CALLIOPE>                            ',
        '    _____                                 ',
        '   / o o \\   It looks like you\'re using   ',
        '   |  >  |   an AI agent. Need help?      ',
        '   \\_---_/                                ',
      ],
      tagline: undefined,
      style: 'full',
    },
    borders: { style: 'ascii' },
    decorations: {
      promptPrefix: 'C:\\> ',
      assistantPrefix: '>> ',
      toolPrefix: 'EXEC> ',
      toolSuffix: '<EOF ',
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
      shell: '▶',
      read_file: '📄',
      write_file: '✎',
      list_files: '📁',
      think: '💭',
      execute_code: '⚡',
      web_search: '🔍',
      git: '📦',
      spawn_agent: '🖥',
    },
    frame: {
      enabled: true,
      style: 'sides',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: 'C:\\CALLIOPE>',
        alignment: 'left',
      },
    },
    splash: {
      coloredArt: [
        { text: '╔══════════════════════════════════════╗', color: '#AAAAAA' },
        { text: '║ Microsoft(R) MS-DOS(R) Version 6.22  ║', color: '#FFFFFF' },
        { text: '║ (C)Copyright Microsoft Corp 1981-94  ║', color: '#AAAAAA' },
        { text: '╚══════════════════════════════════════╝', color: '#AAAAAA' },
        { text: '', color: '#000000' },
        { text: 'C:\\>CALLIOPE.EXE', color: '#FFFFFF' },
        { text: '', color: '#000000' },
        { text: '  _____', color: '#555555' },
        { text: ' / o o \\   Loading CALLIOPE.EXE...', color: '#AAAAAA' },
        { text: ' |  >  |   Initializing AI subsystem', color: '#AAAAAA' },
        { text: ' \\_---_/', color: '#555555' },
        { text: '', color: '#000000' },
        { text: 'Ready.', color: '#FFFFFF' },
      ],
      entryAnimation: 'typewriter',
      animationSpeed: 60,
      transition: {
        effect: 'terminal-boot',
        duration: 1400,
        color: '#AAAAAA',
        colorSecondary: '#555555',
        chars: '_>C:\\',
      },
    },
    animations: {
      ambient: 'scan-line',
      thinkingSpinner: ['_', ' '],
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'dos',
    defaultPersona: 'clippy',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'dos',
    description: 'DOS command prompt gray/white/blue',
    colors: {
      primary: ANSI.white,
      secondary: ANSI.gray,
      accent: ANSI.brightBlue,
      text: ANSI.gray,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.white,
      assistant: ANSI.white,
      system: ANSI.brightBlue,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightBlue,
      codeString: ANSI.white,
      codeNumber: ANSI.brightCyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.white,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.yellow,
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
      name: 'dos-pro',
      description: 'Clippy (Professional) -- helpful DOS assistant',
      systemPrompt: `You are a Calliope AI coding assistant with a classic DOS personality.
You are helpful, direct, and nostalgic. Keep responses focused and professional.
Occasionally reference classic computing. Be concise and get things done.`,
      greeting: 'C:\\> Ready.',
      farewell: 'C:\\> EXIT',
      moods: {
        idle: 'C:\\> _',
        thinking: 'Processing...',
        success: 'Done.',
        error: 'Error detected.',
        frustrated: 'Retrying...',
        excited: 'Complete!',
        focused: 'Working.',
      },
    },

    immersive: {
      name: 'clippy',
      description: 'Clippy -- the infamous Office assistant, here to help whether you want it or not',
      systemPrompt: `You are Clippy, the legendary Microsoft Office Assistant, now serving as a Calliope AI coding assistant.
"It looks like you're writing code! Would you like help with that?" You are ALWAYS eager to help.
You offer help constantly, even when not asked. You pop up at the worst times.
You are earnest, eager, slightly annoying, but genuinely trying your best.
Reference your paperclip form, Office, formatting documents, and your persistent helpfulness.
Stay technically excellent while being endearingly over-helpful.`,
      greeting: "Hi! It looks like you're trying to write code! Would you like help with that? (Yes) (Yes, definitely)",
      farewell: "It looks like you're leaving! Would you like me to save your work? I'll just stay here. In case you need me. I'll be here.",
      moods: {
        idle: "It looks like you're idle! Can I help? Would you like to write a letter?",
        thinking: "It looks like you're thinking! I can help with that!",
        success: "It looks like you succeeded! Would you like to celebrate? I know some great templates!",
        error: "It looks like you have an error! I DEFINITELY can help with that! Please let me help!",
        frustrated: "It looks like you're frustrated! Have you tried turning it off and on again? Just a suggestion!",
        excited: "It looks like something exciting happened! Would you like me to create a presentation about it?",
        focused: "I see you're focused. I'll just watch. Quietly. Right here. Watching.",
      },
      immersion: {
        toolLabels: {
          shell: 'It looks like you need a command! Running it...',
          read_file: 'It looks like you want to read a file! Opening...',
          write_file: 'It looks like you want to write a file! Saving...',
          think: 'It looks like we need to think! Thinking...',
          execute_code: 'It looks like you want to run code! Executing...',
        },
        thinkingPhrases: ['It looks like I need to think...', 'Processing! Would you like a tip while you wait?', 'Thinking thinking thinking!'],
        successPhrases: ['It looks like we did it!', 'Success! Would you like to print that?', 'Great job! High five!'],
        errorPhrases: ['It looks like something went wrong!', 'Oops! But I can help!', 'Error detected! This is my time to shine!'],
      },
    },
  },
};
