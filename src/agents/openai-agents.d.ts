/**
 * Type declaration for optional @openai/agents dependency.
 * Minimal types needed for the SDK backend integration.
 */
declare module '@openai/agents' {
  interface AgentConfig {
    name: string;
    instructions?: string;
    model?: string;
    modelSettings?: {
      baseUrl?: string;
      apiKey?: string;
    };
    [key: string]: unknown;
  }

  interface RunResult {
    finalOutput?: string;
    output?: string;
    toTextStream?: () => AsyncIterable<string>;
    events?: AsyncIterable<unknown>;
    [key: string]: unknown;
  }

  export class Agent {
    constructor(config: AgentConfig);
  }

  export function run(
    agent: Agent,
    prompt: string,
    options?: { stream?: boolean; [key: string]: unknown }
  ): Promise<RunResult>;
}
