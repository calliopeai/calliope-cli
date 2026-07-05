# Governance

Primitives for running Calliope as an agent in CI and in enterprise settings:
an append-only **audit run log** with tamper evidence, a read-only **replay**
command, **budget caps** that halt a run before it overspends, and a pre-tool
**policy hook** for an external allow/deny engine.

All four are local and dependency-free. The audit log is on by default; the rest
are opt-in via config.

- [Audit run logs](#audit-run-logs)
- [Replay](#replay)
- [Budget caps](#budget-caps)
- [Policy hook](#policy-hook)
- [Exit codes](#exit-codes)

---

## Audit run logs

Every agent session writes an append-only JSONL trace to:

```
~/.calliope-cli/runs/<sessionId>.jsonl
```

One line per event. A session file may contain several *runs* (one per agent
turn), each bracketed by `run_start` … `run_end`. Writes are buffered and
appended asynchronously, so logging never blocks the agent loop.

### Configuration

| Key | Default | Meaning |
|-----|---------|---------|
| `audit.enabled` | `true` | Master switch. It's on by default — the audit trail is the point, and it's cheap local disk. |
| `audit.dir` | `~/.calliope-cli/runs` | Directory for run-log files. |
| `audit.retention` | `100` | Keep the most recent N run-log files; older ones are pruned when a new session opens. |

```bash
calliope /config set audit.enabled false      # disable
```

Credentials are **never** written. The `run_start` config snapshot and every
`tool_call`'s arguments pass through a redaction pass that strips values under
secret-named keys (`apiKey`, `token`, `secret`, `password`, …) and masks
secret-looking strings (`sk-…`, `AKIA…`, `ghp_…`, `Bearer …`, PEM blocks).

### Schema (version 1)

Every line carries a schema `v`ersion, a monotonic `seq`, an ISO `ts`, an event
`type`, a type-specific payload, and the two hash-chain fields:

```jsonc
{
  "v": 1,
  "seq": 3,
  "ts": "2026-07-05T21:14:08.164Z",
  "type": "tool_call",
  "id": "tc1",
  "name": "shell",
  "args": { "command": "ls -la" },
  "prev_hash": "9f2c…",   // hash of the previous line
  "hash": "1a7b…"         // sha256(prev_hash + canonical(this line without the chain fields))
}
```

Event types and their payloads:

| `type` | Payload |
|--------|---------|
| `run_start` | `session`, `cwd`, `provider`, `model`, `config` (redacted snapshot) |
| `user_prompt` | `text` |
| `assistant_message` | `content`, `tokens: {input, output}`, `cost` |
| `tool_call` | `id`, `name`, `args` (redacted) |
| `tool_result` | `id`, `result` (truncated), `isError`, `durationMs` |
| `budget_event` | `scope` (`run`\|`project`), `kind` (`cost`\|`tokens`), `spent`, `cap`, `message` |
| `policy_event` | `tool`, `decision` (`allow`\|`deny`), `source`, `reason?`, `durationMs` |
| `run_end` | `totals: {inputTokens, outputTokens, cost, toolCalls, durationMs}`, `exitReason` |

The schema is stable: fields are only ever added, and the `v` field is bumped
for any breaking change.

### Hash chain (tamper evidence)

Each line's `hash` is `sha256(prev_hash + canonicalJSON(line-without-chain-fields))`,
where the canonical form sorts object keys recursively so it is independent of
key order. `prev_hash` is the previous line's `hash` (empty string for the first
line). This forms a chain: **any** edit, reordering, insertion, or deletion
changes a `hash` and breaks the link at that point. No signing keys are needed —
this proves *integrity*, not authorship.

Verify a trace with [`replay`](#replay); it recomputes the chain and reports
either `Hash chain: OK` or `Hash chain: BROKEN at line N`.

---

## Replay

Render a trace read-only to stdout — chronological, human-readable, with tool
call/result pairing, running cost, and the chain-verification result:

```bash
calliope replay <path|sessionId>          # human-readable text
calliope replay <sessionId> --json        # machine-readable (events + verification + summary)
```

A bare session id is resolved under `audit.dir`; a path is used as-is.

```
$ calliope replay session_1751749200_ab12
Run log — 7 events
────────────────────────────────────────────────────────────
[21:14:08] ▶ run start  session=session_1751749200_ab12
         cwd=/work/repo
         provider=anthropic model=claude-sonnet-4-6
[21:14:08] › user: list files then summarize
[21:14:08] ‹ assistant [40→12 tok] $0.0012: Running ls
[21:14:08]   ⚙ shell({"command":"ls -la"})  #tc1
[21:14:08]   ✓ shell #tc1 (14ms): total 4 file.txt
[21:14:08] ■ run end  reason=completed
         tokens=95→18 cost=$0.0030 tools=1 duration=60ms
────────────────────────────────────────────────────────────
Cumulative assistant cost: $0.0030
Hash chain: OK
```

**Exit codes:** `0` ok · `4` hash chain broken · `1` trace not found / unreadable.
This makes `replay` usable as a CI integrity gate:

```bash
calliope replay "$SESSION_ID" >/dev/null || echo "audit trail failed verification"
```

---

## Budget caps

Halt a run before it overspends. Any cap left unset is not enforced.

| Key | Unit | Scope |
|-----|------|-------|
| `budget.maxCostPerRun` | USD | A single agent run |
| `budget.maxTokensPerRun` | input+output tokens | A single agent run |
| `budget.maxCostPerProject` | USD | Accumulated across every run in a project directory |

```bash
calliope /config set budget.maxCostPerRun 0.50
calliope /config set budget.maxCostPerProject 20
calliope /config set budget.maxCostPerRun off      # clear a cap
```

Enforcement lives in the agent loop and the headless runner, right where cost
and tokens are tallied after each provider response. When a cap is reached the
agent **finishes the current tool result**, emits a `budget_event`, prints a
one-line `spent vs cap` summary, and halts cleanly. Interactive sessions show
the summary and stop the turn; `/status` shows budget state whenever any cap is
configured.

Per-project spend is tracked in a small ledger at
`~/.calliope-cli/projects/<hash>/budget.json`, keyed by a hash of the resolved
project path so it never lands inside your repo. It is only maintained when
`budget.maxCostPerProject` is set.

### CI recipe

Headless runs exit **3** when a budget cap halts them — distinct from `1`
(error) and `0` (success), so CI can react precisely:

```bash
#!/usr/bin/env bash
set -euo pipefail

export CALLIOPE_PROVIDER=anthropic
# Caps can be set once in config, or per-invocation via `calliope /config set`.

calliope --headless "run the tests and fix any lint" 
code=$?

case "$code" in
  0) echo "done within budget" ;;
  3) echo "halted: budget cap reached (see the run log)"; exit 3 ;;
  *) echo "agent error ($code)"; exit "$code" ;;
esac
```

The run log records exactly why it stopped (`run_end` with `exitReason: budget`
plus the preceding `budget_event`); replay it for the audit trail.

---

## Policy hook

A pre-tool-call gate for an external allow/deny engine. This is a distinct,
stronger-contract seam from the general [hooks](./configuration.md) (which veto
via exit code 42 and pass context through environment variables): a policy
engine receives the full tool-call JSON and uses conventional exit semantics.

```bash
calliope /config set policy.command /usr/local/bin/calliope-policy
calliope /config set policy.command off    # disable
```

### Contract

Before each tool executes, if `policy.command` is set, Calliope spawns it and:

- **stdin** — the pending tool call as JSON: `{ "id": "...", "name": "...", "arguments": { ... } }`
- **exit 0** — ALLOW; the tool runs.
- **exit non-zero** — DENY; the tool is skipped and the agent sees
  `[Denied by policy: <stderr>]` as the tool result. `stderr` is the reason.
- **timeout** (`policy.timeoutMs`, default 5000ms) — DENY (**fail closed**).
- **spawn failure** (command missing, etc.) — DENY (**fail closed**).

Every decision is recorded as a `policy_event` in the run log. Failing closed is
deliberate: a broken or unreachable policy engine must not silently wave tools
through.

### Shell example

A minimal policy that blocks writes outside `/work` and denies `rm -rf`:

```bash
#!/usr/bin/env bash
# /usr/local/bin/calliope-policy — reads a tool call on stdin.
call="$(cat)"
name="$(printf '%s' "$call" | jq -r '.name')"
cmd="$(printf '%s' "$call"  | jq -r '.arguments.command // empty')"
path="$(printf '%s' "$call" | jq -r '.arguments.path // empty')"

if printf '%s' "$cmd" | grep -Eq 'rm[[:space:]]+-rf'; then
  echo "destructive command blocked" >&2
  exit 1
fi
if [ -n "$path" ] && [ "${path#/work}" = "$path" ]; then
  echo "writes are restricted to /work" >&2
  exit 1
fi
exit 0   # allow
```

### Zentinelle integration

This seam is the integration point for [Zentinelle](https://github.com/calliopeai)
policy enforcement. Point `policy.command` at the Zentinelle adapter: it reads
the tool-call JSON on stdin, evaluates it against the active policy set, and
returns `0` (allow) or non-zero with a reason on stderr (deny). Because the
contract is just *JSON in, exit code out*, any engine that speaks it — Zentinelle,
OPA/Rego wrapped in a shell shim, or a bespoke script — plugs in without code
changes to Calliope.

---

## Exit codes

| Code | Where | Meaning |
|------|-------|---------|
| `0` | headless / replay | success / trace verified ok |
| `1` | headless / replay | error / trace not found or unreadable |
| `3` | headless | halted by a budget cap |
| `4` | replay | hash chain broken |
