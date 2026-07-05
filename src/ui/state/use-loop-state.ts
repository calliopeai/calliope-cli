/**
 * UI state - agent loop control
 *
 * Drives the /loop command: whether a loop is active, its prompt, iteration
 * bounds, and the cancel flag. loopCancelledRef is a ref so the running loop
 * observes cancellation without a stale closure.
 */

import { useState, useRef, useCallback } from 'react';
import * as config from '../../config.js';
import { resolveIterationLimit } from '../../iteration-limit.js';

function initialMaxIterations(): number {
  return resolveIterationLimit(config.get('maxIterations'));
}

export interface LoopStateHook {
  loopActive: boolean;
  setLoopActive: React.Dispatch<React.SetStateAction<boolean>>;
  loopPrompt: string;
  setLoopPrompt: React.Dispatch<React.SetStateAction<string>>;
  loopMaxIterations: number;
  setLoopMaxIterations: React.Dispatch<React.SetStateAction<number>>;
  loopCompletionPromise: string | undefined;
  setLoopCompletionPromise: React.Dispatch<React.SetStateAction<string | undefined>>;
  loopIteration: number;
  setLoopIteration: React.Dispatch<React.SetStateAction<number>>;
  loopCancelledRef: React.MutableRefObject<boolean>;
  reset: () => void;
}

export function useLoopState(): LoopStateHook {
  const [loopActive, setLoopActive] = useState(false);
  const [loopPrompt, setLoopPrompt] = useState<string>('');
  const [loopMaxIterations, setLoopMaxIterations] = useState(initialMaxIterations);
  const [loopCompletionPromise, setLoopCompletionPromise] = useState<string | undefined>();
  const [loopIteration, setLoopIteration] = useState(0);
  const loopCancelledRef = useRef(false);

  const reset = useCallback(() => {
    setLoopActive(false);
    setLoopPrompt('');
    setLoopMaxIterations(initialMaxIterations());
    setLoopCompletionPromise(undefined);
    setLoopIteration(0);
    loopCancelledRef.current = false;
  }, []);

  return {
    loopActive, setLoopActive,
    loopPrompt, setLoopPrompt,
    loopMaxIterations, setLoopMaxIterations,
    loopCompletionPromise, setLoopCompletionPromise,
    loopIteration, setLoopIteration,
    loopCancelledRef,
    reset,
  };
}
