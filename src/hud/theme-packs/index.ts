/**
 * Theme Packs - Registry & Barrel Export
 *
 * Central registry of all theme packs. Category index files
 * re-export packs which are assembled here.
 */

import type { ThemePack } from './types.js';

// Category imports
import {
  MARIO_PACK, PACMAN_PACK, DIGDUG_PACK, DONKEY_KONG_PACK, RESIDENT_EVIL_PACK,
  ZELDA_PACK, POKEMON_PACK, MINECRAFT_PACK, METAL_GEAR_PACK, UNDERTALE_PACK, TETRIS_PACK,
  DARK_SOULS_PACK, DOOM_PACK, SONIC_PACK,
  BIOSHOCK_PACK, MASS_EFFECT_PACK, WARHAMMER_PACK,
  WITCHER_PACK,
} from './gaming/index.js';
import {
  TOS_PACK, TNG_PACK, DS9_PACK, VOYAGER_PACK,
  ENTERPRISE_PACK, SNW_PACK, LOWER_DECKS_PACK, BORG_PACK,
} from './trek/index.js';
import {
  MATRIX_PACK, HAL9000_PACK, DUNE_PACK,
  HITCHHIKER_PACK, FALCON_PACK, DOCTOR_WHO_PACK,
  RICK_AND_MORTY_PACK, JOHNNY_MNEMONIC_PACK, ALTERED_CARBON_PACK,
  FUTURAMA_PACK, BLADE_RUNNER_PACK, ALIEN_PACK, TERMINATOR_PACK,
  TRON_PACK, FIREFLY_PACK, COWBOY_BEBOP_PACK, EVANGELION_PACK,
  GHOST_IN_SHELL_PACK, JETSONS_PACK,
  X_FILES_PACK,
  DARK_SIDE_PACK, JURASSIC_PARK_PACK,
} from './scifi/index.js';
import {
  WARGAMES_PACK, CYBERPUNK_PACK, BASIC_PACK, INVADERS_PACK,
  GLADOS_PACK, PIPBOY_PACK, DOS_PACK, BTTF_PACK, HACKERS_PACK,
  MR_ROBOT_PACK, VIM_PACK, EMACS_PACK, LINUX_PACK,
  AMIGA_PACK, C64_PACK, APPLE2_PACK,
  BILL_AND_TED_PACK, NUCLEAR_PACK,
} from './retro/index.js';
import {
  GREEK_PACK, EGYPTIAN_PACK, MLP_PACK, BANANA_PACK, LOTR_PACK,
  ONE_PIECE_PACK, MHA_PACK, DBZ_PACK, AKIRA_PACK, SCOOBY_DOO_PACK,
  SIMPSONS_PACK, MONTY_PYTHON_PACK, OFFICE_PACK, BREAKING_BAD_PACK,
  STRANGER_THINGS_PACK, ADVENTURE_TIME_PACK, INVADER_ZIM_PACK,
  SPACE_GHOST_PACK, METALOCALYPSE_PACK,
  FAMILY_GUY_PACK, AMERICAN_DAD_PACK,
  AVATAR_PACK, SUPERNATURAL_PACK,
  ARCHER_PACK, BOBS_BURGERS_PACK, GRAVITY_FALLS_PACK,
  HARRY_POTTER_PACK, GOT_PACK,
} from './cultural/index.js';
import {
  SPRING_PACK, SUMMER_PACK, AUTUMN_PACK,
  WINTER_PACK, MEDICAL_PACK, APPLE_CIDER_SPIDER_PACK,
} from './seasonal/index.js';
import { CLEAN_PACK, PRO_PACK, MISANTHROPY_PACK, SAGGITARIA_PACK } from './minimal/index.js';

// Types
export type { ThemePack, ThemeCategory } from './types.js';

// API
export {
  applyThemePack,
  setCompanionMode,
  getCurrentPack,
  getCompanionMode,
  getThemePack,
  listThemePacks,
  getPackCompanions,
  populateLegacyRegistries,
} from './api.js';

// ============================================================================
// Theme Pack Registry
// ============================================================================

export const THEME_PACKS: Record<string, ThemePack> = {
  // Gaming
  mario: MARIO_PACK,
  pacman: PACMAN_PACK,
  digdug: DIGDUG_PACK,
  'donkey-kong': DONKEY_KONG_PACK,
  'resident-evil': RESIDENT_EVIL_PACK,
  zelda: ZELDA_PACK,
  pokemon: POKEMON_PACK,
  minecraft: MINECRAFT_PACK,
  'metal-gear': METAL_GEAR_PACK,
  undertale: UNDERTALE_PACK,
  tetris: TETRIS_PACK,
  'dark-souls': DARK_SOULS_PACK,
  doom: DOOM_PACK,
  sonic: SONIC_PACK,
  bioshock: BIOSHOCK_PACK,
  'mass-effect': MASS_EFFECT_PACK,
  warhammer: WARHAMMER_PACK,
  witcher: WITCHER_PACK,

  // Star Trek
  tos: TOS_PACK,
  tng: TNG_PACK,
  ds9: DS9_PACK,
  voyager: VOYAGER_PACK,
  enterprise: ENTERPRISE_PACK,
  snw: SNW_PACK,
  'lower-decks': LOWER_DECKS_PACK,
  borg: BORG_PACK,

  // Retro
  wargames: WARGAMES_PACK,
  cyberpunk: CYBERPUNK_PACK,
  basic: BASIC_PACK,
  invaders: INVADERS_PACK,
  glados: GLADOS_PACK,
  pipboy: PIPBOY_PACK,
  dos: DOS_PACK,
  bttf: BTTF_PACK,
  hackers: HACKERS_PACK,
  'mr-robot': MR_ROBOT_PACK,
  vim: VIM_PACK,
  emacs: EMACS_PACK,
  linux: LINUX_PACK,
  amiga: AMIGA_PACK,
  c64: C64_PACK,
  apple2: APPLE2_PACK,
  'bill-and-ted': BILL_AND_TED_PACK,
  nuclear: NUCLEAR_PACK,

  // Cultural
  greek: GREEK_PACK,
  egyptian: EGYPTIAN_PACK,
  mlp: MLP_PACK,
  banana: BANANA_PACK,
  lotr: LOTR_PACK,
  'one-piece': ONE_PIECE_PACK,
  mha: MHA_PACK,
  dbz: DBZ_PACK,
  akira: AKIRA_PACK,
  'scooby-doo': SCOOBY_DOO_PACK,
  simpsons: SIMPSONS_PACK,
  'monty-python': MONTY_PYTHON_PACK,
  'the-office': OFFICE_PACK,
  'breaking-bad': BREAKING_BAD_PACK,
  'stranger-things': STRANGER_THINGS_PACK,
  'adventure-time': ADVENTURE_TIME_PACK,
  'invader-zim': INVADER_ZIM_PACK,
  'space-ghost': SPACE_GHOST_PACK,
  metalocalypse: METALOCALYPSE_PACK,
  'family-guy': FAMILY_GUY_PACK,
  'american-dad': AMERICAN_DAD_PACK,
  avatar: AVATAR_PACK,
  supernatural: SUPERNATURAL_PACK,
  archer: ARCHER_PACK,
  'bobs-burgers': BOBS_BURGERS_PACK,
  'gravity-falls': GRAVITY_FALLS_PACK,
  'harry-potter': HARRY_POTTER_PACK,
  'game-of-thrones': GOT_PACK,

  // Sci-Fi
  matrix: MATRIX_PACK,
  hal9000: HAL9000_PACK,
  dune: DUNE_PACK,
  hitchhiker: HITCHHIKER_PACK,
  'millennium-falcon': FALCON_PACK,
  'doctor-who': DOCTOR_WHO_PACK,
  'rick-and-morty': RICK_AND_MORTY_PACK,
  'johnny-mnemonic': JOHNNY_MNEMONIC_PACK,
  'altered-carbon': ALTERED_CARBON_PACK,
  futurama: FUTURAMA_PACK,
  'blade-runner': BLADE_RUNNER_PACK,
  alien: ALIEN_PACK,
  terminator: TERMINATOR_PACK,
  tron: TRON_PACK,
  firefly: FIREFLY_PACK,
  'cowboy-bebop': COWBOY_BEBOP_PACK,
  evangelion: EVANGELION_PACK,
  'ghost-in-shell': GHOST_IN_SHELL_PACK,
  jetsons: JETSONS_PACK,
  'x-files': X_FILES_PACK,
  'dark-side': DARK_SIDE_PACK,
  'jurassic-park': JURASSIC_PARK_PACK,

  // Seasonal
  spring: SPRING_PACK,
  summer: SUMMER_PACK,
  autumn: AUTUMN_PACK,
  winter: WINTER_PACK,

  // Seasonal
  'apple-cider-spider': APPLE_CIDER_SPIDER_PACK,
  medical: MEDICAL_PACK,

  // Minimal
  clean: CLEAN_PACK,
  professional: PRO_PACK,
  misanthropy: MISANTHROPY_PACK,
  saggitaria: SAGGITARIA_PACK,
};
