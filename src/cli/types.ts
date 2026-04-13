/**
 * CLI Types & Constants
 */

import type { Message, LLMProvider, AgentPersona, Mode } from '../types.js';
import { IterationLedger } from '../iteration-ledger.js';

// Debug logging helper
const DEBUG = process.env.CALLIOPE_DEBUG === '1';
export function debugLog(message: string, ...args: unknown[]): void {
  if (DEBUG) console.log(`[DEBUG:cli] ${message}`, ...args);
}

// Slash commands for tab completion
export const COMMANDS = [
  '/help', '/h', '/provider', '/p', '/model', '/m', '/models', '/persona',
  '/clear', '/c', '/status', '/s', '/loop', '/cancel-loop', '/breakloop',
  '/setup', '/config', '/upgrade', '/exit', '/quit',
  '/memory', '/hooks', '/route', '/summarize', '/theme', '/branch', '/find', '/search',
  '/mode', '/work', '/plan', '/debug', '/set', '/confirm',
  '/scope', '/add-dir', '/remove-dir', '/cost', '/costs', '/session', '/context',
  '/log',
  '/skin', '/palette', '/companion', '/hud',
];

export interface CLIOptions {
  skipPermissions?: boolean;
}

export interface CLIState {
  provider: LLMProvider;
  model?: string;
  persona: AgentPersona;
  messages: Message[];
  cwd: string;
  running: boolean;
  skipPermissions: boolean;
  loopActive: boolean;
  loopPrompt: string;
  loopIteration: number;
  loopMaxIterations: number;
  loopCompletionPromise?: string;
  autoRoute: boolean;
  currentBranch: string;
  mode: Mode;
  confirmMode: boolean;
  debugEnabled: boolean;
  sessionCost: number;
  sessionId?: string;
  ledger: IterationLedger;
}
