import { randomUUID } from 'node:crypto';
import type { ApprovalChoice, ApprovalRequest } from './types.js';

export interface PendingApproval { id: string; request: ApprovalRequest; queued: number }
interface Entry { id: string; request: ApprovalRequest; resolve: (choice: ApprovalChoice) => void; cleanup: () => void }
/** A bounded FIFO; stale dialog IDs and late approvals have no effect. */
export class ApprovalQueue {
  private entries: Entry[] = [];
  constructor(private readonly changed: (pending: PendingApproval | null) => void) {}
  private notify(): void { const entry = this.entries[0]; this.changed(entry ? { id: entry.id, request: entry.request, queued: this.entries.length - 1 } : null); }
  request(request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalChoice> {
    if (signal?.aborted) return Promise.resolve('cancelled');
    if (this.entries.length >= 100) return Promise.resolve('reject');
    return new Promise(resolve => {
      const id = randomUUID();
      const abort = () => this.settle(id, 'cancelled');
      this.entries.push({ id, request, resolve, cleanup: () => signal?.removeEventListener('abort', abort) });
      signal?.addEventListener('abort', abort, { once: true }); this.notify();
    });
  }
  private settle(id: string, choice: ApprovalChoice): void {
    const index = this.entries.findIndex(entry => entry.id === id); if (index < 0) return;
    const [entry] = this.entries.splice(index, 1); entry!.cleanup(); entry!.resolve(choice); this.notify();
  }
  answer(id: string, choice: ApprovalChoice): boolean {
    const current = this.entries[0]; if (!current || current.id !== id) return false;
    if (['allow_session', 'allow_project'].includes(choice) && !current.request.reusable) return false;
    this.settle(id, choice); return true;
  }
  cancel(): void { const entries = this.entries.splice(0); for (const entry of entries) { entry.cleanup(); entry.resolve('cancelled'); } this.notify(); }
}
