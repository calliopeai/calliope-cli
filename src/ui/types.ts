/**
 * UI Module - Shared Types
 *
 * Types shared across all UI components and modules.
 */

import type { Message } from '../types.js';

export interface UIMessage {
  toolOutput?: { record: Omit<import('../sessions/index.js').ToolOutputRecord, 'content'>; saved: boolean; retainedLines: number; retainedChars: number };
  id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  content: string;
  /** True when a 'tool' message represents a failed tool execution (drives the
   *  status icon instead of string-matching the content for "error"). */
  isError?: boolean;
}

export interface SessionStats {
  inputTokens: number;
  outputTokens: number;
  cost: number;
  messageCount: number;
}

export interface CollapseSettings {
  collapseTools: boolean;
  collapseThinking: boolean;
  toolDisplayLimit: number;
  toolIndex?: number;      // Position in tool list (for toolDisplayLimit)
  totalTools?: number;     // Total tools in current batch
}

export interface ThinkingState {
  status: string;
  detail?: string;
  thinking?: string;  // Output from think tool
  iteration?: number;
  maxIterations?: number;
}

export interface ActivityState {
  tools?: import('./tool-progress.js').ActiveTool[];
  omittedTools?: number;
  action: string;      // e.g., "Reading", "Writing", "Running"
  target?: string;     // e.g., file path or command preview
  startTime: number;   // for elapsed time display
  detail?: string;     // e.g., last line of shell output for real-time streaming
}

export interface SessionInfo {
  id: string;
  projectName: string;
  lastAccessedAt: string;
  messageCount: number;
  projectPath: string;
}

export interface ConversationSnapshot {
  messages: UIMessage[];
  llmMessages: Message[];
  timestamp: Date;
}

export interface Bookmark {
  id: string;
  name: string;
  messageIndex: number;
  llmMessageIndex: number;
  timestamp: Date;
}

export interface PromptTemplate {
  name: string;
  prompt: string;
  createdAt: Date;
}
