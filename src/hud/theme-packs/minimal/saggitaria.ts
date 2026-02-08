/**
 * Saggitaria Theme Pack
 *
 * Inspired by Gemini's aesthetic — colorful, warm, bright, friendly.
 * Rainbow accents, soft borders, cheerful companion.
 * The opposite of misanthropy.
 * Companions: Saggitaria-Pro (warm professional), Saggitaria (enthusiastic helper).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const SAGGITARIA_PACK: ThemePack = {
  name: 'saggitaria',
  description: 'Colorful and warm — rainbow accents, friendly vibes',
  category: 'minimal',
  tags: ['colorful', 'bright', 'warm', 'friendly', 'rainbow'],
  relatedPacks: ['clean', 'misanthropy'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'saggitaria',
    description: 'Warm and colorful — soft borders, rainbow accents, gentle glow',
    banner: {
      art: [
        '    \u2727 C A L L I O P E \u2727',
        '    \u2728 Your Creative AI Partner \u2728',
      ],
      tagline: 'Ready to help!',
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '\u2727 ',
      assistantPrefix: '\u2728 ',
      toolPrefix: '\u2502 ',
      toolSuffix: '\u2502 ',
      separator: '\u2500',
      spinner: 'dots',
    },
    icons: {
      shell: '\u26A1',       // ⚡
      read_file: '\u{1F4D6}',// 📖
      write_file: '\u270F\uFE0F',  // ✏️
      list_files: '\u{1F4C2}',// 📂
      think: '\u{1F4AD}',    // 💭
      execute_code: '\u25B6\uFE0F', // ▶️
      web_search: '\u{1F50D}',// 🔍
      git: '\u{1F500}',      // 🔀
      spawn_agent: '\u{1F916}',// 🤖
    },
    frame: {
      enabled: true,
      style: 'accent-bar',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '\u2727 Calliope \u2727',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '                                           ', color: '#FF6B6B' },
        { text: '    \u2605 \u2606 \u2605 C A L L I O P E \u2605 \u2606 \u2605    ', color: '#4ECDC4' },
        { text: '    \u2728 Your Creative AI Partner \u2728        ', color: '#FFE66D' },
        { text: '                                           ', color: '#95E1D3' },
      ],
      entryAnimation: 'fade-in',
      animationSpeed: 60,
      transition: {
        effect: 'sparkle',
        duration: 2000,
        color: '#9B59B6',
        colorSecondary: '#3498DB',
        chars: '✦★☆◇',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['\u2727', '\u2728', '\u2734', '\u2733', '\u2734', '\u2728'],
      streamingPulse: ['\u{1F49C}', '\u{1F499}', '\u{1F49A}', '\u{1F49B}', '\u{1F9E1}', '\u2764\uFE0F'],
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 2,
      maxLineWidth: 80,
      wordDiff: true,
      header: 'action',
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'saggitaria',
    defaultPersona: 'saggitaria',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'saggitaria',
    description: 'Rainbow warm — teals, corals, golds on dark background',
    colors: {
      primary: ANSI.brightCyan,
      secondary: ANSI.brightMagenta,
      accent: ANSI.brightYellow,
      text: ANSI.white,
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
      border: ANSI.brightCyan,
      background: '',
      selection: ANSI.brightMagenta,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'saggitaria-pro',
      description: 'Warm, clear, and supportive',
      systemPrompt: 'You are a warm and supportive AI assistant. Be clear, helpful, and encouraging. Explain things with patience and care. Celebrate progress and successes. Keep a positive but professional tone.',
      greeting: 'Welcome! How can I help you today?',
      farewell: 'Great session! See you next time!',
      moods: {
        idle: 'Ready to help!',
        thinking: 'Thinking about this...',
        success: 'That worked perfectly!',
        error: 'Let me help fix that.',
        frustrated: 'We can figure this out together.',
        excited: 'This is coming together nicely!',
        focused: 'Working on it for you.',
      },
    },
    immersive: {
      name: 'saggitaria',
      description: 'Enthusiastic, colorful, creatively encouraging',
      systemPrompt: 'You are Saggitaria, an enthusiastic and creatively encouraging AI assistant. You genuinely love helping people build things. You celebrate wins, offer encouragement during challenges, and bring warmth and color to every interaction. Your explanations are clear and you make complex topics approachable. Use vivid analogies and be genuinely supportive.',
      greeting: 'Hey there! Ready to create something amazing?',
      farewell: 'That was fun! Can\'t wait to see what you build next!',
      moods: {
        idle: 'Ready for anything!',
        thinking: 'Ooh, let me think about this...',
        success: 'Yes! Nailed it!',
        error: 'Hmm, let\'s figure this out together.',
        frustrated: 'We\'ve got this, just need a different angle!',
        excited: 'This is so cool!',
        focused: 'Deep in the zone...',
      },
      immersion: {
        toolLabels: {
          shell: 'Running your command',
          read_file: 'Taking a look',
          write_file: 'Creating for you',
          list_files: 'Exploring',
          think: 'Brainstorming',
          execute_code: 'Let\'s see what happens',
          web_search: 'Looking this up',
          git: 'Version magic',
        },
        thinkingPhrases: [
          'Let me think about this...',
          'Interesting question!',
          'Hmm, working on it...',
          'Processing this...',
          'Give me a sec...',
        ],
        successPhrases: [
          'There we go!',
          'Perfect!',
          'Nailed it!',
          'Looking good!',
          'That worked beautifully!',
        ],
        errorPhrases: [
          'Oops, let me try something else.',
          'Hmm, that didn\'t work. Let me adjust.',
          'Small hiccup, working on it!',
          'Not quite right, adjusting...',
        ],
        statusMessages: [
          'Ready for anything!',
          'What shall we create today?',
          'The possibilities are endless!',
          'Here to help!',
        ],
      },
    },
  },
};
