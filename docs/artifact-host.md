# Native artifact host

`executeReviewedRun` accepts an optional trusted `artifactHost` in its library
options. This supplies one tool named `artifact` for a product-owned draft store.
It is not discovered from project files, environment variables, MCP registration
or model arguments. The CLI does not install a host or grant access by default.

The reviewed workspace and agent lineage must explicitly allow `artifact`.
`ExecutionGuard` also requires the current coordinator host binding. A forged
model call without either condition is denied before the host executes. Normal
mode, policy, hook, approval, cancellation, budget and ownership checks remain in
force. Artifact calls require mutating-tool confirmation; plan mode refuses them.
The existing `read-only-v1` task contract does not allow artifact mutation tools.

`artifactHostCapabilities()` describes version 1 of this interface. The host
supplies a bounded `Tool` descriptor with the fixed name and an `execute`
callback. The coordinator snapshots both before worker admission. Its arguments
are separate from an executor-owned `ArtifactTaskContext` containing:

- Canonical project root/key, run ID, manifest hash, plan hash and approval revision.
- Task, agent, native worker session and attempt number.
- The exact task-start event identity and hash.

Each invocation receives a private copy of this context. A model-provided field
named `sessionId`, `taskId` or similar is merely request data and cannot replace
the host context. The embedding product must validate its own operation schema
and reject fields it does not support.

The callback receives an `AbortSignal` and `assertActive()`. It must propagate the
signal into I/O and recheck activity immediately before committing a mutation.
The coordinator checks activity before dispatch and before returning a result.
The adapter waits at most 60 seconds, narrowed by the native task deadline. It
does not retry tool calls. A lost response or cancelled wait does not prove that
the host did not commit; the product must provide stable request identities and
read-only receipt recovery. Never blindly replay an uncertain mutation.

Requests permit at most one MiB of finite plain JSON; responses permit two MiB.
Both have depth/node bounds. The host returns `{content, isError?}`. Explicit
product refusals remain tool errors; arbitrary exceptions and invalid/oversized
responses become a fixed acknowledgement error without leaking host diagnostics.
The descriptor is limited to 64 KiB and its description to 4096 characters.

Artifact calls are conservatively journaled as possible mutations using event
version 11, including failed acknowledgements. This prevents automatic worker
retry after an unknown artifact result. Earlier failed `artifact` calls recorded
with the legacy non-mutating event retain their original interpretation. Artifact
calls have no project file path and cannot satisfy the isolated worker's required
source edit before verification. Provider requests retain their existing native
attempt attribution and reservations; this interface adds no inference or budget.

The host is trusted application code, equivalent to a native embedding adapter.
It must restrict operations to enrolled artifact stores, enforce current owner,
selection and revision checks, preserve agent/reviewer provenance and require
normal human review for publication or accepted changes. A CLI tool grant alone
does not authorize access to a Cy conversation, board, brain or external service.
No parent-conversation authority is inferred from a task prompt or local path.
This interface is not a sandbox for arbitrary third-party callback code.

Qualification uses the actual coordinator/runtime and provider response parser
with synthetic inference. Tests verify native context, inherited grants, missing
host and denied approval, mutation journal replay, unchanged accounting,
cancellation, bounds and refusal to count draft changes as source edits. The
Cykick board-store adapter and human task-to-board enrollment are separate
integration work; this native contract alone does not complete that feature.
