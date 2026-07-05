/**
 * UI region - transcript
 *
 * Splits into two zones:
 *  - STATIC ZONE: completed messages, rendered write-once via <StaticScrollback>
 *    (Ink <Static>) so history is emitted to stdout once and never re-traversed
 *    on streaming/stats updates or scrollback growth.
 *  - LIVE ZONE: the processing/thinking/streaming indicators, the streaming
 *    response block, the state transition, and the optional debug overlay — the
 *    only things that change per token/tick.
 *
 * Owns the state-transition tracking (derived purely from the processing props)
 * so that logic lives with the only region that renders it.
 *
 * Memoized: a keystroke never changes these props, so typing does not re-render
 * the transcript. Streaming/stats updates flow in as prop changes and re-render
 * this region's live zone only — the memoized StaticScrollback skips re-render
 * because its `messages`/`collapseSettings` props are unchanged.
 */

import React, { useState, useEffect, useRef } from 'react';
import { Box, Text } from 'ink';
import type { UIMessage, CollapseSettings, ThinkingState, ActivityState } from '../types.js';
import type { Mode } from '../../types.js';
import { StaticScrollback } from './static-scrollback.js';
import { ThinkingDisplay, ProcessingIndicator, StreamingIndicator, StateTransition } from '../components.js';
import { probeRender } from './render-probe.js';

type ProcPhase = 'idle' | 'thinking' | 'streaming' | 'done';

export interface TranscriptRegionProps {
  messages: UIMessage[];
  collapseSettings: CollapseSettings;
  /** Monotonic counter bumped when `messages` is cleared/replaced non-append.
   *  Used as the StaticScrollback `key` so Static remounts (fresh emitted-count)
   *  instead of desyncing against a truncated list. */
  clearCount: number;
  isProcessing: boolean;
  thinkingState: ThinkingState | null;
  streamingResponse: string;
  activityState: ActivityState | null;
  debugEnabled: boolean;
  mode: Mode;
  queuedCount: number;
}

function TranscriptRegionInner({
  messages,
  collapseSettings,
  clearCount,
  isProcessing,
  thinkingState,
  streamingResponse,
  activityState,
  debugEnabled,
  mode,
  queuedCount,
}: TranscriptRegionProps) {
  probeRender('transcript');

  // State transition tracking (moved here from the parent — this is the only
  // place the transition is rendered).
  const prevProcessingState = useRef<ProcPhase>('idle');
  const [transition, setTransition] = useState<{ from: string; to: string } | null>(null);

  useEffect(() => {
    const current: ProcPhase =
      isProcessing && thinkingState && !streamingResponse ? 'thinking' :
      isProcessing && streamingResponse ? 'streaming' :
      !isProcessing && prevProcessingState.current !== 'idle' ? 'done' : 'idle';

    if (current !== prevProcessingState.current) {
      const from = prevProcessingState.current;
      // Only show transitions for meaningful state changes
      if (from !== 'idle' || current !== 'idle') {
        setTransition({ from, to: current });
      }
      prevProcessingState.current = current;
    }
  }, [isProcessing, thinkingState, streamingResponse]);

  // Streaming response block (reused across layouts)
  const StreamingResponseBox = streamingResponse ? (
    <Box flexDirection="column">
      <Text color="cyan">✧ Calliope:</Text>
      {streamingResponse.split('\n').map((line, i) => (
        <Text key={i}><Text color="blue">│</Text> {line}</Text>
      ))}
      <Text color="cyan">▌</Text>
    </Box>
  ) : null;

  // Thinking/Processing indicator with state transitions
  const ProcessingBox = (
    <>
      {transition && (
        <StateTransition
          from={transition.from as ProcPhase}
          to={transition.to as ProcPhase}
          onComplete={() => setTransition(null)}
        />
      )}
      {isProcessing && thinkingState && !streamingResponse && <ThinkingDisplay state={thinkingState} />}
      {isProcessing && !thinkingState && !streamingResponse && <ProcessingIndicator label="Waiting for response" />}
      {isProcessing && streamingResponse && <StreamingIndicator activity={activityState ?? undefined} />}
    </>
  );

  return (
    <>
      {/* Completed history (write-once), then the live processing indicator and
          streaming response. `key={clearCount}` remounts Static on clear/reset. */}
      <StaticScrollback key={clearCount} messages={messages} collapseSettings={collapseSettings} />
      {ProcessingBox}
      {StreamingResponseBox}

      {/* Debug overlay when debug mode is enabled */}
      {debugEnabled && (
        <Box marginY={0}>
          <Text dimColor>[dbg] proc={isProcessing ? 'Y' : 'N'} think={thinkingState ? 'Y' : 'N'} stream={streamingResponse.length} mode={mode} queue={queuedCount} activity={activityState?.action || 'none'}</Text>
        </Box>
      )}
    </>
  );
}

export const TranscriptRegion = React.memo(TranscriptRegionInner);
