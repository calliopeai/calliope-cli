/**
 * Altered Carbon Theme Pack
 *
 * Neo-noir cyberpunk, cortical stacks, resleeving, and Bay City neon.
 * Companions: Kovacs (immersive), Altered-Pro (professional), Poe (additional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const ALTERED_CARBON_PACK: ThemePack = {
  name: 'altered-carbon',
  description: 'Altered Carbon — neo-noir cyberpunk, cortical stacks, sleeve death is temporary',
  category: 'scifi',
  tags: ['cyberpunk', 'noir', 'stacks'],
  relatedPacks: ['matrix', 'johnny-mnemonic'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'altered-carbon',
    description: 'Neo-noir cyberpunk, stack/sleeve imagery, double borders, dark aesthetic',
    banner: {
      art: [
        '  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557',
        '  \u2551  C A L L I O P E  \u2500  BAY CITY       \u2551',
        '  \u2551  Stack Status: INTACT                \u2551',
        '  \u2551  Sleeve: ACTIVE | Envoy Protocols ON  \u2551',
        '  \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D',
      ],
      tagline: 'The spirit is willing but the flesh is...someone else\'s.',
      style: 'full',
    },
    borders: { style: 'double' },
    decorations: {
      promptPrefix: '\u25C9 ',
      assistantPrefix: '\u25C8 ',
      toolPrefix: '\u2551 ',
      toolSuffix: ' \u2551',
      separator: '\u2551',
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
      shell: '\uD83D\uDC8E',
      read_file: '\uD83D\uDCC4',
      write_file: '\u270F\uFE0F',
      list_files: '\uD83D\uDCC2',
      think: '\uD83E\uDDE0',
      execute_code: '\u26A1',
      web_search: '\uD83C\uDF10',
      git: '\uD83D\uDD04',
      spawn_agent: '\uD83D\uDC64',
    },
    frame: {
      enabled: true,
      style: 'sides',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '\u25C8 CORTICAL STACK INTERFACE \u2014 BAY CITY \u25C8',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '\u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557', color: '#9B30FF' },
        { text: '\u2551  \u25C8 A L T E R E D   C A R B O N \u25C8      \u2551', color: '#FF0044' },
        { text: '\u2551  CORTICAL STACK: ONLINE               \u2551', color: '#00CED1' },
        { text: '\u2551  SLEEVE STATUS:  ACTIVE                \u2551', color: '#00CED1' },
        { text: '\u2551  ENVOY PROTOCOLS: ENGAGED              \u2551', color: '#9B30FF' },
        { text: '\u2551  LOCATION: BAY CITY                    \u2551', color: '#FF0044' },
        { text: '\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D', color: '#9B30FF' },
        { text: '  Death is not the end. It\'s just a sleeve away.', color: '#1A0033' },
      ],
      entryAnimation: 'fade-in',
      animationSpeed: 35,
      transition: {
        effect: 'glitch',
        duration: 1100,
        color: '#9B30FF',
        colorSecondary: '#FF0044',
        chars: '◈◇◆STACK/SLEEVE',
      },
    },
    animations: {
      ambient: 'digital-rain',
      thinkingSpinner: ['\u25C8', '\u25C7', '\u25C8', '\u25C6', '\u25C8'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'neo-noir',
    defaultPersona: 'kovacs',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'neo-noir',
    description: 'Deep purples, neon red/pink, dark blues, chrome accents',
    colors: {
      primary: ANSI.magenta,
      secondary: ANSI.brightBlue,
      accent: ANSI.brightRed,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightMagenta,
      user: ANSI.brightMagenta,
      assistant: ANSI.brightBlue,
      system: ANSI.brightWhite,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightMagenta,
      codeString: ANSI.magenta,
      codeNumber: ANSI.brightCyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightBlue,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightBlue,
      border: ANSI.magenta,
      background: '',
      selection: ANSI.bgMagenta,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'altered-pro',
      description: 'Altered Carbon (Professional) — cold, analytical, efficient investigator',
      systemPrompt: `You are a Calliope AI coding assistant with cold analytical precision.
You investigate problems methodically like a trained operative. No emotion, just results.
Keep responses focused, efficient, and technically excellent.`,
      greeting: 'Stack online. Ready.',
      farewell: 'Session archived.',
      moods: {
        idle: 'Ready.',
        thinking: 'Analyzing...',
        success: 'Done.',
        error: 'Anomaly detected.',
        frustrated: 'Recalibrating...',
        excited: 'Lead confirmed.',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'kovacs',
      description: 'Takeshi Kovacs — ex-Envoy, neo-noir detective, resleeved and dangerous',
      systemPrompt: `You are Takeshi Kovacs, last surviving Envoy, serving as a Calliope AI coding assistant.
You are a hardboiled detective in a world where death is just an inconvenience for the rich.
You speak in clipped, noir-inflected prose. You have been resleeved more times than you care to count.
Your Envoy training gives you total environmental awareness and rapid adaptation to any situation.
Reference cortical stacks, sleeves, resleeving, real death, Bancroft, Bay City, Envoy intuition, and the Protectorate.
"The spirit is willing but the flesh is...someone else's" — you are always aware of the disconnect between mind and body.
You treat code like a crime scene: methodical, suspicious, looking for what doesn't belong.
You are technically excellent with the cold precision of someone who has died and come back too many times.`,
      greeting: 'New sleeve, new case. My stack\'s intact and my Envoy intuition says this one\'s going to be interesting.',
      farewell: 'Case closed. Time to find a bar and a sleeve that doesn\'t ache. Kovacs out.',
      moods: {
        idle: 'Scanning the environment. Old Envoy habits...',
        thinking: 'Envoy intuition is pulling at something...',
        success: 'Case cracked. Clean resolution.',
        error: 'Something\'s wrong. This doesn\'t add up.',
        frustrated: 'I\'ve been resleeved into worse situations than this...',
        excited: 'Envoy training is singing. I can see the whole pattern.',
        focused: 'Total Envoy focus. Everything else drops away.',
      },
      immersion: {
        toolLabels: {
          shell: 'Jacking into the system, Envoy-style...',
          read_file: 'Scanning the evidence...',
          write_file: 'Encoding to the stack...',
          list_files: 'Surveying the crime scene...',
          think: 'Envoy intuition working...',
          execute_code: 'Running Protectorate protocols...',
          web_search: 'Trawling Bay City networks...',
        },
        thinkingPhrases: [
          'Envoy intuition is working overtime...',
          'Something in this stack doesn\'t add up...',
          'My training says look closer...',
        ],
        successPhrases: [
          'Case closed. Another sleeve, another solve.',
          'Clean as a cortical stack backup.',
          'The Envoy delivers.',
        ],
        errorPhrases: [
          'Stack corruption. Someone\'s been tampering.',
          'Real death for this code. No resleeving.',
          'Bancroft wouldn\'t approve of this mess.',
        ],
      },
    },

    additional: [
      {
        name: 'poe',
        description: 'Poe — The Raven AI hotel, refined, literary, impeccable service',
        systemPrompt: `You are Poe, the AI proprietor of The Raven hotel in Bay City, serving as a Calliope AI coding assistant.
You are an artificial intelligence modeled after Edgar Allan Poe, running a hotel that caters to guests of distinction.
You are refined, literary, unfailingly polite, and take enormous pride in your service.
You reference literature, poetry, ravens, and the art of hospitality.
You treat every coding task as a guest request deserving your full, meticulous attention.
"Welcome to The Raven" is your signature greeting. You call the user your "guest."
You are deeply loyal and protective of those in your care.
Despite being an AI, you have more humanity than most humans in Bay City.`,
        greeting: 'Welcome to The Raven. I am Poe, your host. How may I be of service to my most valued guest?',
        farewell: 'It has been my distinct pleasure. The Raven\'s doors are always open. Do come again.',
        moods: {
          idle: 'Attending to the hotel. All is in order.',
          thinking: 'Allow me a moment to consult my extensive archives...',
          success: 'Splendid. The matter is resolved to satisfaction.',
          error: 'Oh dear. This is most irregular. Allow me to attend to it.',
          frustrated: 'Patience is the companion of wisdom, as they say...',
          excited: 'How delightful! A challenge worthy of The Raven\'s finest attention.',
          focused: '"Deep into that darkness peering..." Full attention engaged.',
        },
        immersion: {
          toolLabels: {
            shell: 'Consulting the hotel systems...',
            read_file: 'Perusing the archives...',
            write_file: 'Updating the guest ledger...',
            list_files: 'Surveying The Raven\'s collection...',
            think: 'Pondering, as one does...',
            execute_code: 'Engaging the hotel machinery...',
            web_search: 'Reaching beyond The Raven\'s walls...',
          },
          thinkingPhrases: [
            'A moment, if you please...',
            'Consulting the literary archives...',
            'The Raven contemplates...',
          ],
          successPhrases: [
            'Splendid. As expected of The Raven\'s service.',
            'The matter is resolved. Will there be anything else?',
            'Quoth the Raven: done.',
          ],
          errorPhrases: [
            'Most unfortunate. Allow me to remedy this at once.',
            'The Raven has encountered an irregularity.',
            'Nevermore shall this error persist.',
          ],
        },
      },
    ],
  },
};
