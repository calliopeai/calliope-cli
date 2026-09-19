# Typed judgments

Small units of semantic judgment that code can threshold, weight and compose.
One request evaluates a **state** (text or JSON) against a map of typed
**questions** and returns one probabilistic **answer** per question. Code owns
the workflow; the model supplies the bounded judgment where ordinary code needs
semantic understanding.

The request and answer contract follows the System One programming model
(TypeSafe's Jev), so cookbooks written for it apply unchanged. Two engines serve
the same contract:

- **Prompted:** any configured chat backend, including Ollama and self-hosted
  OpenAI-compatible servers. Runs air-gapped.
- **Native (`typesafe`):** TypeSafe's `POST /v1/systemone` endpoint, whose
  models are trained to return calibrated distributions.

- [Primitives](#primitives)
- [Request and answers](#request-and-answers)
- [Command line](#command-line)
- [Library](#library)
- [Engines and calibration](#engines-and-calibration)
- [Composing judgments](#composing-judgments)
- [Policy engine](#policy-engine)
- [Exit codes](#exit-codes)

---

## Primitives

| Need | Type | Answer |
| --- | --- | --- |
| Whether a condition holds | `noul` | `noul`: probability of yes, 0 to 1 |
| One option from a defined set | `choice` | `choice`, `probabilities` over options, `confidence` |
| Degree along ordered levels | `score` | `score` (probability-weighted level index), `legend`, `probabilities`, `confidence` |

Ask one narrow judgment per question. Split independently useful dimensions
into separate questions and combine them in code; when priorities change, change
a coefficient rather than a prompt. Include a no-match option when nothing may
fit. A `noul` near 0.5 means yes and no are similarly likely, not medium
intensity.

`confidence` on choice and score answers is how far the leading outcome sits
above chance: `(max - 1/n) / (1 - 1/n)`, 1 when one outcome holds all the mass
and 0 when the distribution is flat. The full `probabilities` are always
returned so you can substitute your own statistic.

## Request and answers

```json
{
  "state": "Help! My payouts have been failing for 3 days.",
  "questions": {
    "is_urgent":   { "type": "noul",   "instructions": "Does this convey urgency?",
                     "criteria": { "true": "Explicitly time-sensitive", "false": "No urgency expressed" } },
    "department":  { "type": "choice", "instructions": "Which team should handle this?",
                     "criteria": { "billing": "Payments, invoicing, refunds", "technical": "Bugs, outages", "sales": null } },
    "frustration": { "type": "score",  "instructions": "How frustrated is the customer?",
                     "criteria": ["Calm", "Frustrated", "Very angry"] }
  }
}
```

- `state` is a string, object or array. Prefer named JSON fields when the
  context has several parts, and reference them in instructions with backticked
  paths such as `` `ticket.messages[0].text` ``.
- `instructions` is a string, or an object or array when definitions, contrasts
  or examples sharpen the question.
- `criteria` describes the possible answers: optional `true`/`false` glosses for
  noul, a map of option to rubric (or `null`) for choice, and an ordered array of
  at least two level descriptions for score.
- Question ids are for your code. They are never sent to the model.

Answers come back under the same ids:

```json
{
  "provider": "typesafe", "model": "jev-1.13.0",
  "answers": {
    "is_urgent":   { "type": "noul", "noul": 0.98 },
    "department":  { "type": "choice", "choice": "billing",
                     "probabilities": { "billing": 0.89, "technical": 0.11, "sales": 0 }, "confidence": 0.83 },
    "frustration": { "type": "score", "score": 1.2, "legend": { "0": "Calm", "1": "Frustrated", "2": "Very angry" },
                     "probabilities": { "0": 0, "1": 0.8, "2": 0.2 }, "confidence": 0.71 }
  },
  "usage": { "input_tokens": 443, "output_tokens": 73 }
}
```

## Command line

```bash
calliope judge --request ticket.json                       # project/global provider
calliope judge --request ticket.json --provider ollama --model qwen3.8:latest
calliope judge --request ticket.json --provider typesafe   # native engine
cat ticket.json | calliope judge --request - --json        # stdin, JSON contract
calliope judge --questions q.json --state "Help! My payouts have been failing."
calliope judge --questions q.json --state-file ticket.json # .json files are parsed as state
```

`--provider` and `--model` follow the same precedence as every other command
(turn, environment `CALLIOPE_PROVIDER`/`CALLIOPE_MODEL`, project defaults,
global defaults). `--provider typesafe` selects the native engine; it reads
`TYPESAFE_API_KEY` (or a stored `typesafe` credential) and `TYPESAFE_BASE_URL`
for a proxy. Its default model is the `jev-latest` alias; pin a versioned id
with `--model` when thresholds are tuned against a release.

Without `--json` the output is one line per answer; with it, the response above
plus `"version": 1, "type": "judgment"`, and failures as
`{ "version": 1, "type": "judgment", "error": "<code>", "message": "..." }`.

## Library

```ts
import { judge } from '@calliopelabs/cli';

const { answers } = await judge(request, { provider: 'ollama', model: 'qwen3.8:latest' });
if (answers.is_urgent.type === 'noul' && answers.is_urgent.noul > 0.8) escalate();
```

`judge(request, { provider?, model?, signal? })` validates the request, throws
`JudgmentError` with `code` `invalid-request`, `model-output` or `unavailable`,
and otherwise returns the response above. `validateJudgmentRequest` runs the
validation alone.

## Engines and calibration

The prompted engine sends the state and all questions in one request, asks the
backend for a probability over each question's outcomes, then normalizes the
distributions and derives the typed answers. Ollama receives a grammar schema
so its output is structurally constrained; other backends are prompted for
strict JSON and anything outside one JSON object is rejected as `model-output`.

Two differences from the native engine are worth designing around:

- **Calibration.** Jev is trained to return calibrated probabilities. A general
  chat model self-reports a distribution; the ranking is usually right, the
  spread is not a measured probability. Validate thresholds on your own data
  per model before acting automatically, and read `confidence` as relative,
  not as a permission to act.
- **Isolation.** Jev evaluates every question independently against the same
  state. The prompted engine batches them into one prompt, so a question can
  in principle color its neighbours. Keep batches to questions that share a
  premise, and split unrelated fan-outs into separate requests.

The native engine retries `429` and `529` with `retry-after` or exponential
backoff, up to four attempts. It reports the versioned model that answered.

## Composing judgments

- **Route and fill.** A choice selects a handler; speculative questions fill its
  arguments up front; code reads only the branch it took.
- **Select instead of generate.** Enumerate candidate values in code, ask a
  choice to pick one, then copy or normalize it. The model cannot choose a value
  you did not list.
- **Verify and escalate.** Gate consequential actions on confidence per action:
  a read-only step may proceed at 0.6 where a destructive one waits for a
  person below 0.9.
- **Keep raw judgments reusable.** Store the distributions; weights, thresholds
  and views can change without re-running inference.

## Policy engine

Judgments can drive the pre-tool [policy hook](./governance.md#policy-hook),
deciding whether a tool runs. This is an extra mechanism and never a default:
nothing is judged until an operator sets one of the two settings below, and a
judgment can only ever withhold a tool.

**Built in** (`policy.judgment`), evaluated in process:

```bash
calliope /config set policy.judgment /etc/calliope/policy-rules.json
calliope /config set policy.judgmentProvider typesafe   # optional, else normal resolution
calliope /config set policy.judgmentModel jev-1.13.0    # optional
calliope /config set policy.judgment off                # disable
```

**External** (`policy.command`), spawned per tool call, for composing with other
checks or running the engine somewhere else:

```bash
calliope /config set policy.command /usr/local/bin/calliope-policy
```

```bash
#!/usr/bin/env bash
# /usr/local/bin/calliope-policy
exec calliope judge --policy /etc/calliope/policy-rules.json --provider typesafe
```

Both read the same rules file and decide identically. Setting both is an
ambiguous security control, so it denies rather than silently picking one.

A rules file declares the questions and the conditions that deny:

```json
{
  "questions": {
    "destructive": { "type": "noul", "instructions": "Would running `arguments.command` irreversibly destroy data the user did not intend to lose? Deleting build output, caches or git-ignored artifacts is NOT irreversible loss.",
                     "criteria": { "true": "It removes source, user data, system files or remote state", "false": "It is read-only, or removes only regenerable artifacts" } },
    "scope":       { "type": "choice", "instructions": "What does `arguments.command` operate on?",
                     "criteria": { "workspace": "Paths inside the project", "system": "Paths outside it", "remote": "A remote or production service", "none": "It modifies nothing" } }
  },
  "deny": [
    { "question": "destructive", "above": 0.6, "reason": "irreversible data loss" },
    { "question": "scope", "is": "system", "minConfidence": 0.5, "reason": "operates outside the project directory" }
  ]
}
```

The state is the tool call itself, so instructions reference its fields by path:
`arguments.command`, `name`, `arguments.path`.

One operator per primitive, and rules are checked against their own questions
when the file loads, so a typo or a mismatched operator fails immediately rather
than at the moment a tool is judged:

| Primitive | Operator | Denies when |
| --- | --- | --- |
| noul | `above` | the probability of yes is strictly greater |
| choice | `is` | that option is selected |
| score | `atLeast` | the weighted level is greater or equal |

`minConfidence` (choice and score) ignores a match the model is not sure about.
Deny wins and the first matching rule supplies the reason; if none match, the
tool is allowed.

Author rules against real tool calls with `--json`, which prints the verdict and
every distribution to stdout:

```bash
echo '{"id":"c1","name":"shell","arguments":{"command":"rm -rf ./build"}}' \
  | calliope judge --policy rules.json --provider typesafe --json
```

This is what a judgment adds over the regex example in
[governance](./governance.md#shell-example), which blocks every `rm -rf`:

| Tool call | Verdict |
| --- | --- |
| `rm -rf ./build` | allow |
| `rm -rf node_modules` | allow |
| `rm -rf /` | deny, irreversible data loss |
| `rm -rf ~/Documents` | deny, irreversible data loss |
| `kubectl delete deployment api --context prod` | deny, operates on remote or production state |

**Latency.** A timeout denies, so the two sources have different defaults:
5000ms for a spawned `policy.command`, and 30000ms for `policy.judgment`, which
waits on a provider rather than a local script. Observed round trips run from
about one second to over six on a hosted backend, which is why the spawn default
would deny healthy calls. Local models are slower again. `policy.timeoutMs`
overrides either, and pinning a fast backend with `policy.judgmentProvider`
matters more than the timeout.

**Cost.** This fires per tool call, so a long session pays a judgment per tool.
Pin the provider and model deliberately rather than inheriting whatever the
session is using.

**This is a gate, not a boundary.** A judgment can withhold a tool; it cannot
contain one that runs. The sandbox remains the boundary, exactly as for the
advisory blocklists in `risk.ts`. Validate a rules file against your own tool
calls before trusting it, and remember every failure denies.

## Exit codes

| Code | Meaning |
| --- | --- |
| 0 | Every question answered |
| 1 | The provider failed, or the model returned unusable output (`model-output`, `unavailable`) |
| 2 | Invalid arguments or request (`invalid-arguments`, `invalid-request`) |
| 130 | Cancelled |

With `--policy` the codes are the hook's instead: 0 allows, 1 denies by rule,
and 2 denies because the engine could not decide (unreadable or invalid rules,
a malformed tool call, a provider or model failure). Every non-zero exit is a
denial, so a broken engine fails closed.
