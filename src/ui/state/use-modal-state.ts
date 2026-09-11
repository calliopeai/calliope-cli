/**
 * UI state - modal host
 *
 * The active modal plus every modal's pending payload (picker lists, pending
 * prompt, resume candidate, tool confirmation). reset() closes any open modal
 * and clears all payloads — this is what the full remount used to do for modal
 * state, now done in place.
 */

import { useState, useCallback } from 'react';
import type { ModelInfo } from '../../model-detection.js';
import type { MessageContent } from '../../types.js';
import type { SessionInfo } from '../types.js';
import type { ProviderEntry } from '../modals/index.js';
import type { Submission } from '../../preferences/index.js';

export type ModalMode =
  | 'none' | 'model' | 'upgrade' | 'confirm' | 'session-resume'
  | 'tool-output' | 'complexity-warning' | 'keys' | 'sessions' | 'provider' | 'api-key-setup';

export interface PendingComplexPrompt {
  prompt: MessageContent;
  submission?: Submission;
  complexity: { isComplex: boolean; reason?: string };
}

export interface PreviousSessionInfo {
  projectName: string;
  lastAccessedAt: string;
  messageCount: number;
}

export interface ModalStateHook {
  toolOutput: import('../../sessions/index.js').CapturedToolOutput | null;
  setToolOutput: React.Dispatch<React.SetStateAction<import('../../sessions/index.js').CapturedToolOutput | null>>;
  modalMode: ModalMode;
  setModalMode: React.Dispatch<React.SetStateAction<ModalMode>>;
  providerEntries: ProviderEntry[];
  setProviderEntries: React.Dispatch<React.SetStateAction<ProviderEntry[]>>;
  pendingSetupProvider: ProviderEntry | null;
  setPendingSetupProvider: React.Dispatch<React.SetStateAction<ProviderEntry | null>>;
  pendingComplexPrompt: PendingComplexPrompt | null;
  setPendingComplexPrompt: React.Dispatch<React.SetStateAction<PendingComplexPrompt | null>>;
  previousSession: PreviousSessionInfo | null;
  setPreviousSession: React.Dispatch<React.SetStateAction<PreviousSessionInfo | null>>;
  availableModels: ModelInfo[];
  setAvailableModels: React.Dispatch<React.SetStateAction<ModelInfo[]>>;
  availableSessions: SessionInfo[];
  setAvailableSessions: React.Dispatch<React.SetStateAction<SessionInfo[]>>;
  latestVersion: string | null;
  setLatestVersion: React.Dispatch<React.SetStateAction<string | null>>;
  reset: () => void;
}

export function useModalState(): ModalStateHook {
  const [toolOutput, setToolOutput] = useState<import('../../sessions/index.js').CapturedToolOutput | null>(null);
  const [modalMode, setModalMode] = useState<ModalMode>('none');
  const [providerEntries, setProviderEntries] = useState<ProviderEntry[]>([]);
  const [pendingSetupProvider, setPendingSetupProvider] = useState<ProviderEntry | null>(null);
  const [pendingComplexPrompt, setPendingComplexPrompt] = useState<PendingComplexPrompt | null>(null);
  const [previousSession, setPreviousSession] = useState<PreviousSessionInfo | null>(null);
  const [availableModels, setAvailableModels] = useState<ModelInfo[]>([]);
  const [availableSessions, setAvailableSessions] = useState<SessionInfo[]>([]);
  const [latestVersion, setLatestVersion] = useState<string | null>(null);

  const reset = useCallback(() => {
    setModalMode('none'); setToolOutput(null);
    setProviderEntries([]);
    setPendingSetupProvider(null);
    setPendingComplexPrompt(null);
    setPreviousSession(null);
    setAvailableModels([]);
    setAvailableSessions([]);
    setLatestVersion(null);
  }, []);

  return {
    modalMode, setModalMode, toolOutput, setToolOutput,
    providerEntries, setProviderEntries,
    pendingSetupProvider, setPendingSetupProvider,
    pendingComplexPrompt, setPendingComplexPrompt,
    previousSession, setPreviousSession,
    availableModels, setAvailableModels,
    availableSessions, setAvailableSessions,
    latestVersion, setLatestVersion,
    reset,
  };
}
