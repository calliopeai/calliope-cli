/**
 * UI state - model / provider / mode
 *
 * The active provider, model, mode, and the routing/breaker flags shown in the
 * status bar. Explicit session choices outrank environment and trusted project
 * defaults; reset() restores the startup choices.
 */

import { useState, useCallback } from 'react';
import * as config from '../../config.js';
import type { LLMProvider, Mode } from '../../types.js';
import { resolvePreferences, type ModelPreference, type ResolvedPreference } from '../../preferences/index.js';

type BreakerHealth = 'ok' | 'warning' | 'tripped';

function initialSmartRoute(): boolean {
  return config.get('routing')?.enabled ?? false;
}

export interface ModelStateHook {
  provider: LLMProvider;
  setProvider: React.Dispatch<React.SetStateAction<LLMProvider>>;
  model: string | undefined;
  setModel: React.Dispatch<React.SetStateAction<string | undefined>>;
  mode: Mode;
  setMode: React.Dispatch<React.SetStateAction<Mode>>;
  confirmMode: boolean;
  setConfirmMode: React.Dispatch<React.SetStateAction<boolean>>;
  autoRoute: boolean;
  setAutoRoute: React.Dispatch<React.SetStateAction<boolean>>;
  smartRouteActive: boolean;
  setSmartRouteActive: React.Dispatch<React.SetStateAction<boolean>>;
  breakerHealth: BreakerHealth;
  setBreakerHealth: React.Dispatch<React.SetStateAction<BreakerHealth>>;
  reset: () => void;
  sources: ResolvedPreference['sources'];
  warnings: string[];
  reload: (cwd: string) => void;
}

export function useModelState(initial?: ModelPreference, skipPermissions = false): ModelStateHook {
  const [choice, setChoice] = useState(() => resolvePreferences(process.cwd(), { session: initial }));
  const { provider, model, sources, warnings } = choice;
  const setProvider: ModelStateHook['setProvider'] = useCallback(value => setChoice(previous => {
    const provider = typeof value === 'function' ? value(previous.provider) : value;
    return { ...previous, provider, model: provider === previous.provider ? previous.model : undefined,
      sources: { provider: 'session', model: provider === previous.provider ? previous.sources.model : null } };
  }), []);
  const setModel: ModelStateHook['setModel'] = useCallback(value => setChoice(previous => {
    const model = typeof value === 'function' ? value(previous.model) : value;
    return { ...previous, model, sources: { ...previous.sources, model: model ? 'session' : null } };
  }), []);
  const [mode, setMode] = useState<Mode>('hybrid');            // Default to hybrid mode
  const [confirmMode, setConfirmMode] = useState<boolean>(!skipPermissions); // Require confirmation for risky ops
  const [autoRoute, setAutoRoute] = useState<boolean>(false);    // Auto model routing
  const [smartRouteActive, setSmartRouteActive] = useState<boolean>(initialSmartRoute);
  const [breakerHealth, setBreakerHealth] = useState<BreakerHealth>('ok');
  const reload = useCallback((cwd: string) => setChoice(previous => resolvePreferences(cwd, { session: {
    ...(['session', 'turn'].includes(previous.sources.provider) ? { provider: previous.provider, model: null } : {}),
    ...(previous.sources.model && ['session', 'turn'].includes(previous.sources.model) ? { model: previous.model } : {}),
  } })), []);

  const reset = useCallback(() => {
    setChoice(resolvePreferences(process.cwd(), { session: initial }));
    setMode('hybrid');
    setConfirmMode(!skipPermissions);
    setAutoRoute(false);
    setSmartRouteActive(initialSmartRoute());
    setBreakerHealth('ok');
  }, [initial, skipPermissions]);

  return {
    reload, sources, warnings, provider, setProvider,
    model, setModel,
    mode, setMode,
    confirmMode, setConfirmMode,
    autoRoute, setAutoRoute,
    smartRouteActive, setSmartRouteActive,
    breakerHealth, setBreakerHealth,
    reset,
  };
}
