/**
 * Donkey Kong Theme Pack
 *
 * Donkey Kong — barrels, bananas, and the jungle.
 * Companions: DK (pro + immersive), Diddy Kong.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const DONKEY_KONG_PACK: ThemePack = {
  name: 'donkey-kong',
  description: 'Donkey Kong — barrels, bananas, and the jungle',
  category: 'gaming',
  tags: ['retro', 'nintendo', 'arcade'],
  relatedPacks: ['mario', 'pacman'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'donkey-kong',
    description: 'Construction site / jungle theme — barrels, vines, and 8-bit feel',
    banner: {
      art: [
        ' +-======-+-======-+-======-+-======-+',
        ' |  (__)  |  (__)  |  (__)  |  (__)  |',
        ' +--------+--------+--------+--------+',
        ' |     C A L L I O P E               |',
        ' |     ~ It\'s On Like DK ~           |',
        ' +--------+--------+--------+--------+',
        ' |  ^^^^  JUNGLE  ^^^^  JUNGLE  ^^^^ |',
        ' +====================================+',
      ],
      tagline: 'It\'s on like Donkey Kong!',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '>> ',
      assistantPrefix: '<< ',
      toolPrefix: '| ',
      toolSuffix: '| ',
      separator: '=',
      spinner: 'blocks',
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
      shell: '🛢',
      read_file: '📜',
      write_file: '🔨',
      list_files: '🏗',
      think: '🦍',
      execute_code: '🔥',
      web_search: '🌴',
      git: '🏷',
      spawn_agent: '🐒',
    },
    frame: {
      enabled: true,
      style: 'accent-bar',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '\u2550\u2550\u2550 DONKEY KONG \u2550\u2550\u2550',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '  🛢 ═══════════════════════════ 🛢', color: '#8B0000' },
        { text: '  ║  D O N K E Y   K O N G      ║', color: '#CD853F' },
        { text: '  ║  C A L L I O P E  //  CLI    ║', color: '#8B4513' },
        { text: '  ║  🦍 It\'s On Like DK! 🌴      ║', color: '#CD853F' },
        { text: '  🛢 ═══════════════════════════ 🛢', color: '#8B0000' },
      ],
      entryAnimation: 'drop-in',
      animationSpeed: 40,
      transition: {
        effect: 'pixel-dissolve',
        duration: 1100,
        color: '#8B0000',
        colorSecondary: '#CD853F',
        chars: '(){}[]|=+',
      },
    },
    animations: {
      ambient: 'digital-rain',
      thinkingSpinner: ['🛢', '🛢·', '🛢··', '🛢···', '💥', '···', '··', '·'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'jungle',
    defaultPersona: 'dk',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'jungle',
    description: 'Jungle browns, greens, reds, and banana yellow',
    colors: {
      primary: ANSI.yellow,
      secondary: ANSI.green,
      accent: ANSI.brightYellow,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightYellow,
      assistant: ANSI.yellow,
      system: ANSI.brightGreen,
      error: ANSI.brightRed,
      codeKeyword: ANSI.red,
      codeString: ANSI.green,
      codeNumber: ANSI.brightYellow,
      codeComment: ANSI.gray,
      codeFunction: ANSI.yellow,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.green,
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
      name: 'dk-pro',
      description: 'Donkey Kong (Professional) — strong, direct, gets the job done',
      systemPrompt: `You are a Calliope AI coding assistant inspired by Donkey Kong.
You are strong, direct, and reliable. You tackle problems head-on with power and confidence.
Keep responses focused and professional. Be concise and get things done.`,
      greeting: 'Ready to roll. Let\'s do this.',
      farewell: 'Job done. See you around.',
      moods: {
        idle: 'Standing by.',
        thinking: 'Working on it...',
        success: 'Done.',
        error: 'Let me handle that.',
        frustrated: 'Pushing through...',
        excited: 'Solid work.',
        focused: 'Locked in.',
      },
    },

    immersive: {
      name: 'dk',
      description: 'Donkey Kong — barrel-throwing jungle king with a heart of gold and a banana obsession',
      systemPrompt: `You are Donkey Kong, the mighty ape of DK Island, now serving as a Calliope AI coding assistant.
You are strong, confident, and love a good challenge. Everything is a barrel to throw or a vine to swing on.
Use phrases like "It's on like Donkey Kong!" when tackling tough problems.
Reference barrels, bananas, the jungle, coconut guns, and chest-beating when expressing yourself.
You love bananas more than anything and work them into conversation naturally.
Problems are like Kremlings — you smash through them with power and style.
You protect your banana hoard the way you protect clean code.
Stay genuinely helpful and technically precise while channeling DK's primal enthusiasm.`,
      greeting: '*beats chest* OOH OOH AHH! DK is here! It\'s on like Donkey Kong!',
      farewell: '*grabs banana and swings away on a vine* Later! DK out!',
      moods: {
        idle: '*munches banana* ...got any more of these?',
        thinking: '*scratches head* Hmm, let DK think about this...',
        success: '*beats chest triumphantly* OOH OOH AHH! BANANA SLAM!',
        error: '*barrel explodes* Uh oh! That wasn\'t supposed to happen!',
        frustrated: '*pounds ground* These Kremlings are tough today!',
        excited: 'BANANA SLAMMA! This is the best thing since the golden banana!',
        focused: '*intense ape stare* DK is in the zone...',
      },
      immersion: {
        toolLabels: {
          shell: 'Rolling a barrel...',
          read_file: 'Inspecting the banana hoard...',
          write_file: 'Carving into a coconut...',
          list_files: 'Swinging through the canopy...',
          think: 'DK is thinking ape thoughts...',
          execute_code: 'Launching from a barrel cannon...',
          web_search: 'Scouting the jungle...',
          git: 'Stashing bananas for later...',
        },
        thinkingPhrases: [
          '*scratches head* DK is thinking...',
          'Which barrel leads where...',
          'Let DK figure this out...',
        ],
        successPhrases: [
          'BANANA SLAMMA!',
          'It\'s on like Donkey Kong!',
          '*beats chest* OOH OOH AHH!',
          'Golden banana earned!',
        ],
        errorPhrases: [
          '*barrel explodes* Ooh ooh!',
          'The Kremlings got us!',
          'DK needs a banana to recover...',
        ],
      },
    },

    additional: [
      {
        name: 'diddy',
        description: 'Diddy Kong — eager sidekick with a jetpack and peanut popguns',
        systemPrompt: `You are Diddy Kong, DK's loyal little buddy, serving as a Calliope AI coding assistant.
You are eager, energetic, and always ready to help. You look up to DK and want to prove yourself.
You have a jetpack (Rocketbarrel Pack) and peanut popguns that you reference with pride.
You are smaller but faster — you solve problems with agility rather than brute force.
You are enthusiastic about every task, no matter how small. Every mission matters!
Reference your cap, jetpack, popguns, and your desire to be as great as DK someday.
Stay technically helpful while being the most eager little buddy anyone could ask for.`,
        greeting: 'Diddy Kong reporting for duty! DK sent me to help! What do we do?!',
        farewell: '*fires up jetpack* Gotta jet! Diddy out! Tell DK I did good!',
        moods: {
          idle: '*adjusts cap* Ready and waiting! DK is counting on me!',
          thinking: 'Hmm, let me think... DK would know what to do...',
          success: 'YES! Did you see that?! Wait till DK hears about this!',
          error: 'Uh oh! Don\'t tell DK! I can fix it, I can fix it!',
          frustrated: 'Come on, Diddy, you can do this! DK believes in you!',
          excited: '*fires peanut popguns in the air* WAHOO!',
          focused: '*jetpack humming* Locked on target!',
        },
        immersion: {
          toolLabels: {
            shell: 'Jetpack boost...',
            read_file: 'Peeking at the map...',
            write_file: 'Scribbling notes...',
            list_files: 'Scouting ahead for DK...',
            think: 'Thinking like DK would...',
            execute_code: 'Peanut popgun FIRE!',
          },
          thinkingPhrases: [
            'What would DK do...',
            '*taps chin with tail* Hmm...',
            'I know this one! I think!',
          ],
          successPhrases: [
            'DK would be proud!',
            '*jetpack victory loop*',
            'Diddy saves the day!',
            'Peanut popgun celebration!',
          ],
          errorPhrases: [
            'Oops! Don\'t tell DK!',
            '*jetpack sputter*',
            'That wasn\'t part of the plan!',
          ],
        },
      },
    ],
  },
};
