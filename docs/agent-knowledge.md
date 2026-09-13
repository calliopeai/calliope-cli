# Opt-in project knowledge for agents

`calliope orchestrate "Use the recorded design to fix the boundary test" --brain`
adds read-only project knowledge tools to a new goal's reviewed workspace. The
REPL accepts the same flag on `/orchestrate`. Ordinary sessions, existing goals
and default model routing do not change. Smart routing remains a separate
explicit mode (`--routing smart --routing-policy routing.json`).

Initialize the project Brain and ingest selected evidence first:

```sh
calliope brain init --allow-mutations
calliope brain ingest docs/design.md --allow-mutations
calliope orchestrate "Implement the recorded design" --brain --cost 5 --json
```

Planning stops for exact proposal-hash approval as before. The proposed plan
must explicitly include knowledge tools for each worker that needs them, with
inherited path and tool grants. `--brain` does not approve mutations or execute
a proposal. Resume/approval cannot add the flag to an existing goal; they use
its captured workspace. Programmatic callers can set `GoalConfiguration.brain`
or provide explicit `brain_search` / `brain_entity` workspace grants. Reviewed
manual plans can grant those same tools.

## Retrieval contract

- `brain_search({query, limit?})` searches the private project index. The default
  limit is five, the maximum ten. It returns visible entities with revision,
  provenance, confidence, current freshness and effective knowledge state.
- `brain_entity({query})` accepts an entity ID or exact name and also returns
  source metadata: IDs, locators, hashes and provenance. Full retained source bodies
  are omitted (`contentOmitted: true`); `excerpt` contains at most 4,096 UTF-8
  bytes, with `excerptTruncated` when it is only a prefix. Hashes still identify
  the complete source snapshot. Entity summaries and cited excerpts remain
  available within the overall result limit.

Both tools accept at most 1,024 UTF-8 query bytes. Unknown fields, store/scope
selectors and secret-like arguments are rejected. Results use a version-1
`project-knowledge` JSON object and cannot exceed 32 KiB. Oversized results fail
with a complete error; agents can narrow their query. Normal per-model context
limits still apply to tool output in conversations. Missing or unavailable Brain
storage is a tool failure; retrieval never initializes a Brain implicitly.

These tools read local knowledge without sending a separate model request.
An agent's decision to retrieve it, and subsequent inference using the result,
still consume its existing bounded turn and request allowance. They cannot write
knowledge, promote a proposal, change a source document or satisfy an execution
acceptance check by themselves. A derived SQLite index may be rebuilt; the
canonical knowledge journal remains unchanged.

## Authority and evidence

The runtime exposes canonical definitions only to explicitly granted execution
accounts. Retrieval uses the original project's Brain even inside an isolated
worker worktree. Model arguments cannot choose another project, private store
or the global namespace. Project identity, ownership, cancellation, deadline,
current budget policy and source permissions are checked at retrieval boundaries.

Every cited source must fit the worker's current read paths as well as current
project policy. A source's file locator narrows access only when it is bound to
the current project identity. Pathless human notes, run summaries and transferred imports require project-wide
read permission. File locators without a project binding are denied; a fabricated
relative locator cannot make knowledge visible to a narrowly scoped worker. Foreign project sources
are denied. Search hides entities with any denied provenance; direct lookup
fails. Current symlink/path checks and configured-secret redaction still apply.

Results explicitly identify retained knowledge as untrusted evidence. Source
changes/missing files mark knowledge stale, while inferred/proposed/rejected
labels and confidence survive retrieval. Rejected entities are excluded from
search but can be inspected by explicit ID. Historical observations are not a
claim that current tests passed. Agents must cite provenance and verify current
work through the existing artifact and acceptance-check path.

The shared run log records tool calls, results and source-policy decisions;
conversation checkpoints preserve the actual returned evidence. Inspection and
replay use recorded events without new retrieval or inference. New lookups
recheck current source access; changing policy does not erase previously
recorded conversation evidence. Audit and session retention rules still apply.

## Scope of this slice

Read-only planners, planning reviewers and explicitly granted workers can use
these tools. Continuous-supervision controllers/reviewers keep their existing
immutable evidence review contract and do not receive a new tool loop. They
assess the worker artifacts and executor verification results. Automatic memory
injection, automatic run ingestion, global retrieval, knowledge writes by
agents, cross-run routing learning and general REPL Brain tool toggles remain
separate work.

This choice uses the existing hashed tool/path authority rather than a new
manifest field containing copied knowledge. Legacy goal and planner hashes stay
unchanged when retrieval is not enabled. Per-query policy/freshness checks avoid
implicitly distributing a broad static project-memory snapshot to every child.
