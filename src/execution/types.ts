/** Runtime authority is supplied by a trusted coordinator, never by model output. */
export interface ExecutionPath { path: string; access: 'read' | 'write' }
export interface ExecutionAccount {
  id: string; parentId: string | null;
  tokenBudget: number; costBudgetNanos: number; deadline: number;
  allowedTools: string[]; allowedPaths: ExecutionPath[];
}
export interface ExecutionManifest {
  version: 1; runId: string; planHash: string;
  project: { root: string; key: string };
  createdAt: number; deadline: number;
  tokenBudget: number; costBudgetNanos: number;
  accounts: ExecutionAccount[];
}
export interface RequestReservation {
  id: string; agentId: string; provider: string; model: string; target: string;
  inputTokens: number; outputTokens: number; costNanos: number;
  inputPrice: number; outputPrice: number;
  limits?: {tokens?:number;costNanos?:number};
}
export interface RequestSettlement {
  requestId: string; outcome: 'success' | 'error' | 'cancelled' | 'invalid-usage';
  usage?: { inputTokens: number; outputTokens: number };
}
export interface ReservationEvent {
  version: 1; id: string; at: number; previous: string;
  change: { type: 'reserve'; reservation: RequestReservation } | { type: 'settle'; settlement: RequestSettlement };
  hash: string;
}
export interface AccountSpend { tokens: number; costNanos: number }
export interface ReservationProjection {
  version: 1; runId: string; manifestHash: string; revision: string;
  spent: AccountSpend; accounts: Record<string, AccountSpend>;
  requests: Record<string, { reservation: RequestReservation; state: 'pending' | 'settled' | 'unknown' | 'exceeded' }>;
  exceeded: boolean;
}
export class ExecutionLimitError extends Error {
  constructor(readonly code: 'invalid' | 'authority' | 'budget' | 'deadline' | 'unavailable' | 'locked' | 'conflict' | 'limit', message: string) {
    super(message); this.name = 'ExecutionLimitError';
  }
}
