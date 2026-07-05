# Performance budgets

Calliope's M2 exit bar is codified as measurable budgets enforced in CI, so
performance cannot silently regress (issue #186). Three benches live in `bench/`,
each with a hard budget. `npm run bench` runs all three, prints a summary table,
and exits non-zero if any budget is breached — the same gate CI runs on every PR.

## Budgets vs. baseline

Baselines below were measured on **Darwin arm64, Apple M2 Max, node v22.21.1**.
Numbers on your machine (and on CI) will differ; the budgets carry headroom for
that. "CI budget" is the effective gate when `CALLIOPE_BENCH_CI=1` (see
[CI multiplier](#ci-multiplier)).

| Bench | Gated metric | Budget | CI budget | Baseline (this machine) |
|-------|--------------|--------|-----------|-------------------------|
| Cold start | `--help` spawn→exit median | ≤ 200 ms | ≤ 400 ms | ~91 ms (p95 ~105 ms) |
| Keystroke-to-paint | stdin.write→painted-frame p95 | ≤ 16 ms | ≤ 32 ms | ~2.5 ms (median ~0.8 ms) |
| Memory flatness | post-GC heap slope, final 300 msgs | ≤ 40 KB/msg | ≤ 40 KB/msg | ~23.6 KB/msg |
| Memory flatness | absolute post-GC growth (500 msgs) | < 40 MB | < 40 MB | ~14.2 MB |

The cold-start budget is **interim, for the node runtime** (`node dist/bin.js`).
**#187** ships the compiled single binary and takes over this budget, tightening
it to **150 ms** and switching the gated artifact from `node dist/bin.js` to the
compiled binary.

## Running

```bash
npm run bench        # build, then all three benches + summary table (the CI gate)
npm run bench:cold   # build, then cold-start only
npm run bench:ui     # keystroke-to-paint only (vitest)
npm run bench:mem    # memory flatness only (vitest, sets --expose-gc)
```

Run it twice to confirm stability — the benches are deterministic (seeded content,
fixed sample counts) and the baselines above reproduce within noise.

## The benches

### 1. Cold start — `bench/cold-start.mjs`

Spawns the built CLI 10× per command and measures spawn→first-stdout-byte and
spawn→process-exit, reporting min/median/p95.

**Gated commands are network-free:**

- `--help` — prints and exits with no I/O beyond stdout. Fully deterministic;
  the **primary** gated metric (both first-byte and exit).
- `--config` — reads the on-disk config store, then exits. Gated on exit.
- `--version` — prints the version string *before* the npm update-check, so its
  **first byte** is a clean module-load proxy and is gated. Its **exit** includes
  a one-time network update-check (cached 24 h afterwards), so exit is reported
  but **not** gated.

**Headless is not a keyless cold-start metric.** `node dist/bin.js --headless
"noop"` with no API keys falls into interactive setup and exits non-zero after
~0.5 s (no stdout — the setup prompt goes to stderr). It cannot run keyless
without either a provider network call or a TTY, so `--help` is the honest
module-load proxy. The bench probes headless once and prints the finding, but
does not gate on it.

### 2. Keystroke-to-paint — `bench/keystroke.bench.test.ts`

Mounts the **real** decomposed `TerminalChat` tree (heavy I/O modules mocked,
reusing the mock surface from `tests/ui-render-isolation.test.ts`), writes single
characters to stdin, and measures the time until the frame echoes the character
in the input line. It collects ≥100 samples after a 10-sample warmup and gates
the p95.

**What the number means.** `ink-testing-library` renders with `debug: true`,
which disables Ink's production render throttle (`unthrottled = options.debug`).
So this measures the **unthrottled per-keystroke render-compute cost** — input
parse + React re-render + Yoga layout + paint — which is exactly the work the
16 ms (one 60 fps frame) budget targets. Production additionally caps output at
~30 fps on the leading edge, so an isolated keystroke still paints immediately;
this harness isolates the compute, not the frame cap.

The ~12× headroom over the 16 ms budget is expected: the #184 region
decomposition makes a keystroke re-render only the input region, so the per-key
cost is sub-millisecond. The 16 ms ceiling is the product requirement; a
regression that re-coupled the transcript to keystrokes would blow through it.

### 3. Memory flatness — `bench/memory.bench.test.ts`

Simulates a ~4 h / 500-message session through the **real** pieces that
accumulate state: the transcript state hook, the Static scrollback (Ink
`<Static>`), and the streaming flusher (`createStreamFlusher`). It appends 500
messages with realistic 1–5 KB bodies (types cycling user/assistant/tool),
produces every 10th message via a real 200-token streaming burst (50 bursts),
and samples post-GC `heapUsed` every 50 messages.

**Why the slope is ~23 KB/msg, not ~3 KB.** Heap growth is dominated by
**intended** scrollback retention, not a leak:

- Ink keeps `fullStaticOutput` — the rendered ANSI of every emitted `<Static>`
  item — for the app's lifetime, so it can redraw on terminal resize/clear. A
  3 KB markdown body renders to a multi-line ANSI box many times larger.
- The message bodies themselves are held in transcript state.

Both are linear and bounded per message. The budget is therefore set from the
**measured** slope (~23.6 KB/msg, very stable) × 1.5, rounded up to a clean
**40 KB/msg**. That trips on a real leak — something that grows the heap *faster*
than the scrollback it renders (runaway streaming buffers, accumulating
listeners, undo-stack growth, or a Static regression that stops unmounting old
items) — while tolerating the expected retention. The absolute-growth cap
(< 40 MB over 500 messages) is the gross-leak backstop.

**Harness note.** This bench renders via Ink's own `render()` with a
**discarding** stdout. `ink-testing-library` pushes every frame into an unbounded
`frames` array, which would masquerade as a heap leak; a real terminal consumes
writes and drops them, which the sink stdout models.

## CI multiplier

GitHub-hosted runners are slower and noisier than a developer laptop. Setting
`CALLIOPE_BENCH_CI=1` doubles the **time** budgets (cold start, keystroke) so the
gate catches genuine regressions (a 2×+ slowdown) rather than tripping on runner
jitter. **Memory** budgets are **not** scaled: allocation is deterministic and
the heap slope is content-driven (machine-independent), so a memory regression
shows up identically everywhere.

The CI workflow (`.github/workflows/ci.yml`) sets `CALLIOPE_BENCH_CI=1` on the
`bench` job, which runs after `build` on `ubuntu-latest`.

All budgets and the multiplier live in one place: `bench/budgets.mjs`.
