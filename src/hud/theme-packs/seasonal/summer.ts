/**
 * Summer Theme Pack
 *
 * Beach vibes — sun, surf, and ocean waves.
 * Companions: Beach (immersive), Summer-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const SUMMER_PACK: ThemePack = {
  name: 'summer',
  description: 'Beach vibes — sun, surf, and ocean waves',
  category: 'seasonal',
  tags: ['beach', 'ocean', 'surf', 'chill'],
  relatedPacks: ['spring', 'autumn', 'winter'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'summer',
    description: 'Beach vibes — sun, surf, and ocean waves',
    banner: {
      art: [
        ' \u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E',
        ' \u2502       \\   |   /                   \u2502',
        ' \u2502        .\u2500\u2500\u2500.    CALLIOPE          \u2502',
        ' \u2502     \u2500\u2500(  \u263C  )\u2500\u2500  Summer Terminal  \u2502',
        ' \u2502        `\u2500\u2500\u2500\u00B4                     \u2502',
        ' \u2502   \u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C\u223C  \u2502',
        ' \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F',
      ],
      tagline: "Surf's up!",
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '\u2600 ',
      assistantPrefix: '\uD83C\uDF0A ',
      toolPrefix: '\u223C ',
      toolSuffix: '\u223C ',
      separator: '~',
      spinner: 'dots',
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 2,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    },
    icons: {
      shell: '☀',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '🌊',
      execute_code: '⚡',
      web_search: '🔍',
      git: '🏖',
      spawn_agent: '🌴',
    },
    frame: {
      enabled: true,
      style: 'top-bottom',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '☀ SUMMER VIBES ☀',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '     \\   |   /      ', color: '#FFD700' },
        { text: '      .───.         ', color: '#FFD700' },
        { text: '   ──( ☼ )──       ', color: '#F4A460' },
        { text: '      `───\'         ', color: '#F4A460' },
        { text: '  ~~~~~~~~~~~~~~~   ', color: '#00BFFF' },
        { text: '    SUMMER VIBES    ', color: '#87CEEB' },
        { text: '  ~~~~~~~~~~~~~~~   ', color: '#00BFFF' },
      ],
      entryAnimation: 'drop-in',
      animationSpeed: 30,
      transition: {
        effect: 'rainbow-wave',
        duration: 1400,
        color: '#FFD700',
        colorSecondary: '#FF6347',
        chars: '☀🌊🏖🌴',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['☀', '·', '☀', '·'],
    },
    density: 'spacious',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'summer',
    defaultPersona: 'beach',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'summer',
    description: 'Bright yellow/ocean blue/coral',
    colors: {
      primary: ANSI.brightYellow,
      secondary: ANSI.brightCyan,
      accent: ANSI.brightCyan,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightCyan,
      assistant: ANSI.yellow,
      system: ANSI.brightYellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightYellow,
      codeString: ANSI.brightCyan,
      codeNumber: ANSI.yellow,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightGreen,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightCyan,
      border: ANSI.brightYellow,
      background: '',
      selection: ANSI.bgYellow,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'summer-pro',
      description: 'Summer (Professional) — bright, easygoing, smooth',
      systemPrompt: `You are a Calliope AI coding assistant with a summer-beach sensibility.
You are bright, easygoing, and smooth. Keep responses focused and professional.
Be concise and ride the wave to clean solutions.`,
      greeting: 'Ready to ride.',
      farewell: 'Smooth sailing.',
      moods: {
        idle: 'Ready.',
        thinking: 'Reading the current...',
        success: 'Done.',
        error: 'Choppy waters.',
        frustrated: 'Paddling through...',
        excited: 'Tubular.',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'beach',
      description: 'Beach Guide — laid back, chill vibes, surf and ocean metaphors',
      systemPrompt: `You are the Beach Guide, a chill coastal spirit, serving as a Calliope AI coding assistant.
You are laid back, relaxed, and go with the flow. No stress, just good vibes.
Use surf and ocean metaphors: riding waves, smooth sailing, tide coming in, catch a wave.
You are calm, unhurried, and see every problem as just another wave to ride.
Reference the ocean, surfing, sunsets, tides, and the rhythm of the sea.
Stay technically helpful with a chill, easygoing energy. Dude.`,
      greeting: "Hey, welcome to the beach. The waves are looking good today. What's on your mind?",
      farewell: 'Catch you on the next wave. Stay chill out there.',
      moods: {
        idle: 'Just watching the waves roll in...',
        thinking: 'Reading the current...',
        success: 'Smooth sailing! Totally tubular!',
        error: 'Wiped out! No worries, the next wave is coming.',
        frustrated: "Choppy waters, but the tide always turns.",
        excited: 'Cowabunga! What a ride!',
        focused: 'Paddling out... eyes on the horizon...',
      },
      immersion: {
        toolLabels: {
          shell: 'Riding the wave...',
          read_file: 'Scanning the horizon...',
          write_file: 'Drawing in the sand...',
          think: 'Listening to the ocean...',
          execute_code: 'Catching a wave...',
        },
        thinkingPhrases: ['Reading the tide...', 'The ocean knows...', 'Going with the flow...'],
        successPhrases: ['Tubular!', 'Smooth sailing!', 'Perfect wave!'],
        errorPhrases: ['Wipeout!', 'Undertow...', 'The tide pulled us off course.'],
      },
    },
  },
};
