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
  },
};
