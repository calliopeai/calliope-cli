/**
 * UI region - input
 *
 * Owns every input-widget concern: the current value, tab-completion
 * suggestions, up/down history navigation, and submit (which records history
 * and clears the line before delegating message processing to the parent).
 *
 * This is where keystroke isolation lives. The value is held in a ref for the
 * synchronous-paint pattern ChatInput relies on, and a version counter bumps on
 * every change so ONLY this region re-renders while typing — the parent, the
 * transcript, and the status bar are untouched.
 */

import React, { useState, useRef, useCallback, useEffect, useMemo } from 'react';
import * as fs from 'fs';
import type { Mode } from '../../types.js';
import { ChatInput } from '../chat-input.js';
import { probeRender } from './render-probe.js';

export interface InputRegionProps {
  /** Process a submitted, trimmed, non-empty message (command/shell/agent routing). */
  onSubmitMessage: (trimmed: string) => void;
  /** Populated with the full submit fn (records history, clears, routes) so the
   *  parent can drive submissions from outside the widget (e.g. fleet polling). */
  submitRef?: React.MutableRefObject<((value: string) => void) | null>;
  disabled: boolean;
  isProcessing: boolean;
  queuedCount: number;
  queuedMessages: string[];
  editingQueueIndex: number | null;
  onQueueMessage: (msg: string) => void;
  onEditQueuedMessage: (index: number, msg: string) => void;
  onSetEditingQueueIndex: (index: number | null) => void;
  onDirectSend: (msg: string) => void;
  onEscape: () => void;
  onExit: () => void;
  onCycleMode: () => void;
  currentMode: Mode;
  contextPercentage: number;
  cwd: string;
}

function InputRegionInner(props: InputRegionProps) {
  probeRender('input');

  const {
    onSubmitMessage, submitRef, disabled, isProcessing, queuedCount, queuedMessages,
    editingQueueIndex, onQueueMessage, onEditQueuedMessage, onSetEditingQueueIndex,
    onDirectSend, onEscape, onExit, onCycleMode, currentMode, contextPercentage, cwd,
  } = props;

  // Input value is held in a ref for ChatInput's synchronous-paint pattern; the
  // version counter bumps on every change so this region re-renders on a
  // keystroke while the rest of the tree stays put.
  const inputRef = useRef('');
  const [inputVersion, setInputVersion] = useState(0);
  const [suggestions, setSuggestions] = useState<string[]>([]);

  // Input history for up/down arrow navigation
  const [inputHistory, setInputHistory] = useState<string[]>([]);
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [savedInput, setSavedInput] = useState(''); // Save current input when navigating

  const [hasGitRepo] = useState(() => {
    try {
      return fs.existsSync('.git') || fs.existsSync('../.git');
    } catch {
      return false;
    }
  });

  const recentCommands = useMemo(
    () => inputHistory.filter(cmd => cmd.startsWith('/')).slice(-10),
    [inputHistory]
  );

  const setInputValue = useCallback((value: string) => {
    inputRef.current = value;
    setInputVersion(v => v + 1);
  }, []);

  // Typing: keep the ref canonical and bump the version so this region repaints.
  // Slash-suggestion and history-index resets bail out when already current.
  const handleInputChange = useCallback((newValue: string) => {
    inputRef.current = newValue;
    setInputVersion(v => v + 1);
    if (!newValue || !newValue.startsWith('/')) {
      setSuggestions(prev => prev.length > 0 ? [] : prev);
    }
    setHistoryIndex(prev => prev === -1 ? prev : -1);
  }, []);

  // Navigate input history
  const navigateHistory = useCallback((direction: 'up' | 'down') => {
    if (inputHistory.length === 0) return;

    if (direction === 'up') {
      if (historyIndex === -1) {
        // Save current input before navigating
        setSavedInput(inputRef.current);
        setHistoryIndex(inputHistory.length - 1);
        setInputValue(inputHistory[inputHistory.length - 1]!);
      } else if (historyIndex > 0) {
        setHistoryIndex(historyIndex - 1);
        setInputValue(inputHistory[historyIndex - 1]!);
      }
    } else {
      if (historyIndex === -1) return;
      if (historyIndex < inputHistory.length - 1) {
        setHistoryIndex(historyIndex + 1);
        setInputValue(inputHistory[historyIndex + 1]!);
      } else {
        // Return to saved input
        setHistoryIndex(-1);
        setInputValue(savedInput);
      }
    }
  }, [inputHistory, historyIndex, savedInput, setInputValue]);

  // Add to history when submitting
  const addToHistory = useCallback((value: string) => {
    if (value.trim() && (inputHistory.length === 0 || inputHistory[inputHistory.length - 1] !== value)) {
      setInputHistory(prev => [...prev.slice(-100), value]); // Keep last 100 entries
    }
    setHistoryIndex(-1);
    setSavedInput('');
  }, [inputHistory]);

  // Submit: record history, clear the line, then hand off routing to the parent.
  // (ChatInput queues rather than submitting while processing, and fleet checks
  // isProcessingRef before calling, so the value is only ever submitted idle.)
  const handleSubmit = useCallback((value: string) => {
    const trimmed = value.trim();
    if (!trimmed) return;
    addToHistory(trimmed);
    setInputValue('');
    onSubmitMessage(trimmed);
  }, [addToHistory, setInputValue, onSubmitMessage]);

  // Expose the full submit to the parent (fleet polling drives it directly).
  useEffect(() => {
    if (submitRef) {
      submitRef.current = handleSubmit;
      return () => { submitRef.current = null; };
    }
    return undefined;
  }, [submitRef, handleSubmit]);

  return (
    <ChatInput
      value={inputRef.current}
      valueVersion={inputVersion}
      onChange={handleInputChange}
      onSubmit={handleSubmit}
      onEscape={onEscape}
      onExit={onExit}
      onCycleMode={onCycleMode}
      disabled={disabled}
      isProcessing={isProcessing}
      queuedCount={queuedCount}
      queuedMessages={queuedMessages}
      editingQueueIndex={editingQueueIndex}
      onQueueMessage={onQueueMessage}
      onEditQueuedMessage={onEditQueuedMessage}
      onSetEditingQueueIndex={onSetEditingQueueIndex}
      onDirectSend={onDirectSend}
      cwd={cwd}
      suggestions={suggestions}
      onSuggestionsChange={setSuggestions}
      onNavigateHistory={navigateHistory}
      // Smart suggestions context
      currentMode={currentMode}
      contextPercentage={contextPercentage}
      recentCommands={recentCommands}
      hasGitRepo={hasGitRepo}
    />
  );
}

export const InputRegion = React.memo(InputRegionInner);
