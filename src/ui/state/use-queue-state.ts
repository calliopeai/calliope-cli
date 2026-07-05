/**
 * UI state - message queue
 *
 * Human-in-the-loop messages queued while the agent is processing, plus the
 * index of the queued message currently being edited. queuedMessagesRef mirrors
 * the state so the agent loop never reads a stale closure.
 */

import { useState, useRef, useEffect, useCallback } from 'react';

export interface QueueStateHook {
  queuedMessages: string[];
  setQueuedMessages: React.Dispatch<React.SetStateAction<string[]>>;
  queuedMessagesRef: React.MutableRefObject<string[]>;
  queueInput: string;
  setQueueInput: React.Dispatch<React.SetStateAction<string>>;
  editingQueueIndex: number | null;
  setEditingQueueIndex: React.Dispatch<React.SetStateAction<number | null>>;
  reset: () => void;
}

export function useQueueState(): QueueStateHook {
  const [queuedMessages, setQueuedMessages] = useState<string[]>([]);
  const queuedMessagesRef = useRef<string[]>([]); // Ref to avoid stale closure in runAgent
  const [queueInput, setQueueInput] = useState('');
  const [editingQueueIndex, setEditingQueueIndex] = useState<number | null>(null);

  // Keep ref in sync with state
  useEffect(() => {
    queuedMessagesRef.current = queuedMessages;
  }, [queuedMessages]);

  const reset = useCallback(() => {
    setQueuedMessages([]);
    setQueueInput('');
    setEditingQueueIndex(null);
  }, []);

  return {
    queuedMessages, setQueuedMessages, queuedMessagesRef,
    queueInput, setQueueInput,
    editingQueueIndex, setEditingQueueIndex,
    reset,
  };
}
