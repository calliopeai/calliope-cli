/**
 * Calliope AI terminal colours.
 *
 * The CLI paints with the Calliope AI Workbench brand from the design
 * system's terminal token mapping (@calliopelabs/ui `tokens/terminal`): the
 * brand's dark or light theme, degraded to what the terminal takes.
 *
 * - Colour depth: detected once from the environment (FORCE_COLOR, NO_COLOR,
 *   COLORTERM, TERM, a piped stdout) as truecolor, 256, 16 or none.
 * - Light or dark: the stored theme (/theme dark|light|no-color), overridden by
 *   CALLIOPE_THEME; dark when neither says. The CLI does not probe the
 *   terminal's background.
 */

import {
  brandTheme,
  detectColorDepth,
  inkColor,
  sgr,
  type ColorDepth,
  type Mode,
  type TerminalTheme,
} from '@calliopelabs/ui/tokens/terminal';

export type { ColorDepth, Mode, TerminalTheme };
export { inkColor, sgr };

/** The family brand the CLI wears. */
export const BRAND = 'workbench';

let depth: ColorDepth | undefined;

/** The terminal's colour depth, detected on first use. */
export function colorDepth(): ColorDepth {
  depth ??= detectColorDepth({ isTTY: Boolean(process.stdout.isTTY) });
  return depth;
}

/** Pins the colour depth (tests, a future flag); undefined detects it again. */
export function setColorDepth(value: ColorDepth | undefined): void {
  depth = value;
}

/** The theme CALLIOPE_THEME asks for, if it names one. */
export function themeOverride(env: NodeJS.ProcessEnv = process.env): 'dark' | 'light' | 'no-color' | undefined {
  const value = env.CALLIOPE_THEME?.trim().toLowerCase();
  return value === 'dark' || value === 'light' || value === 'no-color' ? value : undefined;
}

/** The brand's terminal theme for a mode, on its default ground (navy dark, mist light). */
export function brandTerminalTheme(mode: Mode): TerminalTheme {
  return brandTheme(BRAND, mode);
}
