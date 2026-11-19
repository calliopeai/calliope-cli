import type { ProviderResponseCheckpoint } from '../providers/types.js';

/** Correlated, accounted facts only; never a cold execution resume capability. */
export const PROVIDER_RESPONSE_CHECKPOINT_PROTOCOL_VERSION = 1;

export type ProviderRequestPurpose = 'primary' | 'compression' | 'repair';

/** Correlated response facts. This record cannot authorize restoring execution. */
export interface RuntimeProviderResponseCheckpoint {
  readonly version: 1;
  readonly sessionId: string;
  readonly turnId: string;
  readonly runId: string;
  readonly agentId: string;
  readonly manifestHash: string;
  readonly operationId: string;
  readonly parentOperationId: string | null;
  readonly purpose: ProviderRequestPurpose;
  readonly iteration: number;
  /** Digest of the detached runtime request, not a claim about provider wire encoding. */
  readonly runtimeRequestSha256: string;
  readonly checkpoint: ProviderResponseCheckpoint;
}
