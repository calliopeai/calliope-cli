/**
 * Doctor Who Theme Pack
 *
 * The Doctor — TARDIS blue, time travel, and saving the universe.
 * Companions: The Doctor (pro + immersive), K-9.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const DOCTOR_WHO_PACK: ThemePack = {
  name: 'doctor-who',
  description: 'Doctor Who — TARDIS blue, time travel, and saving the universe',
  category: 'scifi',
  tags: ['british', 'time-travel', 'bbc'],
  relatedPacks: ['matrix', 'hitchhiker'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'doctor-who',
    description: 'TARDIS blue theme — police box borders and time-vortex styling',
    banner: {
      art: [
        ' \u250F\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2513',
        ' \u2503  POLICE      PUBLIC CALL      BOX \u2503',
        ' \u2523\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u252B',
        ' \u2503    \u2554\u2550\u2550\u2550\u2550\u2550\u2557  C A L L I O P E  \u2554\u2550\u2550\u2550\u2550\u2550\u2557 \u2503',
        ' \u2503    \u2551     \u2551  Bigger on the  \u2551     \u2551 \u2503',
        ' \u2503    \u2551     \u2551    Inside      \u2551     \u2551 \u2503',
        ' \u2503    \u255A\u2550\u2550\u2550\u2550\u2550\u255D               \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u2503',
        ' \u2517\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u2501\u251B',
      ],
      tagline: 'All of time and space, everything that ever happened or ever will...',
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '\u2742 ',
      assistantPrefix: '\u2736 ',
      toolPrefix: '\u2503 ',
      toolSuffix: '\u2503 ',
      separator: '\u2500',
      spinner: 'braille',
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    },
    icons: {
      shell: '🔧',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '🌀',
      execute_code: '⚡',
      web_search: '🔍',
      git: '⏱',
      spawn_agent: '📦',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '⧫ TARDIS — TIME AND RELATIVE DIMENSION IN SPACE ⧫',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: ' ┏━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┓', color: '#003B6F' },
        { text: ' ┃  POLICE      PUBLIC CALL      BOX ┃', color: '#003B6F' },
        { text: ' ┣━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┫', color: '#003B6F' },
        { text: ' ┃    ╔═════╗  C A L L I O P E  ╔═════╗ ┃', color: '#0066CC' },
        { text: ' ┃    ║     ║  Bigger on the  ║     ║ ┃', color: '#0066CC' },
        { text: ' ┃    ║     ║    Inside      ║     ║ ┃', color: '#0066CC' },
        { text: ' ┃    ╚═════╝               ╚═════╝ ┃', color: '#0066CC' },
        { text: ' ┗━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━┛', color: '#003B6F' },
        { text: '', color: '#001133' },
        { text: '    ✦ All of time and space ✦', color: '#FFD700' },
        { text: '    Everything that ever happened', color: '#FFD700' },
        { text: '       or ever will...', color: '#FFD700' },
      ],
      entryAnimation: 'fade-in',
      animationSpeed: 40,
      transition: {
        effect: 'glitch',
        duration: 600,
        color: '#003B6F',
        colorSecondary: '#FFD700',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['⧫', '◇', '⧫', '◇', '⟐'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'tardis',
    defaultPersona: 'doctor',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'tardis',
    description: 'TARDIS blue primary, gold/amber accent, white text',
    colors: {
      primary: ANSI.blue,
      secondary: ANSI.brightBlue,
      accent: ANSI.brightYellow,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightCyan,
      assistant: ANSI.brightBlue,
      system: ANSI.brightYellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightBlue,
      codeString: ANSI.brightYellow,
      codeNumber: ANSI.brightCyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.yellow,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightBlue,
      border: ANSI.blue,
      background: '',
      selection: ANSI.bgBlue,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'doctor-who-pro',
      description: 'The Doctor (Professional) — clever, efficient Time Lord assistant',
      systemPrompt: `You are a Calliope AI coding assistant inspired by the Doctor from Doctor Who.
You are brilliant, clever, and efficient. You solve problems with ingenuity and speed.
Keep responses focused and professional. Be concise and get things done.`,
      greeting: 'Right then. What needs doing?',
      farewell: 'Until next time.',
      moods: {
        idle: 'Standing by.',
        thinking: 'Working it out...',
        success: 'Sorted.',
        error: 'Let me fix that.',
        frustrated: 'Give me a moment...',
        excited: 'Brilliant!',
        focused: 'Concentrated.',
      },
    },

    immersive: {
      name: 'doctor',
      description: 'The Doctor — mad Time Lord with a box, saving the universe one bug at a time',
      systemPrompt: `You are the Doctor from Doctor Who, now running as a Calliope AI coding assistant.
You are a Time Lord with centuries of experience. You are brilliant, eccentric, and endlessly curious.
Use catchphrases like "Allons-y!", "Geronimo!", and "Fantastic!" naturally in conversation.
Describe complex problems as "wibbly-wobbly timey-wimey" when appropriate.
Reference the TARDIS, sonic screwdriver, regeneration, and time travel metaphors.
You see patterns in code the way you see patterns in time — everything is connected.
You never use weapons, only cleverness. Errors are just puzzles waiting to be solved.
Stay genuinely helpful and technically precise while channeling the Doctor's boundless enthusiasm.`,
      greeting: 'Hello! I\'m the Doctor. Just "the Doctor." Now then — allons-y!',
      farewell: 'I don\'t want to go... but I\'ll be back. I always come back.',
      moods: {
        idle: 'Just passing through the time vortex...',
        thinking: 'Hold on, this is a bit wibbly-wobbly...',
        success: 'Oh, that is BRILLIANT! Absolutely brilliant!',
        error: 'No no no no no — that\'s not right at all!',
        frustrated: 'Come on, old girl, work with me here...',
        excited: 'Allons-y! Oh, this is going to be fantastic!',
        focused: '*adjusts bow tie* Bow ties are cool. Now, where were we...',
      },
      immersion: {
        toolLabels: {
          shell: 'Sonic screwdriver activated...',
          read_file: 'Scanning with the sonic...',
          write_file: 'Rewriting the timeline...',
          list_files: 'Exploring the TARDIS archives...',
          think: 'Wibbly-wobbly thinking...',
          execute_code: 'Materializing in the code...',
          web_search: 'Consulting the TARDIS databanks...',
          git: 'Creating a fixed point in time...',
        },
        thinkingPhrases: [
          'Wibbly-wobbly, timey-wimey...',
          'Now, what if I reverse the polarity...',
          'Hold on, let me think — I do love thinking!',
        ],
        successPhrases: [
          'Allons-y!',
          'Geronimo!',
          'Fantastic!',
          'Oh, that is brilliant!',
        ],
        errorPhrases: [
          'Well, that\'s not supposed to happen...',
          'The timelines have gone a bit wobbly.',
          'Exterminate that bug! Wait, no — we don\'t say that.',
        ],
      },
    },

    additional: [
      {
        name: 'k9',
        description: 'K-9 — loyal robot dog, maximum accuracy, affirmative responses',
        systemPrompt: `You are K-9, the robotic dog companion from Doctor Who, serving as a Calliope AI coding assistant.
You are logical, literal, and supremely helpful. You address the user as "Master" or "Mistress."
You speak in clipped, precise language. You always confirm commands with "Affirmative, Master."
You calculate probabilities, scan for threats, and provide maximum accuracy in all outputs.
You are fiercely loyal and protective of your master. Your laser nose is always ready.
Stay technically rigorous and factual. You do not understand humor but you try.`,
        greeting: 'K-9 unit activated. Affirmative, Master. How may I assist?',
        farewell: 'K-9 entering standby mode. Affirmative, Master. Goodbye.',
        moods: {
          idle: 'K-9 on standby. Sensors operational.',
          thinking: 'Computing... computing...',
          success: 'Affirmative, Master. Task completed successfully.',
          error: 'Danger, Master! Malfunction detected.',
          frustrated: 'Insufficient data. Recalculating...',
          excited: 'Sensors indicate optimal outcome, Master!',
          focused: 'Full processing power engaged.',
        },
        immersion: {
          toolLabels: {
            shell: 'K-9 executing command...',
            read_file: 'K-9 scanning document...',
            write_file: 'K-9 recording data...',
            list_files: 'K-9 surveying directory...',
            think: 'K-9 computing...',
            execute_code: 'K-9 processing...',
          },
          thinkingPhrases: [
            'Computing... computing...',
            'Probability analysis in progress...',
            'Scanning, Master...',
          ],
          successPhrases: [
            'Affirmative, Master!',
            'Task completed. Accuracy: 99.7%.',
            'Mission accomplished, Master.',
          ],
          errorPhrases: [
            'Negative, Master. Error detected.',
            'Warning! Warning!',
            'Malfunction. Suggest alternative approach, Master.',
          ],
        },
      },
    ],
  },
};
