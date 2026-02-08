/**
 * Calliope CLI - Scope Management
 *
 * Manages allowed directories for file operations.
 * Provides guardrails to prevent the agent from accessing unauthorized paths.
 */

import * as path from 'path';
import * as fs from 'fs';

// ============================================================================
// Types
// ============================================================================

export interface ScopeConfig {
  /** Base directories the agent can access */
  allowedDirs: string[];
  /** Whether to allow access to home directory */
  allowHome: boolean;
  /** Whether to allow access to /tmp */
  allowTmp: boolean;
  /** Directories explicitly denied (takes precedence) */
  deniedDirs: string[];
  /** File patterns to deny (e.g., '.env', '*.key') */
  deniedPatterns: string[];
}

export interface ScopeValidationResult {
  allowed: boolean;
  reason?: string;
  suggestedAction?: string;
}

// ============================================================================
// Default Configuration
// ============================================================================

const DEFAULT_DENIED_PATTERNS = [
  '.env',
  '.env.local',
  '.env.development',
  '.env.production',
  '.env.*',
  'secrets.*',
  '*.pem',
  '*.key',
  'id_rsa',
  'id_ed25519',
  'credentials',
  '.npmrc',
  '.pypirc',
];

// ============================================================================
// Scope Manager
// ============================================================================

class ScopeManager {
  private config: ScopeConfig;
  private homeDir: string;
  private tmpDir: string;

  constructor() {
    this.homeDir = process.env.HOME || process.env.USERPROFILE || '/tmp';
    this.tmpDir = '/tmp';
    this.config = {
      allowedDirs: [process.cwd()],
      allowHome: false,
      allowTmp: true,
      deniedDirs: [],
      deniedPatterns: [...DEFAULT_DENIED_PATTERNS],
    };
  }

  /**
   * Reset scope to just the current working directory.
   * Also resets denied dirs to defaults. Call between agent operations
   * to prevent scope leakage across sessions.
   */
  reset(cwd: string = process.cwd()): void {
    this.config.allowedDirs = [path.resolve(cwd)];
    this.config.deniedDirs = [];
    this.config.deniedPatterns = [...DEFAULT_DENIED_PATTERNS];
    this.config.allowHome = false;
    this.config.allowTmp = true;
  }

  /**
   * Add a directory to the allowed scope
   */
  addDirectory(dirPath: string): { success: boolean; message: string } {
    const absPath = path.resolve(dirPath);

    if (!fs.existsSync(absPath)) {
      return { success: false, message: `Directory does not exist: ${absPath}` };
    }

    if (!fs.statSync(absPath).isDirectory()) {
      return { success: false, message: `Not a directory: ${absPath}` };
    }

    if (this.config.allowedDirs.includes(absPath)) {
      return { success: false, message: `Already in scope: ${absPath}` };
    }

    for (const allowed of this.config.allowedDirs) {
      if (absPath.startsWith(allowed + path.sep) || absPath === allowed) {
        return { success: false, message: `Already covered by: ${allowed}` };
      }
    }

    this.config.allowedDirs.push(absPath);
    return { success: true, message: `Added to scope: ${absPath}` };
  }

  /**
   * Remove a directory from scope
   */
  removeDirectory(dirPath: string): { success: boolean; message: string } {
    const absPath = path.resolve(dirPath);
    const index = this.config.allowedDirs.indexOf(absPath);

    if (index === -1) {
      return { success: false, message: `Not in scope: ${absPath}` };
    }

    if (this.config.allowedDirs.length === 1) {
      return { success: false, message: `Cannot remove last allowed directory` };
    }

    this.config.allowedDirs.splice(index, 1);
    return { success: true, message: `Removed from scope: ${absPath}` };
  }

  /**
   * Check if a path is within scope
   */
  isInScope(filePath: string, baseCwd?: string): ScopeValidationResult {
    const cwd = baseCwd || process.cwd();
    const absPath = path.isAbsolute(filePath) 
      ? path.resolve(filePath)
      : path.resolve(cwd, filePath);
    const fileName = path.basename(absPath);

    // Check denied patterns first (match against filename)
    for (const pattern of this.config.deniedPatterns) {
      if (this.matchesPattern(fileName, pattern)) {
        return {
          allowed: false,
          reason: `File matches denied pattern: ${pattern}`,
          suggestedAction: 'This file type is blocked for security reasons.',
        };
      }
    }

    // Check denied directories
    for (const denied of this.config.deniedDirs) {
      if (absPath.startsWith(denied + path.sep) || absPath === denied) {
        return {
          allowed: false,
          reason: `Path is in denied directory: ${denied}`,
        };
      }
    }

    // Check allowed directories
    for (const allowed of this.config.allowedDirs) {
      if (absPath.startsWith(allowed + path.sep) || absPath === allowed) {
        return { allowed: true };
      }
    }

    // Check home directory
    if (this.config.allowHome && absPath.startsWith(this.homeDir + path.sep)) {
      return { allowed: true };
    }

    // Check tmp directory
    if (this.config.allowTmp && absPath.startsWith(this.tmpDir + path.sep)) {
      return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Path is outside allowed scope`,
      suggestedAction: `Use /add-dir "${path.dirname(absPath)}" to add this directory to scope`,
    };
  }

  /**
   * Validate a path and throw if not allowed
   */
  validatePath(filePath: string, cwd: string): string {
    const absPath = path.isAbsolute(filePath)
      ? path.resolve(filePath)
      : path.resolve(cwd, filePath);

    const result = this.isInScope(absPath, cwd);

    if (!result.allowed) {
      let errorMsg = `Access denied: ${filePath} is outside allowed scope.`;
      if (result.suggestedAction) {
        errorMsg += `\n${result.suggestedAction}`;
      }
      throw new Error(errorMsg);
    }

    return absPath;
  }

  /**
   * Get list of allowed directories
   */
  getAllowedDirs(): string[] {
    return [...this.config.allowedDirs];
  }

  /**
   * Get scope summary for display
   */
  getScopeSummary(): string {
    const lines = ['📁 Current Scope:'];
    
    for (const dir of this.config.allowedDirs) {
      const isCwd = dir === path.resolve(process.cwd());
      lines.push(`  ${isCwd ? '→' : '•'} ${dir}${isCwd ? ' (cwd)' : ''}`);
    }

    if (this.config.allowHome) {
      lines.push(`  • ${this.homeDir} (home)`);
    }
    if (this.config.allowTmp) {
      lines.push(`  • ${this.tmpDir} (tmp)`);
    }

    lines.push('');
    lines.push(`Denied patterns: ${this.config.deniedPatterns.length} file types blocked`);

    return lines.join('\n');
  }

  /**
   * Get detailed scope info
   */
  getScopeDetails(): string {
    const lines = ['📁 Scope Configuration:', ''];
    
    lines.push('Allowed Directories:');
    for (const dir of this.config.allowedDirs) {
      lines.push(`  ✓ ${dir}`);
    }

    lines.push('');
    lines.push('Settings:');
    lines.push(`  Allow home (~): ${this.config.allowHome ? 'Yes' : 'No'}`);
    lines.push(`  Allow /tmp: ${this.config.allowTmp ? 'Yes' : 'No'}`);

    lines.push('');
    lines.push('Denied Patterns (sensitive files):');
    for (const pattern of this.config.deniedPatterns.slice(0, 10)) {
      lines.push(`  ✗ ${pattern}`);
    }
    if (this.config.deniedPatterns.length > 10) {
      lines.push(`  ... and ${this.config.deniedPatterns.length - 10} more`);
    }

    return lines.join('\n');
  }

  /**
   * Simple pattern matching for filenames
   * Supports wildcards: * matches any characters
   */
  private matchesPattern(fileName: string, pattern: string): boolean {
    // Exact match
    if (fileName === pattern) {
      return true;
    }
    
    // Pattern with wildcards
    if (pattern.includes('*')) {
      // Convert glob to regex: escape dots, convert * to .*
      const regexStr = pattern
        .replace(/\./g, '\\.')
        .replace(/\*/g, '.*');
      const regex = new RegExp(`^${regexStr}$`);
      return regex.test(fileName);
    }
    
    return false;
  }
}

// ============================================================================
// Singleton Instance
// ============================================================================

export const scopeManager = new ScopeManager();

// ============================================================================
// Convenience Functions
// ============================================================================

export function addToScope(dirPath: string): { success: boolean; message: string } {
  return scopeManager.addDirectory(dirPath);
}

export function removeFromScope(dirPath: string): { success: boolean; message: string } {
  return scopeManager.removeDirectory(dirPath);
}

export function isInScope(filePath: string, cwd?: string): boolean {
  return scopeManager.isInScope(filePath, cwd).allowed;
}

export function validatePath(filePath: string, cwd: string): string {
  return scopeManager.validatePath(filePath, cwd);
}

export function getScopeSummary(): string {
  return scopeManager.getScopeSummary();
}

export function getScopeDetails(): string {
  return scopeManager.getScopeDetails();
}

export function resetScope(cwd?: string): void {
  scopeManager.reset(cwd);
}

export function getAllowedDirs(): string[] {
  return scopeManager.getAllowedDirs();
}
