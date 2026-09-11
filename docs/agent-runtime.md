# Agent runtime authority and reservations

The shared runtime accepts `runTurn({ execution, ... })`. A trusted caller gets
that context from `prepareAgentExecution(cwd, runId, agentId, maxOutputTokens,
options)`, which requires an approved run, checks `orchestration_budget` through
the permission resolver and rechecks approval after waiting. Preparation sends
no provider request and grants no file permission.

This is a library boundary. CLI runs remain inactive: there is no scheduler,
artifact verification or resumable task execution. The embedding caller owns
provider preferences, lifecycle callbacks and run cancellation. Revoking
preparation cannot discover and signal independently embedded runtime instances;
the coordinator must supply that connection before execution commands ship.

## Authority

A version 1 manifest binds the run UUID, plan hash, canonical project identity
(path/device/inode), creation time, absolute deadlines, budgets and accounts.
Accounts declare ID, parent, tools, read/write paths and inclusive descendant
budgets. Children can only narrow authority. Validation rejects unknown fields,
cycles, expanded scopes, over 256 accounts, depth over eight and malformed limits.
Restart preserves the original contract and deadlines.

Tools are filtered before inference and checked again before policy/hooks,
after approval and at execution. Project policy still applies. Bounded turns
promote `confirmation: "none"` to `"mutating"`; mutations require an applicable
grant or explicit callback. Approval cannot expand authority. Config changes are
checked before dispatch.

Supported tools are think, ask_question, create_plan, read_file, write_file,
edit_file and list_files. Shell, network, git, configuration, plugin and custom
tools fail closed pending sandbox containment. Fleet mirroring is disabled.
Trusted policy programs and hooks remain host code, outside that containment
claim. Post-tool hooks are awaited, including asynchronous hooks, and their
process groups receive deadline/cancellation signals.

File operations reject aliases/escapes and files above 1 MiB. Edits bind to the
exact bytes read by that attempt. Writes use exclusive temporary files, fsync,
final content/parent identity checks, atomic rename and directory fsync.
Creating parents requires write coverage of those directories; an exact file
grant alone is insufficient. Listings stop at 1,000 entries and five directory
levels without following links. Caller filesystem delegates cannot replace
these checks. They assume a trusted host/filesystem, not a malicious process
racing every filesystem syscall.

## Request admission

Each attempt, retry, repair and compression call requires durable admission
before HTTP. Discovery must be live and no older than five minutes, with
compatible reported capabilities, positive input/output limits and nonnegative
input/output prices. Missing evidence denies bounded execution, even locally.
A hostname never proves inference is free. Multimodal calls need separate billing
bounds and currently fail closed.

Reservations cover the full discovered input capacity plus the requested output
limit. Even short prompts may therefore exceed an agent budget. Dollar-per-million
prices round up to whole nanodollars per token; caps round down. Settlement uses
the same conservative rates, so ledger cost may exceed invoice cost. The bound
assumes providers honor advertised flat token rates, capacity and output limits.
It cannot guarantee invoices against undisclosed request fees, tier surcharges,
cache write premiums or incorrect metadata. Those dimensions need verified
upper-bound metadata before a provider can be certified for budgeted orchestration.
Provider-side account quotas provide an independent ceiling.

Limits reach Chat Completions, Responses, Anthropic, Google @google/genai,
Bedrock native/gateway, compatible servers and native Ollama. Bounded calls
disable internal SDK retries and automatic model/tool/format fallbacks. Shared
retries reserve again; tool-stripping shims reject calls with tools. Google
thought tokens and Anthropic cached input contribute to usage. Missing usage
stays unknown, never zero; malformed required fields may instead fail the request.

Project admission commits first, then one run transaction charges the leaf,
ancestors and run. Failed local admission before dispatch can release its project
reservation. Partial storage failures can conservatively retain spend in one
ledger but cannot authorize HTTP without successful admission. Endpoint changes
during admission stop dispatch. Storage failures cannot trigger network retry.

Successful valid usage settles once. Errors, cancellation, missing usage and
unfinished requests retain their full bound across restart. Invalid usage or
an overrun freezes further execution without crediting the overrun. Parent
cancellation and absolute deadlines reach HTTP, retry waits, permissions and
file tools. Ordinary project-capped turns share project reservations with a
60-second request deadline. Uncapped ordinary turns retain existing behavior.

## Persistence and recovery

`~/.calliope-cli/orchestration/<run-id>/budget/history.json` contains version 1,
the manifest, events and a hash binding both. Events have immutable UUIDs,
epoch-millisecond times, previous hashes and reserve/settle changes.
Reservations record provider/model IDs, endpoint fingerprint, counts, prices,
cost and configured run caps. Settlements reference a reservation and outcome
with optional usage. Replay reconstructs totals, revision and
pending/settled/unknown/exceeded states. Budget records contain no prompt,
response text or credential.

The existing project budget.json becomes version 2 with import, charge, reserve,
settle and explicit reset events using UUIDs, ISO times and hash links. Runtime
and legacy writers share one lock. First write imports the legacy spentUsd total,
without inventing prior events. Replay checks the spentUsd/updatedAt header.
An initialization marker makes a removed journal fail closed. Reset preserves
history and refuses pending reservations.

Both journals use exclusive locks and fsynced atomic replacement. Logical event
prefixes are append-only; the JSON container is replaced on commit. Run files and
directories are private (0600/0700). Project files are private; existing parents
must not be writable by others. Lock waits are bounded and async admission waits
are cancellable. Run limits are 10,000 events/16 MiB; project limits are 10,000
events/8 MiB. Admission leaves event slots for pending settlements. Exhaustion
stops work without deleting history. Hashes detect corruption, not an owner who
rewrites or rolls back all files; there is no signed external integrity anchor.

The optional conversation log records routing, admission/outcomes, permissions,
usage and tool results. Budget persistence remains mandatory when that log is
disabled. Headless JSON retains its shape: budget denial exits 3; cancellation
exits 130. Denials explain unavailable capacity without invented numeric totals.

After interruption, reopen the same journal instead of starting fresh to recover
unknown spend. Preserve damaged histories and markers. Remove locks only after
independently verifying the owner stopped. Restore verified backups or reconcile
provider evidence with human review; no automatic forgiveness/repair command is
provided. Archive only after accounting for pending requests and preserving the
project total.

Synthetic tests exercise installed SDKs, concurrent agent/ordinary project spend,
restart, approval races, policy denial, file conflicts, cancellation, malformed
state and retention. They do not replace real-wire captures. Scheduling, artifact
verification, task retries/cancellation trees, executable run events and isolated
shell/network tools remain required, along with the brain/KG and improvement loop
in #254. See [orchestration plans](orchestration.md).
