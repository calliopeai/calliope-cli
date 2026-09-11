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
import type { CapturedToolOutput } from '../../sessions/index.js';
import { ToolOutputCache } from '../tool-output-cache.js';

export interface TranscriptStateHook {
  messages: UIMessage[];
  setMessages: React.Dispatch<React.SetStateAction<UIMessage[]>>;
  collapseSettings: CollapseSettings;
  /** Monotonic counter, bumped whenever the message list is replaced or shrinks (clear/undo/
   *  reset). The transcript region uses it to key <Static>, forcing a remount
   *  so Static's write-once emitted-count is reset when history is dropped. */
  clearCount: number;
  addMessage: (type: UIMessage['type'], content: string, isError?: boolean, toolOutput?: CapturedToolOutput) => void;
  reset: () => void;
  toolOutputs: () => CapturedToolOutput[];
}

export function useTranscriptState(sessionRef?: React.MutableRefObject<storage.Session | null>): TranscriptStateHook {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const outputCache = useRef(new ToolOutputCache());
  const toolOutputs = useCallback(() => outputCache.current.read(sessionRef?.current?.id), [sessionRef]);
  const [clearCount, setClearCount] = useState(0);
  const previous = useRef<UIMessage[]>([]);
  const [collapseSettings] = useState<CollapseSettings>(() => ({
    collapseTools: config.get('collapseTools') ?? false,
    collapseThinking: false,
    toolDisplayLimit: config.get('toolDisplayLimit') ?? 0,
  }));

  // Static emits each item once. Session checkout can replace an equal-sized or
  // longer transcript, so detect all non-append changes, including undo/clear.
  useEffect(() => {
    if (messages.length < previous.current.length || previous.current.some((message, index) =>
      messages[index]?.id !== message.id || messages[index]?.content !== message.content)) setClearCount(c => c + 1);
    previous.current = messages;
  }, [messages]);

  const addMessage = useCallback((type: UIMessage['type'], content: string, isError?: boolean, toolOutput?: CapturedToolOutput) => {
    let reference: UIMessage['toolOutput'];
    if (toolOutput) {
      outputCache.current.remember(toolOutput, sessionRef?.current?.id);
      const { content: full, ...record } = toolOutput.record;
      reference = { record, saved: toolOutput.saved, retainedLines: full.split('\n').length, retainedChars: full.length };
      content = full.split('\n').slice(0, 5).map(line => line.slice(0, 100)).join('\n');
    }
    setMessages(prev => [...prev, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2)}`,
      type,
      content,
      ...(reference ? { toolOutput: reference } : {}),
      // isError is plumbed through to the renderer (messages.tsx) so the tool
      // status icon is driven by the authoritative executeTool flag rather than
      // string-matching the output. Omitted (undefined) for non-tool messages.
      ...(isError !== undefined ? { isError } : {}),
    }]);
    // Persist user and assistant messages to storage for session history
    if (type === 'user' || type === 'assistant') {
      if (sessionRef?.current) {
        try { storage.addChatMessage({ role: type, content }, sessionRef.current.id); } catch { /* Recovery snapshot is authoritative. */ }
      }
    }
  }, [sessionRef]);

  const reset = useCallback(() => { outputCache.current.clear(); setMessages([]); }, []);

  return { messages, setMessages, collapseSettings, clearCount, addMessage, reset, toolOutputs };
}
