import { useCallback, useEffect, useRef, useState } from 'react';
import { ApprovalQueue, ApprovalStore, type ApprovalChoice, type ApprovalRequest, type PendingApproval } from '../../approvals/index.js';

export function useApprovalState() {
  const [pending, setPending] = useState<PendingApproval | null>(null);
  const [store] = useState(() => new ApprovalStore());
  const mounted = useRef(true);
  const [queue] = useState(() => new ApprovalQueue(value => { if (mounted.current) setPending(value); }));
  // Session changes run only while the turn controller is idle. Cancel via the
  // turn signal/reset, never a render effect: initial session creation can be
  // observed by React after the first approval request is already pending.
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; queue.cancel(); }; }, [queue]);
  const request = useCallback((request: ApprovalRequest, signal?: AbortSignal) => queue.request(request, signal), [queue]);
  const answer = useCallback((id: string, choice: ApprovalChoice) => queue.answer(id, choice), [queue]);
  const cancel = useCallback(() => queue.cancel(), [queue]);
  return { store, pending, request, answer, cancel };
}
