# Test selection

Which test files a change reaches, from measured coverage rather than imports. An
import graph selects almost everything here: hub modules such as `src/config.ts` are
loaded by most test files, so "imports the changed file" says little. Executed lines
say which tests actually run the changed code.

Today this is **report only**. Pull requests and the factory still run the whole
suite; the selection and its report sit beside it until they have earned trust (see
[the plan](#the-plan)).

```bash
npm run coverage:map                     # build coverage-map.json from one suite run
npm run test:affected                    # run what a change against origin/main reaches
npm run test:affected -- --maxWorkers=2  # flags after -- go to vitest
node scripts/coverage-map.mjs select --base origin/main            # print the selection only
node scripts/coverage-map.mjs select --base origin/main --report   # and measure uncovered lines
```

## How it works

**The map.** `scripts/coverage-map.mjs build` runs the suite once under a custom
vitest coverage provider (`scripts/coverage-map-provider.mjs`). Vitest already takes V8
coverage once per test file: with `isolate` (the default) each file starts from fresh
modules, and each take resets the counters. The stock provider merges those chunks
into one report; this one keeps them apart. So the build costs about one ordinary
suite run, and `coverage-map.json` records, for every test file, the `src/` files and
line ranges it executed, import-time code included. It also records the commit, the
vitest version, the build time, the executable lines of every source file, the test
files that failed during the build, and the ones it cannot place (below).

**Lines.** A source line is *executable* when the TypeScript transform emits code for
it; comments, blank lines, interfaces and type-only imports emit none. A test file
*executed* the line when any of that code ran in its chunk: the innermost V8 range
around it has a non-zero count. A line counts as executed when any of its code ran,
so a one-line `if (x) return;` whose `return` never ran still counts. Selection and
the uncovered-lines report use this one definition.

**Select.** `select --base <ref>` diffs the working tree against the merge base of
`<ref>` and `HEAD`. In a clean checkout that is `git diff <ref>...HEAD`; locally,
uncommitted and untracked files count too, because they are what the tests will run.
Then:

| Change | Test files selected |
| --- | --- |
| Source lines the map holds | Those that executed the touched lines. A pure insertion, or a hunk of only comments, blank lines and types, uses the nearest executable line above and below it. |
| A source file changed on the base branch since the map | Its lines are translated back to the map's commit; a touched line with no counterpart there selects every test file that ran the file. |
| A deleted source file | Every test file that ran it, and the change is unmapped (below). |
| A test file, or a snapshot under `tests/**/__snapshots__/` | That test file. |
| A source file a test names by its `.ts` path | That test file: it reads the file as text (imports use `.js`). |

Every selection also keeps an **always** tier: test files absent from the map, edited
on the base branch since it was built, failed while it was built, or that the map
cannot place (they execute no line that at most half of the suite does not also run).
The last group is the tests that read code instead of running it, or run it in a
subprocess: release and workflow checks, script tests, and `tests/version-json.test.ts`,
which compiles `src/` and runs the CLI. No line change could select them.

## Run-everything rules

The selection is replaced by the whole suite, and the output says why, when:

| Rule | Why |
| --- | --- |
| There is no map, or it is not a map | Nothing to select from. |
| The map is older than 72 hours (`--max-age-hours`) | Nightly builds keep it fresh; an old one has drifted. |
| The map was built from uncommitted changes | Its lines belong to no commit. |
| The map was built with another vitest version | Coverage was measured by a different runner. |
| The map's commit is not an ancestor of the merge base, or not in the clone | Its lines cannot be translated to the change. |
| A changed file is **unmapped** | The map measures only `src/`. Tooling (`package.json`, the lockfile, `.npmrc`, vitest and TypeScript config, `tests/setup/`, the selector itself) changes how every test runs. Everything else outside `src/` (docs, `scripts/`, CI files, test helpers and fixtures, build scripts) may be read by a test the map cannot see. A new source file, a deleted one, a binary one, or one no test executed is not in the map. |
| The selection is over 70% of the suite | Selecting saves little, so run everything. |

`--run` executes `vitest run <selected files>` (or plain `vitest run`) with the flags
you pass and exits with its status; an empty selection runs nothing and exits 0.

### Jev (optional)

`select --jev` with `TYPESAFE_API_KEY` set asks Typesafe's Jev about unmapped changes,
when they are the only reason to run everything. It is one System One request
(`POST https://api.typesafe.ai/v1/systemone`, model `jev-1.14.0`; `TYPESAFE_BASE_URL`
points it elsewhere) with a `choice` question over `run_all` and `run_selection`. The
state is the unmapped paths, their change kind and line counts, the test files that
name each path, and the selection's size; file contents are never sent. A
`run_selection` at confidence 0.8 or more runs the selection plus the test files that
name the paths. Anything else keeps the whole suite: no key, an error, a timeout
(15 s), an unexpected answer, low confidence, or `run_all`. Tooling changes are never
sent. Jev can only turn "run everything" back into the selection: it never removes a
test the map picked, and the 70% rule still applies afterwards.

## Reading the report

`select` prints Markdown (`--json` prints the same as data); vitest's own output goes
to stderr. In order:

- **Runs N of M test files**, or **Runs all M test files** with the reasons.
- **Map**: its commit, build time, age and vitest version, and the merge base.
- **Unmapped**: each change the map cannot judge, with its status, line counts and why.
- **Jev**: whether it was asked and what it chose.
- **Selected test files**, each with the first reason it was picked (`executes
  src/x.ts:12-14`, `changed`, `not in the map`, `the map cannot place it`). When
  everything runs, the list is what the map alone would have picked.
- **Uncovered changed lines** (`--report` only): the changed executable `src/` lines
  that no measured test executed, per file. `--report` measures them by running the
  selection (or everything) under the same coverage capture, so new lines count.
  Files the coverage floor in `vitest.config.ts` leaves out (the Ink UI and pure type
  files) are marked "outside the coverage floor". This is the signal for a future
  coverage gate; nothing fails on it yet.

## CI

`.github/workflows/test-selection.yml`:

- **`coverage map`** runs nightly and on demand, builds the map on `main`, and uploads
  it as the `coverage-map` artifact for 14 days. A failing test still leaves a map.
- **`test selection (report)`** runs on pull requests with `continue-on-error`. It
  downloads the newest map built on `main`, runs `select --report --jev` against the
  pull request's base, and writes the result to the job summary.

The required `build` job in `ci.yml` is unchanged and still runs the whole suite.

## The plan

1. **Validate.** For about a week, compare each pull request's report with its full
   run: every test file that failed in the full suite should be in the selection.
   Record misses and how often a rule forced the whole suite.
2. **Select.** Then let pull-request CI and the factory's `qa` check run
   `npm run test:affected` instead of the whole suite, while `main` and the nightly
   map keep running everything.
3. **Gate.** Then fail a pull request on uncovered changed lines inside the coverage
   floor.

## Limits

- Only in-process execution is measured. Code a test runs in a child process (the
  compiled CLI, `scripts/`) is invisible; such tests land in the always tier when
  they execute nothing else.
- The map is up to a day old. Lines are translated across the base branch's changes,
  but a test that started reaching a file through code changed since the map is
  missed until the next build.
- A test that reads a source file through a computed path, rather than naming it, is
  not found by the text rule.
