/**
 * UI state - model / provider / mode
 *
 * The active provider, model, mode, and the routing/breaker flags shown in the
 * status bar. Initializers read env overrides then config, exactly as the
 * original component did; reset() restores those same defaults.
 */

import { useState, useCallback } from 'react';
import * as config from '../../config.js';
import type { LLMProvider, Mode } from '../../types.js';

type BreakerHealth = 'ok' | 'warning' | 'tripped';

function initialProvider(): LLMProvider {
  return (process.env.CALLIOPE_PROVIDER as LLMProvider) || config.get('defaultProvider');
}
function initialModel(): string | undefined {
  return process.env.CALLIOPE_MODEL || config.get('defaultModel');
}
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
}

export function useModelState(): ModelStateHook {
  const [provider, setProvider] = useState<LLMProvider>(initialProvider);
  const [model, setModel] = useState<string | undefined>(initialModel);
  const [mode, setMode] = useState<Mode>('hybrid');            // Default to hybrid mode
  const [confirmMode, setConfirmMode] = useState<boolean>(true); // Require confirmation for risky ops
  const [autoRoute, setAutoRoute] = useState<boolean>(false);    // Auto model routing
  const [smartRouteActive, setSmartRouteActive] = useState<boolean>(initialSmartRoute);
  const [breakerHealth, setBreakerHealth] = useState<BreakerHealth>('ok');

  const reset = useCallback(() => {
    setProvider(initialProvider());
    setModel(initialModel());
    setMode('hybrid');
    setConfirmMode(true);
    setAutoRoute(false);
    setSmartRouteActive(initialSmartRoute());
    setBreakerHealth('ok');
  }, []);

  return {
    provider, setProvider,
    model, setModel,
    mode, setMode,
    confirmMode, setConfirmMode,
    autoRoute, setAutoRoute,
    smartRouteActive, setSmartRouteActive,
    breakerHealth, setBreakerHealth,
    reset,
  };
}
