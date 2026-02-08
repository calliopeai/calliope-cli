/**
 * Theme Pack Types
 *
 * A ThemePack bundles a skin, palette, and companions into
 * one cohesive unit. Each pack has professional (minimal) and
 * immersive (full character) companion variants.
 */

import type { Skin, Palette } from '../types.js';
import type { PersonaCompanion } from '../../companions.js';

export type ThemeCategory =
  | 'gaming'
  | 'trek'
  | 'scifi'
  | 'retro'
  | 'cultural'
  | 'seasonal'
  | 'minimal'
  | 'custom';

export interface ThemePack {
  name: string;
  description: string;
  category: ThemeCategory;
  author?: string;
  tags?: string[];

  skin: Skin;
  palette: Palette;

  companions: {
    /** Minimal, work-focused companion variant */
    professional: PersonaCompanion;
    /** Full character personality with immersion */
    immersive: PersonaCompanion;
    /** Extra companions for variety (e.g. TNG: Data, Riker, Worf) */
    additional?: PersonaCompanion[];
  };

  relatedPacks?: string[];
}
