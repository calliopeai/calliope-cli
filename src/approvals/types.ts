export type ApprovalChoice = 'allow' | 'allow_session' | 'allow_project' | 'reject' | 'cancelled';
export interface ApprovalRequest {
  version: 1;
  key: string;
  project: string;
  projectKey: string;
  tool: string;
  risk: 'none' | 'low' | 'medium' | 'high' | 'critical';
  reason: string;
  details: string[];
  reusable: boolean;
}
export interface ApprovalGrant {
  version: 1; id: string; projectKey: string; key: string; tool: string;
  scope: 'session' | 'project'; sessionId?: string; createdAt: number; expiresAt: number;
}
export class ApprovalError extends Error {
  constructor(message: string) { super(`Approval records: ${message}`); this.name = 'ApprovalError'; }
}
