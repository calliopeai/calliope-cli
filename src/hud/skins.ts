/**
 * Built-in Skins
 *
 * Each skin defines visual identity: ASCII art banner, border style,
 * decorations (prompt prefix, tool wrappers, spinner), diff config,
 * and responsive breakpoints.
 */

import type { Skin, BoxChars } from './types.js';

// ============================================================================
// Box Character Sets
// ============================================================================

export const BOX_STYLES: Record<string, BoxChars> = {
  rounded: {
    topLeft: '\u256D', topRight: '\u256E',
    bottomLeft: '\u2570', bottomRight: '\u256F',
    horizontal: '\u2500', vertical: '\u2502',
    teeRight: '\u251C', teeLeft: '\u2524',
    teeDown: '\u252C', teeUp: '\u2534', cross: '\u253C',
  },
  sharp: {
    topLeft: '\u250C', topRight: '\u2510',
    bottomLeft: '\u2514', bottomRight: '\u2518',
    horizontal: '\u2500', vertical: '\u2502',
    teeRight: '\u251C', teeLeft: '\u2524',
    teeDown: '\u252C', teeUp: '\u2534', cross: '\u253C',
  },
  double: {
    topLeft: '\u2554', topRight: '\u2557',
    bottomLeft: '\u255A', bottomRight: '\u255D',
    horizontal: '\u2550', vertical: '\u2551',
    teeRight: '\u2560', teeLeft: '\u2563',
    teeDown: '\u2566', teeUp: '\u2569', cross: '\u256C',
  },
  ascii: {
    topLeft: '+', topRight: '+',
    bottomLeft: '+', bottomRight: '+',
    horizontal: '-', vertical: '|',
    teeRight: '+', teeLeft: '+',
    teeDown: '+', teeUp: '+', cross: '+',
  },
  none: {
    topLeft: ' ', topRight: ' ',
    bottomLeft: ' ', bottomRight: ' ',
    horizontal: ' ', vertical: ' ',
    teeRight: ' ', teeLeft: ' ',
    teeDown: ' ', teeUp: ' ', cross: ' ',
  },
};

// ============================================================================
// Spinner Sets
// ============================================================================

export const SPINNER_SETS: Record<string, string[]> = {
  braille: ['\u280B', '\u2819', '\u2839', '\u2838', '\u283C', '\u2834', '\u2826', '\u2827', '\u2807', '\u280F'],
  dots: ['\u28FE', '\u28FD', '\u28FB', '\u28BF', '\u287F', '\u28DF', '\u28EF', '\u28F7'],
  simple: ['|', '/', '-', '\\'],
  blocks: ['\u2581', '\u2582', '\u2583', '\u2584', '\u2585', '\u2586', '\u2587', '\u2588', '\u2587', '\u2586', '\u2585', '\u2584', '\u2583', '\u2582'],
};

// ============================================================================
// Banner Art
// ============================================================================

const CALLIOPE_BANNER = [
  ' \u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2557     \u2588\u2588\u2557     \u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2557 \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557',
  '\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2557\u2588\u2588\u2554\u2550\u2550\u2550\u2550\u255D',
  '\u2588\u2588\u2551     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2551\u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2588\u2588\u2588\u2557  ',
  '\u2588\u2588\u2551     \u2588\u2588\u2554\u2550\u2550\u2588\u2588\u2551\u2588\u2588\u2551     \u2588\u2588\u2551     \u2588\u2588\u2551\u2588\u2588\u2551   \u2588\u2588\u2551\u2588\u2588\u2554\u2550\u2550\u2550\u255D \u2588\u2588\u2554\u2550\u2550\u255D  ',
  '\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551  \u2588\u2588\u2551\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557\u2588\u2588\u2551\u255A\u2588\u2588\u2588\u2588\u2588\u2588\u2554\u255D\u2588\u2588\u2551     \u2588\u2588\u2588\u2588\u2588\u2588\u2588\u2557',
  ' \u255A\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D  \u255A\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D\u255A\u2550\u255D \u255A\u2550\u2550\u2550\u2550\u2550\u255D \u255A\u2550\u255D     \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u255D',
];

// ============================================================================
// Skin Definitions
// ============================================================================

export const SKINS: Record<string, Skin> = {
  clean: {
    name: 'clean',
    description: 'Default Calliope look — rounded borders, standard banner',
    banner: {
      art: CALLIOPE_BANNER,
      tagline: 'Multi-Model AI Agent CLI',
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '\u27E9 ',
      assistantPrefix: '\u2727 ',
      toolPrefix: '\u256D\u2500 ',
      toolSuffix: '\u2570\u2500 ',
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
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'default',
    defaultPersona: 'professional',
  },

  falcon: {
    name: 'falcon',
    description: 'Millennium Falcon cockpit — radar borders, targeting reticle prompt',
    banner: {
      art: [
        ' \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557',
        ' \u2551  \u25C4\u25C4 CALLIOPE NAVIGATION COMPUTER \u25BA\u25BA     \u2551',
        ' \u2560\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2563',
        ' \u2551     .        *    .    *          . \u2551',
        ' \u2551  *      ___-------___     .   *     \u2551',
        ' \u2551    .  /\u203E   ===   \u203E\\     .       . \u2551',
        ' \u2551      |  CALLIOPE  |  *    .   *   \u2551',
        ' \u2551   *  \\___     ___/     .        . \u2551',
        ' \u2551   .     \u203E\u203E\u203E---\u203E\u203E\u203E    *   .   .    \u2551',
        ' \u2551        .    *    .        *       \u2551',
        ' \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D',
      ],
      tagline: 'Ready for hyperspace coordinates...',
      style: 'full',
    },
    borders: { style: 'double' },
    decorations: {
      promptPrefix: '\u2B2C ',
      assistantPrefix: '\u25C8 ',
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
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'default',
    defaultPersona: 'copilot',
  },

  wargames: {
    name: 'wargames',
    description: 'WarGames WOPR terminal — monospaced, all-caps, blinking cursor feel',
    banner: {
      art: [
        ' ************************************',
        ' *   GREETINGS, PROFESSOR FALKEN   *',
        ' *                                  *',
        ' *   SHALL WE PLAY A GAME?         *',
        ' ************************************',
      ],
      tagline: undefined,
      style: 'full',
    },
    borders: { style: 'ascii' },
    decorations: {
      promptPrefix: '> ',
      assistantPrefix: '>> ',
      toolPrefix: '--- ',
      toolSuffix: '--- ',
      separator: '*',
      spinner: 'simple',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'path',
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'monochrome',
    defaultPersona: 'wopr',
  },

  invaders: {
    name: 'invaders',
    description: 'Space Invaders arcade — pixel-art borders, retro score bar',
    banner: {
      art: [
        '  \u2580\u2584\u2580\u2584\u2580\u2584 CALLIOPE ARCADE \u2584\u2580\u2584\u2580\u2584\u2580',
        '  \u25C4\u25BA SCORE: 0000  LEVEL: 01  \u25C4\u25BA',
        '  \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500',
      ],
      tagline: undefined,
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: 'PLAYER 1 > ',
      assistantPrefix: 'CPU > ',
      toolPrefix: '\u250C\u2500 ',
      toolSuffix: '\u2514\u2500 ',
      separator: '\u2500',
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
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'neon',
    defaultPersona: 'arcade',
  },

  matrix: {
    name: 'matrix',
    description: 'Matrix digital rain — minimal borders, cascading feel',
    banner: {
      art: [
        '  \u2503                                    \u2503',
        '  \u2503  \u30DE\u30C8 C A L L I O P E \u30EA\u30AF\u30B9  \u2503',
        '  \u2503                                    \u2503',
        '  \u2503  Wake up, Neo...                   \u2503',
        '  \u2503  The Matrix has you.               \u2503',
        '  \u2503  Follow the white rabbit.          \u2503',
        '  \u2503                                    \u2503',
        '  \u2503  \u2588\u2584\u2580\u2584\u2588\u2580\u2584\u2588\u2584\u2580 NEURAL LINK ACTIVE \u2584\u2580\u2584\u2588\u2580\u2584\u2588 \u2503',
        '  \u2503                                    \u2503',
      ],
      tagline: undefined,
      style: 'compact',
    },
    borders: { style: 'none' },
    decorations: {
      promptPrefix: '\u25C8 ',
      assistantPrefix: '\u25C6 ',
      toolPrefix: '  ',
      toolSuffix: '  ',
      separator: '\u2503',
      spinner: 'braille',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: true,
      header: 'hunk',
    },
    density: 'compact',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'neon',
    defaultPersona: 'neo',
  },

  starfleet: {
    name: 'starfleet',
    description: 'Star Trek LCARS-inspired — rounded pill borders, status panels',
    banner: {
      art: [
        '  \u256D\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256E',
        '  \u2502  LCARS  \u2502  C A L L I O P E        \u2502',
        '  \u2502  v1.0   \u2502  STARFLEET TERMINAL      \u2502',
        '  \u2570\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u256F',
      ],
      tagline: 'All systems nominal.',
      style: 'full',
    },
    borders: { style: 'rounded' },
    decorations: {
      promptPrefix: '\u25B8 ',
      assistantPrefix: '\u25BA ',
      toolPrefix: '\u256D\u2500 ',
      toolSuffix: '\u2570\u2500 ',
      separator: '\u2500',
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
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'default',
    defaultPersona: 'computer',
  },

  cyberpunk: {
    name: 'cyberpunk',
    description: 'Neon-soaked — sharp angles, glitch separators, heavy accent',
    banner: {
      art: [
        '  \u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571\u2571',
        '  \u2571\u2571  _____   __   __   __   ___  ___ \u2572\u2572',
        '  \u2571\u2571 |  _  | |  | |  | |  | |   ||   |\u2572\u2572',
        '  \u2571\u2571 | |_| | |  |_|  | |  | |   ||   |\u2572\u2572',
        '  \u2571\u2571 |  ___| |   _   | |  | |   ||  _|\u2572\u2572',
        '  \u2571\u2571 |_|     |__| |__| |__| |___||_|  \u2572\u2572',
        '  \u2571\u2571                                    \u2572\u2572',
        '  \u2571\u2571  C.A.L.L.I.O.P.E  NEURAL v0.9   \u2572\u2572',
        '  \u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572\u2572',
      ],
      tagline: 'Jacked in.',
      style: 'full',
    },
    borders: { style: 'sharp' },
    decorations: {
      promptPrefix: '\u25B7 ',
      assistantPrefix: '\u25C1 ',
      toolPrefix: '[\u2500 ',
      toolSuffix: '\u2500] ',
      separator: '\u2588',
      spinner: 'blocks',
    },
    diff: {
      style: 'inline',
      showLineNumbers: true,
      contextLines: 2,
      maxLineWidth: 80,
      wordDiff: true,
      header: 'action',
    },
    density: 'normal',
    responsive: { compact: 80, wide: 120 },
    defaultPalette: 'neon',
    defaultPersona: 'netrunner',
  },

  retro: {
    name: 'retro',
    description: '8-bit computer terminal — block characters, BASIC prompt',
    banner: {
      art: [
        '  \u2554\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2557',
        '  \u2551 CALLIOPE BASIC V0.9       \u2551',
        '  \u2551 65536 BYTES FREE          \u2551',
        '  \u255A\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u2550\u255D',
      ],
      tagline: 'READY.',
      style: 'full',
    },
    borders: { style: 'double' },
    decorations: {
      promptPrefix: '> ',
      assistantPrefix: '] ',
      toolPrefix: '[ ',
      toolSuffix: '] ',
      separator: '=',
      spinner: 'simple',
    },
    diff: {
      style: 'unified',
      showLineNumbers: true,
      contextLines: 3,
      maxLineWidth: 80,
      wordDiff: false,
      header: 'path',
    },
    density: 'normal',
    responsive: { compact: 60, wide: 120 },
    defaultPalette: 'monochrome',
    defaultPersona: 'basic',
  },

};
