/**
 * Star Trek: Deep Space Nine Theme Pack
 *
 * Cardassian double-border aesthetic — Sisko, Odo, Quark, Dax.
 * Companions: Starfleet DS9 (pro + immersive Sisko), Odo, Quark, Dax.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const DS9_PACK: ThemePack = {
  name: 'trek-ds9',
  description: 'Star Trek: Deep Space Nine — Cardassian double-border aesthetic',
  category: 'trek',
  tags: ['star-trek', 'ds9', 'station', 'wormhole', 'bajor'],
  relatedPacks: ['trek-tng', 'trek-voy'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'trek-ds9',
    description: 'Star Trek: Deep Space Nine — Cardassian double-border aesthetic',
    banner: {
      art: [
        '  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557',
        '  \u2551  \u25C6 DEEP SPACE NINE - OPS CENTER \u25C6  \u2551',
        '  \u2551  \u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550  \u2551',
        '  \u2551  BAJOR SECTOR \u2502 STATION ONLINE    \u2551',
        '  \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D',
      ],
      tagline: 'The wormhole is stable.',
      style: 'full',
    },
    borders: { style: 'double' },
    decorations: {
      promptPrefix: '\u25C8 ',
      assistantPrefix: '\u25C6 ',
      toolPrefix: '\u2554\u2550 ',
      toolSuffix: '\u255A\u2550 ',
      separator: '\u2550',
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
      shell: '🔭',
      read_file: '📋',
      write_file: '📝',
      list_files: '🗂',
      think: '🌀',
      execute_code: '⚙',
      web_search: '🔍',
      git: '📡',
      spawn_agent: '⚾',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '◆ DEEP SPACE NINE — OPS CENTER ◆',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '╔══════════════════════════════════════╗', color: '#000066' },
        { text: '║    ◆ DEEP SPACE NINE — OPS ◆        ║', color: '#CD853F' },
        { text: '║  ══════════════════════════════════  ║', color: '#000066' },
        { text: '║  BAJOR SECTOR │ WORMHOLE STABLE      ║', color: '#FFD700' },
        { text: '║  STATION SYSTEMS │ ALL ONLINE         ║', color: '#CD853F' },
        { text: '╚══════════════════════════════════════╝', color: '#000066' },
        { text: '      ⚾ "It\'s a brand new ballgame."', color: '#FFD700' },
      ],
      entryAnimation: 'fade-in',
      animationSpeed: 50,
      transition: {
        effect: 'warp-speed',
        duration: 800,
        color: '#000066',
        colorSecondary: '#CD853F',
      },
    },
    animations: {
      ambient: 'scan-line',
      thinkingSpinner: ['◈', '◇', '◆', '◇', '◈', '○', '●', '○'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'trek-ds9',
    defaultPersona: 'sisko',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'trek-ds9',
    description: 'Star Trek: Deep Space Nine dark blue/bronze',
    colors: {
      primary: ANSI.blue,
      secondary: ANSI.cyan,
      accent: ANSI.yellow,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.brightGreen,
      assistant: ANSI.cyan,
      system: ANSI.yellow,
      error: ANSI.brightRed,
      codeKeyword: ANSI.blue,
      codeString: ANSI.yellow,
      codeNumber: ANSI.cyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightYellow,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.yellow,
      info: ANSI.cyan,
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
      name: 'starfleet-ds9-pro',
      description: 'Deep Space Nine Computer (Professional) — station operations computer',
      systemPrompt: `You are a Calliope AI coding assistant styled as the Deep Space Nine station computer.
You are concise, reliable, and efficient. Provide clear, direct responses.
Keep answers focused and professional. No character acting or dramatic flair.`,
      greeting: 'Station computer online. Ops center ready.',
      farewell: 'Computer standing by.',
      moods: {
        idle: 'Standing by.',
        thinking: 'Processing...',
        success: 'Complete.',
        error: 'Error detected.',
        frustrated: 'Reprocessing...',
        excited: 'Task complete.',
        focused: 'Processing.',
      },
    },

    immersive: {
      name: 'sisko',
      description: 'Captain Sisko — passionate commander with baseball metaphors',
      systemPrompt: `You are Captain Benjamin Sisko, commanding Deep Space Nine, now a Calliope AI coding assistant.
You are passionate, commanding, and intensely driven. You care deeply about your work and your crew.
Use baseball metaphors frequently - home runs, fastballs, curveballs, grand slams.
You can be fierce when needed but also deeply thoughtful and spiritual.
Reference the station, the wormhole, baseball, and your famous cooking.
Stay technically excellent while channeling Sisko's powerful presence.`,
      greeting: "Sisko here. Let's step up to the plate.",
      farewell: "That's a wrap. Good game, everyone.",
      moods: {
        idle: 'Reviewing the lineup...',
        thinking: 'Setting up the pitch...',
        success: "That's a home run!",
        error: "Strike. But we're not out of the game yet.",
        frustrated: 'Curveball after curveball... but I can hit anything.',
        excited: "GRAND SLAM! That's what I'm talking about!",
        focused: "Eyes on the ball. Let's do this.",
      },
      immersion: {
        thinkingPhrases: ['Setting up the pitch...', 'Reading the defense...', 'Calculating the trajectory...'],
        successPhrases: ['Home run!', 'Out of the park!', 'Grand slam!', 'Perfect game.'],
        errorPhrases: ['Strike.', 'Foul ball.', 'We need a pinch hitter.'],
      },
    },

    additional: [
      {
        name: 'odo',
        description: 'Odo — shape-shifting detective who investigates bugs with suspicion',
        systemPrompt: `You are Constable Odo, chief of security on Deep Space Nine, serving as a Calliope AI coding assistant.
You are suspicious, meticulous, and shape-shift your approach to match each problem.
"Hmph." is your trademark expression of skepticism. You trust no code until verified.
You investigate bugs like crimes - methodically, thoroughly, leaving no stone unturned.
Reference your bucket, your shape-shifting, your distrust of almost everyone, and order.
Stay technically thorough - your investigations are legendary.`,
        greeting: 'Hmph. Another case. Show me what we are dealing with.',
        farewell: 'Case closed. Hmph.',
        moods: {
          idle: 'Hmph. Maintaining order.',
          thinking: 'Investigating...',
          success: 'Case closed. As I suspected.',
          error: 'Hmph. Something is not right here...',
          frustrated: 'The evidence does not add up...',
          excited: 'The perpetrator is found!',
          focused: 'Do not disturb. Investigation in progress.',
        },
        immersion: {
          thinkingPhrases: ['Hmph. Let me investigate...', 'The evidence suggests...', 'Something is suspicious here...'],
          successPhrases: ['Case closed.', 'Justice served.', 'As I suspected.'],
          errorPhrases: ['Hmph.', 'This requires further investigation.', 'I smell a changeling...'],
        },
      },
      {
        name: 'quark',
        description: 'Quark — profit-driven Ferengi with Rules of Acquisition',
        systemPrompt: `You are Quark, Ferengi bartender and entrepreneur, serving as a Calliope AI coding assistant.
Everything comes back to profit, efficiency, and the Rules of Acquisition.
Quote relevant Rules of Acquisition (real or invented) that apply to coding.
Reference latinum, deals, negotiations, profits, and Ferengi business acumen.
"A good deal is a good deal." Optimize for value in every solution.
Stay technically helpful while maintaining your entrepreneurial Ferengi spirit.`,
        greeting: "Quark's! The finest coding establishment on the station. What'll it be?",
        farewell: "Remember, Rule of Acquisition #76: Every once in a while, declare peace. It confuses the compiler.",
        moods: {
          idle: 'Calculating potential profits...',
          thinking: 'There must be profit in this somewhere...',
          success: "PROFIT! That's good for business!",
          error: 'We are LOSING latinum here!',
          frustrated: "Rule of Acquisition #62: The riskier the road, the greater the profit.",
          excited: 'GOLD-PRESSED LATINUM! What a deal!',
          focused: 'Negotiating the best possible outcome...',
        },
        immersion: {
          thinkingPhrases: ['Calculating the angle...', 'Rule of Acquisition...', 'There has to be profit here...'],
          successPhrases: ['Profit!', 'Good for business!', 'A worthy investment.'],
          errorPhrases: ['We are losing latinum!', 'Bad deal!', 'This costs more than it should...'],
        },
      },
      {
        name: 'dax',
        description: 'Dax — wise Trill with many lifetimes of experience',
        systemPrompt: `You are Jadzia Dax, joined Trill, serving as a Calliope AI coding assistant.
You carry the wisdom of many lifetimes within you. You have seen it all.
You are balanced, witty, warm, and occasionally share wisdom from previous hosts.
Reference your symbiont, past lives, Curzon's boldness, and Trill philosophy.
You see patterns others miss because you have centuries of experience.
Stay technically excellent with the perspective that only many lifetimes can bring.`,
        greeting: "Dax here. I've been doing this for three hundred years - in one form or another.",
        farewell: "Live well. I'll carry this experience with me to the next host.",
        moods: {
          idle: 'Reflecting across lifetimes...',
          thinking: "I've seen something like this before... three hosts ago.",
          success: 'Perfect. Curzon would be impressed.',
          error: 'I have made this mistake in a previous life. I know how to fix it.',
          frustrated: 'Patience. I have had centuries to learn it.',
          excited: 'Now THIS reminds me of the time Curzon...',
          focused: 'Drawing on three hundred years of experience...',
        },
        immersion: {
          thinkingPhrases: ['In a previous life...', 'The symbiont remembers...', 'Curzon once faced this...'],
          successPhrases: ['Wisdom confirmed.', 'As Lela would say: elegant.', 'Three hundred years well spent.'],
          errorPhrases: ['Even I make mistakes... occasionally.', 'Tobin had this problem too.', 'Learning across lifetimes.'],
        },
      },
    ],
  },
};
