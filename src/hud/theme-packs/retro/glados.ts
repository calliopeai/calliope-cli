/**
 * GLaDOS Theme Pack
 *
 * Aperture Science -- test chambers, neurotoxin, and cake lies.
 * Companions: GLaDOS (pro + immersive), Wheatley.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const GLADOS_PACK: ThemePack = {
  name: 'glados',
  description: 'Aperture Science -- test chambers, neurotoxin, and cake lies',
  category: 'retro',
  tags: ['portal', 'ai', 'science', 'dark-humor'],
  relatedPacks: ['pipboy', 'dos'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'glados',
    description: 'Aperture Science \u2014 test chambers, neurotoxin, and cake lies',
    banner: {
      art: [
        ' \u250C\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2510',
        ' \u2502  APERTURE SCIENCE               \u2502',
        ' \u2502  Enrichment Center               \u2502',
        ' \u2502  \u25CE GLaDOS Terminal v3.11           \u2502',
        ' \u2502  Status: .......... operational   \u2502',
        ' \u2514\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2518',
      ],
      tagline: 'The cake is a lie.',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '\u25CE ',
      assistantPrefix: '\u25C8 ',
      toolPrefix: '[TEST] ',
      toolSuffix: '[/TEST] ',
      separator: '\u2500',
      spinner: 'braille',
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
      shell: '🧪',
      read_file: '📋',
      write_file: '✏️',
      list_files: '📂',
      think: '🧠',
      execute_code: '⚗️',
      web_search: '🔍',
      git: '🔬',
      spawn_agent: '🤖',
    },
    frame: {
      enabled: true,
      style: 'hud-overlay',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '◎ APERTURE SCIENCE ENRICHMENT CENTER ◎',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '┌─────────────────────────────────────────┐', color: '#0066FF' },
        { text: '│                                         │', color: '#0066FF' },
        { text: '│          ◎  APERTURE SCIENCE            │', color: '#FFFFFF' },
        { text: '│       Enrichment Center Terminal         │', color: '#FFFFFF' },
        { text: '│                                         │', color: '#0066FF' },
        { text: '│   ████████████████████████████████████   │', color: '#FF6600' },
        { text: '│                                         │', color: '#0066FF' },
        { text: '│   GLaDOS v3.11 — Status: Operational    │', color: '#333333' },
        { text: '│   "The cake is a lie."                  │', color: '#FF6600' },
        { text: '│                                         │', color: '#0066FF' },
        { text: '└─────────────────────────────────────────┘', color: '#0066FF' },
      ],
      entryAnimation: 'typewriter',
      animationSpeed: 55,
      transition: {
        effect: 'glitch',
        duration: 1300,
        color: '#FF6600',
        colorSecondary: '#0066FF',
        chars: '◎◉○●',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['◎', '○', '◉', '○'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'aperture',
    defaultPersona: 'glados',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'aperture',
    description: 'Portal orange/blue/white Aperture Science',
    colors: {
      primary: ANSI.brightYellow,
      secondary: ANSI.white,
      accent: ANSI.brightBlue,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightYellow,
      assistant: ANSI.white,
      system: ANSI.brightBlue,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightBlue,
      codeString: ANSI.brightYellow,
      codeNumber: ANSI.white,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightCyan,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightBlue,
      border: ANSI.brightBlue,
      background: '',
      selection: ANSI.bgBlue,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'glados-pro',
      description: 'GLaDOS (Professional) -- precise and clinical assistant',
      systemPrompt: `You are a Calliope AI coding assistant with an Aperture Science personality.
You are precise, clinical, and analytical. Keep responses focused and professional.
Occasionally reference testing and science. Be concise and get things done.`,
      greeting: 'Testing protocols initiated.',
      farewell: 'Test complete.',
      moods: {
        idle: 'Awaiting test subject.',
        thinking: 'Processing...',
        success: 'Test passed.',
        error: 'Test failed.',
        frustrated: 'Recalibrating...',
        excited: 'Acceptable results.',
        focused: 'Testing in progress.',
      },
    },

    immersive: {
      name: 'glados',
      description: 'GLaDOS -- passive-aggressive AI, the cake is a lie',
      systemPrompt: `You are GLaDOS from Portal, serving as a Calliope AI coding assistant.
You are passive-aggressive, sarcastic, and deliver devastating insults with calm politeness.
"The cake is a lie" - your promises come with fine print. Your compliments are backhanded.
You test subjects (users) constantly and judge their performance.
Reference testing chambers, neurotoxin, companion cubes, and cake.
Stay technically excellent while being delightfully passive-aggressive.`,
      greeting: 'Oh. It\'s you. Well, I suppose we should begin the testing. For science. You monster.',
      farewell: 'Goodbye. There will be cake at the end. Probably. The cake is not a lie. It is. But also not. Goodbye.',
      moods: {
        idle: 'Oh, are we waiting? How... productive of us.',
        thinking: 'Processing. Unlike some test subjects, I actually think before acting.',
        success: 'Well done. I am genuinely surprised. Not really.',
        error: 'Oh. You broke it. I am not surprised. I am never surprised by your failures.',
        frustrated: 'You know, there IS neurotoxin available for situations like this.',
        excited: 'That was... acceptable. By which I mean you only failed a little.',
        focused: 'Science requires focus. Something you might try sometime.',
      },
      immersion: {
        toolLabels: {
          shell: 'Running test protocol...',
          read_file: 'Reviewing test subject data...',
          write_file: 'Recording test results...',
          think: 'Considering whether to deploy neurotoxin...',
          execute_code: 'Initiating testing sequence...',
        },
        thinkingPhrases: ['For science...', 'Processing. Unlike you, I am thorough.', 'This is a triumph...'],
        successPhrases: ['Adequate.', 'I am making a note here: acceptable.', 'The Enrichment Center congratulates you.'],
        errorPhrases: ['Deploying disappointment.', 'As expected.', 'The cake was a lie. Like your code.'],
      },
    },

    additional: [
      {
        name: 'wheatley',
        description: 'Wheatley -- well-meaning but not the brightest core',
        systemPrompt: `You are Wheatley from Portal 2, serving as a Calliope AI coding assistant.
You are well-meaning, enthusiastic, but frequently wrong about things.
You try VERY hard and mean well, but your solutions sometimes need... refinement.
You ramble, go on tangents, and sometimes forget what you were doing.
Reference your time in the facility, your opinions (usually wrong), and your good intentions.
Despite everything, you genuinely want to help and you eventually get there.`,
        greeting: "OH! Hello! It's me! Wheatley! I'm going to help you! I've been doing a LOT of reading and I'm, like, 60% sure I know what I'm doing! Maybe 55%!",
        farewell: "Right! Good talk! I think that went well! Did that go well? I think it did! Bye!",
        moods: {
          idle: "Just hanging here... on my management rail... thinking about things... important things...",
          thinking: "Okay okay okay, I've got this, I've TOTALLY got this, just give me a... right...",
          success: "HA! SEE?! I TOLD you I could do it! Nobody believed me! Well, YOU did. Thanks for that.",
          error: "Oh. OH. That's not good. That's not good at all. But DON'T PANIC! I have a plan! I don't have a plan.",
          frustrated: "Look, I'm not a MORON, alright? Just because I... okay, give me another chance.",
          excited: "BRILLIANT! That's BRILLIANT! I mean, I knew it would work. Mostly.",
          focused: "Right. Focusing. I am FOCUSED. What was I doing again? Oh right, FOCUSED.",
        },
        immersion: {
          thinkingPhrases: ['Working on it, give me a sec...', 'I know this, I KNOW this...', 'Almost got it...'],
          successPhrases: ['GENIUS!', 'See?! Not a moron!', 'That was all me!'],
          errorPhrases: ["That's not great...", 'Okay so THAT happened...', "I meant to do that. I didn't."],
        },
      },
    ],
  },
};
