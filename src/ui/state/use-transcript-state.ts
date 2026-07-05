/**
 * UI state - transcript
 *
 * The visible message list plus the addMessage helper (which also persists
 * user/assistant turns). collapseSettings is derived once from config and never
 * mutated in-session, matching the original behavior.
 */

import { useState, useCallback } from 'react';
import * as config from '../../config.js';
import * as storage from '../../storage.js';
import type { UIMessage, CollapseSettings } from '../types.js';

export interface TranscriptStateHook {
  messages: UIMessage[];
  setMessages: React.Dispatch<React.SetStateAction<UIMessage[]>>;
  collapseSettings: CollapseSettings;
  addMessage: (type: UIMessage['type'], content: string, isError?: boolean) => void;
  reset: () => void;
}

export function useTranscriptState(): TranscriptStateHook {
  const [messages, setMessages] = useState<UIMessage[]>([]);
  const [collapseSettings] = useState<CollapseSettings>(() => ({
    collapseTools: config.get('collapseTools') ?? false,
    collapseThinking: false,
    toolDisplayLimit: config.get('toolDisplayLimit') ?? 0,
  }));

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

  return { messages, setMessages, collapseSettings, addMessage, reset };
}
