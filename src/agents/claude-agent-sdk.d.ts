/**
 * Type declaration for optional @anthropic-ai/claude-agent-sdk dependency.
 * Minimal types needed for the SDK backend integration.
 */
declare module '@anthropic-ai/claude-agent-sdk' {
  interface QueryOptions {
    prompt: string;
    options?: {
      model?: string;
      permissionMode?: 'default' | 'bypassPermissions';
      maxTurns?: number;
      cwd?: string;
      maxBudgetUsd?: number;
    };
  }

  interface SDKMessage {
    type: string;
    content?: string;
    text?: string;
    result?: string;
    [key: string]: unknown;
  }

  export function query(options: QueryOptions): AsyncIterable<SDKMessage>;
}
