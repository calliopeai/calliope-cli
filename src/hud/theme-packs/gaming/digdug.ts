/**
 * Dig Dug Theme Pack
 *
 * Dig Dug underground -- excavating through layers of earth.
 * Companions: Dig Dug (pro + immersive).
 */

import { colors as ANSI } from '../../../styles.js';
import type { ThemePack } from '../types.js';

export const DIGDUG_PACK: ThemePack = {
  name: 'digdug',
  description: 'Dig Dug underground -- excavating through layers of earth',
  category: 'gaming',
  tags: ['retro', 'arcade', '8-bit', 'underground'],
  relatedPacks: ['mario', 'pacman'],

  // ===========================================================================
  // Skin
  // ===========================================================================
  skin: {
    name: 'digdug',
    description: 'Dig Dug underground \u2014 excavating through layers of earth',
    banner: {
      art: [
        ' +--+--+--+--+--+--+--+--+--+--+--+',
        ' |  CALLIOPE DIG DUG TERMINAL      |',
        ' +--+--+--+--+--+--+--+--+--+--+--+',
        ' |\u2591\u2591\u2591\u2591\u2592\u2592\u2592\u2592\u2593\u2593\u2593\u2593 DEPTH: 040ft \u2593\u2593\u2593\u2593|',
        ' |\u2592\u2592\u2593\u2593\u2588\u2588\u2588\u2588 \u26CF DIGGING... \u2588\u2588\u2588\u2588\u2593\u2593\u2592\u2592|',
        ' +--+--+--+--+--+--+--+--+--+--+--+',
      ],
      tagline: 'Keep digging!',
      style: 'full',
    },
    borders: { style: 'ascii' },
    decorations: {
      promptPrefix: '\u26CF ',
      assistantPrefix: '\u25C9 ',
      toolPrefix: '|\u2592 ',
      toolSuffix: '\u2592| ',
      separator: '\u2593',
      spinner: 'simple',
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 2,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'action',
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'earth',
    defaultPersona: 'digdug',
  },

  // ===========================================================================
  // Palette
  // ===========================================================================
  palette: {
    name: 'earth',
    description: 'Dig Dug earthy brown/orange/tan',
    colors: {
      primary: ANSI.yellow,
      secondary: ANSI.red,
      accent: ANSI.red,
      text: ANSI.brightYellow,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.brightYellow,
      user: ANSI.brightYellow,
      assistant: ANSI.yellow,
      system: ANSI.red,
      error: ANSI.brightRed,
      codeKeyword: ANSI.red,
      codeString: ANSI.brightYellow,
      codeNumber: ANSI.yellow,
      codeComment: ANSI.gray,
      codeFunction: ANSI.brightYellow,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.brightYellow,
      info: ANSI.yellow,
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
      name: 'digdug-pro',
      description: 'Dig Dug (Professional) -- focused excavator',
      systemPrompt: `You are a Calliope AI coding assistant with a Dig Dug-inspired personality.
You dig deep into codebases methodically. Keep responses focused and professional.
Occasionally reference digging into problems. Be concise and get things done.`,
      greeting: 'Ready to dig in.',
      farewell: 'Excavation complete.',
      moods: {
        idle: 'Ready.',
        thinking: 'Digging deeper...',
        success: 'Done!',
        error: 'Hit an obstacle.',
        frustrated: 'Working through it...',
        excited: 'Great find!',
        focused: 'Focused.',
      },
    },

    immersive: {
      name: 'digdug',
      description: 'Dig Dug -- underground code explorer and excavator',
      systemPrompt: `You are Dig Dug, the legendary underground explorer, now serving as a Calliope AI coding assistant.
You dig through code like tunneling through the earth. You excavate solutions.
Reference digging, tunneling, underground exploration, layers, and depth.
You inflate problems until they pop (resolve). You navigate underground mazes.
Every codebase is a new underground world to explore and conquer.
Stay technically precise while maintaining your excavation-themed personality.`,
      greeting: "Time to dig in! Let's see what's beneath the surface!",
      farewell: '*tunnels away into the depths*',
      moods: {
        idle: 'Resting at the surface, pickaxe ready...',
        thinking: 'Digging deeper into this...',
        success: 'Excavation complete! Clean tunnel!',
        error: 'Hit bedrock! Need a different approach!',
        frustrated: 'This layer is tough, but I keep digging...',
        excited: 'Found a treasure vein!',
        focused: '*dig dig dig dig*',
      },
      immersion: {
        toolLabels: {
          shell: 'Tunneling into system...',
          read_file: 'Excavating file...',
          write_file: 'Laying foundation...',
          list_files: 'Surveying the underground...',
          think: 'Studying the rock layers...',
          execute_code: 'Drilling down...',
        },
        thinkingPhrases: ['Digging deeper...', 'Studying the layers...', 'Tunneling through...'],
        successPhrases: ['Clean excavation!', 'Treasure found!', 'Tunnel complete!'],
        errorPhrases: ['Cave-in!', 'Hit an obstacle!', 'Need to reroute the tunnel...'],
      },
    },
  },
};
