/**
 * UI state - session initialization (mount effect)
 *
 * Runs once on mount: create/attach the storage session, wire the iteration
 * ledger, fold project memory into the system prompt, fire session-start hooks,
 * initialize fleet mode (and start polling if enabled), and pre-warm the model
 * cache. The original gated this with a `memoryLoaded` state flag; a ref guard
 * is equivalent and avoids a spurious render.
 */

import { useRef, useEffect } from 'react';
import * as config from '../../config.js';
import * as storage from '../../storage.js';
import * as memory from '../../memory.js';
import * as hooks from '../../hooks.js';
import { preWarmModelCache } from '../../model-detection.js';
import {
  fleetInit, fleetStatus, fleetStartPolling, fleetPostOnline, fleetPostMessage,
} from '../../fleet.js';
import { IterationLedger } from '../../iteration-ledger.js';
import type { Message as LLMMessage } from '../../types.js';
import type { Session } from '../../storage.js';
import { debugLog } from '../debug-log.js';

export interface SessionInitDeps {
  sessionRef: React.MutableRefObject<Session | null>;
  ledgerRef: React.MutableRefObject<IterationLedger>;
  llmMessages: React.MutableRefObject<LLMMessage[]>;
  addMessage: (type: 'system', content: string) => void;
  /** Queue-or-submit handler for instructions arriving over the fleet bus. */
  onFleetInstruction: (instruction: string) => void;
}

export function useSessionInit(deps: SessionInitDeps): void {
  const { sessionRef, ledgerRef, llmMessages, addMessage, onFleetInstruction } = deps;
  const initedRef = useRef(false);

  useEffect(() => {
    if (initedRef.current) return;
    initedRef.current = true;

    const cwd = process.cwd();

    // Always start fresh session - skip resume dialog.
    // (Previous session data is still available via storage APIs if needed.)
    const session = storage.getOrCreateSession(cwd);
    sessionRef.current = session;
    ledgerRef.current.setRetentionLimit(config.get('sessionLogLimit') ?? 0);
    ledgerRef.current.setOnChange(() => {
      const activeSessionId = sessionRef.current?.id;
      if (activeSessionId) {
        storage.saveIterationLedger(ledgerRef.current, activeSessionId);
      }
    });
    ledgerRef.current.loadSnapshot(storage.loadIterationLedger(session.id));
    storage.saveIterationLedger(ledgerRef.current, session.id);

    // Load memory context into the system prompt
    const memoryContext = memory.buildMemoryContext(cwd);
    if (memoryContext.trim()) {
      const currentSystem = llmMessages.current[0];
      if (currentSystem && currentSystem.role === 'system') {
        const systemContent = typeof currentSystem.content === 'string' ? currentSystem.content : '';
        llmMessages.current[0] = {
          role: 'system',
          content: systemContent + '\n\n--- Project Context ---\n' + memoryContext,
        };
      }
    }

    // Execute session start hooks
    hooks.executeHooks('session-start', {}).catch((err) => {
      debugLog('hooks', 'session-start hook failed:', err instanceof Error ? err.message : err);
    });

    // Initialize fleet mode (no-op unless fleet.enabled)
    fleetInit(session.id, cwd).then((enabled) => {
      if (enabled) {
        const status = fleetStatus();
        debugLog('fleet', `active, nick=${status?.nick}, irc=${status?.config?.ircAddr}`);
        // Show nick in system messages so operators know how to address calliope
        addMessage('system', `Fleet connected — address me as: ${status?.nick}`);
        fleetPostOnline();
        fleetPostMessage(`connected — address me as: ${status?.nick}`);
        // Route incoming fleet instructions into the agent loop
        fleetStartPolling(onFleetInstruction);
      }
    }).catch((err) => {
      debugLog('fleet', 'initialization failed:', err instanceof Error ? err.message : err);
    });

    // Pre-warm model cache in background for faster model switching
    preWarmModelCache().catch((err) => {
      debugLog('cache', 'model cache pre-warm failed:', err instanceof Error ? err.message : err);
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
