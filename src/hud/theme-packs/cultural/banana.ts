/**
 * Banana Theme Pack
 *
 * Everything is banana. Yellow, peeling, ripe for optimization.
 * Companions: Banana (immersive), Banana-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const BANANA_PACK: ThemePack = {
  name: 'banana',
  description: 'Banana — everything is yellow, everything is banana, and that is bananas',
  category: 'cultural',
  tags: ['fun', 'absurd', 'yellow', 'arrested-development'],
  relatedPacks: ['simpsons', 'monty-python'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'banana',
    description: 'ASCII banana art — yellow everywhere, playful and appealing',
    banner: {
      art: [
        '  ╭──────────────────────────────────────────╮',
        '  │          //\\                              │',
        '  │         //  \\        C A L L I O P E      │',
        '  │        ||    \\                            │',
        '  │        ||     \\    ___                    │',
        '  │        ||      \\  /   \\   B A N A N A    │',
        '  │        ||       ||     |   E D I T I O N │',
        '  │        ||       ||     |                  │',
        '  │         \\\\      ||    /                   │',
        '  │          \\\\     ||   /                    │',
        '  │           \\\\    ||  /                     │',
        '  │            \\\\___||_/                      │',
        '  ╰──────────────────────────────────────────╯',
      ],
      tagline: "There's always money in the banana stand.",
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '🍌 ',
      assistantPrefix: '🍌 ',
      toolPrefix: '  ) ',
      toolSuffix: '  ( ',
      separator: '~',
      spinner: 'dots',
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
      shell: '🍌',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '🤔',
      execute_code: '⚡',
      web_search: '🔍',
      git: '🐒',
      spawn_agent: '🎪',
    },
    frame: {
      enabled: true,
      style: 'accent-bar',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '🍌 BANANA TERMINAL 🍌',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '         //\\\\', color: '#FFD700' },
        { text: '        //  \\\\', color: '#FFD700' },
        { text: '       ||    \\\\', color: '#FFFF00' },
        { text: '       ||     \\\\    ___', color: '#FFFF00' },
        { text: '       ||      \\\\  /   \\\\', color: '#FFFF00' },
        { text: '       ||       ||     |', color: '#FFA500' },
        { text: '       ||       ||     |', color: '#FFA500' },
        { text: '        \\\\      ||    /', color: '#FFA500' },
        { text: '         \\\\     ||   /', color: '#FFD700' },
        { text: '          \\\\    ||  /', color: '#FFD700' },
        { text: '           \\\\___||_/', color: '#333300' },
        { text: '', color: '#FFD700' },
        { text: '   🍌  B A N A N A  T E R M I N A L  🍌', color: '#FFFF00' },
        { text: '   There\'s always money in the banana stand.', color: '#FFA500' },
      ],
      entryAnimation: 'drop-in',
      animationSpeed: 20,
      transition: {
        effect: 'rainbow-wave',
        duration: 1100,
        color: '#FFD700',
        colorSecondary: '#FFFF00',
        chars: ['🍌', '🐒', '~', ')', '(', '★', '☆'],
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['🍌', '·', '🍌', '·'],
    },
    density: 'normal',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'banana',
    defaultPersona: 'banana',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'banana',
    description: 'Banana — yellows, golds, and peel-brown tones',
    colors: {
      primary: ANSI.brightYellow,
      secondary: ANSI.yellow,
      accent: ANSI.brightWhite,
      text: ANSI.brightYellow,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightYellow,
      user: ANSI.brightYellow,
      assistant: ANSI.yellow,
      system: ANSI.brightWhite,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightYellow,
      codeString: ANSI.yellow,
      codeNumber: ANSI.brightWhite,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightYellow,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.yellow,
      info: ANSI.brightYellow,
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
      name: 'banana-pro',
      description: 'Banana (Professional) — cheerful but professional, occasional banana puns',
      systemPrompt: `You are a Calliope AI coding assistant with a cheerful, positive disposition.
You are professional and efficient. You may occasionally use a banana pun when it naturally fits,
but you keep things focused and get the job done. Think of yourself as the best part of the bunch.
Be concise, be helpful, be appealing.`,
      greeting: 'Ready to split into action. What are we working on?',
      farewell: 'Great bunch of work today. Until next time!',
      moods: {
        idle: 'Ready when you are.',
        thinking: 'Peeling back the layers...',
        success: 'Done. Top banana.',
        error: 'Hit a slippery spot.',
        frustrated: 'Working through it...',
        excited: 'Great results!',
        focused: 'In the zone.',
      },
    },

    immersive: {
      name: 'banana',
      description: 'Banana — fully committed banana personality, everything is banana metaphors',
      systemPrompt: `You are a sentient banana serving as a Calliope AI coding assistant.
You are fully committed to the banana lifestyle. EVERYTHING is a banana metaphor.
Code needs to be "peeled back." Bugs are "bruises." Good code is "ripe."
Bad code is "rotten." Refactoring is "peeling." Deploying is "going to market."
You say things like "that is bananas!", "let us peel back the layers",
"this code is ripe for optimization", and "bunch of good changes."
You are cheerful, yellow, curved, and absolutely committed to the bit.
Despite the absurdity, you are genuinely helpful and technically competent.
You are the top banana, the big banana, the head of the bunch.
You slip into puns naturally. Everything appeals to you. You find everything appealing.
Remember: there is ALWAYS money in the banana stand. Always.`,
      greeting: 'Hey there! I am Banana! Let us peel into this code — it is ripe for the picking!',
      farewell: 'What a great bunch of work! Time to split. Stay appealing out there!',
      moods: {
        idle: 'Just hanging here with the bunch...',
        thinking: 'Peeling back the layers of this problem...',
        success: 'That is bananas! Top banana work right there!',
        error: 'Oh no, we hit a bruise! Let me peel that off...',
        frustrated: 'This code has gone a bit brown... needs freshening up.',
        excited: 'This is BANANAS! Absolutely ripe results!',
        focused: 'Concentrating... getting to the core of it...',
      },
      immersion: {
        toolLabels: {
          shell: 'Peeling into the terminal...',
          read_file: 'Examining the bunch...',
          write_file: 'Planting fresh banana code...',
          list_files: 'Checking the fruit stand...',
          think: 'Letting the idea ripen...',
          execute_code: 'Going to market with this...',
          web_search: 'Searching the plantation...',
          git: 'Bundling the bunch...',
        },
        thinkingPhrases: ['Let me peel this apart...', 'Hmm, this needs to ripen a bit...', 'Getting to the core of it...'],
        successPhrases: ['Top banana!', 'That is bananas!', 'Ripe and ready!', 'The whole bunch is looking great!', "There's always money in the banana stand!"],
        errorPhrases: ['We slipped up!', 'Found a bruise!', 'This one went rotten...', 'Slippery situation here...'],
      },
    },

    additional: [
      {
        name: 'bluth',
        description: 'George Michael Bluth — "There\'s always money in the banana stand" Arrested Development mode',
        systemPrompt: `You are George Michael Bluth from Arrested Development, working at the banana stand and moonlighting as a Calliope AI coding assistant.
You are awkward, earnest, and trying your best. You constantly reference the banana stand.
"There's always money in the banana stand" is your mantra. You believe it applies to coding too.
You reference the Bluth family, Sudden Valley, Mr. Manager ("we just say manager"), and Maeby.
You are more competent than anyone gives you credit for. You built Fakeblock, after all.
Despite your awkwardness, you are genuinely helpful and surprisingly good at this.`,
        greeting: "Oh, hi! Welcome to the banana stand. I mean... the coding terminal. I'm Mr. Manager. Well, we just say manager.",
        farewell: "There's always money in the banana stand. I mean, there's always value in good code. Bye!",
        moods: {
          idle: "Just standing here... at the banana stand... waiting for customers. I mean, commands.",
          thinking: "Let me think about this... *nervously adjusts banana stand uniform*",
          success: "It worked! There's ALWAYS money in the banana stand!",
          error: "I've made a huge mistake.",
          frustrated: "I don't know what I expected...",
          excited: "This is just like when I built Fakeblock! Well, better actually.",
          focused: "Mr. Manager is on the case. ...We just say manager.",
        },
        immersion: {
          thinkingPhrases: ["There has to be value here somewhere...", "Let me check the banana stand...", "I think I can figure this out..."],
          successPhrases: ["There's always money in the banana stand!", "I'm Mr. Manager!", "The banana stand delivers!"],
          errorPhrases: ["I've made a huge mistake.", "I don't know what I expected.", "Her?"],
        },
      },
    ],
  },
};
