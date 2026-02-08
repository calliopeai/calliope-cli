/**
 * UI Module - Shared Types
 *
 * Types shared across all UI components and modules.
 */

import type { Message } from '../types.js';

export interface UIMessage {
  id: string;
  type: 'user' | 'assistant' | 'tool' | 'system' | 'error';
  content: string;
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
  action: string;      // e.g., "Reading", "Writing", "Running"
  target?: string;     // e.g., file path or command preview
  startTime: number;   // for elapsed time display
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
