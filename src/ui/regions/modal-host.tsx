/**
 * UI region - modal host
 *
 * Renders whichever modal `modalMode` selects. Purely presentational: every bit
 * of logic (session loading, provider config, upgrade) is supplied by the
 * controller as a stable callback. Memoized so it stays put on keystrokes.
 */

import React from 'react';
import { getVersion } from '../../version-check.js';
import type { ModelInfo } from '../../model-detection.js';
import type { SessionInfo } from '../types.js';
import {
  ModelSelector, SessionSelector, UpgradePrompt, ComplexityWarning,
  SessionResumePrompt, KeybindingsModal, ProviderSelector, ApiKeySetup,
} from '../modals/index.js';
import type { ProviderEntry } from '../modals/index.js';
import type {
  ModalMode, PendingComplexPrompt, PreviousSessionInfo,
} from '../state/use-modal-state.js';
import { probeRender } from './render-probe.js';

export interface ModalHostProps {
  modalMode: ModalMode;
  // Model selector
  availableModels: ModelInfo[];
  onModelSelect: (model: string) => void;
  onModalCancel: () => void;
  // Session selector
  availableSessions: SessionInfo[];
  onSessionSelect: (session: SessionInfo) => void;
  onSessionDelete: (session: SessionInfo) => void;
  // Upgrade
  latestVersion: string | null;
  onUpgradeConfirm: () => void;
  // Session resume
  previousSession: PreviousSessionInfo | null;
  onSessionResume: () => void;
  onSessionResumeNew: () => void;
  // Complexity warning
  pendingComplexPrompt: PendingComplexPrompt | null;
  onComplexityProceed: () => void;
  onComplexityPlan: () => void;
  onComplexityCancel: () => void;
  // Keybindings
  onKeybindingsClose: () => void;
  // Provider picker
  providerEntries: ProviderEntry[];
  onProviderSelect: (entry: ProviderEntry) => void;
  onProviderCancel: () => void;
  // Api key setup
  pendingSetupProvider: ProviderEntry | null;
  onApiKeySubmit: (value: string) => void;
  onApiKeyCancel: () => void;
}

function ModalHostInner(props: ModalHostProps) {
  probeRender('modal');

  const { modalMode } = props;

  if (modalMode === 'model' && props.availableModels.length > 0) {
    return (
      <ModelSelector
        models={props.availableModels}
        onSelect={props.onModelSelect}
        onCancel={props.onModalCancel}
      />
    );
  }

  if (modalMode === 'sessions') {
    return (
      <SessionSelector
        sessions={props.availableSessions}
        onSelect={props.onSessionSelect}
        onDelete={props.onSessionDelete}
        onCancel={props.onModalCancel}
      />
    );
  }

  if (modalMode === 'upgrade' && props.latestVersion) {
    return (
      <UpgradePrompt
        currentVersion={getVersion()}
        latestVersion={props.latestVersion}
        onConfirm={props.onUpgradeConfirm}
        onCancel={props.onModalCancel}
      />
    );
  }

  if (modalMode === 'session-resume' && props.previousSession) {
    return (
      <SessionResumePrompt
        session={props.previousSession}
        onResume={props.onSessionResume}
        onNew={props.onSessionResumeNew}
      />
    );
  }

  if (modalMode === 'complexity-warning' && props.pendingComplexPrompt) {
    const { pendingComplexPrompt } = props;
    return (
      <ComplexityWarning
        reason={pendingComplexPrompt.complexity.reason || 'Complex operation detected'}
        prompt={typeof pendingComplexPrompt.prompt === 'string' ? pendingComplexPrompt.prompt : undefined}
        onProceed={props.onComplexityProceed}
        onPlan={props.onComplexityPlan}
        onCancel={props.onComplexityCancel}
      />
    );
  }

  if (modalMode === 'keys') {
    return <KeybindingsModal onClose={props.onKeybindingsClose} />;
  }

  if (modalMode === 'provider' && props.providerEntries.length > 0) {
    return (
      <ProviderSelector
        providers={props.providerEntries}
        onSelect={props.onProviderSelect}
        onCancel={props.onProviderCancel}
      />
    );
  }

  if (modalMode === 'api-key-setup' && props.pendingSetupProvider) {
    const { pendingSetupProvider } = props;
    return (
      <ApiKeySetup
        provider={pendingSetupProvider.id}
        configHint={pendingSetupProvider.configHint}
        onSubmit={props.onApiKeySubmit}
        onCancel={props.onApiKeyCancel}
        extraInstructions={
          pendingSetupProvider.id === 'ollama'
            ? 'e.g. http://localhost:11434  (start with: ollama serve)'
            : pendingSetupProvider.id === 'bedrock'
            ? 'Enter your AWS profile name. Ensure it exists in ~/.aws/credentials or ~/.aws/config.'
            : pendingSetupProvider.id === 'litellm'
            ? 'e.g. http://localhost:4000'
            : undefined
        }
      />
    );
  }

  return null;
}

export const ModalHost = React.memo(ModalHostInner);
