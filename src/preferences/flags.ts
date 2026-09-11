import { validatePreference } from './validate.js';
import type { ModelPreference } from './types.js';

/** Strip only provider/model flags; arguments after -- are literal prompt text. */
export function parseModelFlags(args: string[]): { preference: ModelPreference; args: string[]; literal: string[] } {
  const preference: ModelPreference = {}, remaining: string[] = [];
  for (let index = 0; index < args.length; index++) {
    const arg = args[index]!;
    if (arg === '--') return { preference: validatePreference(preference), args: remaining, literal: args.slice(index + 1) };
    const flag = arg.split('=', 1)[0];
    if (flag !== '--provider' && flag !== '--model') { remaining.push(arg); continue; }
    const field = flag === '--provider' ? 'provider' : 'model';
    if (Object.hasOwn(preference, field)) throw new Error(`Duplicate ${flag} option`);
    const value = arg.includes('=') ? arg.slice(arg.indexOf('=') + 1) : args[++index];
    if (!value || value.startsWith('-')) throw new Error(`${flag} requires a value`);
    if (field === 'provider') preference.provider = value as ModelPreference['provider']; else preference.model = value;
  }
  return { preference: validatePreference(preference), args: remaining, literal: [] };
}
