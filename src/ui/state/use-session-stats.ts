/**
 * UI state - session stats
 *
 * Token/cost accounting and the estimated context-window usage shown in the
 * status bar. Reset to zeros on a session reset.
 */

import { useState, useCallback } from 'react';
import type { SessionStats } from '../types.js';

const ZERO_STATS: SessionStats = { inputTokens: 0, outputTokens: 0, cost: 0, messageCount: 0 };

export interface SessionStatsHook {
  stats: SessionStats;
  setStats: React.Dispatch<React.SetStateAction<SessionStats>>;
  contextTokens: number;
  setContextTokens: React.Dispatch<React.SetStateAction<number>>;
  reset: () => void;
}

export function useSessionStats(): SessionStatsHook {
  const [stats, setStats] = useState<SessionStats>({ ...ZERO_STATS });
  const [contextTokens, setContextTokens] = useState(0);

  const reset = useCallback(() => {
    setStats({ ...ZERO_STATS });
    setContextTokens(0);
  }, []);

  return { stats, setStats, contextTokens, setContextTokens, reset };
}
