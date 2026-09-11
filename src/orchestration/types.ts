/** Version 1 describes declared work. Preparation never claims execution. */
export interface PathGrant { path: string; access: 'read' | 'write' }
export interface AgentInput { id: string; kind: 'text' | 'file' | 'artifact'; value: string }
export interface ArtifactSpec { id: string; kind: 'file' | 'patch' | 'report' | 'test_result' | 'decision' | 'evidence'; description: string; path?: string }
export interface AgentContract {
  id: string; parentId: string | null; role: string; objective: string; inputs: AgentInput[];
  allowedTools: string[]; allowedPaths: PathGrant[];
  preference: { provider: string; model?: string };
  tokenBudget: number; costBudgetUsd: number; timeBudgetMs: number;
  maxChildDepth: number; maxChildCount: number; acceptanceCriteria: string[];
  escalationPolicy: { onFailure: 'stop' | 'parent' | 'human'; maxRetries: number };
}
export interface ProjectTask {
  id: string; agentId: string; objective: string; inputs: AgentInput[]; outputs: ArtifactSpec[];
  dependencies: string[]; acceptanceCriteria: string[];
}
export interface ProjectPlan {
  version: 1; id: string; goal: string;
  workspace: { id: string; root: '.'; allowedTools: string[]; allowedPaths: PathGrant[] };
  limits: { maxAgents: number; maxTasks: number; maxDepth: number; maxConcurrent: number; tokenBudget: number; costBudgetUsd: number; timeBudgetMs: number };
  agents: AgentContract[]; tasks: ProjectTask[];
}
export interface ArtifactEvidence {
  id: string; taskId: string; agentId: string; kind: ArtifactSpec['kind']; path: string; sha256: string;
  createdAt: string; source: { runId: string; eventId: string }; confidence: number;
}
export interface AgentOutput {
  version: 1; agentId: string; taskId: string; status: 'success' | 'partial' | 'failed' | 'cancelled' | 'denied';
  summary: string; changedFiles: string[]; artifacts: ArtifactEvidence[];
  testEvidence: string[]; unresolvedRisks: string[]; recommendedNextAction: string;
}
export interface PlanAnalysis {
  plan: ProjectPlan; hash: string; coordinatorId: string; depths: Record<string, number>;
  stages: string[][]; conflicts: { tasks: [string, string]; paths: string[] }[];
}
export interface ProjectIdentity { root: string; key: string }
export interface RunManifest {
  version: 1; id: string; createdAt: string; project: ProjectIdentity;
  plan: ProjectPlan; planHash: string; source: { path: string; sha256: string }; hash: string;
}
export type RunChange = { type: 'prepared'; manifestHash: string } | { type: 'approved' | 'cancelled'; source: 'cli' | 'repl' };
export interface EventLink { id: string; hash: string }
export interface OrchestrationEvent {
  version: 1; id: string; runId: string; at: string; sequence: number; previous: EventLink | null; change: RunChange; hash: string;
}
export interface PreparedRun {
  version: 1; id: string; project: ProjectIdentity; planHash: string; revision: string;
  status: 'prepared' | 'approved' | 'cancelled'; approval: 'pending' | 'approved' | 'revoked';
  createdAt: string; updatedAt: string; eventCount: number; executedTasks: 0;
}
export interface RunInspection { run: PreparedRun; manifest: RunManifest; events: OrchestrationEvent[]; analysis: PlanAnalysis }
export class OrchestrationError extends Error {
  constructor(readonly code: 'invalid' | 'policy-denied' | 'conflict' | 'locked' | 'limit' | 'unavailable', message: string) {
    super(message); this.name = 'OrchestrationError';
  }
}
