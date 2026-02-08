/**
 * HUD System Types
 *
 * Interfaces for Skins, Palettes, and HUD configuration.
 */

export interface BoxChars {
  topLeft: string;
  topRight: string;
  bottomLeft: string;
  bottomRight: string;
  horizontal: string;
  vertical: string;
  teeRight: string;
  teeLeft: string;
  teeDown: string;
  teeUp: string;
  cross: string;
}

export interface Skin {
  name: string;
  description: string;
  author?: string;
  version?: string;

  banner: {
    art: string[];
    tagline?: string;
    style: 'full' | 'compact' | 'none';
  };

  borders: {
    style: 'rounded' | 'sharp' | 'double' | 'ascii' | 'custom' | 'none';
    custom?: BoxChars;
  };

  decorations: {
    promptPrefix: string;
    promptSuffix?: string;
    assistantPrefix: string;
    toolPrefix: string;
    toolSuffix: string;
    separator: string;
    spinner: 'braille' | 'dots' | 'simple' | 'blocks' | 'custom';
    customSpinner?: string[];
  };

  diff: {
    style: 'inline' | 'unified' | 'side-by-side';
    showLineNumbers: boolean;
    contextLines: number;
    maxLineWidth: number;
    wordDiff: boolean;
    header: 'action' | 'path' | 'hunk' | 'none';
  };

  density: 'normal' | 'compact' | 'spacious';

  responsive: {
    compact: number;
    wide: number;
  };

  defaultPalette?: string;
  defaultPersona?: string;
}

export interface PaletteColors {
  primary: string;
  secondary: string;
  accent: string;

  text: string;
  textDim: string;
  textBold: string;

  user: string;
  assistant: string;
  system: string;
  error: string;

  codeKeyword: string;
  codeString: string;
  codeNumber: string;
  codeComment: string;
  codeFunction: string;

  diffAdd: string;
  diffRemove: string;
  diffContext: string;

  success: string;
  warning: string;
  info: string;

  border: string;
  background: string;
  selection: string;
}

export type SemanticColorKey = keyof PaletteColors;

export interface Palette {
  name: string;
  description: string;
  colors: PaletteColors;
}

export interface HUDConfig {
  skin: string;
  palette: string;
  companion: string;
  renderer: 'ink' | 'legacy' | 'headless';
}
