# Read-only migration assessment

`calliope migration assess --repository /path/to/clone --request request.json --json`
produces a feasibility report, rulebook and work manifest from a pinned source
inventory and supplied pilot evidence. It does not run scripts, invoke Docker,
start workers, create a workflow, write project artifacts or propose brain changes.
Save the returned JSON through the project's authorized artifact owner when wanted.

`migration assessment-schema` returns the request/report JSON Schemas.
`migration review-assessment --request request.json` validates the request and
returns its digest without reading a repository. Schemas describe structure;
runtime validation also checks normalized paths, ownership and cross-references.
The assessment CLI exits 0 when it produced a report, including `investigate` or
`do-not-migrate`. Read `recommendation`; exit 0 is not a migration approval.

## Request and inventory

The versioned request records:

- Source commit and authorized literal read paths, target adapter/stack/runtime.
- Port, redesign or incremental-upgrade intent, motivation, compatibility
  obligations, deployment constraints and success criteria.
- USD budget in integer micros, duration limit and maximum concurrency.
- The rulebook's exact commit/path/blob, unique source/target unit ownership,
  explicit source-file dependencies, risk and rationale, and reasoned exclusions.
- Up to 16 pilot plan/report pairs with separately evidenced implementation,
  verification and review measurements. Measurements bind the exact report digest.

One request is bounded to 2 MiB, 128 units, 128 exclusions and 64 read prefixes.
All repository reads use the existing bounded committed inventory. The repository
is canonicalized before asynchronous work; moving a path alias cannot redirect
later reads. Evidence pins outside the selected read scope are reported without
reading them. Hosts must supply a scope already authorized for the user/task.

Every selected source file must be owned by a unit or explicitly excluded. Original
tests, build configuration, manifests and lockfiles remain listed in the rulebook.
The assessment identifies unsupported adapter/runtime/unit shapes, unavailable
sources, uncovered code, external dependencies, declared package cycles and unit
cycles. Unit dependencies must include declared local-package ordering. This is
declaration analysis, not an import parser or proof of dynamic dependency coverage.

The current adapter supports self-contained `.mjs` to `.mts` CLI ports on the pinned
Node 24 runtime. A redesign or incremental upgrade requires a different plan;
passing old CLI cases does not make it a structure-preserving port. Unsupported
scope yields `do-not-migrate` **for this plan and adapter**, not a general claim
that the selected technology or a migration is unsuitable.

## Evidence and independent host review

Each pilot goes through [saved evidence review](migration-verification.md#review-saved-observations).
The assessment then checks every source, candidate, negative-control and rules pin
against actual committed blobs. Self-consistent JSON with invented Git pins is not
enough. Changed source, rules, runtime, cases or pilot accounting require a new
assessment and review. Missing or nonpassing baselines, known-failure checks or
candidate observations remain findings, regardless of a host's acceptance.

Library hosts call `assessMigration(repository, request, { signal, implementation, review })`.
`implementation` contains `kitSha256` and `verifierSha256`, supplied by the trusted
host from its installed kit artifact and the verifier that produced the pilot
evidence. These exact identities join the logical versions in the report, review
digest and unit bindings. Missing identities prevent `go`; request JSON cannot
supply them as authority. The host must check these hashes against its own
installation and evidence-producer records, not blindly copy a client's claims.
The optional `review` callback is trusted host code, never deserialized request
data. It receives the canonical repository, request, inventory digest, findings
and a digest binding that exact review context. The host must verify evidence
provenance, behavioral/compatibility coverage, risk classification, representative
pilot selection and measurement receipts through its owning records. It returns
`{ decision: 'accepted' | 'rejected', receipt: 'opaque-review-reference' }`.

Callbacks get a detached copy and cannot rewrite the assessment's inputs or
findings. A rejection, invalid receipt, unavailable review or absent host callback
prevents `go`. The standalone CLI deliberately has no flag that turns an authored
JSON report into independent review authority; it can still complete a read-only
assessment and return the work to investigate. A future native host adapter must
resolve review receipts through its existing authenticated owner.

`go` means the supported, pinned plan has no unresolved assessment findings and
its pilot evidence/coverage has been accepted by that host. It does not mean all
manifest units were migrated or verified. Every unit remains `planned`. Neither
the output digest nor an opaque review reference is portable authentication or
execution permission. A workflow owner must validate current bindings and its own
authority before dispatch; merely loading this report must never start work.

## Measured ranges and work artifacts

Every populated risk group, including high-risk units, requires a passing pilot,
with representativeness checked by the host. The manifest shows coverage by risk
group; one passing example does not establish coverage of every unit. A measurement
records total pilot cost, work time (implementation plus verification), independent
review time and an accounting evidence ID. Zero billed cost is valid for an
evidenced local fixture; missing measurements are not represented as zero.

Only accepted, fully qualified evidence produces estimates. Cost bounds multiply
the observed pilot minimum/maximum by the exact manifest unit count. Lower time
uses concurrency and dependency depth, then serial review; upper time assumes
serial work and review. These are explicit extrapolation assumptions, not
statistical confidence intervals. Unmeasured deployment, external data migration
and operating costs are excluded. A lower bound over budget yields
`do-not-migrate`; an overlapping range yields `investigate`.

The manifest has stable source-path unit IDs, deterministic dependency ordering
or cycle components, exact source blobs, per-unit binding digests and pilot
references. Binding digests conservatively include the complete assessment inputs,
including source/config/rules, logical revisions and exact kit/verifier hashes. A changed plan
requires re-review; this version does not claim minimal per-unit invalidation or
resume reconciliation. Execution must honor the pinned worker package artifact.

The evidence storage plan names a project-relative directory, assessment/rulebook/
manifest files and per-unit pin, verification, accounting and review artifacts.
`written: false` makes its status explicit. Native Astrolift project/agent bindings,
artifact persistence, conversational setup, reviewed compatibility exceptions,
rule-update replay and resumable execution remain separate host integration work.
