/**
 * Calliope CLI - Enhanced Context Management
 * 
 * Intelligent context monitoring and proactive management to prevent
 * response truncation and guide users toward optimal usage patterns.
 */

import type { Message } from './types.js';

// ============================================================================
// Types
// ============================================================================

export type ContextLevel = 'healthy' | 'caution' | 'warning' | 'critical' | 'emergency';

export interface ContextAnalysis {
  tokensUsed: number;
  tokensLimit: number;
  percentage: number;
  level: ContextLevel;
  recommendation: string;
  actionRequired: boolean;
  autoCompactSuggested: boolean;
}

export interface ContextWarning {
  level: ContextLevel;
  message: string;
  actions: string[];
  urgent: boolean;
}

export interface ContextManagerOptions {
  enableAutoCompact: boolean;
  warningThresholds: {
    caution: number;    // Default: 70%
    warning: number;    // Default: 85%
    critical: number;   // Default: 95%
    emergency: number;  // Default: 98%
  };
  autoCompactThreshold: number; // Default: 98%
  maxWarningsPerLevel: number;  // Default: 2
}

// ============================================================================
// Context Analysis
// ============================================================================

const DEFAULT_CONTEXT_LIMITS: Record<string, number> = {
  'claude-sonnet-4': 200000,
  'claude-opus-4': 200000,
  'claude-3': 200000,
  'gpt-4o': 128000,
  'gpt-4-turbo': 128000,
  'gpt-4': 8192,
  'gemini-2': 1000000,
  'gemini-1.5-pro': 1000000,
  'gemini-1.5-flash': 1000000,
  'llama-3.3': 128000,
  'llama-3.1': 128000,
  'mistral-large': 128000,
  'default': 32000,
};

const DEFAULT_OPTIONS: ContextManagerOptions = {
  enableAutoCompact: true,
  warningThresholds: {
    caution: 70,
    warning: 85,
    critical: 95,
    emergency: 98,
  },
  autoCompactThreshold: 98,
  maxWarningsPerLevel: 2,
};

export function getContextLimit(model: string): number {
  for (const [key, limit] of Object.entries(DEFAULT_CONTEXT_LIMITS)) {
    if (model.toLowerCase().includes(key.toLowerCase())) {
      return limit;
    }
  }
  return DEFAULT_CONTEXT_LIMITS.default;
}

export function estimateContextTokens(messages: Message[]): number {
  let chars = 0;
  
  for (const msg of messages) {
    if (typeof msg.content === 'string') {
      chars += msg.content.length;
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          chars += block.text.length;
        } else if (block.type === 'image') {
          chars += 1000; // Images count as ~250 tokens
        }
      }
    }
  }
  
  return Math.round(chars / 4); // Rough estimate: ~4 chars per token
}

export function analyzeContext(
  messages: Message[], 
  model: string, 
  options: Partial<ContextManagerOptions> = {}
): ContextAnalysis {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const tokensUsed = estimateContextTokens(messages);
  const tokensLimit = getContextLimit(model);
  const percentage = (tokensUsed / tokensLimit) * 100;
  
  let level: ContextLevel = 'healthy';
  let actionRequired = false;
  let autoCompactSuggested = false;
  
  if (percentage >= opts.warningThresholds.emergency) {
    level = 'emergency';
    actionRequired = true;
    autoCompactSuggested = opts.enableAutoCompact;
  } else if (percentage >= opts.warningThresholds.critical) {
    level = 'critical';
    actionRequired = true;
    autoCompactSuggested = true;
  } else if (percentage >= opts.warningThresholds.warning) {
    level = 'warning';
    actionRequired = false;
  } else if (percentage >= opts.warningThresholds.caution) {
    level = 'caution';
  }
  
  const recommendation = generateRecommendation(level, percentage, tokensUsed, tokensLimit);
  
  return {
    tokensUsed,
    tokensLimit,
    percentage,
    level,
    recommendation,
    actionRequired,
    autoCompactSuggested,
  };
}

function generateRecommendation(
  level: ContextLevel, 
  percentage: number, 
  tokensUsed: number, 
  tokensLimit: number
): string {
  const used = Math.round(tokensUsed / 1000);
  const limit = Math.round(tokensLimit / 1000);
  
  switch (level) {
    case 'emergency':
      return `EMERGENCY (${used}K/${limit}K): Auto-compact NOW or responses will be truncated`;
    case 'critical':
      return `CRITICAL (${used}K/${limit}K): Immediate action required`;
    case 'warning':
      return `WARNING (${used}K/${limit}K): Consider compacting soon`;
    case 'caution':
      return `CAUTION (${used}K/${limit}K): Monitor usage`;
    default:
      return `HEALTHY (${used}K/${limit}K)`;
  }
}

// ============================================================================
// Context Manager Class
// ============================================================================

export class ContextManager {
  private options: ContextManagerOptions;
  private warningCounts: Map<ContextLevel, number> = new Map();
  private lastWarningLevel: ContextLevel = 'healthy';
  private callbacks: {
    onWarning?: (warning: ContextWarning) => void;
    onAutoCompact?: () => Promise<void>;
    onEmergency?: () => Promise<void>;
  } = {};

  constructor(options: Partial<ContextManagerOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
    this.resetWarningCounts();
  }

  private resetWarningCounts() {
    this.warningCounts.set('healthy', 0);
    this.warningCounts.set('caution', 0);
    this.warningCounts.set('warning', 0);
    this.warningCounts.set('critical', 0);
    this.warningCounts.set('emergency', 0);
  }

  public setCallbacks(callbacks: typeof this.callbacks) {
    this.callbacks = { ...this.callbacks, ...callbacks };
  }

  public async checkContext(messages: Message[], model: string): Promise<ContextAnalysis> {
    const analysis = analyzeContext(messages, model, this.options);
    
    // Only warn on level increases to avoid spam
    if (this.shouldWarn(analysis.level)) {
      const warning = this.generateWarning(analysis);
      
      // Track warning count for this level
      const currentCount = this.warningCounts.get(analysis.level) || 0;
      this.warningCounts.set(analysis.level, currentCount + 1);
      this.lastWarningLevel = analysis.level;
      
      // Emit warning
      if (this.callbacks.onWarning) {
        this.callbacks.onWarning(warning);
      }
      
      // Handle emergency auto-compact
      if (analysis.level === 'emergency' && 
          analysis.percentage >= this.options.autoCompactThreshold &&
          this.callbacks.onAutoCompact) {
        await this.callbacks.onAutoCompact();
      }
      
      // Handle emergency callback
      if (analysis.level === 'emergency' && this.callbacks.onEmergency) {
        await this.callbacks.onEmergency();
      }
    }
    
    return analysis;
  }

  private shouldWarn(level: ContextLevel): boolean {
    if (level === 'healthy') return false;
    
    // Always warn on first occurrence of any level (level can't be 'healthy' here due to early return)
    if (this.lastWarningLevel === 'healthy') return true;
    
    // Warn when escalating to a higher level
    const levelOrder = ['healthy', 'caution', 'warning', 'critical', 'emergency'];
    const currentIndex = levelOrder.indexOf(this.lastWarningLevel);
    const newIndex = levelOrder.indexOf(level);
    
    if (newIndex > currentIndex) return true;
    
    // Warn again if we've exceeded max warnings for this level
    const warningCount = this.warningCounts.get(level) || 0;
    if (warningCount >= this.options.maxWarningsPerLevel) {
      return true;
    }
    
    return false;
  }

  private generateWarning(analysis: ContextAnalysis): ContextWarning {
    const { level, percentage, tokensUsed, tokensLimit } = analysis;
    const used = Math.round(tokensUsed / 1000);
    const limit = Math.round(tokensLimit / 1000);
    const warningCount = this.warningCounts.get(level) || 0;
    
    let message: string;
    let actions: string[];
    let urgent: boolean;
    
    switch (level) {
      case 'emergency':
        message = `🚨 EMERGENCY: Context at ${Math.round(percentage)}% (${used}K/${limit}K)\n\nYour next responses WILL be truncated. Take action NOW!`;
        actions = [
          '/summarize compact - Auto-compress conversation (RECOMMENDED)',
          '/clear - Start fresh conversation',
          '/branch new "emergency-save" - Save progress and start new branch',
        ];
        urgent = true;
        break;
        
      case 'critical':
        message = `🔴 CRITICAL: Context at ${Math.round(percentage)}% (${used}K/${limit}K)\n\nApproaching truncation limits. Immediate action recommended.`;
        actions = [
          '/summarize compact - Compress conversation',
          '/clear - Fresh start',
          '/branch new - Save and branch',
          'Use shorter, more focused messages',
        ];
        
        // Suggest auto-compact on repeated critical warnings
        if (warningCount > 0) {
          actions.unshift('💡 AUTO-SUGGESTION: Run "/summarize compact" now?');
        }
        urgent = true;
        break;
        
      case 'warning':
        message = `⚠️ WARNING: Context at ${Math.round(percentage)}% (${used}K/${limit}K)\n\nGetting close to limits. Consider optimization.`;
        actions = [
          '/summarize compact - Compress conversation', 
          '/summarize context - View key topics',
          '/clear - Start fresh if needed',
          'Focus on shorter messages',
        ];
        urgent = false;
        break;
        
      case 'caution':
        message = `💡 CAUTION: Context at ${Math.round(percentage)}% (${used}K/${limit}K)\n\nUsage is growing substantial. Awareness recommended.`;
        actions = [
          '/context summary - Check current usage',
          '/summarize context - View conversation topics',
          'Monitor message length',
        ];
        urgent = false;
        break;
        
      default:
        message = `Context healthy at ${Math.round(percentage)}% (${used}K/${limit}K)`;
        actions = [];
        urgent = false;
    }
    
    return { level, message, actions, urgent };
  }

  public reset() {
    this.resetWarningCounts();
    this.lastWarningLevel = 'healthy';
  }

  public getStatus(): { 
    lastLevel: ContextLevel; 
    warningCounts: Record<ContextLevel, number>;
  } {
    return {
      lastLevel: this.lastWarningLevel,
      warningCounts: {
        healthy: this.warningCounts.get('healthy') || 0,
        caution: this.warningCounts.get('caution') || 0,
        warning: this.warningCounts.get('warning') || 0,
        critical: this.warningCounts.get('critical') || 0,
        emergency: this.warningCounts.get('emergency') || 0,
      },
    };
  }
}

// ============================================================================
// Utilities
// ============================================================================

/**
 * Get color for context level display
 */
export function getContextColor(level: ContextLevel): string {
  switch (level) {
    case 'emergency':
    case 'critical':
      return 'red';
    case 'warning':
      return 'yellow';
    case 'caution':
      return 'cyan';
    default:
      return 'green';
  }
}

/**
 * Get icon for context level
 */
export function getContextIcon(level: ContextLevel): string {
  switch (level) {
    case 'emergency':
      return '🚨';
    case 'critical':
      return '🔴';
    case 'warning':
      return '⚠️';
    case 'caution':
      return '💡';
    default:
      return '✅';
  }
}

/**
 * Format context information for status display
 */
export function formatContextStatus(analysis: ContextAnalysis): string {
  const used = Math.round(analysis.tokensUsed / 1000);
  const limit = Math.round(analysis.tokensLimit / 1000);
  const icon = getContextIcon(analysis.level);
  
  return `${icon} ${used}K/${limit}K (${Math.round(analysis.percentage)}%)`;
}