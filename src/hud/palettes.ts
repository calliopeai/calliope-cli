/**
 * Built-in Palettes
 *
 * Palettes are independent of skins — mix freely.
 * "Pink Millennium Falcon" = falcon skin + pastel palette.
 */

import { colors as ANSI } from '../styles.js';
import type { Palette } from './types.js';

export const PALETTES: Record<string, Palette> = {
  default: {
    name: 'default',
    description: 'Standard dark terminal',
    colors: {
      primary: ANSI.cyan,
      secondary: ANSI.blue,
      accent: ANSI.magenta,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.green,
      assistant: ANSI.cyan,
      system: ANSI.yellow,
      error: ANSI.red,
      codeKeyword: ANSI.magenta,
      codeString: ANSI.green,
      codeNumber: ANSI.cyan,
      codeComment: ANSI.gray,
      codeFunction: ANSI.yellow,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.yellow,
      info: ANSI.blue,
      border: ANSI.gray,
      background: '',
      selection: ANSI.bgBlue,
    },
  },

  light: {
    name: 'light',
    description: 'Light terminal backgrounds',
    colors: {
      primary: ANSI.blue,
      secondary: ANSI.cyan,
      accent: ANSI.magenta,
      text: ANSI.black,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.black,
      user: ANSI.blue,
      assistant: ANSI.magenta,
      system: ANSI.gray,
      error: ANSI.red,
      codeKeyword: ANSI.magenta,
      codeString: ANSI.green,
      codeNumber: ANSI.blue,
      codeComment: ANSI.gray,
      codeFunction: ANSI.cyan,
      diffAdd: ANSI.green,
      diffRemove: ANSI.red,
      diffContext: ANSI.gray,
      success: ANSI.green,
      warning: ANSI.yellow,
      info: ANSI.blue,
      border: ANSI.gray,
      background: '',
      selection: ANSI.bgCyan,
    },
  },

  monochrome: {
    name: 'monochrome',
    description: 'Black & white only',
    colors: {
      primary: ANSI.white,
      secondary: ANSI.gray,
      accent: ANSI.white,
      text: ANSI.white,
      textDim: ANSI.gray,
      textBold: ANSI.bold + ANSI.white,
      user: ANSI.white,
      assistant: ANSI.white,
      system: ANSI.gray,
      error: ANSI.white,
      codeKeyword: ANSI.bold + ANSI.white,
      codeString: ANSI.white,
      codeNumber: ANSI.white,
      codeComment: ANSI.gray,
      codeFunction: ANSI.white,
      diffAdd: ANSI.white,
      diffRemove: ANSI.dim + ANSI.white,
      diffContext: ANSI.gray,
      success: ANSI.white,
      warning: ANSI.white,
      info: ANSI.gray,
      border: ANSI.gray,
      background: '',
      selection: ANSI.bgGray,
    },
  },

};
