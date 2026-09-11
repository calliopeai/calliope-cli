import { validatePreference } from './validate.js';
import type { ModelPreference } from './types.js';

export const ONCE_USAGE = '/once [--provider <name>] [--model <id>] -- <prompt>';
/** The delimiter makes arbitrary prompts unambiguous; never shell-parse or execute them. */
export function parseOnce(input: string): { preference: ModelPreference; prompt: string } | undefined {
  if (!/^\/once(?:\s|$)/i.test(input)) return undefined;
  if (input.length > 1024 * 1024) throw new Error('Single-turn input exceeds 1 MiB');
  const split = /\s--(?:\s|$)/.exec(input);
  if (!split) throw new Error(`Usage: ${ONCE_USAGE}`);
  const flags = input.slice(5, split.index).trim().split(/\s+/).filter(Boolean);
  const prompt = input.slice(split.index + split[0].length).trim();
  if (!prompt || !flags.length || flags.length > 4 || flags.length % 2) throw new Error(`Usage: ${ONCE_USAGE}`);
  const preference: ModelPreference = {};
  for (let i = 0; i < flags.length; i += 2) {
    const flag = flags[i], value = flags[i + 1]!;
    if (flag === '--provider' && preference.provider === undefined) preference.provider = value as ModelPreference['provider'];
    else if (flag === '--model' && preference.model === undefined) preference.model = value;
    else throw new Error(`Usage: ${ONCE_USAGE}`);
  }
  return { preference: validatePreference(preference), prompt };
}
