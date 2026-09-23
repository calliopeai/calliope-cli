# Editors: Agent Client Protocol (ACP)

Calliope can run as an [Agent Client Protocol](https://agentclientprotocol.com)
agent, so ACP-speaking editors — [Zed](https://zed.dev), JetBrains IDEs, Neovim,
and others — can drive it as a coding agent without any Calliope-specific plugin.
One command, `calliope acp`, speaks JSON-RPC 2.0 over stdio.

```bash
calliope acp
```

The subcommand is not meant to be run by hand: the editor launches it, writes
JSON-RPC to its stdin, and reads notifications from its stdout. **stdout carries
the protocol; all logs go to stderr**, so nothing corrupts the stream.

It reuses the same agent core as everything else in Calliope — the provider chat
loop, the tool runtime, the pre-tool policy hook, and the audit run log — so an
ACP session behaves like a headless or interactive session, just driven by your
editor.

## What works (baseline conformance)

The [baseline ACP agent surface](https://agentclientprotocol.com/protocol/overview#agent)
is implemented and tested against the official TypeScript SDK
(`@zed-industries/agent-client-protocol`):

| Method / flow | Status | Notes |
|---|---|---|
| `initialize` | ✅ | Negotiates protocol v1; advertises agent capabilities |
| `authenticate` | ✅ | No-op — Calliope authenticates via locally-configured provider keys |
| `session/new` | ✅ | One Calliope session per ACP session; the session id round-trips |
| `session/load` | ✅ | Restores a saved session in its project and replays its history (see *Loading a session*) |
| `session/prompt` | ✅ | Drives the agent loop (chat + tools) to a stop reason |
| `session/cancel` | ✅ | Aborts provider I/O and pending permission waits; returns `stopReason: cancelled` |
| `session/update` (streaming) | ✅ | `agent_message_chunk`, `tool_call`, `tool_call_update`; `user_message_chunk` in a replay |
| `session/request_permission` | ✅ | Asked for mutating/destructive tools (see below) |
| `fs/read_text_file`, `fs/write_text_file` | ✅ | Preferred for file tools when the client advertises `fs` |

### Capability matrix

**Advertised by Calliope (agent):**

| Capability | Value |
|---|---|
| `promptCapabilities.image` / `audio` / `embeddedContext` | `false` — text and resource links only |
| `loadSession` | `true`; see *Loading a session* |
| `authMethods` | `[]` — no authentication required |

**Consumed from the client (editor):**

| Client capability | Effect |
|---|---|
| `fs.readTextFile` | `read_file` / `edit_file` read the editor's buffer instead of disk |
| `fs.writeTextFile` | `write_file` / `edit_file` write through the editor instead of disk |
| `requestPermission` | Used to gate mutating tools; falls back to *deny* if unavailable |
| `terminal` | Not used yet — Calliope runs shell tools itself |

### Permissions

Read-only tools (`read_file`, `list_files`, `glob`, `grep`, `web_search`,
`think`) run without asking. Tools that mutate state or that Calliope's risk model
flags for confirmation (`write_file`, `edit_file`, `shell`, `git`, `execute_code`,
and any high/critical-risk command) trigger a `session/request_permission` call so
your editor can prompt you. If the client can't handle a permission request, the
non-interactive default is to **deny** the mutating tool (read-only tools still
run).

Scope, **pre-tool hooks** and the external **policy hook** (the
[Zentinelle](./governance.md) integration point) run before the prompt and again
after approval. A denial prevents execution and is reported to the model.

`allow` approves once. For eligible file operations, `allow_always` means the
exact arguments and canonical path in this ACP session for at most 24 hours;
changed arguments or policy configuration need a new approval. Shell, code and
plugin operations offer only once/reject. Unknown option IDs are rejected.
Session grants disappear on process restart; existing project grants may apply
but ACP does not create project grants. See [permissions](./permissions.md) for
scope, revocation and audit semantics.

### Loading a session

`session/load` restores a session this agent saved, including after the agent or
its host restarts. Every turn already checkpoints a verified
[recovery snapshot](./session-recovery.md), and `session/new` commits the first
one, so a session that was never prompted loads too.

- Pass the ID from `session/new` and the same `cwd`. A session loads only in its
  recorded project; an unknown ID or a missing or damaged snapshot is refused.
- Before responding, Calliope replays the conversation as `session/update`
  notifications: `user_message_chunk`, `agent_message_chunk`, `tool_call`, then a
  `tool_call_update` carrying the recorded result. The system prompt is not
  replayed.
- A tool call without a recorded result is closed as an unknown outcome and
  replays as `failed`, as do recorded tool errors. Nothing runs and no provider
  request is made; an `agent_thought_chunk` says so when work was interrupted or
  retention omitted older messages.
- A load is refused while a prompt runs in that session. Provider and model
  preferences resolve for `cwd` as they do for `session/new`, and session
  approvals do not survive a restart.

### Client-side filesystem

When your editor advertises the `fs` capability, Calliope routes `read_file`,
`write_file`, and `edit_file` through the editor's `fs/read_text_file` and
`fs/write_text_file` rather than touching local disk. This is the marquee ACP
behavior: edits apply to the buffer you are actually looking at — including
**unsaved changes** — instead of the last-saved bytes on disk. Without the `fs`
capability, file tools use local disk as usual.

### Audit

Every ACP session writes the same tamper-evident audit run log as any other
Calliope session, tagged `mode: acp` in its `run_start` event. Inspect one with
`calliope replay <sessionId>` (see [governance](./governance.md)).

## Configuring your editor

The provider and model come from your Calliope config (`defaultProvider` /
`defaultModel`) or the usual `*_API_KEY` environment variables — configure those
first (`calliope --setup`), exactly as for interactive use.

### Zed

Add an agent server to your Zed `settings.json`. Point it at the `calliope`
binary (or `node /absolute/path/to/dist/bin.js`) with the `acp` argument:

```json
{
  "agent_servers": {
    "Calliope": {
      "command": "calliope",
      "args": ["acp"],
      "env": {
        "ANTHROPIC_API_KEY": "sk-ant-..."
      }
    }
  }
}
```

Then pick **Calliope** from the agent panel's agent menu. See Zed's
[External Agents](https://zed.dev/docs/ai/external-agents) docs.

### JetBrains

JetBrains IDEs speak ACP through the AI Assistant / external-agent integration.
Register an external ACP agent with the command `calliope` and argument `acp`
(and the provider key in the environment), then select Calliope as the agent.
The exact settings path varies by IDE version; consult your IDE's ACP/external
agent documentation.

### Any ACP client

Any client that can launch a stdio ACP agent works the same way: run the command
`calliope acp` with a configured provider key in the environment.

## Not yet done

- **Registry listing.** Submitting Calliope to the public ACP agent registry is
  deferred to a later release.
- **Session modes / model selection** (`session/set_mode`, `session/set_model`).
- **MCP servers over ACP.** `session/new` accepts an `mcpServers` list; Calliope
  ignores it for now and uses its own MCP configuration.
- **Terminals, images, and audio** in prompts/tool calls.

## Verification status

Code-level conformance is tested against the official ACP TypeScript SDK: the
handshake, session lifecycle, streaming updates, the permission round-trip (grant
and deny), mid-prompt cancellation, and client-side filesystem delegation are all
covered by in-process tests that drive the SDK's client against the agent
(`tests/acp.test.ts`, `tests/acp-fs-delegate.test.ts`). `tests/acp-stdio.test.ts`
runs the built CLI over stdio, kills it after a turn and loads the session in a
new process. A live editor smoke test
in Zed and JetBrains is pending and tracked on the release checklist.

## Cancellation and instructions

Each session owns one active prompt. Concurrent prompts in the same session are
rejected; a completed cancellation permits a new prompt. Late permission replies
cannot authorize tools from a cancelled turn. Cancellation preserves assistant /
tool-result pairing for the next request. It cannot undo completed writes or
retract remote operations; see [cancellation limits](./features.md#cancellation).

Trusted [repository instructions](./instructions.md) load from the session's
`cwd` when the session is created.

ACP forwards append-only assistant chunks. A partial stream failure returns the
existing JSON-RPC error without automatically repeating those chunks; an explicit
later prompt continues from committed conversation state. Bounded tool output
is available locally through `calliope session outputs SESSION_ID --json`. See
[streaming and output storage](streaming.md); no ACP message schema is changed.
