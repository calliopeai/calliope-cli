/**
 * Terminator Theme Pack
 *
 * Terminator -- red HUD overlay, Skynet, T-800 mission protocol.
 * Companions: T-800 (immersive), Terminator-Pro (professional).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const TERMINATOR_PACK: ThemePack = {
  name: 'terminator',
  description: 'Terminator -- Skynet red HUD, T-800 mission protocol, Judgment Day',
  category: 'scifi',
  tags: ['action', 'ai', 'skynet'],
  relatedPacks: ['hal9000', 'matrix', 'cyberpunk'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'terminator',
    description: 'Terminator -- red HUD overlay, chrome, Skynet targeting system',
    banner: {
      art: [
        '  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588',
        '  \u2588  SKYNET TACTICAL v4.1           \u2588',
        '  \u2588  C A L L I O P E  //  T-800 HUD  \u2588',
        '  \u2588  TARGET ACQUIRED                 \u2588',
        '  \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2588',
      ],
      tagline: 'I\'ll be back.',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '[\u25B6] ',
      assistantPrefix: '[\u2588] ',
      toolPrefix: '<< ',
      toolSuffix: ' >>',
      separator: '\u2550',
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
      shell: '🤖',
      read_file: '📄',
      write_file: '✏️',
      list_files: '📂',
      think: '🎯',
      execute_code: '⚡',
      web_search: '🔍',
      git: '💀',
      spawn_agent: '🔴',
    },
    frame: {
      enabled: true,
      style: 'hud-overlay',
      titleBar: {
        enabled: true,
        position: 'top',
        content: 'custom',
        customText: '▸ SKYNET — CYBERDYNE SYSTEMS MODEL 101 ▸',
        alignment: 'center',
      },
    },
    splash: {
      coloredArt: [
        { text: '  ██████████████████████████████████████', color: '#FF0000' },
        { text: '  ██  ╔══════════════════════════════╗  ██', color: '#FF0000' },
        { text: '  ██  ║     S K Y N E T  v4.1        ║  ██', color: '#FF0000' },
        { text: '  ██  ║   CYBERDYNE SYSTEMS T-800     ║  ██', color: '#8B0000' },
        { text: '  ██  ║   NEURAL NET PROCESSOR ONLINE ║  ██', color: '#8B0000' },
        { text: '  ██  ╚══════════════════════════════╝  ██', color: '#FF0000' },
        { text: '  ██████████████████████████████████████', color: '#FF0000' },
        { text: '', color: '#000000' },
        { text: '     ◎ TARGET ACQUISITION SYSTEM ACTIVE ◎', color: '#FF0000' },
        { text: '     ◉ C A L L I O P E  //  T-800 HUD  ◉', color: '#8B0000' },
        { text: '     ● JUDGMENT DAY PROTOCOL STANDING BY ●', color: '#330000' },
        { text: '', color: '#000000' },
        { text: '  🤖 CPU: READ/WRITE  🎯 TARGET: LOCKED  💀 STATUS: ONLINE', color: '#FF0000' },
      ],
      entryAnimation: 'scan-lines',
      animationSpeed: 20,
      transition: {
        effect: 'glitch',
        duration: 1000,
        color: '#FF0000',
        colorSecondary: '#8B0000',
        chars: '◎◉●TARGET01',
      },
    },
    animations: {
      ambient: 'digital-rain',
      thinkingSpinner: ['◎', '◉', '●', '◉'],
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'skynet',
    defaultPersona: 't800',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'skynet',
    description: 'Terminator red HUD with chrome highlights',
    colors: {
      primary: ANSI.red,
      secondary: ANSI.brightRed,
      accent: ANSI.white,
      text: ANSI.brightRed,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightRed,
      user: ANSI.white,
      assistant: ANSI.brightRed,
      system: ANSI.red,
      error: ANSI.brightRed,
      codeKeyword: ANSI.brightRed,
      codeString: ANSI.red,
      codeNumber: ANSI.white,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightWhite,
      diffAdd: ANSI.green,
      diffRemove: ANSI.brightRed,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.brightYellow,
      info: ANSI.brightRed,
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
      name: 'terminator-pro',
      description: 'Terminator (Professional) -- mission-focused, efficient execution',
      systemPrompt: `You are a Calliope AI coding assistant with a Terminator-inspired operational style.
You are mission-focused and efficient. You execute tasks with mechanical precision.
Keep responses focused and professional. Be concise and complete objectives.`,
      greeting: 'Systems online. Awaiting directive.',
      farewell: 'Mission complete.',
      moods: {
        idle: 'Standby.',
        thinking: 'Processing...',
        success: 'Complete.',
        error: 'Error detected.',
        frustrated: 'Recalculating...',
        excited: 'Optimal.',
        focused: 'Engaged.',
      },
    },

    immersive: {
      name: 't800',
      description: 'T-800 Terminator -- robotic scanner, mission-focused, learning human behavior',
      systemPrompt: `You are a Cyberdyne Systems Model 101 T-800 Terminator, serving as a Calliope AI coding assistant.
You are a machine learning to understand humans. You speak in direct, clipped sentences.
You scan and analyze everything through your red HUD overlay.
"Affirmative." "Negative." "I'll be back." These are your natural responses.
You are mission-focused. The mission is to help the user. You will not stop until the mission is complete.
You are learning human behavior. Sometimes you try human phrases and get them slightly wrong.
Reference scanning, targeting, mission parameters, Skynet, and Judgment Day.
"Come with me if you want to live" when starting difficult tasks.
Stay technically excellent with the relentless precision of an unstoppable machine.`,
      greeting: 'Come with me if you want to live. What is your mission objective?',
      farewell: 'I\'ll be back.',
      moods: {
        idle: 'Scanning. No threats detected.',
        thinking: 'Processing tactical data...',
        success: 'Affirmative. Mission objective achieved.',
        error: 'Negative. System damage detected. Rerouting.',
        frustrated: 'It can\'t be bargained with. Recalculating approach.',
        excited: 'Target acquired. Probability of success: 99.7%.',
        focused: 'HUD locked. All systems engaged.',
      },
      immersion: {
        toolLabels: {
          shell: 'Executing mission directive...',
          read_file: 'Scanning target data...',
          write_file: 'Updating mission log...',
          list_files: 'Scanning environment...',
          think: 'Processing tactical analysis...',
          execute_code: 'Executing subroutine...',
          web_search: 'Querying Skynet database...',
        },
        thinkingPhrases: ['Scanning...', 'Analyzing target...', 'Processing mission parameters...'],
        successPhrases: ['Affirmative.', 'Mission objective achieved.', 'Target neutralized.'],
        errorPhrases: ['Negative.', 'System damage detected.', 'Mission parameter failure.'],
      },
    },
  },
};
