import { afterEach, describe, expect, it } from 'vitest';
import { isNotableRoutingDecision } from '../src/routing/index.js';
import type { RouteCandidate, RoutingDecision } from '../src/routing/types.js';

function candidate(provider: RouteCandidate['provider'], model: string, evidence: RouteCandidate['evidence'] = 'live'): RouteCandidate {
  return { provider, model, target: '0'.repeat(64), evidence, discoveredAt: null, capabilities: {}, contextLength: null,
    maxOutputTokens: null, price: null, estimatedCost: null, latencyMs: null, errorRate: null, score: 0, reason: 'fixture' };
}

function decision(overrides: Partial<RoutingDecision>): RoutingDecision {
  return { version: 1, id: 'd', at: '2026-01-01T00:00:00Z', status: 'selected', mode: 'explicit',
    requested: { provider: 'openai', model: null }, selected: candidate('openai', 'gpt-6-astra'),
    alternatives: [], exclusions: [], reason: 'explicit selection', ...overrides };
}

describe('isNotableRoutingDecision', () => {
  const debug = process.env.CALLIOPE_DEBUG;
  afterEach(() => { if (debug === undefined) delete process.env.CALLIOPE_DEBUG; else process.env.CALLIOPE_DEBUG = debug; });

  it('stays quiet for an explicit or turn-pinned pick that landed where the user pointed', () => {
    delete process.env.CALLIOPE_DEBUG;
    expect(isNotableRoutingDecision(decision({}))).toBe(false);
    expect(isNotableRoutingDecision(decision({ requested: { provider: 'openai', model: 'gpt-6-astra' } }))).toBe(false);
    expect(isNotableRoutingDecision(decision({ mode: 'turn-pinned', requested: { provider: 'openai', model: 'gpt-6-astra' } }))).toBe(false);
  });

  it('announces auto and smart routing, fallbacks, unverified models and failures', () => {
    delete process.env.CALLIOPE_DEBUG;
    expect(isNotableRoutingDecision(decision({ mode: 'auto', requested: { provider: 'auto', model: null } }))).toBe(true);
    expect(isNotableRoutingDecision(decision({ smart: { profile: 'balanced', stage: 'initial' } as RoutingDecision['smart'] }))).toBe(true);
    expect(isNotableRoutingDecision(decision({ requested: { provider: 'anthropic', model: null } }))).toBe(true);
    expect(isNotableRoutingDecision(decision({ requested: { provider: 'openai', model: 'gpt-5.5' } }))).toBe(true);
    expect(isNotableRoutingDecision(decision({ selected: candidate('openai', 'gpt-6-astra', 'explicit-unverified') }))).toBe(true);
    expect(isNotableRoutingDecision(decision({ status: 'unavailable', selected: null }))).toBe(true);
  });

  it('shows every decision under CALLIOPE_DEBUG=1', () => {
    process.env.CALLIOPE_DEBUG = '1';
    expect(isNotableRoutingDecision(decision({}))).toBe(true);
  });
});
