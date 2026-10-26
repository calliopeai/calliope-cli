# Generated source candidates

An isolated task can produce a candidate commit before independent behavioral
verification. Hosts discover `sourceCandidateCapabilities()` in the orchestration
or migration library; `calliope migration capabilities --json` also includes it at
`execution.candidate`. This is a library host capability, not a model-selected
shell command or a new scheduler.

Select the exact `runId`, `executionRevision`, `taskId`, `attempt`, `artifactId`
and `artifactHash` from native execution records. The selected task must be a
completed writable isolated task with passing declared checks and its nonempty
executor-collected patch. A syntax or file check may satisfy that task without
proving migration behavior. Candidate receipts therefore always say
`verification: required`.

1. Call `previewSourceCandidate(project, selection, options)`. Review its exact
   patch, base commit, paths, author, task/attempt and hash. Preview creates no Git
   object or ref.
2. Call `createSourceCandidate(project, selection, reviewedHash, options)` after
   review. Native project policy and the distinct `orchestration_source_candidate`
   mutating permission still apply. This creates one local ref under
   `refs/calliope-candidates/<run>/<review-hash>` with status `candidate`.
3. Use its exact commit/blob in a separately approved migration verification plan.
   A candidate receipt is neither passing evidence nor permission to change the
   independent verifier, publish a review proposal, merge or deploy.
4. Reopen with `inspectSourceCandidate(project, runId, reviewHash, options)` or
   discover receipts with `listSourceCandidates`. Recover an uncertain create by
   retrying the original selection/hash; do not create a replacement request.

The existing durable Git writer owns this operation. It uses a private index,
records an intent before creating a commit, pins the commit timestamp, and writes
the candidate identity before publishing its ref. Interrupted publication reuses
that same commit. A published request is read-only on retry, including after the
owning branch advances. It does not need renewed mutation approval to inspect an
already published result. An unpublished request still rechecks authority and
requires approval to finish. Moved refs or damaged receipts are conflicts.

The source checkout, index, native execution journal and user branches stay
unchanged. Creation refuses a changed native revision/attempt/artifact, revoked
approval, active execution owner, advanced source HEAD or an overlapping staged,
unstaged, untracked or ignored target. Unrelated edits remain available. Every
patch path must fit the worker's original write grants, with a 1 MiB patch and
1,000-path bound. Repository-local author identity is part of the review.

HEAD comparison and ref creation share a Git transaction. Local edit checks run
at review boundaries; they do not lock the user's working tree. Edits arriving
after the last check remain untouched and must be reconciled before any later
merge. The writer does not execute project code, call a provider, reset budgets,
or infer unit ownership from prose.

Candidate receipts are stored separately from verified improvement proposals.
The existing `previewSourceChange`/`proposeSourceChange` contract, review hashes,
`refs/heads/calliope-proposals` namespace and required verified improvement cycle
are unchanged. A candidate cannot be inspected as a verified source proposal.

This primitive supplies the generated-commit handoff for migration workflows.
Hosts still own approved unit/rule bindings, independent reviewer authority,
shared allowances, stale-unit reconciliation and production artifact retention.
