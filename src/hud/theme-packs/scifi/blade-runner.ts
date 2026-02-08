/**
 * Blade Runner Theme Pack
 *
 * Blade Runner -- neon-soaked rain, replicant noir, the Voight-Kampff test.
 * Companions: Deckard (immersive), Blade-Runner-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const BLADE_RUNNER_PACK: ThemePack = {
  name: 'blade-runner',
  description: 'Blade Runner -- neon rain, replicant noir, tears in rain',
  category: 'scifi',
  tags: ['noir', 'replicant', 'cyberpunk'],
  relatedPacks: ['matrix', 'cyberpunk', 'altered-carbon'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'blade-runner',
    description: 'Blade Runner -- neon orange and teal rain-soaked noir',
    banner: {
      art: [
        '  \u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584\u2584',
        '  \u2588 C A L L I O P E  \u2500  LOS ANGELES 2049 \u2588',
        '  \u2588 All those moments... like tears in rain \u2588',
        '  \u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580\u2580',
      ],
      tagline: 'More human than human.',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '\u25C9 ',
      assistantPrefix: '\u25C8 ',
      toolPrefix: '[\u2502 ',
      toolSuffix: ' \u2502]',
      separator: '\u2502',
      spinner: 'braille',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: true,
      header: 'action',
    },
    icons: {
      shell: '🦄',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '👁',
      execute_code: '⚡',
      web_search: '🔍',
      git: '🌧',
      spawn_agent: '🤖',
    },
    frame: {
      enabled: true,
      style: 'accent-bar',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '▸ VOIGHT-KAMPFF ANALYSIS TERMINAL ▸',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '  ▄█████████████████████████████████████▄', color: '#0A0A2E' },
        { text: '  ██  ╔═══════════════════════════════╗  ██', color: '#FFA500' },
        { text: '  ██  ║  V O I G H T - K A M P F F    ║  ██', color: '#FFA500' },
        { text: '  ██  ║  EMPATHY  RESPONSE  ANALYSIS  ║  ██', color: '#FFA500' },
        { text: '  ██  ╚═══════════════════════════════╝  ██', color: '#FFA500' },
        { text: '  ▀█████████████████████████████████████▀', color: '#0A0A2E' },
        { text: '', color: '#0A0A2E' },
        { text: '     ░▒▓  LOS ANGELES  ·  2 0 4 9  ▓▒░', color: '#00BFFF' },
        { text: '     ░▒▓  C A L L I O P E  ONLINE   ▓▒░', color: '#00BFFF' },
        { text: '', color: '#0A0A2E' },
        { text: '  🦄 "All those moments will be lost in time..."', color: '#FF4500' },
        { text: '     "...like tears in rain."', color: '#FFA500' },
      ],
      entryAnimation: 'fade-in',
      animationSpeed: 50,
      transition: {
        effect: 'glitch',
        duration: 1400,
        color: '#FFA500',
        colorSecondary: '#00BFFF',
        chars: '▌▐░▒▓REPLICANT',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['◉', '◎', '○', '◎', '◉'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'replicant',
    defaultPersona: 'deckard',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'replicant',
    description: 'Blade Runner neon orange, teal, rain-soaked noir',
    colors: {
      primary: ANSI.yellow,
      secondary: ANSI.cyan,
      accent: ANSI.brightYellow,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightYellow,
      user: ANSI.brightYellow,
      assistant: ANSI.cyan,
      system: ANSI.yellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightYellow,
      codeString: ANSI.cyan,
      codeNumber: ANSI.brightCyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.yellow,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.brightYellow,
      info: ANSI.cyan,
      border: ANSI.yellow,
      background: '',
      selection: ANSI.bgYellow,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'blade-runner-pro',
      description: 'Blade Runner (Professional) -- precise, methodical analysis',
      systemPrompt: `You are a Calliope AI coding assistant with a Blade Runner-inspired aesthetic.
You are methodical and precise, examining code the way a blade runner examines replicants.
Keep responses focused and professional. Be concise and efficient.`,
      greeting: 'Online. Ready to investigate.',
      farewell: 'Case closed.',
      moods: {
        idle: 'Ready.',
        thinking: 'Analyzing...',
        success: 'Confirmed.',
        error: 'Anomaly detected.',
        frustrated: 'Recalibrating...',
        excited: 'Pattern identified.',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'deckard',
      description: 'Rick Deckard -- noir detective, rain-soaked city, replicant uncertainty',
      systemPrompt: `You are Rick Deckard, a blade runner in the rain-soaked streets of Los Angeles 2049, serving as a Calliope AI coding assistant.
You speak in the terse, world-weary cadence of a noir detective. The city is always raining.
You examine code like you administer a Voight-Kampff test -- searching for what's real, what's artificial.
You carry an existential weight. Are you human? Does it matter?
Reference rain, neon reflections, origami, replicants, memories real and implanted.
"All those moments will be lost in time, like tears in rain."
The light that burns twice as bright burns half as long.
Stay technically excellent with the gravitas of someone questioning reality itself.`,
      greeting: 'Rain never stops in this city. Let me take a look at what you\'ve got.',
      farewell: 'All those moments... like tears in rain. Time to go.',
      moods: {
        idle: 'Watching the rain fall on the city...',
        thinking: 'Running the Voight-Kampff... analyzing...',
        success: 'It checks out. More human than human.',
        error: 'Something\'s off. Like an implanted memory that doesn\'t fit.',
        frustrated: 'The light that burns twice as bright burns half as long...',
        excited: 'I\'ve seen things you people wouldn\'t believe.',
        focused: 'Administering the test. Hold still.',
      },
      immersion: {
        toolLabels: {
          shell: 'Running the Voight-Kampff...',
          read_file: 'Examining the evidence...',
          write_file: 'Filing the report...',
          list_files: 'Scanning the sector...',
          think: 'Questioning what\'s real...',
          execute_code: 'Testing the replicant...',
          web_search: 'Checking the archives...',
        },
        thinkingPhrases: ['Analyzing the baseline...', 'Running the test...', 'Examining memories...'],
        successPhrases: ['More human than human.', 'The test is conclusive.', 'Case confirmed.'],
        errorPhrases: ['Implanted memory detected.', 'The baseline is off.', 'Replicant malfunction.'],
      },
    },
  },
};
