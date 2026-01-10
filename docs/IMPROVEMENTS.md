# Calliope CLI - Improvement Analysis & Recommendations

## Executive Summary

After a thorough analysis of the Calliope CLI codebase, I've identified several opportunities for improvement ranging from critical fixes to nice-to-have features. This document outlines the findings and provides actionable recommendations.

## Current State

The codebase is well-architected with:
- ✅ Clean multi-provider abstraction (12+ providers)
- ✅ Thoughtful security model with path validation
- ✅ Elegant CLI design with beautiful output
- ✅ Comprehensive feature set (memory, hooks, themes, skills, MCP)
- ✅ Good TypeScript foundation

## High Priority Improvements

### 1. 🔴 Add Test Infrastructure

**Status:** No tests exist  
**Impact:** Critical for maintainability  
**Effort:** Medium  

The codebase has grown to 32+ modules with complex interactions. Tests are essential for:
- Preventing regressions
- Documenting expected behavior
- Enabling confident refactoring

**Recommended approach:**
```bash
npm install -D vitest @vitest/coverage-v8
```

Priority test targets:
1. `risk.ts` - Risk assessment logic
2. `errors.ts` - Error classification
3. `memory.ts` - Memory parsing/formatting
4. `tools.ts` - Tool execution
5. `providers.ts` - Provider selection

### 2. 🔴 Integrate Parallel Tool Execution

**Status:** Infrastructure exists in `parallel-tools.ts` but unused  
**Impact:** Significant performance improvement  
**Effort:** Low  

The `analyzeDependencies()` and `executeParallel()` functions are implemented but not integrated into the main agent loop. When the LLM returns multiple independent tool calls, they could run concurrently.

**Current flow:**
```
Tool 1 → wait → Tool 2 → wait → Tool 3 → wait
```

**Optimized flow:**
```
Tool 1 ─┬─→ wait → Done
Tool 2 ─┤
Tool 3 ─┘
```

### 3. 🟡 Proactive Context Limit Warnings

**Status:** Shows usage in status bar but no proactive warning  
**Impact:** Better UX, prevents truncated responses  
**Effort:** Low  

Add warning when context approaches 80% of model limit:
```
⚠️ Context at 85% capacity. Consider /summarize compact or /clear
```

### 4. 🟡 Session Resume Prompt

**Status:** Mentioned in spec but not implemented in Ink UI  
**Impact:** Better continuity between sessions  
**Effort:** Medium  

On startup, if a recent session exists:
```
╭─ Found previous session (2 hours ago)
│  • 12 messages, 3 plans, 2 TODOs
╰─ [R]esume  [N]ew session
```

## Code Quality Improvements

### 5. 🟢 Extract Common Styling

Both `cli.ts` and `ui-cli.tsx` have their own color/styling code. Extract to a shared `styles.ts`:

```typescript
// src/styles.ts
export const colors = {
  reset: '\x1b[0m',
  cyan: '\x1b[36m',
  // ...
};

export const icons = {
  shell: '⚡',
  read_file: '📄',
  // ...
};
```

### 6. 🟢 Stronger Type Safety

Some uses of `Record<string, unknown>` could be more specific:
- Tool arguments
- Config values
- Hook payloads

Consider using Zod for runtime validation of configs.

### 7. 🟢 Add React Error Boundaries

The Ink UI could crash on unexpected errors. Add error boundaries:

```tsx
class ErrorBoundary extends React.Component {
  componentDidCatch(error, errorInfo) {
    // Log error, show fallback UI
  }
}
```

## Feature Enhancements

### 8. 🟢 Cost Tracking Persistence

Currently tracks cost per session but doesn't persist. Add to session storage:
```json
{
  "totalCost": 0.42,
  "costByProvider": { "anthropic": 0.35, "openai": 0.07 }
}
```

### 9. 🟢 Multi-file Edit Preview

Before executing multiple writes, show a summary:
```
About to modify 5 files:
  ✍️ src/cli.ts (15 changes)
  ✍️ src/ui-cli.tsx (8 changes)
  📄 src/styles.ts (new file)
  ...
Proceed? [Y/n]
```

### 10. 🟢 Conversation Bookmarks

Allow marking important points:
```
/bookmark "Got the architecture working"
```

Jump back with `/bookmarks` list.

## Implementation Priority

| Priority | Item | Effort | Impact |
|----------|------|--------|--------|
| 1 | Test Infrastructure | Medium | Critical |
| 2 | Parallel Tools Integration | Low | High |
| 3 | Context Warnings | Low | Medium |
| 4 | Session Resume | Medium | Medium |
| 5 | Extract Styling | Low | Low |
| 6 | Type Safety | Medium | Medium |
| 7 | Error Boundaries | Low | Medium |
| 8 | Cost Persistence | Low | Low |
| 9 | Multi-file Preview | Medium | Medium |
| 10 | Bookmarks | Low | Low |

## Next Steps

1. **Immediate:** Set up Vitest and write tests for `risk.ts` and `errors.ts`
2. **Short-term:** Integrate parallel tool execution in agent loop
3. **Medium-term:** Add context warnings and session resume
4. **Ongoing:** Improve type safety, add error boundaries

---

*Analysis performed on the Calliope CLI codebase v0.6.3*
