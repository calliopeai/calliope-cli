/** A retained session restriction; it never grants execution authority. */
export interface SessionExecutionBinding {
  version: 1;
  manifestHash: string;
  agentId: string;
}

export function validSessionExecutionBinding(value: unknown): value is SessionExecutionBinding {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return Object.keys(v).sort().join() === 'agentId,manifestHash,version' && v.version === 1
    && typeof v.manifestHash === 'string' && /^[a-f0-9]{64}$/.test(v.manifestHash)
    && typeof v.agentId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(v.agentId);
}
