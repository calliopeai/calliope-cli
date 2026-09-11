export type PermissionLayer = 'mode' | 'confirmation' | 'scope' | 'sandbox' | 'blocklist' | 'hook' | 'policy' | 'default' | 'resolver' | 'cancellation';
export interface PermissionDecision {
  decision: 'allow' | 'deny' | 'confirm' | 'cancelled';
  layer: PermissionLayer;
  reason: string;
  durationMs: number;
}
/** One display/audit string, including the deciding layer, for every client. */
export function permissionReason(layer: PermissionLayer, detail: string): string {
  return `[${layer}] ${detail.replace(/\s+/g, ' ').trim()}`;
}
