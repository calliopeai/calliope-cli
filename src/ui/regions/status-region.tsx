/**
 * UI region - status bar
 *
 * Thin wrapper around StatusBar. Memoized so keystrokes (which never change
 * these props) don't re-render the footer; stats/cost/context updates flow in
 * as prop changes and re-render only this region.
 */

import React from 'react';
import { StatusBar } from '../status-bar.js';
import type { SessionStats } from '../types.js';
import type { Mode } from '../../types.js';
import { probeRender } from './render-probe.js';

export interface StatusRegionProps {
  provider: string;
  model: string;
  mode: Mode;
  stats: SessionStats;
  contextTokens: number;
  breakerHealth?: 'ok' | 'warning' | 'tripped';
  smartRouteActive: boolean;
  width: number;
}

function StatusRegionInner({
  provider,
  model,
  mode,
  stats,
  contextTokens,
  breakerHealth,
  smartRouteActive,
  width,
}: StatusRegionProps) {
  probeRender('status');

  return (
    <StatusBar
      provider={provider}
      model={model}
      mode={mode}
      stats={stats}
      contextTokens={contextTokens}
      breakerHealth={breakerHealth}
      smartRouteActive={smartRouteActive}
      width={width}
    />
  );
}

export const StatusRegion = React.memo(StatusRegionInner);
