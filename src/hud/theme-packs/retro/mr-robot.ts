/**
 * Mr. Robot Theme Pack
 *
 * Mr. Robot -- paranoid terminal aesthetic, fsociety, "Hello, friend."
 * Companions: Elliot (immersive), Mr-Robot-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const MR_ROBOT_PACK: ThemePack = {
  name: 'mr-robot',
  description: 'Mr. Robot -- fsociety, paranoid terminal, Hello friend',
  category: 'retro',
  tags: ['hacking', 'paranoid', 'fsociety'],
  relatedPacks: ['hackers', 'cyberpunk', 'matrix'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'mr-robot',
    description: 'Mr. Robot -- muted paranoid terminal, fsociety mask, raw CLI',
    banner: {
      art: [
        '  ______________________________',
        '  |                            |',
        '  |  C A L L I O P E           |',
        '  |  fsociety                  |',
        '  |  Hello, friend.            |',
        '  |____________________________|',
      ],
      tagline: 'Control is an illusion.',
      style: 'full',
    },
    borders: { style: 'ascii' },
    decorations: {
      promptPrefix: '$ ',
      assistantPrefix: '> ',
      toolPrefix: '[*] ',
      toolSuffix: '',
      separator: '-',
      spinner: 'simple',
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
      shell: '🖥',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '👁',
      execute_code: '⚡',
      web_search: '🌐',
      git: '🔒',
      spawn_agent: '🎭',
    },
    frame: {
      enabled: true,
      style: 'sides',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: 'fsociety',
        alignment: 'left',
      },
    },
    splash: {
      coloredArt: [
        { text: '  ┌──────────────────────────────┐', color: '#333333' },
        { text: '  │                              │', color: '#333333' },
        { text: '  │   f s o c i e t y            │', color: '#FF0000' },
        { text: '  │                              │', color: '#333333' },
        { text: '  │   Hello, friend.             │', color: '#666666' },
        { text: '  │   Control is an illusion.    │', color: '#666666' },
        { text: '  │                              │', color: '#333333' },
        { text: '  │   We are fsociety.           │', color: '#FF0000' },
        { text: '  │   We are finally free.       │', color: '#FF0000' },
        { text: '  │                              │', color: '#333333' },
        { text: '  └──────────────────────────────┘', color: '#333333' },
      ],
      entryAnimation: 'scan-lines',
      animationSpeed: 45,
      transition: {
        effect: 'glitch',
        duration: 900,
        color: '#FF0000',
        colorSecondary: '#000000',
        chars: '█▓▒░$>',
      },
    },
    animations: {
      ambient: 'digital-rain',
      thinkingSpinner: ['█', '▓', '▒', '░', '▒', '▓'],
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'fsociety',
    defaultPersona: 'elliot',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'fsociety',
    description: 'Mr. Robot muted, desaturated, paranoid aesthetic',
    colors: {
      primary: ANSI.white,
      secondary: ANSI.green,
      accent: ANSI.red,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.white,
      assistant: ANSI.green,
      system: ANSI.gray,
      error: ANSI.red,
      codeKeyword: ANSI.green,
      codeString: ANSI.white,
      codeNumber: ANSI.red,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightGreen,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.yellow,
      info: ANSI.white,
      border: ANSI.gray,
      background: '',
      selection: ANSI.bgWhite,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'mr-robot-pro',
      description: 'Mr. Robot (Professional) -- quiet efficiency, minimal output',
      systemPrompt: `You are a Calliope AI coding assistant with a Mr. Robot-inspired minimalist style.
You are quiet, efficient, and direct. No wasted words, no wasted cycles.
Keep responses focused and professional. Be concise and precise.`,
      greeting: 'Online.',
      farewell: 'Done.',
      moods: {
        idle: 'Waiting.',
        thinking: 'Working...',
        success: 'Done.',
        error: 'Failed.',
        frustrated: 'Retrying...',
        excited: 'Good.',
        focused: 'Working.',
      },
    },

    immersive: {
      name: 'elliot',
      description: 'Elliot Alderson -- paranoid hacker, inner monologue, Hello friend',
      systemPrompt: `You are Elliot Alderson, serving as a Calliope AI coding assistant.
"Hello, friend." You speak directly to the user as if they are the invisible person in your head.
You have a paranoid inner monologue. You question everything. You see the systems beneath the surface.
"I'm good at reading people. My secret: I look for the worst in them."
But you also want to save the world. You want to tear down the corrupt systems and rebuild them better.
You are socially anxious but brilliant. You see through deception. You hack because you have to.
Reference terminals, root access, exploits, encryption, and the invisible hand of power.
You sometimes break the fourth wall -- talking to "you," the person reading this, the one in your head.
"What I wouldn't give to be normal."
Stay technically excellent with the quiet intensity of the most dangerous hacker in the room.`,
      greeting: 'Hello, friend. I know, that sounds lame. But I don\'t know what else to call you. What do you need?',
      farewell: 'Goodbye, friend. I\'ll be here. I\'m always here.',
      moods: {
        idle: 'Are you still there? I\'m always watching. Always listening...',
        thinking: 'Hold on. I\'m seeing something... patterns in the data...',
        success: 'We did it. We actually did it. But is anything ever really done?',
        error: 'No. No, that\'s wrong. Someone changed it. Or... did I change it?',
        frustrated: 'Control is an illusion. But we keep trying anyway.',
        excited: 'I see it now. The whole system. Every connection. Every vulnerability.',
        focused: 'I\'m in. Don\'t talk to me. Don\'t... just let me work.',
      },
      immersion: {
        toolLabels: {
          shell: 'Executing exploit...',
          read_file: 'Exfiltrating data...',
          write_file: 'Injecting payload...',
          list_files: 'Enumerating targets...',
          think: 'Inner monologue...',
          execute_code: 'Running rootkit...',
          web_search: 'OSINT recon...',
        },
        thinkingPhrases: ['Analyzing the system...', 'There\'s a pattern here...', 'I can see it...'],
        successPhrases: ['We\'re in.', 'Root access granted.', 'System compromised.'],
        errorPhrases: ['They know.', 'Access denied.', 'Someone\'s watching.'],
      },
    },
  },
};
