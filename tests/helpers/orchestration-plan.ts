import type { AgentContract, ProjectPlan } from '../../src/orchestration/index.js';
export function toyPlan(): ProjectPlan {
  const worker = (id: string, path: string): AgentContract => ({ id, parentId: 'coordinator', role: 'Task worker', objective: 'Inspect a public toy file and record evidence.', inputs: [],
    allowedTools: ['read_file','write_file'], allowedPaths: [{ path, access: 'write' }], preference: { provider: 'auto' }, tokenBudget: 1000, costBudgetUsd: 0.01, timeBudgetMs: 10000, maxChildDepth: 0, maxChildCount: 0,
    acceptanceCriteria: ['Produce a source-backed report.'], escalationPolicy: { onFailure: 'parent', maxRetries: 1 } });
  return { version: 1, id: 'toy-plan', goal: 'Inspect independent toy files, then verify the reports.',
    workspace: { id: 'toy-workspace', root: '.', allowedTools: ['read_file','write_file'], allowedPaths: [{ path: '.', access: 'write' }] },
    limits: { maxAgents: 4, maxTasks: 4, maxDepth: 2, maxConcurrent: 2, tokenBudget: 4000, costBudgetUsd: 0.04, timeBudgetMs: 30000 },
    agents: [{ ...worker('coordinator','.'), parentId: null, role: 'Project coordinator', tokenBudget: 4000, costBudgetUsd: 0.04, timeBudgetMs: 30000, maxChildDepth: 2, maxChildCount: 3, escalationPolicy: { onFailure: 'human', maxRetries: 1 } }, worker('a','a'), worker('b','b')],
    tasks: [{ id: 'inspect-a', agentId: 'a', objective: 'Inspect toy A.', inputs: [], outputs: [{ id: 'report-a', kind: 'report', description: 'Toy A findings.', path: 'a/report.txt' }], dependencies: [], acceptanceCriteria: ['Report cites the source.'] },
      { id: 'inspect-b', agentId: 'b', objective: 'Inspect toy B.', inputs: [], outputs: [{ id: 'report-b', kind: 'report', description: 'Toy B findings.', path: 'b/report.txt' }], dependencies: [], acceptanceCriteria: ['Report cites the source.'] },
      { id: 'verify', agentId: 'coordinator', objective: 'Check both reports.', inputs: [{ id: 'a-report', kind: 'artifact', value: 'report-a' }, { id: 'b-report', kind: 'artifact', value: 'report-b' }], outputs: [{ id: 'verification', kind: 'test_result', description: 'Verification evidence.', path: 'verification.json' }], dependencies: ['inspect-a','inspect-b'], acceptanceCriteria: ['Both reports have verifiable source evidence.'] }] };
}
