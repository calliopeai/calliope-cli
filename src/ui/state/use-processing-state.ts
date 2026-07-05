/**
 * UI state - processing / thinking / streaming
 *
 * The classic co-updating trio (plus activity) driven by the agent loop. Backed
 * by useReducer because these four fields transition together; individual
 * setters preserve the exact React setState semantics the AgentContext expects
 * (including the functional-updater form used to append streaming chunks).
 */

import { useReducer, useCallback } from 'react';
import type { ThinkingState, ActivityState } from '../types.js';

export interface ProcessingState {
  isProcessing: boolean;
  thinkingState: ThinkingState | null;
  streamingResponse: string;
  activityState: ActivityState | null;
}

const INITIAL: ProcessingState = {
  isProcessing: false,
  thinkingState: null,
  streamingResponse: '',
  activityState: null,
};

type Action =
  | { type: 'setIsProcessing'; value: boolean }
  | { type: 'setThinkingState'; value: ThinkingState | null }
  | { type: 'setStreamingResponse'; value: string | ((prev: string) => string) }
  | { type: 'setActivityState'; value: ActivityState | null }
  | { type: 'reset' };

function reducer(state: ProcessingState, action: Action): ProcessingState {
  switch (action.type) {
    case 'setIsProcessing':
      // Identity bail-out mirrors useState's Object.is skip (no spurious render).
      return state.isProcessing === action.value ? state : { ...state, isProcessing: action.value };
    case 'setThinkingState':
      return state.thinkingState === action.value ? state : { ...state, thinkingState: action.value };
    case 'setStreamingResponse': {
      const next = typeof action.value === 'function' ? action.value(state.streamingResponse) : action.value;
      return next === state.streamingResponse ? state : { ...state, streamingResponse: next };
    }
    case 'setActivityState':
      return state.activityState === action.value ? state : { ...state, activityState: action.value };
    case 'reset':
      return INITIAL;
    default:
      return state;
  }
}

export interface ProcessingStateHook extends ProcessingState {
  setIsProcessing: (v: boolean) => void;
  setThinkingState: (v: ThinkingState | null) => void;
  setStreamingResponse: (v: string | ((prev: string) => string)) => void;
  setActivityState: (v: ActivityState | null) => void;
  reset: () => void;
}

export function useProcessingState(): ProcessingStateHook {
  const [state, dispatch] = useReducer(reducer, INITIAL);

  return {
    ...state,
    setIsProcessing: useCallback((value: boolean) => dispatch({ type: 'setIsProcessing', value }), []),
    setThinkingState: useCallback((value: ThinkingState | null) => dispatch({ type: 'setThinkingState', value }), []),
    setStreamingResponse: useCallback((value: string | ((prev: string) => string)) => dispatch({ type: 'setStreamingResponse', value }), []),
    setActivityState: useCallback((value: ActivityState | null) => dispatch({ type: 'setActivityState', value }), []),
    reset: useCallback(() => dispatch({ type: 'reset' }), []),
  };
}
