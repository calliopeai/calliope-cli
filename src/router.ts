/** Task classification helpers. Model selection lives in routing/ and uses live evidence. */
import type { HealthProvider } from './health/index.js';
export type TaskComplexity = 'trivial' | 'simple' | 'moderate' | 'complex' | 'expert';
export type TaskType = 'code' | 'research' | 'creative' | 'analysis' | 'simple-qa' | 'general';
export interface SmartRoutingConfig {
  enabled: boolean;
  providerPool: HealthProvider[];
  costSensitivity: number;
  preferredProviders: HealthProvider[];
}

export function analyzeComplexity(message: string, context?: {
  messageCount?: number;
  hasCode?: boolean;
  fileCount?: number;
  toolsUsed?: string[];
}): { complexity: TaskComplexity; confidence: number; signals: string[] } {
  const signals: string[] = [];
  let score = 0;

  const lower = message.toLowerCase();
  const words = message.split(/\s+/).length;

  // Message length signals
  if (words < 10) {
    signals.push('short message');
    score -= 1;
  } else if (words > 100) {
    signals.push('long message');
    score += 2;
  }

  // Simple task indicators — only count when the message is short enough
  // to likely be a genuinely simple request (not a complex question starting with "what")
  const simplePatterns = [
    /\b(simple|quick|easy|basic|just)\b/i,
    /\b(typo|fix|rename|format)\b/i,
  ];
  // Question words only count as simple for short messages (< 30 words)
  const simpleQuestionPattern = /\b(what|how|explain|show|list|print|display)\b/i;
  if (words < 30 && simpleQuestionPattern.test(lower)) {
    signals.push('simple task keywords');
    score -= 1;
  } else {
    for (const pattern of simplePatterns) {
      if (pattern.test(lower)) {
        signals.push('simple task keywords');
        score -= 1;
        break;
      }
    }
  }

  // Complex task indicators — cap at first match to prevent score explosion
  const complexPatterns = [
    /\b(refactor|architect|design|implement|optimize)\b/i,
    /\b(complex|comprehensive|thorough|detailed)\b/i,
    /\b(security|performance|scalability)\s+(audit|review|analysis|optimization|issue|improvement)/i,
    /\b(debug|investigate|diagnose)\b/i,
    /\b(multiple|several|various|different)\s+(files?|components?|modules?)/i,
  ];
  let complexMatchCount = 0;
  for (const pattern of complexPatterns) {
    if (pattern.test(lower)) {
      signals.push('complex task keywords');
      score += 2;
      complexMatchCount++;
      if (complexMatchCount >= 2) break;  // Cap accumulation at 2 matches
    }
  }

  // "analyze" is complex only when accompanied by another complex signal or a long message
  if (/\banalyze\b/i.test(lower) && (complexMatchCount > 0 || words > 20)) {
    signals.push('complex task keywords');
    score += 2;
  }

  // Expert task indicators
  const expertPatterns = [
    /\b(cryptograph|concurrency|distributed|microservice)/i,
    /\b(algorithm|data\s*structure)\b/i,
    /\b(security\s*audit|vulnerability|exploit)\b/i,
    /\b(machine\s*learning|neural|ai\s*model)\b/i,
  ];
  for (const pattern of expertPatterns) {
    if (pattern.test(lower)) {
      signals.push('expert domain keywords');
      score += 3;
    }
  }

  // Context-based adjustments
  if (context) {
    if (context.messageCount && context.messageCount > 10) {
      signals.push('long conversation');
      score += 1;
    }
    if (context.hasCode) {
      signals.push('involves code');
      score += 1;
    }
    if (context.fileCount && context.fileCount > 3) {
      signals.push('multiple files');
      score += 1;
    }
    if (context.toolsUsed && context.toolsUsed.length > 2) {
      signals.push('multiple tools needed');
      score += 1;
    }
  }

  // Map score to complexity
  let complexity: TaskComplexity;
  if (score <= -1) complexity = 'trivial';
  else if (score <= 1) complexity = 'simple';
  else if (score <= 3) complexity = 'moderate';
  else if (score <= 5) complexity = 'complex';
  else complexity = 'expert';

  // Confidence based on signal count
  const confidence = Math.min(0.9, 0.5 + signals.length * 0.1);

  return { complexity, confidence, signals };
}

const TASK_TYPE_PATTERNS: Partial<Record<TaskType, RegExp[]>> = {
  'code': [
    /\b(implement|refactor|bug|fix|debug|code|function|class|method|module)\b/i,
    /\b(typescript|javascript|python|rust|java|go|ruby|c\+\+)\b/i,
    /\.(ts|js|tsx|jsx|py|rs|go|java|rb|cpp|c|h|css|html|sql)\b/,
    /```[\s\S]*```/,
    /\b(npm|pip|cargo|maven|yarn|pnpm|git)\b/i,
    /\b(compile|build|test|lint|deploy)\b/i,
  ],
  'research': [
    /\b(explain|compare|documentation|how\s+does|what\s+is|describe|overview)\b/i,
    /\b(research|investigate|look\s+into|find\s+out|summarize)\b/i,
    /\b(pros\s+and\s+cons|tradeoffs?|trade-offs?|differences?\s+between)\b/i,
  ],
  'creative': [
    /\b(write|story|brainstorm|imagine|creative|poem|narrative)\b/i,
    /\b(generate|compose|craft|design|invent|create\s+a)\b/i,
    /\b(naming|tagline|slogan|pitch|headline)\b/i,
  ],
  'analysis': [
    /\b(analyze|review|audit|evaluate|assess|inspect)\b/i,
    /\b(metrics|performance|benchmark|profil|optimize)\b/i,
    /\b(security|vulnerability|risk|compliance)\b/i,
    /\b(data|statistics|trends|patterns|correlat)\b/i,
  ],
  'simple-qa': [
    /^.{0,80}$/,  // Very short messages
    /^(what|who|when|where|why|how|is|are|do|does|can|could|will|would)\b/i,
    /\?$/,
  ],
};

/**
 * Detect the task type from a user message.
 */
export function detectTaskType(message: string): { taskType: TaskType; confidence: number; signals: string[] } {
  const scores: Record<TaskType, number> = {
    'code': 0,
    'research': 0,
    'creative': 0,
    'analysis': 0,
    'simple-qa': 0,
    'general': 0,
  };
  const signals: string[] = [];

  for (const [type, patterns] of Object.entries(TASK_TYPE_PATTERNS) as [TaskType, RegExp[] | undefined][]) {
    if (!patterns) continue;
    for (const pattern of patterns) {
      if (pattern.test(message)) {
        scores[type] += 1;
        if (scores[type] === 1) {
          signals.push(type);
        }
      }
    }
  }

  // Find highest scoring type
  let bestType: TaskType = 'general';
  let bestScore = 0;
  for (const [type, score] of Object.entries(scores) as [TaskType, number][]) {
    if (score > bestScore) {
      bestScore = score;
      bestType = type;
    }
  }

  // If simple-qa is the only match but it's a short question, keep it
  // If code or analysis also matches, those take priority
  if (bestType === 'simple-qa' && scores['code'] > 0) bestType = 'code';
  if (bestType === 'simple-qa' && scores['analysis'] > 0) bestType = 'analysis';
  if (bestType === 'simple-qa' && scores['research'] > 0) bestType = 'research';

  const confidence = bestScore > 0 ? Math.min(0.95, 0.5 + bestScore * 0.15) : 0.3;

  return { taskType: bestType, confidence, signals };
}

export function getDefaultSmartRoutingConfig(): SmartRoutingConfig {
  return {
    enabled: false,
    providerPool: [],
    costSensitivity: 0.3,
    preferredProviders: [],
  };
}
