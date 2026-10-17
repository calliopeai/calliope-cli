# Migration behavior verification

The `javascript-to-typescript-cli/v1` adapter compares self-contained JavaScript
`.mjs` and TypeScript `.mts` command-line programs through their public interface:
one argument, stdout bytes, stderr bytes and exit status. It runs the original,
a known regression and the candidate in the existing native isolated-command
backend. No model, new scheduler or repository-wide translation is involved.

```sh
calliope migration example --json
calliope migration verification-schema --json
calliope migration review-verification --plan verification.json --json
calliope migration verify --repository /path/to/repository --plan verification.json --approve REVIEW_DIGEST --json
```

`example` emits files and cases as JSON without installing, writing or executing
them. The example sums an array of safe integers, including empty, negative and
invalid inputs; its known-bad target adds an extra one per input. Its wrong result
has the same byte length as the correct result. To use it, save its four
files in a disposable repository and commit them. Create a plan from the emitted
cases, negative control and limits, with these additional fields:

- `format`: `calliope.migration.verification-plan/v1`.
- `adapter` and `verifier`: the example's `javascript-to-typescript-cli/v1` and
  `byte-parity-v1` identities.
- `runtime`: an already present Linux Docker image's full `sha256:...` ID and
  exact Node version (`v24.x.y`). The runtime probe verifies the actual version;
  the helper never pulls an image.
- `source`, `candidate`, `negative`, `rules`: each has `revision` (full commit ID),
  `path` (repository-relative file) and `object` (the exact Git blob ID). Use
  `migration inventory` to obtain those identities. Different roles may use
  different commits in the same repository. Each file must be regular UTF-8 and
  at most 64 KiB; source is `.mjs`, candidate/negative are `.mts`.

Review the full plan before passing its returned digest to `verify`. Changing a
case, rule pin, program pin, runtime or limit changes that digest. A mismatched
approval does not execute code. The schema is a transport contract; native
validation additionally checks byte bounds, related fields and Git object pins.

## Evidence and outcomes

Before reading program contents, the host approves the exact plan and read pins.
Verification then reads immutable Git blobs, checks their identities and creates
private temporary snapshots. Dirty and untracked checkout files are preserved.
The selected image sees only the current role's snapshot, read-only, with no host
credentials, network or writable host mount. Existing CPU/memory/process/output
limits and container-cleanup receipts apply. No package installation occurs.

The comparator's adversarial self-test runs first. Execution checks the runtime,
every baseline case, then the pinned negative-control case. The negative control
must both reproduce its declared wrong behavior and differ from the baseline.
Only then does it execute candidate cases. Stdout/stderr hashes are computed on
raw captured bytes before display redaction; truncated or legacy receipts without
those hashes cannot pass. Reports omit display output, retaining hashes, byte
counts, exit status, commands and native cleanup evidence.

| Outcome | Meaning |
| --- | --- |
| `passed` | All declared cases passed after baseline and negative-control checks. |
| `input-failure` | A program/rule pin or snapshot is stale, oversized or unsupported. |
| `baseline-failure` | The original does not satisfy the proposed contract. |
| `verifier-failure` | Comparator or known-regression validation failed. |
| `regression` | The candidate differs on a declared case. |
| `environment-failure` | Runtime, observation, deadline, host allowance or cleanup prevented complete evidence. |
| `cancelled` | The caller cancelled; retained observations are not a pass. |

Reports bind the plan digest, exact source/candidate/negative/rule pins, runtime,
verifier version and observations. Their own digest covers the canonical body
excluding `digest`. A passing report applies only to those commits and cases. It
does not imply that a newer branch tip passed. Replan changed inputs and obtain
independent review of changes to success criteria; this helper does not supply
that review authority or automatically invalidate a larger workflow's units.

## Host policy and limits

Library hosts use `analyzeVerificationPlan` and `verifyMigration`. The mandatory
`approve` callback receives the plan digest, canonical repository, exact read pins, image,
command count and time limit. Intersect these with existing task grants before
approving. `deadline` can shorten the execution allowance; `reserveCommand` can
charge or deny each command through the host's existing ledger. These callbacks
are trusted host code, never fields accepted from agent-authored JSON.

There are 1–8 cases, at most 18 verification commands, 100–10,000ms per command and
at most 300,000ms after approval. Read-only Git inspection shares that deadline.
Cleanup may take the shared runner's additional bounded cleanup
time. A missing or unconfirmed execution receipt retains the exact temporary
workspace for inspection; the report identifies it. Confirmed cleanup allows
removal of the disposable snapshots. Existing repository files are not deleted.

The CLI's explicit approval applies to one verification invocation. It does not
create a reusable permission grant or replenish an existing hosted allowance.
Hosted callers must carry their parent deadline and command reservations forward.

## Current support boundary

This is one small language-pair adapter and verification phase of #414. It does
not prove general program equivalence, type-check TypeScript, install dependencies,
verify imported project modules, dispatch migration workers or approve rollout.
Application/framework adapters, source dependency analysis, rule-update review,
unit invalidation, headless tool discovery and Cykick/Astrolift workflow integration
remain separate work. Keep generated, reviewed and verified states distinct.
