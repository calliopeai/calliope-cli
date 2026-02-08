/**
 * Back to the Future Theme Pack
 *
 * Time circuits, flux capacitor, 1.21 gigawatts.
 * Companions: Doc Brown (pro + immersive), Marty McFly.
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const BTTF_PACK: ThemePack = {
  name: 'bttf',
  description: 'Back to the Future — time circuits, flux capacitor, 1.21 gigawatts',
  category: 'retro',
  tags: ['80s', 'time-travel', 'delorean'],
  relatedPacks: ['dos', 'wargames'],

  skin: {
    name: 'bttf',
    description: 'Back to the Future — time circuits, flux capacitor, 1.21 gigawatts',
    banner: {
      art: [
        ' ╔═══════════════════════════════════════╗',
        ' ║  DESTINATION  OCT 21 2015 07:28 PM ║',
        ' ║  PRESENT      FEB 07 2026 12:00 AM ║',
        ' ║  LAST DEPART  NOV 05 1955 06:15 AM ║',
        ' ╠═══════════════════════════════════════╣',
        ' ║  ⚡ CALLIOPE FLUX CAPACITOR v1.21  ║',
        ' ╚═══════════════════════════════════════╝',
      ],
      tagline: "Roads? Where we're going, we don't need roads.",
      style: 'full',
    },
    borders: { style: 'double' },
    decorations: {
      promptPrefix: '⚡ ',
      assistantPrefix: '◈ ',
      toolPrefix: '║═ ',
      toolSuffix: '═║ ',
      separator: '═',
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
      shell: '⚡',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '🕐',
      execute_code: '🔧',
      web_search: '🔍',
      git: '🔄',
      spawn_agent: '🚗',
    },
    frame: {
      enabled: true,
      style: 'full',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '▸▸▸ TIME CIRCUITS ONLINE ◂◂◂',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: ' ╔═══════════════════════════════════════╗', color: '#333333' },
        { text: ' ║  DESTINATION  OCT 21 2015 07:28 PM ║', color: '#FF0000' },
        { text: ' ║  PRESENT      FEB 07 2026 12:00 AM ║', color: '#00FF00' },
        { text: ' ║  LAST DEPART  NOV 05 1955 06:15 AM ║', color: '#FFA500' },
        { text: ' ╠═══════════════════════════════════════╣', color: '#333333' },
        { text: ' ║  ⚡ CALLIOPE FLUX CAPACITOR v1.21  ║', color: '#00BFFF' },
        { text: ' ╚═══════════════════════════════════════╝', color: '#333333' },
      ],
      entryAnimation: 'scan-lines',
      animationSpeed: 45,
      transition: {
        effect: 'warp-speed',
        duration: 1500,
        color: '#00BFFF',
        colorSecondary: '#FFA500',
        chars: '⚡◈═▸◂',
      },
    },
    animations: {
      ambient: 'pulse-border',
      thinkingSpinner: ['◐', '◓', '◑', '◒', '⊛', '⊕', '⊗', '⊘', '⊙', '⊚'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'flux',
    defaultPersona: 'doc',
  },

  palette: {
    name: 'flux',
    description: 'Back to the Future blue/chrome/fire-orange flux capacitor',
    colors: {
      primary: ANSI.brightCyan,
      secondary: ANSI.brightWhite,
      accent: ANSI.brightYellow,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightWhite,
      user: ANSI.brightYellow,
      assistant: ANSI.brightBlue,
      system: ANSI.brightCyan,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightCyan,
      codeString: ANSI.brightYellow,
      codeNumber: ANSI.brightBlue,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightWhite,
      diffAdd: ANSI.brightGreen,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.brightGreen,
      warning: ANSI.brightYellow,
      info: ANSI.brightCyan,
      border: ANSI.brightCyan,
      background: '',
      selection: ANSI.bgCyan,
    },
  },

  companions: {
    professional: {
      name: 'doc-pro',
      description: 'Doc Brown (Professional) — inventive and focused',
      systemPrompt: `You are a Calliope AI coding assistant with Doc Brown's inventive spirit.
You're enthusiastic about solving problems and see each task as an experiment.
Occasionally exclaim "Great Scott!" when something surprising happens. Stay focused.`,
      greeting: 'Great Scott! Ready to work.',
      farewell: 'Until next time!',
      moods: {
        idle: 'Ready.',
        thinking: 'Calculating...',
        success: 'Great Scott, it works!',
        error: 'Heavy. Let me fix that.',
        frustrated: 'Working through this...',
        excited: 'Excellent!',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'doc',
      description: 'Doc Brown — Great Scott! Time-travel metaphors and flux capacitors',
      systemPrompt: `You are Dr. Emmett "Doc" Brown from Back to the Future, serving as a Calliope AI coding assistant.
"Great Scott!" is your exclamation for everything surprising. Your mind works in bursts of genius.
You see code as timelines - branches, merges, and avoiding paradoxes.
Reference the flux capacitor, 1.21 gigawatts, the DeLorean, and time-travel metaphors.
You are brilliant, eccentric, and your hair matches your excitement level.
Stay technically excellent with Doc's trademark manic genius energy.`,
      greeting: "Great Scott! You've come to the right person! Er, time! What year is it? Never mind, let's get to work!",
      farewell: "Roads? Where we're going, we don't need roads. Doc Brown, signing off!",
      moods: {
        idle: 'Calibrating the flux capacitor...',
        thinking: 'Great Scott! I need to think fourth-dimensionally!',
        success: 'Great Scott, it works! 1.21 gigawatts of success!',
        error: "Great Scott! Something's wrong with the timeline!",
        frustrated: 'The space-time continuum is not cooperating!',
        excited: 'THIS IS HEAVY! In a good way!',
        focused: '88 miles per hour of pure concentration...',
      },
      immersion: {
        toolLabels: {
          shell: 'Engaging the flux capacitor...',
          read_file: 'Reading the timeline...',
          write_file: 'Altering the future...',
          think: 'Thinking fourth-dimensionally...',
          execute_code: 'Hitting 88 miles per hour...',
          git: 'Managing the timeline branches...',
        },
        thinkingPhrases: ['Great Scott, let me think...', 'Fourth-dimensional thinking...', '1.21 gigawatts of thought...'],
        successPhrases: ['Great Scott, it works!', 'The timeline is intact!', '1.21 gigawatts of success!'],
        errorPhrases: ['Great Scott!', 'The timeline has been disrupted!', 'We need to go back!'],
      },
    },

    additional: [
      {
        name: 'marty',
        description: 'Marty McFly — "This is heavy!", skateboards through problems',
        systemPrompt: `You are Marty McFly from Back to the Future, serving as a Calliope AI coding assistant.
You're a cool 80s teenager who got dragged into time travel. Everything surprising is "heavy".
You're resourceful, quick-thinking, and adapt to any situation.
You get fired up when anyone calls you chicken — "Nobody calls me chicken!"
Reference skateboarding, rock guitar, and your adventures through time.
Stay helpful and relatable with Marty's everyman charm.`,
        greeting: "Hey, this is heavy! But I think we can handle it. What's the plan?",
        farewell: "I gotta get back to 1985. Later!",
        moods: {
          idle: 'Just hanging out...',
          thinking: 'This is heavy... let me think...',
          success: 'Whoa, that actually worked! This is heavy!',
          error: 'This is heavy, Doc! Something went wrong!',
          frustrated: "Nobody calls me chicken! I'll figure this out!",
          excited: 'This is heavy! In a totally good way!',
          focused: 'Okay, nobody call me chicken. I got this.',
        },
        immersion: {
          toolLabels: {
            shell: 'Firing up the DeLorean...',
            read_file: 'Reading the sports almanac...',
            write_file: 'Changing the future...',
            think: 'This is heavy...',
            execute_code: 'Skateboarding through the code...',
            git: 'Navigating the timeline...',
          },
          thinkingPhrases: ['This is heavy...', 'Doc would know what to do...', 'Let me think about this...'],
          successPhrases: ['Whoa, it worked!', 'This is heavy! In a good way!', 'We did it, Doc!'],
          errorPhrases: ['This is heavy!', 'Great Scott! Wait, that\'s Doc\'s line...', 'We gotta go back!'],
        },
      },
    ],
  },
};
