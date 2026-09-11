import { MUTATING_TOOLS } from './permissions.js';

const READ_TOOLS = new Set(['read_file', 'list_files', 'glob', 'grep', 'web_search', 'web_fetch']);

/** Retry only known read operations; unknown/plugin operations may mutate state. */
export function shouldRetryTool(name: string, error: string): boolean {
  if (MUTATING_TOOLS.has(name) || !READ_TOOLS.has(name)) return false;
  const message = error.toLowerCase();
  if (['must be', 'is required', 'invalid', 'not found', 'no such file', 'permission denied', 'unauthorized', 'forbidden', '401', '403', '404', '400', 'bad request', 'validation'].some(part => message.includes(part))) return false;
  return ['timeout', 'timed out', 'etimedout', 'econnreset', 'econnrefused', 'enotfound', 'eai_again', 'network', 'socket hang up', 'rate limit', 'rate-limit', 'too many requests', '429', '503', '502', '500', 'temporarily', 'try again'].some(part => message.includes(part));
}
