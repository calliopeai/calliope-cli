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

  /** Per-skin tool icons (overrides default TOOL_ICONS) */
  icons?: SkinIcons;

  /** Splash/startup screen configuration */
  splash?: SkinSplash;

  /** HUD frame around entire UI */
  frame?: SkinFrame;

  /** Animation configuration */
  animations?: SkinAnimations;
}

// ============================================================================
// Rich HUD Types
// ============================================================================

export interface SkinIcons {
  shell?: string;
  read_file?: string;
  write_file?: string;
  list_files?: string;
  think?: string;
  execute_code?: string;
  web_search?: string;
  git?: string;
  mermaid?: string;
  spawn_agent?: string;
  check_agent?: string;
  list_agents?: string;
  cancel_agent?: string;
  [toolName: string]: string | undefined;
}

export interface SkinSplash {
  /** Colored banner: array of {text, color} per line for multi-color banners */
  coloredArt?: Array<{ text: string; color: string }>;
  /** Duration in ms to display splash before auto-dismiss (0 = no auto-dismiss) */
  duration?: number;
  /** Animation style for splash entry */
  entryAnimation?: 'none' | 'typewriter' | 'fade-in' | 'scan-lines' | 'drop-in';
  /** Animation speed in ms per frame/line */
  animationSpeed?: number;
  /** Full-screen transition effect when switching to this theme */
  transition?: SkinTransition;
}

export interface SkinTransition {
  /** Named transition effect */
  effect: 'none' | 'fade-in' | 'fade' | 'scan-lines' | 'drop-in' | 'digital-rain'
    | 'matrix-rain' | 'warp-speed' | 'glitch' | 'terminal-boot'
    | 'pixel-dissolve' | 'sparkle' | 'rainbow-wave' | 'static-noise';
  /** Duration in ms (default 1500) */
  duration?: number;
  /** Primary color for the transition (hex) */
  color?: string;
  /** Secondary color for dual-tone effects (hex) */
  colorSecondary?: string;
  /** Characters used in the effect (e.g. katakana for matrix, stars for sparkle) */
  chars?: string;
}

export interface SkinFrame {
  enabled: boolean;
  style: 'full' | 'top-bottom' | 'sides' | 'none';
  titleBar?: {
    enabled: boolean;
    position: 'top' | 'bottom';
    content: 'skin-name' | 'companion-name' | 'custom';
    customText?: string;
    alignment: 'left' | 'center' | 'right';
  };
  /** Render status bar inside the bottom frame border */
  statusBarIntegrated?: boolean;
  /** Decorative strings for frame corners */
  cornerDecor?: {
    topLeft?: string;
    topRight?: string;
    bottomLeft?: string;
    bottomRight?: string;
  };
}

export interface SkinAnimations {
  /** Ambient animation effect running in frame background */
  ambient?: 'none' | 'scan-line' | 'pulse-border' | 'digital-rain';
  /** Animation on theme switch */
  transitionEffect?: 'none' | 'flash' | 'dissolve' | 'wipe';
  /** Custom spinner for thinking state */
  thinkingSpinner?: string[];
  /** Custom spinner for processing state */
  processingSpinner?: string[];
  /** Custom pulse for streaming state */
  streamingPulse?: string[];
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
