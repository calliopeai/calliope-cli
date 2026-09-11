import type { LLMProvider } from '../types.js';

export interface ModelPreference {
  provider?: LLMProvider;
  /** null explicitly clears an inherited model. */
  model?: string | null;
}
export type PreferenceSource = 'global' | 'project' | 'environment' | 'session' | 'turn';
export interface ResolvedPreference {
  provider: LLMProvider;
  model?: string;
  sources: { provider: PreferenceSource; model: PreferenceSource | null };
  warnings: string[];
}
export interface ProjectModelDefaults {
  version: 1;
  updatedAt: string;
  selection: ModelPreference;
  [key: string]: unknown;
}
