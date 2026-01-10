# 🎯 Quick Wins for Calliope CLI

*Immediate improvements you can implement today*

---

## 1. Integrate Parallel Tool Execution (30 minutes)

**Impact**: 2-5x performance improvement for multi-tool operations  
**Effort**: Very Low  
**Files**: `src/cli.ts`

**Current Implementation**: Sequential tool execution
```typescript
// In runAgent() function around line 300
for (const toolCall of response.toolCalls) {
  const result = await executeTool(toolCall, state.cwd);
  // Add to messages...
}
```

**Improvement**: Use existing parallel infrastructure
```typescript
import { executeParallel } from './parallel-tools.js';

// Replace the sequential loop with:
const results = await executeParallel(response.toolCalls, state.cwd);
for (const result of results) {
  state.messages.push({
    role: 'tool',
    content: result.result,
    toolCallId: result.toolCallId,
  });
}
```

---

## 2. Add Context Limit Warnings (15 minutes)

**Impact**: Prevents truncated responses  
**Effort**: Very Low  
**Files**: `src/providers.ts`

Add before API calls:
```typescript
function warnIfContextLimitApproaching(messages: Message[], model: string) {
  const estimated = messages.reduce((acc, msg) => {
    const content = typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content);
    return acc + Math.ceil(content.length / 4); // Rough token estimation
  }, 0);
  
  const limit = getModelContextLimit(model); // You'll need to implement this
  const percentage = estimated / limit;
  
  if (percentage > 0.8) {
    console.log(`⚠️  Context at ${Math.round(percentage * 100)}% capacity`);
    console.log(`   Consider: /summarize compact or /clear`);
  }
}
```

---

## 3. Better Error Messages with Suggestions (20 minutes)

**Impact**: Much better user experience  
**Effort**: Low  
**Files**: `src/errors.ts`

Enhance error display:
```typescript
export function displayEnhancedError(error: Error, context: string) {
  console.log(`${color('✗', 'red')} ${color(`Error: ${error.message}`, 'red')}`);
  
  // Add specific suggestions based on error type
  if (error.message.includes('ENOENT')) {
    console.log(`${color('💡', 'yellow')} File not found. Try:`);
    console.log(`   • Check the file path`);
    console.log(`   • Use /find <filename> to search`);
  } else if (error.message.includes('permission denied')) {
    console.log(`${color('💡', 'yellow')} Permission denied. Try:`);
    console.log(`   • Check file permissions with ls -la`);
    console.log(`   • Use sudo if needed (carefully)`);
  } else if (error.message.includes('rate limit')) {
    console.log(`${color('💡', 'yellow')} Rate limited. Try:`);
    console.log(`   • Wait a moment and retry`);
    console.log(`   • Switch provider with /provider`);
  }
  
  console.log();
}
```

---

## 4. Extract Common Styling (25 minutes)

**Impact**: Better maintainability  
**Effort**: Low  
**Files**: New `src/styles.ts`, update imports

Create shared styling:
```typescript
// src/styles.ts
export const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  red: '\x1b[31m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  brightCyan: '\x1b[96m',
} as const;

export function color(text: string, style: keyof typeof colors): string {
  return `${colors[style]}${text}${colors.reset}`;
}

export const icons = {
  shell: '⚡',
  read_file: '📄',
  write_file: '✍️',
  list_files: '📁',
  think: '💭',
  success: '✓',
  error: '✗',
  warning: '⚠️',
  info: 'ℹ️',
} as const;

export const spinnerFrames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
```

Then update imports in `cli.ts` and `ui-cli.tsx`.

---

## 5. Improve Tool Execution Display (15 minutes)

**Impact**: Better visual feedback  
**Effort**: Very Low  
**Files**: `src/cli.ts`

Enhance the tool result display:
```typescript
function printToolResult(name: string, result: string): void {
  if (name === 'think') {
    console.log(`${color('╰─', 'dim')} ${color('✓', 'green')}`);
    return;
  }

  // Show preview of result
  const lines = result.split('\n').filter(line => line.trim());
  const preview = lines.slice(0, 3);
  
  for (const line of preview) {
    const truncated = line.length > 80 ? line.substring(0, 77) + '...' : line;
    console.log(`${color('│', 'dim')}  ${color(truncated, 'dim')}`);
  }
  
  if (lines.length > 3) {
    console.log(`${color('│', 'dim')}  ${color(`... (${lines.length - 3} more lines)`, 'dim')}`);
  }

  // Better success/error detection
  const hasError = result.toLowerCase().includes('error') || 
                  result.toLowerCase().includes('failed') ||
                  result.toLowerCase().includes('permission denied');
  
  const hasWarning = result.toLowerCase().includes('warning') || 
                    result.toLowerCase().includes('deprecated');
                    
  let status = '✓';
  let statusColor: keyof typeof colors = 'green';
  
  if (hasError) {
    status = '✗';
    statusColor = 'red';
  } else if (hasWarning) {
    status = '⚠️';
    statusColor = 'yellow';
  }

  console.log(`${color('╰─', 'dim')} ${color(status, statusColor)}`);
}
```

---

## 6. Add Model Context Limits (10 minutes)

**Impact**: Better context management  
**Effort**: Very Low  
**Files**: `src/types.ts`

Add model context limits:
```typescript
export const MODEL_CONTEXT_LIMITS: Record<string, number> = {
  // Anthropic
  'claude-sonnet-4-20250514': 200_000,
  'claude-opus-4-20250514': 200_000,
  'claude-3-5-sonnet-20241022': 200_000,
  'claude-3-5-haiku-20241022': 200_000,
  
  // OpenAI  
  'gpt-4o': 128_000,
  'gpt-4o-mini': 128_000,
  'o1': 200_000,
  'o1-mini': 128_000,
  
  // Google
  'gemini-2.0-flash': 1_000_000,
  'gemini-1.5-pro': 2_000_000,
  
  // Default
  'default': 128_000,
};

export function getModelContextLimit(model: string): number {
  return MODEL_CONTEXT_LIMITS[model] || MODEL_CONTEXT_LIMITS['default'];
}
```

---

## 7. Enhance Spinner with Status (10 minutes)

**Impact**: Better user feedback during long operations  
**Effort**: Very Low  
**Files**: `src/cli.ts`

Replace static spinner with status-aware version:
```typescript
function createStatusSpinner(initialStatus = 'Thinking...') {
  let spinnerIdx = 0;
  let currentStatus = initialStatus;
  
  const interval = setInterval(() => {
    process.stdout.write(`\r${color(spinnerFrames[spinnerIdx], 'cyan')} ${color(currentStatus, 'dim')}`);
    spinnerIdx = (spinnerIdx + 1) % spinnerFrames.length;
  }, 80);
  
  return {
    updateStatus: (status: string) => { currentStatus = status; },
    stop: () => {
      clearInterval(interval);
      process.stdout.write('\r\x1b[K');
    }
  };
}

// Usage in runAgent:
const spinner = createStatusSpinner('Analyzing request...');
// Later: spinner.updateStatus('Executing tools...');
```

---

## 8. Add Debug Mode (5 minutes)

**Impact**: Better development experience  
**Effort**: Very Low  
**Files**: `src/cli.ts`

Add debug output for development:
```typescript
const DEBUG = process.env.CALLIOPE_DEBUG === 'true';

function debugLog(message: string, data?: any) {
  if (DEBUG) {
    console.log(`${color('[DEBUG]', 'magenta')} ${message}`);
    if (data) console.log(data);
  }
}

// Use throughout code:
debugLog('Tool execution started', { toolCount: response.toolCalls.length });
debugLog('Context tokens', { estimated: tokenCount, limit: modelLimit });
```

---

## Implementation Order

**Start with these in order:**

1. **Parallel tool execution** (biggest impact, already implemented infrastructure)
2. **Context limit warnings** (prevents user frustration)
3. **Better error messages** (improves troubleshooting experience)
4. **Extract styling** (cleans up code, enables consistency)
5. **Enhanced tool display** (better visual feedback)

**Time investment**: ~2 hours total for transformative improvements

**Testing**: Run `npm run build && npm run start` after each change to verify.

---

*These quick wins will immediately improve the user experience while setting the foundation for larger improvements.*