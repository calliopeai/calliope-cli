# Project brain and knowledge graph

Calliope records local project knowledge without a provider request. Documents,
human proposals, execution records and their relationships have explicit source
provenance. The brain is separate from conversation history and execution
permissions: reading a fact cannot authorize a tool or increase a run budget.

## Commands

The same arguments work with `calliope brain` and `/brain`. Use `/kg search` or
`/kg graph` (also `calliope kg`) for graph aliases. Quote names containing spaces;
IDs disambiguate duplicate names.

```sh
calliope brain init --allow-mutations
calliope brain ingest docs/design.md --allow-mutations
calliope brain search 'storage decision' --json
calliope brain entity '<id or name>' --json
calliope brain neighbors '<id or name>'
calliope brain path '<from>' '<to>' --direction out --depth 8
calliope kg graph --limit 20
calliope brain decisions
calliope brain risks
calliope brain note 'Storage choice' 'Use SQLite for local search.' --kind decision --allow-mutations
calliope brain edit '<entity-id>' --state accepted --reason 'Reviewed the cited source.' --allow-mutations
calliope brain link '<from>' '<to>' supports --source '<source-id>' --allow-mutations
calliope brain edit-edge '<relationship-id>' --state accepted --confidence 0.9 --reason 'Relationship checked against source.' --allow-mutations
calliope brain history
calliope brain reverse '<event-id>' --reason 'Withdraw this correction.' --allow-mutations
calliope brain ingest-run '<run-id>' --allow-mutations
calliope brain refresh --allow-mutations
calliope brain reindex --allow-mutations
calliope brain export reviewed-brain.json --allow-mutations
calliope brain init --global --allow-mutations
calliope brain import reviewed-brain.json --global --allow-mutations
```

`note --kind` accepts document, decision, requirement, task, risk, dependency,
stakeholder, provider, agent, artifact, test_evidence and run. Notes are human
**proposals**, including notes labelled test_evidence. That label alone never
establishes a passed test. `edit` changes name, summary, state or confidence and
requires a reason; relationship review changes state or confidence. A link is
initially an inferred proposal. Source IDs and complete retained source snapshots
appear in `entity --json`. Terminal source previews stop at 3,000 characters.

`--global` explicitly selects a distinct global namespace. File-backed global
records retain their originating project boundary; opening another project does
not grant access to those source paths. Use an explicit export/import to share
reviewed knowledge. Human notes without file references are portable global
knowledge. No brain content is automatically injected into worker prompts or
added to an agent's allowed tools.

Mutations require the shared permission resolver. Headless defaults deny missing
confirmation; `--allow-mutations` supplies operator consent but still runs current
scope, mode, hooks and policy checks. REPL commands use the active project,
approval callback and cancellation signal. This does not approve execution,
publication, merge, deployment or external communication.

## Storage decision: portable SQLite index with a canonical journal

Decision: use pinned `sql.js` (SQLite WebAssembly), loaded only for brain commands,
with a rebuildable SQLite index and a canonical private journal. The supported
Node minimum is 20; avoiding a native addon also permits the installed package to
run under a different compatible Node major without an ABI rebuild. The engine
and WASM ship in the installed dependency; brain operations do not download an
engine or contact a model. See the [sql.js documentation](https://sql.js.org/documentation/)
and [upstream implementation](https://github.com/sql-js/sql.js).

Tradeoff: sql.js loads a database snapshot in memory and exports a whole SQLite
file. This is appropriate for the bounded local brain, not an unlimited database
service. Native direct-disk SQLite would scale better but adds runtime/platform
packaging requirements. The versioned journal and portable SQLite format leave
that migration possible without changing knowledge semantics.

Storage is outside project/worker scope:

```text
~/.calliope-cli/brain/<canonical-project-identity>/history.json
~/.calliope-cli/brain/<canonical-project-identity>/index.sqlite
~/.calliope-cli/brain/global/{history.json,index.sqlite}
```

Directories are private (0700), files private (0600). Project identity includes
canonical path, device and inode. Aliased, shared or foreign history is rejected.
A bounded writer lock serializes processes. A confirmed dead writer can be
recovered; a timer alone does not establish death. Writes use exclusive temporary
files, fsync and atomic replacement, with history and identity checks after
approval. Concurrent stale revisions fail instead of overwriting another writer.

The journal is **logically append-only**: atomic replacement writes its existing
events plus new events. Immutable event IDs and a SHA-256 ancestry chain detect
corruption and accidental rewriting. This is not a signature against an attacker
who controls the same account and can rewrite both data and hashes.

SQLite schema version 1 has entities, edges, sources, source-to-entity provenance,
metadata, endpoint/kind/name indexes and Unicode FTS4 indexes over source content
and entity text. A cache is checked against the journal, including its schema,
rows, scalar index fields, provenance and FTS integrity. Missing, stale or damaged
caches rebuild in memory during reads. Reads never rewrite the index; a mutation
or explicit `reindex` can persist it. An index failure after a committed mutation
returns `index: rebuild-required`; the journal remains the result of record.

## Version 1 schemas

| Record | Required information |
|---|---|
| Header | Version, UUID, project/global scope, project identity (or null), creation time |
| Source | ID, file/run/human/import kind, name, sanitized content, original and retained SHA-256 hashes, redaction flag, source locator |
| Entity | ID, typed kind, name, summary, state, confidence, provenance, bounded scalar attributes |
| Relationship | ID, source/target entity IDs, typed relationship identifier, state, confidence, provenance |
| Record stamp | Version, created/updated timestamps, last modifying event ID |
| Event | Version, immutable UUID, sequence, timestamp, previous/head hashes, actor, reason, changes, optional reversed event ID |
| Change | Immutable source addition, or entity/edge replacement/removal with its expected prior event ID |
| Provenance | Source ID, observed/inferred basis, optional literal verified excerpt |

Confidence is a finite number in [0, 1]. Every entity and relationship needs one
to 32 provenance references; relationships cannot dangle. Source bytes are
immutable. Redaction stores both original and retained hashes; a redacted copy is
not represented as byte-identical to the original. A model's inference cannot be
accepted by ingestion or import. Human review must be explicit and adds evidence.

Large operations split into bounded events but commit the whole journal update
atomically. Reversal restores the recorded inverse of one event and keeps source
evidence. Reverse a multi-event operation in reverse event order. Later edits,
including an edit subsequently reversed, retain their revision history: an older
inverse cannot silently replace them. Deletion retains a revision tombstone so
concurrent recreation cannot evade this check.

Retention limits stop writes rather than erasing history: 64 MiB each for journal
and index; 10,000 events; 10,000 entities; 30,000 edges; 5,000 sources; 256 changes
and 1 MiB per event. Ingestion accepts regular UTF-8 files up to 512 KiB and retains
at most 128 KiB per source, without silent truncation. Search accepts 1–16 words,
up to 4 KiB, and 1–100 results. Paths use a visited set, at most 16 edges of depth
and the bounded graph population. Cancellation is checked at I/O and iteration
boundaries; an individual synchronous SQLite operation finishes before Node can
process a new signal.

## Knowledge state and provenance

States are proposed, accepted, rejected and stale. Ingestion accepts only the
observation that a particular document snapshot exists; its contents remain the
author's claims. It does not extract semantic facts or invoke a model. Human notes
start proposed. Structural run metadata and actual executor checks are observed;
controller improvement hypotheses remain inferred/proposed, even when a later
attempt succeeds. An accepted failed check means the failure observation is
recorded, not that the test passed. Check kind stays explicit: a text `contains`
check is not represented as a process test suite.

Queries recheck current read policy for cited local paths before returning retained
content. Restricted entities/relationships are omitted from searches; direct
inspection fails with policy denial. Search limits can yield a partial view.
`entity` reports `freshness: current|changed|missing|unverified` and an
`effectiveState`. Changed/missing file sources make unrejected knowledge effectively
stale without mutating it. `refresh` records those stale markers. Re-ingestion adds
a new immutable source snapshot; knowledge citing the old snapshot remains stale.
Missing source directories are also recoverable observations. Unverified imports
and run metadata are not advertised as fresh filesystem documents.

`ingest-run` validates run history and artifact hashes before recording a stable
snapshot. It links agents, tasks, dependencies, artifacts, executor checks and
final controller/reviewer improvement cycles. Worker prose is not imported as
proof of test success. Active coordinators and changing artifacts are rejected;
brain ingestion never runs an agent, changes an approval, or resets a reservation.
Different execution revisions create separately identifiable run snapshots.

Exports contain the validated journal with a checksum, preserving original states
and provenance. Destination creation is private and exclusive; source documents
and previous exports cannot be overwritten. Import validates ancestry, namespaces
IDs and stores sources as unverified local transfer claims. Original record IDs,
revisions, timestamps, state/confidence claims and source locators survive in
bounded `origins` metadata; more than eight transfer hops requires a separate
reviewed scope rather than dropping provenance. Previously accepted
claims become proposed; local corrections cause conflicts on repeat import.
Exact repeats are idempotent. Budget, tool, policy and execution authority are not
part of the import schema. Foreign locators never trigger automatic filesystem or
network reads. Review knowledge before exporting it to other people.

## Headless contract

One JSON line per brain command:

```json
{"version":1,"type":"brain","action":"search","localOnly":true,"data":{"entities":[],"limit":20,"partial":false,"index":"valid","revision":"<sha256>"}}
```

Errors replace `data` with `error: {code, message}`. Exit codes: 0 success,
2 malformed input, 3 policy denial, 130 cancellation, 1 unavailable/conflicting/
limited operation. Mutation results are compact receipts (scope, brain ID,
revision, event ID/count, affected IDs, index state); they do not dump unrelated
private history. KG aliases retain the same brain envelope. Terminal text is
sanitized for control characters and credentials.

## Threat model and recovery

Inputs and imported claims are untrusted. Strict schemas, hashes, path boundaries,
private files, size limits, parameterized SQLite queries and exact cache comparison
protect the local persistence boundary. Recognizable secrets, complete private-key
blocks, credential assignments and exact configured secret values are redacted
before ingestion. Newly configured secrets matching retained evidence prevent its
reuse/export. Pattern matching cannot identify every confidential fact: explicitly
choose documents appropriate for this knowledge scope.

- **Missing index:** search rebuilds in memory; run `brain reindex` to persist it.
- **Interrupted write:** inspect `brain status` and `brain history`. A cancellation
  after commit can leave a valid new event; do not assume the mutation was absent.
- **Conflicting writer/review:** inspect the current record revision and retry the
  intended correction. Do not remove another live writer's lock.
- **Damaged journal:** preserve the directory and restore a verified private backup.
  `init`, `reindex` and queries do not overwrite broken history with an empty brain.
- **Moved/replaced project:** the old brain remains under its old identity. Transfer
  reviewed knowledge explicitly; do not copy authority or silently rebind history.
- **Stale document:** inspect the source, re-ingest its current contents, and review
  dependent claims. Refresh does not promote them back to accepted.
- **Retention reached:** preserve/export the scope; create a deliberately separate
  scope/project for new work. No automatic pruning erases audit history.
- **Index/version migration:** future versions must explicitly migrate a verified
  journal or rebuild a derived index; unsupported journals fail closed today.

Tests cover actual SQLite, provenance, exact reversal, stale sources, changed
policy, cancellation, concurrent writers, restart, malformed imports, transfers,
run checks, JSON contracts and REPL wiring. Local operations spend no model tokens.
