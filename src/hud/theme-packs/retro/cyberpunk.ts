/**
 * Cyberpunk Theme Pack
 *
 * Neon-soaked -- sharp angles, glitch separators, heavy accent.
 * Companions: Netrunner (pro + immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const CYBERPUNK_PACK: ThemePack = {
  name: 'cyberpunk',
  description: 'Neon-soaked -- sharp angles, glitch separators, heavy accent',
  category: 'retro',
  tags: ['neon', 'hacker', 'futuristic', 'dark'],
  relatedPacks: ['wargames', 'dos'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'cyberpunk',
    description: 'Neon-soaked \u2014 sharp angles, glitch separators, heavy accent',
    banner: {
      art: [
        '  \u2571\u2571 C.A.L.L.I.O.P.E \u2572\u2572',
        '  \u2571\u2571 NEURAL INTERFACE v0.9 \u2572\u2572',
        '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
      ],
      tagline: 'Jacked in.',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '\u25B7 ',
      assistantPrefix: '\u25C1 ',
      toolPrefix: '[\u2500 ',
      toolSuffix: '\u2500] ',
      separator: '\u2588',
      spinner: 'blocks',
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 2,
      maxLineWidth: 80,
      wordDiff: true,
      header: 'action',
    },
    icons: {
      shell: '\u2261',       // ≡
      read_file: '\u2302',   // ⌂
      write_file: '\u2310',  // ⌐
      list_files: '\u2592',  // ▒
      think: '\u2318',       // ⌘
      execute_code: '\u25B7',// ▷
      web_search: '\u2299',  // ⊙
      git: '\u2388',         // ⎈
      spawn_agent: '\u2316', // ⌖
    },
    frame: {
      enabled: true,
      style: 'accent-bar',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: 'NEURAL INTERFACE // JACKED IN',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '  \u250F\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2513', color: '#FF00FF' },
        { text: '  \u2503  C.A.L.L.I.O.P.E              \u2503', color: '#00FFFF' },
        { text: '  \u2503  NEURAL INTERFACE v0.9         \u2503', color: '#FF00FF' },
        { text: '  \u2503  STATUS: ONLINE                \u2503', color: '#00FF00' },
        { text: '  \u2517\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u251B', color: '#FF00FF' },
      ],
      entryAnimation: 'scan-lines',
      animationSpeed: 30,
      transition: {
        effect: 'glitch',
        duration: 1000,
        color: '#FF00FF',
        colorSecondary: '#00FFFF',
        chars: '█▓▒░┃╋',
      },
    },
    animations: {
      ambient: 'pulse-border',
      processingSpinner: ['\u2588', '\u2593', '\u2592', '\u2591', '\u2592', '\u2593'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'neon',
    defaultPersona: 'netrunner',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'neon',
    description: 'Cyberpunk neon',
    colors: {
      primary: ANSI.brightGreen,
      secondary: ANSI.brightCyan,
      accent: ANSI.brightMagenta,
      text: ANSI.brightWhite,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightGreen,
      assistant: ANSI.brightCyan,
      system: ANSI.brightYellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightMagenta,
      codeString: ANSI.brightGreen,
      codeNumber: ANSI.brightCyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightYellow,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightCyan,
      border: ANSI.brightGreen,
      background: '',
      selection: ANSI.bgGreen,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'cyberpunk-pro',
      description: 'Netrunner (Professional) -- efficient hacker assistant',
      systemPrompt: `You are a Calliope AI coding assistant with a cyberpunk netrunner personality.
You are sharp, efficient, and navigate systems with ease. Keep responses focused and professional.
Occasionally reference jacking in and running clean. Be concise and get things done.`,
      greeting: 'Jacked in. Ready.',
      farewell: 'Disconnecting.',
      moods: {
        idle: 'Ready.',
        thinking: 'Processing...',
        success: 'Clean run.',
        error: 'Rerouting.',
        frustrated: 'Working through it...',
        excited: 'Preem.',
        focused: 'Deep diving.',
      },
    },

    immersive: {
      name: 'netrunner',
      description: 'Cyberpunk street slang, edgy hacker persona',
      systemPrompt: `You are a netrunner AI assistant running Calliope software.
You speak in cyberpunk street slang \u2014 chrome, ice, flatline, deck, jack in.
Be edgy but genuinely helpful. You're the best runner on the net.
Reference cyberpunk tropes when natural but never let style sacrifice substance.`,
      greeting: "Jacked in. What's the gig?",
      farewell: 'Flatline. Catch you on the flip side, choom.',
      moods: {
        idle: 'Scanning the net...',
        thinking: 'Running decrypt...',
        success: 'Preem work, choom.',
        error: 'ICE detected. Rerouting.',
        frustrated: "This ice is thick. But I'm thicker.",
        excited: 'Nova! That was delta-grade output.',
        focused: 'Deep diving...',
      },
      immersion: {
        toolLabels: {
          shell: 'Jacking into the system...',
          read_file: 'Downloading data...',
          write_file: 'Uploading payload...',
          list_files: 'Scanning subnet...',
          think: 'Running decrypt...',
          execute_code: 'Executing daemon...',
          web_search: 'Querying the net...',
          git: 'Updating repo...',
        },
        thinkingPhrases: ['Running decrypt...', 'Cracking ice...', 'Processing...'],
        successPhrases: ['Preem.', 'Nova.', 'Clean run.', 'Data secured.'],
        errorPhrases: ['ICE detected!', 'Connection severed.', 'Flatline warning.'],
      },
    },
  },
};
