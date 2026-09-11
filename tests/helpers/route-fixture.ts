/** Deterministic routing dependency for existing client/permission unit suites.
 * Live discovery/routing and runtime transport integration have separate tests. */
import { randomUUID } from 'node:crypto';
import { DEFAULT_MODELS } from '../../src/types.js';
import type { RoutingDecision, RoutingRequest } from '../../src/routing/types.js';

export async function fixtureRoute(request: RoutingRequest): Promise<RoutingDecision> {
  const provider = !request.provider || request.provider === 'auto' ? 'anthropic' : request.provider;
  const model = request.model || DEFAULT_MODELS[provider] || 'fixture-model';
  return { version: 1, id: randomUUID(), at: new Date().toISOString(), status: request.signal?.aborted ? 'cancelled' : 'selected',
    mode: 'explicit', requested: { provider: request.origin?.provider ?? request.provider, model: (request.origin?.model ?? request.model) || null },
    selected: request.signal?.aborted ? null : { provider, model, target: '0'.repeat(64), evidence: 'explicit-unverified', discoveredAt: null,
      capabilities: {}, contextLength: null, maxOutputTokens: null, price: null, estimatedCost: null, latencyMs: null, errorRate: null, score: 0, reason: 'Synthetic client fixture' },
    alternatives: [], exclusions: [], reason: 'Synthetic client fixture' };
}
