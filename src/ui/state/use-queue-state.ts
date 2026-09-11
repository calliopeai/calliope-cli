/**
 * UI state - message queue
 *
 * Human-in-the-loop messages queued while the agent is processing, plus the
 * index of the queued message currently being edited. queuedMessagesRef mirrors
 * the state so the agent loop never reads a stale closure.
 */

import { useState, useRef, useCallback } from 'react';
import type { Submission } from '../../preferences/index.js';

export interface QueueStateHook {
  queuedMessages: Submission[];
  setQueuedMessages: React.Dispatch<React.SetStateAction<Submission[]>>;
  queuedMessagesRef: React.MutableRefObject<Submission[]>;
  queueInput: string;
  setQueueInput: React.Dispatch<React.SetStateAction<string>>;
  editingQueueIndex: number | null;
  setEditingQueueIndex: React.Dispatch<React.SetStateAction<number | null>>;
  reset: () => void;
}

export function useQueueState(): QueueStateHook {
  const [queuedMessages, setState] = useState<Submission[]>([]);
  const queuedMessagesRef = useRef<Submission[]>([]);
  const setQueuedMessages: QueueStateHook['setQueuedMessages'] = useCallback(value => {
    const next = typeof value === 'function' ? value(queuedMessagesRef.current) : value;
    if (next.length > 100) throw new Error('Message queue is full (100 turns); finish or remove pending work first');
    queuedMessagesRef.current = next;
    setState(next);
  }, []);
  const [queueInput, setQueueInput] = useState('');
  const [editingQueueIndex, setEditingQueueIndex] = useState<number | null>(null);

  const reset = useCallback(() => {
    setQueuedMessages([]);
    setQueueInput('');
    setEditingQueueIndex(null);
  }, [setQueuedMessages]);

  return {
    queuedMessages, setQueuedMessages, queuedMessagesRef,
    queueInput, setQueueInput,
    editingQueueIndex, setEditingQueueIndex,
    reset,
  };
}
