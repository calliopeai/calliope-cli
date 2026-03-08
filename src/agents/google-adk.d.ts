/**
 * Type declaration for optional @google/adk dependency.
 * Minimal types needed for the SDK backend integration.
 */
declare module '@google/adk' {
  interface AgentConfig {
    name: string;
    model?: string;
    instruction?: string;
    [key: string]: unknown;
  }

  interface RunnerConfig {
    agent: Agent;
    appName?: string;
    [key: string]: unknown;
  }

  export class Agent {
    constructor(config: AgentConfig);
    generate?(prompt: string): Promise<Record<string, unknown>>;
  }

  export class Runner {
    constructor(config: RunnerConfig);
    run?(prompt: string): Promise<Record<string, unknown>>;
  }
}
