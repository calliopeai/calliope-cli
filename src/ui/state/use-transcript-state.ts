/**
 * UI state - transcript
 *
 * The visible message list plus the addMessage helper (which also persists
 * user/assistant turns). collapseSettings is derived once from config and never
 * mutated in-session, matching the original behavior.
 */

import { useState, useCallback, useEffect, useRef } from 'react';
import * as config from '../../config.js';
import * as storage from '../../storage.js';
import type { UIMessage, CollapseSettings } from '../types.js';

export interface TranscriptStateHook {
  messages: UIMessage[];
  setMessages: React.Dispatch<React.SetStateAction<UIMessage[]>>;
  collapseSettings: CollapseSettings;
  /** Monotonic counter, bumped whenever the message list shrinks (clear/undo/
   *  reset). The transcript region uses it to key <Static>, forcing a remount
   *  so Static's write-once emitted-count is reset when history is dropped. */
  clearCount: number;
  addMessage: (type: UIMessage['type'], content: string, isError?: boolean) => void;
  reset: () => void;
}

export function useTranscriptState(): TranscriptStateHook {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [clearCount, setClearCount] = useState(0);
  const prevLen = useRef(0);
  const [collapseSettings] = useState<CollapseSettings>(() => ({
    collapseTools: config.get('collapseTools') ?? false,
    collapseThinking: false,
    toolDisplayLimit: config.get('toolDisplayLimit') ?? 0,
  }));

  // <Static> assumes append-only items. Every non-append mutation in this app
  // shrinks the list: /clear and reset() empty it, /undo restores a shorter
  // prefix. Detect the shrink here (a single source of truth co-located with
  // the state) and bump clearCount so the transcript region remounts Static.
  // Pure appends only grow the list, so they never bump.
  useEffect(() => {
    if (messages.length < prevLen.current) {
      setClearCount(c => c + 1);
    }
    prevLen.current = messages.length;
  }, [messages]);

  const addMessage = useCallback((type: UIMessage['type'], content: string, isError?: boolean) => {
    setMessages(prev => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      content,
      // isError is plumbed through to the renderer (messages.tsx) so the tool
      // status icon is driven by the authoritative executeTool flag rather than
      // string-matching the output. Omitted (undefined) for non-tool messages.
      ...(isError !== undefined ? { isError } : {}),
    }]);
    // Persist user and assistant messages to storage for session history
    if (type === 'user' || type === 'assistant') {
      storage.addChatMessage({ role: type, content });
    }
  }, []);

  const reset = useCallback(() => setMessages([]), []);

  return { messages, setMessages, collapseSettings, clearCount, addMessage, reset };
}
