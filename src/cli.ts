/**
 * Calliope CLI - Interactive REPL
 *
 * Barrel re-export. The implementation lives in src/cli/.
 *
 * @see cli/types.ts    — CLIState, CLIOptions interfaces
 * @see cli/commands.ts — Slash command handlers (handleCommand)
 * @see cli/agent.ts    — Agent loop, tool display
 * @see cli/index.ts    — startCLI entry point
 */

export { startCLI } from './cli/index.js';
export type { CLIOptions, CLIState } from './cli/types.js';
