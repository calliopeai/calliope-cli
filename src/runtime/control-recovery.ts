import type { ControlCheckpoint, ControlReceipt, SteeringIntent } from './control.js';

/** Acknowledged host history only; ownership and execution admission remain external. */
export interface ControlRecoveryState {
  version: 1;
  sessionId: string;
  checkpoint: ControlCheckpoint;
  phase: 'running' | 'paused';
  pauses: { paused: ControlReceipt; resumed: ControlReceipt | null }[];
  steering: { intent: SteeringIntent; receipt: ControlReceipt }[];
}

export const validControlIdentifier = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value);

function invalid(): never { throw new Error('Retained control history is invalid; the original session remains held.'); }
function object(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && Object.getPrototypeOf(value) === Object.prototype;
}
function keys(value: unknown, expected: string): value is Record<string, unknown> {
  return object(value) && Object.keys(value).sort().join() === expected;
}
function checkpoint(value: unknown): void {
  if (!object(value) || !validControlIdentifier(value.revision) ||
      typeof value.checksum !== 'string' || !/^[a-f0-9]{64}$/.test(value.checksum)) invalid();
}
function receipt(value: unknown, session: string, kind: ControlReceipt['kind']): asserts value is ControlReceipt {
  if (!keys(value, 'checksum,kind,requestId,revision,sessionId') || value.sessionId !== session ||
      value.kind !== kind || !validControlIdentifier(value.requestId)) invalid();
  checkpoint(value);
}

export function validateControlRecovery(value: unknown): asserts value is ControlRecoveryState {
  if (!keys(value, 'checkpoint,pauses,phase,sessionId,steering,version') || value.version !== 1 ||
      !validControlIdentifier(value.sessionId) || value.phase !== 'running' && value.phase !== 'paused' ||
      !keys(value.checkpoint, 'checksum,revision') || !Array.isArray(value.pauses) || !Array.isArray(value.steering) ||
      value.pauses.length + value.steering.length > 128) invalid();
  checkpoint(value.checkpoint);
  const ids = new Set<string>();
  let open = 0;
  for (const [index, pause] of value.pauses.entries()) {
    if (!keys(pause, 'paused,resumed')) invalid();
    receipt(pause.paused, value.sessionId, 'paused');
    const id = pause.paused.requestId;
    if (ids.has(id)) invalid();
    ids.add(id);
    if (pause.resumed === null) {
      if (index !== value.pauses.length - 1) invalid();
      open++;
    } else {
      receipt(pause.resumed, value.sessionId, 'resumed');
      if (pause.resumed.requestId !== id) invalid();
    }
  }
  if (open !== (value.phase === 'paused' ? 1 : 0)) invalid();
  for (const entry of value.steering) {
    if (!keys(entry, 'intent,receipt') || !keys(entry.intent, 'requestId,revision,sessionId,text')) invalid();
    const intent = entry.intent;
    if (intent.sessionId !== value.sessionId || !validControlIdentifier(intent.requestId) ||
        !validControlIdentifier(intent.revision) || typeof intent.text !== 'string' || !intent.text.trim() ||
        intent.text.includes('\0') || Buffer.byteLength(intent.text) > 16 * 1024 || ids.has(intent.requestId)) invalid();
    receipt(entry.receipt, value.sessionId, 'steered');
    if (entry.receipt.requestId !== intent.requestId) invalid();
    ids.add(intent.requestId);
  }
}

export function controlRecoveryIdentity(value: ControlRecoveryState): string {
  const receipt = (item: ControlReceipt | null) => item &&
    [item.sessionId, item.requestId, item.kind, item.revision, item.checksum];
  return JSON.stringify([value.version, value.sessionId, value.phase,
    [value.checkpoint.revision, value.checkpoint.checksum],
    value.pauses.map(item => [receipt(item.paused), receipt(item.resumed)]),
    value.steering.map(item => [[item.intent.sessionId, item.intent.requestId, item.intent.revision, item.intent.text], receipt(item.receipt)])]);
}
