import type { LLMProvider } from '../types.js';

export type HealthProvider = Exclude<LLMProvider, 'auto'>;
export type HealthOutcome = 'success' | 'error' | 'timeout' | 'cancelled';
export type FailureKind = 'authentication' | 'quota' | 'rate_limit' | 'timeout' | 'network' | 'server' | 'invalid_request' | 'response' | 'unknown';
export type Capability = 'tools' | 'streaming' | 'cancellation' | 'usage';
export type CapabilityEvidence = Partial<Record<Capability, boolean>>;
export interface HealthSettings {
  retentionEvents: number;
  retentionDays: number;
  failureThreshold: number;
  failureWindowMs: number;
  quarantineMs: number;
  probeTimeoutMs: number;
}
export interface HealthTarget {
  provider: HealthProvider;
  key: string;
  endpoint: string;
  protocol: string;
  credentials: 'configured' | 'missing' | 'not-required';
}
export interface HealthObservation {
  provider: HealthProvider;
  target: string;
  type: 'attempt' | 'discovery' | 'conformance' | 'reset';
  outcome?: HealthOutcome;
  durationMs?: number;
  retryIndex?: number;
  failure?: FailureKind;
  httpStatus?: number;
  modelCount?: number;
  capabilities?: CapabilityEvidence;
  evidenceHash?: string;
}
export interface HealthEvent extends HealthObservation {
  version: 1;
  id: string;
  at: string;
  source: 'local' | 'imported';
  originId?: string;
  sha256: string;
}
export interface HealthSnapshot {
  provider: HealthProvider;
  target: string;
  sampleCount: number;
  latencyMs: number | null;
  timeoutRate: number | null;
  retryRate: number | null;
  errorRate: number | null;
  lastSuccessAt: string | null;
  lastFailure: { at: string; kind: FailureKind; httpStatus: number | null } | null;
  discovery: { status: HealthOutcome | 'unknown'; at: string | null; modelCount: number | null };
  lastSuccessfulConformanceAt: string | null;
  capabilities: Record<Capability, boolean | 'unknown'>;
  quarantine: { active: boolean; reason: FailureKind | null; expiresAt: string | null; failures: number };
  importedEvents: number;
}
