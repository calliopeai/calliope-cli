# Brain maintenance proposals

Calliope can bind an adopted [Project Brain](https://github.com/ConflictHQ/project-brain)
instance's maintenance primitives for independent review
([project-brain#292](https://github.com/ConflictHQ/project-brain/issues/292)).
This is distinct from Calliope's own local [project brain](project-brain.md) and
[graph interchange](brain-interchange.md): those are Calliope's private knowledge
store and its portable KG format. `brain-proposals` targets an external, adopted
Project Brain instance directly, by its own `--root`.

```sh
calliope brain-proposals maintenance-report --root <project-brain-path> \
  --host-config _internal/context-host.json --actor operator@example.test \
  --request _internal/context-request.json [--max-findings N] [--max-bytes N] \
  [--now <iso>] [--output <path>]

calliope brain-proposals summary-plan --root <project-brain-path> \
  --host-config _internal/context-host.json --input _internal/amendment.json \
  [--now <iso>] [--output <path>]
```

## What this binds to

Every Project Brain instance vendors two stable, externally-invocable CLI
primitives: `scripts/inspect-maintenance.py` (semantic maintenance findings,
`maintenance-proposals/v1`) and `scripts/maintain-summary.py` (maintained-summary
amendment previews). See that project's `template/docs/primitives/
semantic-maintenance.md` and `maintained-summaries.md` for the full contract
and `schemas/maintenance-proposals.schema.json` for the report shape. This
module never reimplements that logic: it locates the two scripts under the
given `--root`, invokes them as subprocesses, and relays their JSON output
unchanged for independent review.

## Identity and review, never authority

- `--actor` (`maintenance-report`) is a required, explicit CLI argument — a
  trusted local operator identity, exactly like the upstream primitive itself
  requires. It is never read from the request or candidate content.
- `summary-plan` takes no actor argument at all; the target instance resolves
  reviewer/generator identity from its own adopted authority, keyed to the
  real host process, matching the upstream contract.
- Before either script runs, the `--request` (`maintenance-report`) or
  `--input` and its nested `candidate` (`summary-plan`) content is refused
  outright if it carries `actor`, `grants`, `grant`, `principal`, `reviewer`,
  `reviewedBy` or `review` — a model-authored draft is data this binding
  reads, never a source of identity or review status.
- Neither action ever passes `--propose`. There is no persist/commit path:
  every result is a read-only preview presented for independent review.

## Output

Output is always the one-line headless JSON envelope
(`{"version":1,"type":"brain-proposals","action":...}`), with an `--output` file
path under `data` when given (matching the upstream `--output` contract: a new
private file, never overwritten) or the parsed report/preview under `data`
otherwise. Errors
use `{"error":{"code","message"}}`; exit codes follow the same scheme as
`calliope brain`: `0` success, `2` malformed input, `3` policy denial
(a refused forwarded identity/grant), `130` cancellation, `1` unavailable
(missing interpreter, missing `--root` primitives, or a non-zero exit from the
target instance).

## Testing

`npx vitest run tests/brain-proposals.test.ts` covers the identity-refusal guard
(no fixture needed), a real subprocess success path per action against a
stand-in script, `--output` handling, and the error/cancellation paths. The
target instance's own core conformance proof — which runs this binding's real
output through its actual validators — lives in that repository, not here.
