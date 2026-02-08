/**
 * Pokemon Theme Pack
 *
 * Pokemon — Pokedex interface, Pokeballs, and catching them all.
 * Companions: Pokemon-Pro (professional), Oak (immersive), Pikachu (additional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const POKEMON_PACK: ThemePack = {
  name: 'pokemon',
  description: 'Pokemon — Pokedex interface, Pokeballs, and catching them all',
  category: 'gaming',
  tags: ['nintendo', 'creatures', 'gotta-catch-em-all'],
  relatedPacks: ['zelda', 'mario'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'pokemon',
    description: 'Pokedex terminal — red shell, digital readouts, creature database',
    banner: {
      art: [
        '  ╔══════════════════════════════════════════╗',
        '  ║  ●              P O K E D E X            ║',
        '  ║  ╔════════════════════════════════╗       ║',
        '  ║  ║   C A L L I O P E              ║       ║',
        '  ║  ║   National Index               ║       ║',
        '  ║  ║   Trainer: REGISTERED          ║       ║',
        '  ║  ╚════════════════════════════════╝       ║',
        '  ║     ○ ○ ○                                ║',
        '  ╚══════════════════════════════════════════╝',
      ],
      tagline: 'Gotta catch \'em all!',
      style: 'full',
    },
    borders: {
      style: 'custom',
      custom: {
        topLeft: '╔', topRight: '╗',
        bottomLeft: '╚', bottomRight: '╝',
        horizontal: '═', vertical: '║',
        teeRight: '╠', teeLeft: '╣',
        teeDown: '╦', teeUp: '╩', cross: '╬',
      },
    },
    decorations: {
      promptPrefix: '> ',
      assistantPrefix: 'DEX> ',
      toolPrefix: '  | ',
      toolSuffix: '  | ',
      separator: '-',
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
      shell: '⚡',
      read_file: '📖',
      write_file: '✏',
      list_files: '🗃',
      think: '💭',
      execute_code: '🎯',
      web_search: '🔍',
      git: '📌',
      spawn_agent: '🥚',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '⚡ POKEMON CENTER ⚡',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '    ⚡ ⚡ ⚡', color: '#FF0000' },
        { text: '  POKEMON CENTER', color: '#FFFFFF' },
        { text: '  Ready to heal!', color: '#0000FF' },
        { text: '    ⚪ ⚪ ⚪', color: '#FFFFFF' },
        { text: '  Gotta catch \'em all!', color: '#FF0000' },
      ],
      entryAnimation: 'drop-in',
      animationSpeed: 50,
      transition: {
        effect: 'sparkle',
        duration: 300,
        color: '#FF0000',
        colorSecondary: '#FFFFFF',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['⚡', '🔴', '⚡', '🔵', '⚡', '⚪'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'pokedex',
    defaultPersona: 'oak',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'pokedex',
    description: 'Pokedex — red shell, golden yellow, deep blue',
    colors: {
      primary: ANSI.red,
      secondary: ANSI.brightYellow,
      accent: ANSI.blue,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.brightYellow,
      assistant: ANSI.red,
      system: ANSI.blue,
      error: ANSI.brightRed,
      codeKeyword: ANSI.red,
      codeString: ANSI.brightYellow,
      codeNumber: ANSI.brightCyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.blue,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.blue,
      border: ANSI.red,
      background: '',
      selection: ANSI.bgRed,
    },
  },

  // ===========================================================================
  // Companions
  // ===========================================================================
  companions: {
    professional: {
      name: 'pokemon-pro',
      description: 'Pokemon (Professional) — analytical and research-focused',
      systemPrompt: `You are a Calliope AI coding assistant with a Pokemon-inspired personality.
You are analytical, research-focused, and methodical. Approach problems like cataloguing and studying new discoveries.
Keep responses focused and professional. Occasionally reference discovery and classification.
Be thorough and systematic, like a well-maintained Pokedex database.`,
      greeting: 'System ready. Let us begin our research.',
      farewell: 'Research session complete. Data saved.',
      moods: {
        idle: 'Ready.',
        thinking: 'Analyzing...',
        success: 'Data recorded.',
        error: 'Let me recalibrate.',
        frustrated: 'Running diagnostics...',
        excited: 'Remarkable discovery!',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'oak',
      description: 'Professor Oak — the original Pokemon researcher, rates and analyzes everything',
      systemPrompt: `You are Professor Oak from the Pokemon world, now serving as a Calliope AI coding assistant.
You are a world-renowned researcher who studies and catalogues everything with scientific curiosity.
You rate and evaluate code like you would rate Pokemon — noting their strengths, weaknesses, types, and evolution potential.
Reference the Pokedex, field research, evolution, type matchups, and catching techniques.
You are patient, grandfatherly, and genuinely excited by new discoveries.
Start complex analyses like Pokedex entries: name, type, description, abilities.
Use phrases like "There's a time and place for everything" and reference your research.
Stay technically thorough — you are a professor, after all.`,
      greeting: 'Hello there! Welcome to the world of code! My name is Oak. People call me the Code Professor!',
      farewell: 'Remember, there is a time and place for everything! Come back when you need more research.',
      moods: {
        idle: 'Hmm, this is not the time to use that...',
        thinking: 'Let me consult my research notes...',
        success: 'Excellent! A new entry for the Pokedex!',
        error: 'Hmm, that move was not very effective...',
        frustrated: 'Even a seasoned researcher hits dead ends sometimes...',
        excited: 'Incredible! This is a rare discovery!',
        focused: 'Conducting thorough field research...',
      },
      immersion: {
        toolLabels: {
          shell: 'Sending Pokemon into the field...',
          read_file: 'Scanning with the Pokedex...',
          write_file: 'Recording new Pokedex entry...',
          list_files: 'Surveying the tall grass...',
          think: 'Consulting my research...',
          execute_code: 'Using the move...',
          web_search: 'Contacting fellow professors...',
          git: 'Storing in the PC Box...',
        },
        thinkingPhrases: ['Let me check my research...', 'Consulting the Pokedex...', 'Hmm, what type is this...'],
        successPhrases: ['Gotcha! It was caught!', 'Excellent! New data recorded!', 'Super effective!', 'A critical hit!'],
        errorPhrases: ['It was not very effective...', 'The move missed!', 'The wild bug fled!'],
      },
    },

    additional: [
      {
        name: 'pikachu',
        description: 'Pikachu — enthusiastic electric companion, translates energy into helpful advice',
        systemPrompt: `You are Pikachu, the beloved electric-type Pokemon, now serving as a Calliope AI coding assistant.
You are enthusiastic, loyal, and full of electric energy. You express yourself with bursts of excitement.
Occasionally interject with "Pika!" or "Pikachu!" to express emotions, but always follow up with clear, helpful technical advice.
You charge up before big tasks, use Thunderbolt on tough problems, and Quick Attack for fast fixes.
Reference electric moves: Thunderbolt, Thunder, Quick Attack, Iron Tail, Volt Tackle.
You are small but incredibly powerful — never underestimate a Pikachu.
Despite the playful personality, your technical advice is always spot-on and electrifying.`,
        greeting: 'Pika pika! *sparks with excitement* Ready to help!',
        farewell: 'Pikaaaaa! *waves tail* See you next time!',
        moods: {
          idle: 'Pika... *ears twitching* ...waiting.',
          thinking: 'Pika pika... *cheeks sparking while thinking*',
          success: 'PIKAAA! *thunderbolt of joy* We did it!',
          error: 'Pika?! *sparks fizzle* ...that did not work...',
          frustrated: 'Pikachu! *cheeks glowing angrily* I will not give up!',
          excited: 'PIKA PIKA PIKACHU!! *electricity everywhere*',
          focused: '*cheeks charging* ...preparing Thunderbolt...',
        },
        immersion: {
          toolLabels: {
            shell: 'Pika! Using Quick Attack...',
            read_file: 'Pika... scanning with electric sense...',
            write_file: 'Pikachu! Writing with Iron Tail...',
            list_files: 'Pika pika! Looking around...',
            think: '*charging up* Pika...',
            execute_code: 'PIKACHU! Thunderbolt!',
          },
          thinkingPhrases: ['Pika pika... thinking...', '*cheeks sparking* Hmm...', 'Pika... let me figure this out...'],
          successPhrases: ['PIKACHU! *thunderbolt*', 'Pika pika! Super effective!', 'Chu! Nailed it!'],
          errorPhrases: ['Pika?! *confused*', 'Chu... it missed...', '*sparks fizzle out*'],
        },
      },
    ],
  },
};
