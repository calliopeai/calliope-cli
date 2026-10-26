# Code migration playbook v1

This Calliope-owned playbook pairs the `migration-v1` CLI helpers with the native
reviewed execution and improvement contracts. It is packaged with the npm CLI.
It supports one initial adapter: self-contained JavaScript `.mjs` to TypeScript
`.mts` command-line programs on an exact Node 24 Linux image. Other language,
framework and API migrations require another qualified adapter.

## Establish the contract

Select the source repository, full commit, literal read paths, target runtime,
allowed worker tools and paths, total budget, deadline and concurrency. Preserve
original tests, build configuration and lockfiles. Inventory only reads committed
objects; an uncommitted checkout is not evidence for the pinned source.

```sh
calliope migration capabilities --json
calliope migration schema --json
calliope migration inventory --repository REPOSITORY --revision FULL_COMMIT --json
calliope migration example --json
calliope migration baseline-schema --json
calliope migration verification-schema --json
calliope migration assessment-schema --json
```

The example supplies source, candidate, known-regression and rulebook templates,
plus positive, empty, negative-value and invalid-input cases. Save them only in an
authorized disposable repository and commit them before creating pins. Resolve
each pin to its full commit, relative path and blob ID. Replace the runtime with
an already-present image ID and its exact Node version. No helper installs an
image or adopts a downloaded program automatically.

The chosen cases are a public-interface contract, not proof of general program
equivalence. An independent reviewer must approve changes to cases, expectations,
rules and compatibility obligations. Missing coverage remains a finding; it must
not be removed to obtain a passing report.

## Baseline, pilot and assessment

Create a `calliope.migration.baseline-plan/v1` from the emitted schemas and example.
It has no candidate field. Review its complete contents and exact digest before
execution:

```sh
calliope migration review-baseline --plan baseline.json --json
calliope migration verify-baseline --repository REPOSITORY --plan baseline.json --approve REVIEW_DIGEST --json
calliope migration review-baseline-evidence --plan baseline.json --report baseline-report.json --json
```

A baseline must pass the original cases and detect the declared negative control
before implementation. The built-in comparator also checks its own adversarial
cases. Keep baseline failures, verifier failures and environment failures separate.
Neither a failed baseline nor an ineffective negative control permits migration.

After a separately reviewed pilot implementation, create and approve a full
verification plan containing the candidate's immutable pin:

```sh
calliope migration review-verification --plan verification.json --json
calliope migration verify --repository REPOSITORY --plan verification.json --approve REVIEW_DIGEST --json
calliope migration review-evidence --plan verification.json --report verification-report.json --json
```

Use a `calliope.migration.assessment-request/v1` to bind the inventory, source and
rule pins, target/runtime, declared unit dependencies, explicit exclusions,
representative pilot plans/reports and independently evidenced measurements.
Every selected source file must be assigned or excluded with a reason. Preserve
package cycles and unsupported dependency declarations as findings.

```sh
calliope migration review-assessment --request assessment.json --json
calliope migration assess --repository REPOSITORY --request assessment.json --json
```

The standalone assessment can report `investigate` or `do-not-migrate` and does
not approve dispatch. A trusted host uses `assessMigration` with its installed
kit/verifier hashes and independent evidence-review callback before a `go`
recommendation is possible. Cost and time ranges are pilot extrapolations, not
confidence intervals or new execution allowances.

## Execute under the native owner

Translate the reviewed work manifest into a native Calliope plan. The native
coordinator owns review, admission, scheduling, workers, cancellations, attempts
and the original allowance. Use dependency-first ordering and retain task/unit
IDs with their source, rule, configuration and implementation binding digests.
The kit does not supply a second scheduler or allow a worker to mint a root budget.

The host must constrain tools and file paths and bind each worker's budget and
absolute deadline before dispatch. Verification library callers use the existing
`VerificationOptions` approval and command-reservation callbacks plus the
inherited deadline; CLI users
approve the exact verification digest for one invocation. A JSON report, model
instruction or claimed review receipt is never authority to execute.

A collected task patch may become an explicitly reviewed, unverified source
candidate through the native source-candidate API. Creating a candidate is not
verification, merge, publication or permission to modify the original checkout.
Re-run the full verification contract against the candidate's exact commit.

## Rule changes, invalidation and replay

Record recurring failures as proposed rule changes with their failing unit,
source/candidate/rule pins, observation/report digests, hypothesis, risk and
rollback reference. Use the native bounded improvement review contract for the
execution strategy. A strategy proposal or rollback does not edit the rulebook;
source changes need their own reviewed candidate and independent approval.

After an approved source, rule, configuration, case or runtime change, generate a
new inventory and assessment. Compare the new manifest's per-unit binding
against the recorded binding before reusing a result. Version 1 includes the full
assessment context in each binding, so a changed context conservatively
invalidates every unit and its dependants. Re-run the baseline and pilot/full
verification under the new exact pins, preserving old reports for audit. Do not
rewrite a saved report or attach it to a new digest.

Use `calliope improve capabilities --json` before exposing improvement controls.
Only advertised bounded strategy operations are available. A reviewed rule update
or successful migration is not reinforcement learning; cross-run learned policies
and model-weight training are not provided by this kit.

## Evidence and distribution

Retain the inventory, reviewed plan/request digests, rulebook, work manifest,
baseline and candidate reports, command/cleanup receipts, source candidate,
accounting measurements and independent review reference. An example complete
verification and adversarial qualification can be generated by
`scripts/qualification/migration-baseline.mjs` from the source repository; its
arguments require an empty owned directory and an exact local image/runtime.
The packaged [example plan](migration-example-plan.json) and
[completed report](migration-example-report.json) are a snapshot from an actual
disposable local run. Its source commit IDs refer to that synthetic repository;
this example is not evidence for a user project. Review the pair without executing
code using `migration review-evidence --plan docs/migration-example-plan.json
--report docs/migration-example-report.json --json` (on one shell line).

The qualification checks unsupported adapters, stale source and rule pins, a
broken baseline, an ineffective negative control, a regressing candidate,
distinct baseline/candidate approvals and actual container cleanup.

Schemas and deterministic helpers ship in `dist/migration`. The example is
available offline through `migration example --json`; a host can consume the same
structured artifacts through `dist/migration/index.js` without Cy. Match the
package source and exact kit/verifier hashes to the reviewed artifact. Keep
replay evidence separate from current execution authority.

Reference evaluated: Anthropic's code-migration kit at
[`cf91c9d5068d9aaf95a36164169f08c3e636c909`](https://github.com/anthropics/code-migration-kit-with-claude-code/tree/cf91c9d5068d9aaf95a36164169f08c3e636c909),
licensed Apache-2.0 and described by its authors as unmaintained reference code.
No upstream script, prompt or template is copied into this implementation, and
no upstream code is executed by this playbook. Future reuse requires a separate
code audit, tests and retention of its required license/notices.
