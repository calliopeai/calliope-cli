/**
 * UI region - static scrollback
 *
 * Completed transcript entries rendered through Ink's <Static>. Static writes
 * each item to stdout exactly once and never re-traverses it, so a growing
 * scrollback and per-token streaming updates below no longer pay a full-frame
 * redraw for history that hasn't changed.
 *
 * Two Static constraints shape this component:
 *
 *  1. APPEND-ONLY. Static tracks how many items it has emitted and only renders
 *     the tail beyond that count. Items must therefore be appended, never
 *     reordered or truncated. Every UIMessage is finalized before the next one
 *     is appended (streaming text lives in the separate live zone, not here), so
 *     `messages` is naturally append-only during a turn. Clearing/undo replace
 *     the array non-append-only; the parent remounts this component (keyed on
 *     clearCount) to reset Static's emitted-count rather than mutating it.
 *
 *  2. WRITE-ONCE COLLAPSE (tradeoff). A tool message's rendering depends on its
 *     ordinal among tools (collapseTools/toolDisplayLimit windowing). Under
 *     <Static> each item renders once, at append time, so that decision is
 *     FROZEN then: a tool shown expanded when it was the newest stays expanded
 *     even as newer tools arrive — the sliding collapse window no longer
 *     re-collapses already-printed tools. This only affects sessions that opt
 *     into collapseTools (default off; collapseThinking is currently always
 *     off), where the default configuration is byte-identical to the previous
 *     non-Static rendering. This is accepted, not worked around: a re-render
 *     escape hatch would defeat the write-once guarantee that is the point.
 */

import React, { useEffect } from 'react';
import { Box, Static } from 'ink';
import type { UIMessage, CollapseSettings } from '../types.js';
import { MessageItem } from '../messages.js';
import { probeMount, probeRender } from './render-probe.js';

export interface StaticScrollbackProps {
  messages: UIMessage[];
  collapseSettings: CollapseSettings;
}

function StaticScrollbackInner({ messages, collapseSettings }: StaticScrollbackProps) {
  // Counts once per mount; the parent keys this component on clearCount, so a
  // clear/reset remounts it and this fires again — the render-isolation proof
  // that clearing actually resets Static's internal emitted-count.
  useEffect(() => {
    probeMount('transcript-static');
  }, []);

  // Per-item collapse context (ordinal among tools + tool count), matching the
  // previous MessageHistory. Computed each render but consumed by Static only
  // for newly-appended items, so a tool's context is captured at append time.
  const totalTools = messages.reduce((n, m) => (m.type === 'tool' ? n + 1 : n), 0);
  const toolOrdinal = new Map<string, number>();
  let ordinal = 0;
  for (const m of messages) {
    if (m.type === 'tool') toolOrdinal.set(m.id, ordinal++);
  }

  return (
    <Static items={messages}>
      {(msg: UIMessage) => {
        // Runs exactly once per message (Static only renders the unseen tail),
        // so this count stays flat across streaming updates and rising only by
        // one per appended message.
        probeRender('transcript-item');
        const collapse: CollapseSettings =
          msg.type === 'tool'
            ? { ...collapseSettings, toolIndex: toolOrdinal.get(msg.id), totalTools }
            : collapseSettings;
        return (
          <Box key={msg.id}>
            <MessageItem msg={msg} collapse={collapse} />
          </Box>
        );
      }}
    </Static>
  );
}

// Memoized so a streaming/stats prop change on the parent transcript region
// does not re-run Static's diff for unchanged history; only a new `messages`
// reference (a message was appended) re-renders it. A clearCount change remounts
// it via the `key` in the parent, independent of this comparison.
export const StaticScrollback = React.memo(StaticScrollbackInner);
