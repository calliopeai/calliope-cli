/**
 * Calliope CLI - Risk Assessment
 *
 * Evaluates the risk level of tool operations and shell commands.
 */

import type { RiskLevel, RiskAssessment, ToolCall } from './types.js';

/**
 * Shell command patterns by risk level
 */
const SHELL_PATTERNS: Record<RiskLevel, RegExp[]> = {
  none: [], // Shell commands are never 'none' risk
  
  low: [
    /^ls(\s|$)/,
    /^cat\s/,
    /^head\s/,
    /^tail\s/,
    /^grep\s/,
    /^pwd$/,
    /^echo\s/,
    /^wc\s/,
    /^sort\s/,
    /^uniq\s/,
    /^diff\s/,
    /^which\s/,
    /^whoami$/,
    /^date$/,
    /^cal(\s|$)/,
    /^git\s+status/,
    /^git\s+log/,
    /^git\s+diff/,
    /^git\s+branch/,
    /^git\s+show/,
    /^git\s+remote\s+-v/,
    /^npm\s+list/,
    /^npm\s+view/,
    /^npm\s+search/,
    /^node\s+--version/,
    /^npm\s+--version/,
    /^tsc\s+--version/,
    /^python\s+--version/,
    /^env$/,
    /^printenv/,
  ],
  
  medium: [
    /^git\s+add/,
    /^git\s+commit/,
    /^git\s+checkout/,
    /^git\s+branch\s+-[dD]/,
    /^git\s+stash/,
    /^git\s+merge/,
    /^git\s+rebase/,
    /^npm\s+install/,
    /^npm\s+i(\s|$)/,
    /^npm\s+update/,
    /^npm\s+ci/,
    /^yarn(\s+install)?/,
    /^pnpm\s+install/,
    /^pip\s+install/,
    /^mkdir\s/,
    /^touch\s/,
    /^cp\s/,
    /^tsc(\s|$)/,
    /^npx\s/,
    /^node\s/,
    /^python\s/,
  ],
  
  high: [
    /^rm\s/,
    /^rmdir\s/,
    /^mv\s/,
    /^find\s.*\s-delete(\s|$)/,
    /^find\s.*\s-exec\s/,
    /^find\s.*\s-execdir\s/,
    /^shred(\s|$)/,
    /^truncate(\s|$)/,
    /^chmod\s/,
    /^chown\s/,
    /^git\s+push/,
    /^git\s+reset/,
    /^git\s+revert/,
    /^git\s+clean/,
    /^git\s+fetch.*--prune/,
    /^npm\s+publish/,
    /^npm\s+unpublish/,
    /^npm\s+deprecate/,
    /^npm\s+link/,
    /^npm\s+uninstall/,
    /^pip\s+uninstall/,
    /^docker\s+rm/,
    /^docker\s+rmi/,
    /^docker\s+stop/,
    /^docker\s+kill/,
    /^kill\s/,
    /^pkill\s/,
    /^killall\s/,
    // Output redirection to a file (> truncate or >> append). The critical
    // >/dev/ rule is checked earlier; everything else writing via redirect
    // requires confirmation. Allows an optional leading fd (e.g. 2>).
    /\d?>>?\s*\S/,
  ],
  
  critical: [
    /^sudo\s/,
    /^su\s/,
    /^rm\s+-rf/,
    /^rm\s+-fr/,
    /^rm\s+.*-rf/,
    /^rm\s+.*-fr/,
    /^rm\s+-r\s+\//,
    /^chmod\s+777/,
    /^chmod\s+-R/,
    /^chown\s+-R/,
    /^dd\s/,
    /^mkfs/,
    /^fdisk/,
    /^parted/,
    /^format/,
    />\s*\/dev\//,
    /^git\s+push.*--force/,
    /^git\s+push.*-f/,
    /^git\s+reset\s+--hard/,
    /^npm\s+exec/,
    /^eval\s/,
    /\|\s*sh(\s|$)/,
    /\|\s*bash(\s|$)/,
    /curl.*\|\s*(sh|bash)/,
    /wget.*\|\s*(sh|bash)/,
  ],
};

/**
 * Paths that elevate risk to critical
 */
const CRITICAL_PATHS = [
  '/etc',
  '/usr',
  '/var',
  '/sys',
  '/proc',
  '/boot',
  '/root',
  '/bin',
  '/sbin',
  '/lib',
  '/opt',
  '~/.ssh',
  '~/.gnupg',
  '~/.config',
];

/**
 * Assess risk level for a shell command
 */
export function assessShellRisk(command: string): RiskAssessment {
  const trimmed = command.trim();
  
  // Check for critical patterns first
  for (const pattern of SHELL_PATTERNS.critical) {
    if (pattern.test(trimmed)) {
      return {
        level: 'critical',
        reason: 'Potentially destructive or system-altering command',
        requiresConfirmation: true,
      };
    }
  }
  
  // Check for critical paths
  for (const criticalPath of CRITICAL_PATHS) {
    const expandedPath = criticalPath.replace('~', process.env.HOME || '');
    if (trimmed.includes(expandedPath) || trimmed.includes(criticalPath)) {
      // Only elevate if it's a write operation
      if (/\b(rm|mv|cp|chmod|chown|write|echo.*>)\b/.test(trimmed)) {
        return {
          level: 'critical',
          reason: `Operation targets sensitive path: ${criticalPath}`,
          requiresConfirmation: true,
        };
      }
    }
  }
  
  // Check high risk
  for (const pattern of SHELL_PATTERNS.high) {
    if (pattern.test(trimmed)) {
      return {
        level: 'high',
        reason: 'Command modifies or deletes files/resources',
        requiresConfirmation: true,
      };
    }
  }
  
  // Check medium risk
  for (const pattern of SHELL_PATTERNS.medium) {
    if (pattern.test(trimmed)) {
      return {
        level: 'medium',
        reason: 'Command creates or modifies files',
        requiresConfirmation: false,
      };
    }
  }
  
  // Check low risk
  for (const pattern of SHELL_PATTERNS.low) {
    if (pattern.test(trimmed)) {
      return {
        level: 'low',
        reason: 'Read-only or informational command',
        requiresConfirmation: false,
      };
    }
  }
  
  // Default to high-with-confirmation for unknown commands (allowlist-by-default).
  // Anything not explicitly enumerated above could be destructive, so prompt
  // unless god mode is on.
  return {
    level: 'high',
    reason: 'Unknown command - requires confirmation',
    requiresConfirmation: true,
  };
}

/**
 * Base risk levels for each tool type
 */
const TOOL_BASE_RISK: Record<string, RiskLevel> = {
  think: 'none',
  read_file: 'none',
  list_files: 'none',
  write_file: 'medium',
  shell: 'low', // Will be overridden by command analysis
};

/**
 * Assess risk level for a tool call
 */
export function assessToolRisk(toolCall: ToolCall): RiskAssessment {
  const { name, arguments: args } = toolCall;
  
  // Special handling for shell commands
  if (name === 'shell' && typeof args.command === 'string') {
    return assessShellRisk(args.command);
  }
  
  // Special handling for write_file - check the path
  if (name === 'write_file' && typeof args.path === 'string') {
    const filePath = args.path;
    
    // Check for critical paths
    for (const criticalPath of CRITICAL_PATHS) {
      const expandedPath = criticalPath.replace('~', process.env.HOME || '');
      if (filePath.startsWith(expandedPath) || filePath.startsWith(criticalPath)) {
        return {
          level: 'critical',
          reason: `Writing to sensitive path: ${criticalPath}`,
          requiresConfirmation: true,
        };
      }
    }
    
    // Check for sensitive file types
    if (/\.(env|pem|key|crt|ssh|gpg)$/i.test(filePath)) {
      return {
        level: 'high',
        reason: 'Writing to sensitive file type',
        requiresConfirmation: true,
      };
    }
    
    return {
      level: 'medium',
      reason: 'File write operation',
      requiresConfirmation: false,
    };
  }
  
  // Default risk based on tool type
  const baseRisk = TOOL_BASE_RISK[name] || 'medium';
  
  return {
    level: baseRisk,
    reason: getRiskReason(name, baseRisk),
    requiresConfirmation: baseRisk === 'high' || baseRisk === 'critical',
  };
}

/**
 * Get a human-readable reason for the risk level
 */
function getRiskReason(toolName: string, level: RiskLevel): string {
  switch (toolName) {
    case 'think':
      return 'Pure reasoning, no side effects';
    case 'read_file':
      return 'Read-only file access';
    case 'list_files':
      return 'Read-only directory listing';
    case 'write_file':
      return 'File write operation';
    case 'shell':
      return 'Shell command execution';
    default:
      return `Tool operation: ${toolName}`;
  }
}

/**
 * Format risk level as a visual bar
 */
export function formatRiskBar(level: RiskLevel): string {
  const bars: Record<RiskLevel, string> = {
    none: '░░░░░',
    low: '█░░░░',
    medium: '███░░',
    high: '████░',
    critical: '█████',
  };
  return bars[level];
}

/**
 * Check if an operation requires confirmation regardless of mode
 */
export function requiresConfirmation(risk: RiskAssessment, godMode: boolean): boolean {
  // Critical operations ALWAYS require confirmation
  if (risk.level === 'critical') {
    return true;
  }
  
  // In god mode, skip confirmation for non-critical
  if (godMode) {
    return false;
  }
  
  // Otherwise, defer to the risk assessment
  return risk.requiresConfirmation;
}

/**
 * Complexity triggers for hybrid mode planning
 */
const COMPLEXITY_KEYWORDS = [
  'refactor',
  'rewrite',
  'migrate',
  'upgrade',
  'convert',
  'restructure',
  'reorganize',
  'overhaul',
  'replace all',
  'delete all',
  'remove all',
  'update all',
  'change all',
  'fix all',
  'across all',
  'entire codebase',
  'whole project',
  'every file',
];

const AMBIGUOUS_KEYWORDS = [
  'clean up',
  'clean this',
  'fix this',
  'improve',
  'make better',
  'optimize',
  'handle',
  'deal with',
  'sort out',
];

/**
 * Detect if a user prompt suggests a complex operation
 * that should trigger planning in hybrid mode
 */
export function detectComplexity(prompt: string): {
  isComplex: boolean;
  reason?: string;
} {
  const lower = prompt.toLowerCase();
  
  // Check for complexity keywords
  for (const keyword of COMPLEXITY_KEYWORDS) {
    if (lower.includes(keyword)) {
      return {
        isComplex: true,
        reason: `Detected complex operation: "${keyword}"`,
      };
    }
  }
  
  // Check for ambiguous requests
  for (const keyword of AMBIGUOUS_KEYWORDS) {
    if (lower.includes(keyword)) {
      return {
        isComplex: true,
        reason: `Ambiguous request may need clarification: "${keyword}"`,
      };
    }
  }
  
  return { isComplex: false };
}
