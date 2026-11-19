import { ExecutionLimitError } from '../execution/types.js';

/** Host notification failures cannot authorize provider retries or helper fallback. */
export async function hostCallback<T>(name: string, notify: () => T): Promise<Awaited<T>> {
  try { return await notify(); }
  catch (error) {
    if (error instanceof ExecutionLimitError) throw error;
    throw new ExecutionLimitError('unavailable', `Runtime ${name} callback failed; no further execution is authorized.`);
  }
}
