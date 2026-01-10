# 🎭 Calliope CLI - Improvement Recommendations

*A curated analysis of opportunities to enhance the codebase*

---

## ✅ Already Completed This Session

| Item | Status | Details |
|------|--------|---------|
| Test Infrastructure | ✅ Done | Vitest setup with 93 tests passing |
| Test Coverage | ✅ Done | `risk.ts`, `errors.ts`, `memory.ts`, `parallel-tools.ts` |
| Improvement Docs | ✅ Done | `docs/IMPROVEMENTS.md` with full analysis |

---

## 🔥 High Priority Recommendations

### 1. Integrate Parallel Tool Execution

**Current State:** `parallel-tools.ts` (362 lines) is fully implemented but **not used** in the agent loop.

**Impact:** When the LLM returns multiple independent tool calls (e.g., reading 3 files), they currently run sequentially. Parallel execution could provide 2-3x speedup.

**Implementation:**
```typescript
// In runAgent, replace sequential tool execution with:
import { canParallelize, executeParallel } from './parallel-tools.js';

if (response.toolCalls && canParallelize(response.toolCalls)) {
  const results = await executeParallel(response.toolCalls, 
    (call) => executeTool(call, process.cwd())
  );
  // Process results...
}
```

**Effort:** Low (infrastructure exists)  
**Files:** `src/ui-cli.tsx`, `src/cli.ts`

---

### 2. Add Context Limit Warnings

**Current State:** Status bar shows context usage with color coding, but no proactive warnings.

**Improvement:** Add a warning message when context exceeds 80%:
```
⚠️ Context at 85% capacity (170K/200K tokens)
   Consider: /summarize compact | /clear | shorter messages
```

**Effort:** Low  
**Files:** `src/ui-cli.tsx` (after `setContextTokens` calls)

---

### 3. Improve Streaming with Tools

**Current State:** Streaming is disabled when tools are present (`if (onToken && openaiTools.length === 0)`).

**Improvement:** Stream the final response even after tool execution. This requires buffering tool calls, then streaming the final text response.

**Effort:** Medium  
**Files:** `src/providers.ts`

---

## 🟡 Medium Priority Recommendations

### 4. Session Resume Prompt

**From spec but not implemented:** On startup, prompt to resume previous session.

```
╭─ Found previous session (2 hours ago)
│  Project: calliope-cli
│  Messages: 12, TODOs: 2 pending
╰─ [R]esume  [N]ew session
```

**Effort:** Medium  
**Files:** `src/ui-cli.tsx` (startup logic)

---

### 5. Extract Shared Styling

**Current State:** Both `cli.ts` and `ui-cli.tsx` define their own colors/icons.

**Improvement:** Create `src/styles.ts`:
```typescript
export const COLORS = {
  cyan: '\x1b[36m',
  // ...
};

export const TOOL_ICONS = {
  shell: '⚡',
  // ...
};
```

**Effort:** Low  
**Files:** New `src/styles.ts`, update `src/cli.ts`, `src/ui-cli.tsx`

---

### 6. Add More Test Coverage

**Currently tested:** 4 modules (93 tests)  
**Should add tests for:**
- `src/providers.ts` - Mock API responses
- `src/tools.ts` - Tool execution
- `src/config.ts` - Configuration management
- `src/summarization.ts` - Context compression

**Effort:** Medium-High  

---

### 7. Better Undo/Redo

**Current State:** `/undo` removes messages but doesn't handle tool results elegantly.

**Improvement:** 
- Track "exchanges" (user message + all responses + tool calls)
- Implement `/redo` to restore undone exchanges
- Store undo history (limit to 10)

**Effort:** Medium  
**Files:** `src/ui-cli.tsx`

---

## 🟢 Lower Priority / Nice-to-Have

### 8. Conversation Bookmarks

```
/bookmark "Got auth working"
/bookmarks          # List all
/goto bookmark-1    # Jump to that point
```

### 9. Cost Persistence

Track costs across sessions:
```json
// In session storage
{
  "totalCost": 1.42,
  "costByProvider": { "anthropic": 1.20, "openai": 0.22 },
  "costByDay": { "2025-01-15": 0.85 }
}
```

### 10. Multi-file Preview

Before executing multiple writes:
```
📝 About to modify 5 files:
   ✍️ src/cli.ts (15 changes)
   ✍️ src/tools.ts (8 changes)
   📄 src/styles.ts (new)
   
Proceed? [Y/n/details]
```

### 11. Template System

Save common prompts:
```
/template save "code-review" "Review this code for bugs and improvements"
/template use "code-review"
```

### 12. React Error Boundaries

Add error boundaries to Ink components to prevent full crashes:
```tsx
class ErrorBoundary extends React.Component {
  componentDidCatch(error: Error) {
    // Show error message, allow recovery
  }
}
```

---

## 📊 Codebase Statistics

| Metric | Value |
|--------|-------|
| Total Lines | ~14,200 |
| Modules | 32 |
| Largest File | `ui-cli.tsx` (2,031 lines) |
| Test Coverage | 4 modules (93 tests) |
| Dependencies | 7 runtime, 5 dev |

---

## 🎯 Recommended Implementation Order

1. **Parallel tools** - Low effort, high impact
2. **Context warnings** - Low effort, good UX
3. **Extract styling** - Low effort, cleaner code
4. **More tests** - Medium effort, critical for maintenance
5. **Session resume** - Medium effort, good UX
6. **Streaming with tools** - Medium effort, better UX

---

## 🐛 Minor Issues Spotted

1. **Unused imports** - Some files import more than they use
2. **Type safety** - Some `Record<string, unknown>` could be stricter
3. **Magic numbers** - Some timeout values should be constants
4. **Console logging** - Some debug console.log may still exist

---

*Generated by Calliope CLI analysis session*
