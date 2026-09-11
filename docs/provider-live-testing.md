# Live provider testing — September 11, 2026 UTC

The authorized $500 test budget produced **36 successful captures across nine
adapter paths**, using 47 bounded requests. Every captured response replays offline
through Calliope's actual adapter and installed SDK. This establishes the tested
text/tool behavior, not broad model quality or market leadership.

| Adapter | Model / endpoint | Text JSON / stream | Tool JSON / stream |
|---|---|---|---|
| Anthropic | `claude-haiku-4-5-20251001` | Pass / pass | Pass / pass |
| Together | `meta-llama/Llama-3.3-70B-Instruct-Turbo` | Pass / pass | Pass / pass |
| Mistral | `ministral-3b-2512` | Pass / pass | Pass / pass |
| Hugging Face | `meta-llama/Llama-3.3-70B-Instruct`; Novita routing except tool JSON through Together | Pass / pass | Pass / pass |
| Bedrock native | `amazon.nova-micro-v1:0`, `us-east-1` | Pass / pass | Pass / pass |
| Ollama native | `devstral:latest`, Ollama 0.33.2 | Pass / pass | Pass / pass |
| LiteLLM | LiteLLM 1.100.1 → Together, model above | Pass / pass | Pass / pass |
| Bedrock compatibility | LiteLLM 1.100.1 → Bedrock Nova Micro, model/region above | Pass / pass | Pass / pass |
| Generic OpenAI compatibility | Ollama 0.33.2 `/v1` → `devstral:latest` | Pass / pass | Pass / pass |

Models were selected from live model APIs; Hugging Face's model metadata supplied
its provider routes and prices. The local gateway exposed explicit aliases through
its models endpoint. These are historical test selections, not a runtime catalog.
Gateway captures identify their actual upstreams in provenance and count only
toward the gateway adapter invoked. The temporary gateway bound to loopback,
disabled retries, and was stopped after testing. Existing Ollama configuration was
preserved. No returned tools executed and no project context was sent.

## Findings applied

- Hugging Face discovery and inference now use its documented
  [router endpoint](https://huggingface.co/docs/inference-providers/tasks/chat-completion).
  The previous adapter used `api-inference.huggingface.co`.
- The recorder tells the SDK not to retry an error response, preserving the first
  quota/status error. Previously, SDK retries hit the recorder's one-request guard
  and obscured the original error as a connection failure. The guard still refuses
  additional requests; the local SDK control header is excluded from wire evidence.
- Live compatibility streams confirmed that usage can be absent. Two LiteLLM,
  two Bedrock compatibility and two local generic compatibility captures retain
  `usage: null`; Calliope reports that accounting is incomplete.
- Three Hugging Face/Novita JSON requests returned server-overload HTTP 429. A later
  text request passed; the tool JSON probe passed through the independently listed
  Together route. Failed requests are retained in the spend audit, not counted as
  passing evidence.

## Outstanding release evidence

The release gate still requires all 64 combinations. **28 remain missing:**

| Adapter | Observed blocker | Required follow-up |
|---|---|---|
| OpenAI Chat and Responses | Models listed successfully; inference returned `credit_balance_exhausted`, including an error in an HTTP 200 SSE stream. | Fund the configured account or configure a funded API key, then capture eight combinations. |
| Google | Models endpoint returned HTTP 400: invalid API key. The project env file contains the same key. | Configure a valid Google key and capture four combinations. |
| OpenRouter, Groq, Fireworks | No credentials configured. | Configure each provider locally and capture four combinations each. |
| AI21 legacy Studio | Models endpoint returned HTTP 410 with a retirement notice. | Migrate or explicitly retire this adapter before release; a replacement gateway must get its own evidence. |

AI21's [official retirement notice](https://docs.ai21.com/august-deprecation-notice)
names August 9, 2026 as the sunset date for Jamba, Maestro and file-library APIs.
Existing synthetic tests cannot make that endpoint available. No gateway traffic
was relabeled as direct OpenAI, Google, OpenRouter, Groq, Fireworks or AI21 evidence.

## Spend audit

The [machine-readable ledger](reports/provider-conformance-2026-09-11.json) records
every attempt, output cap, status, reported usage and rate source. Reported token
usage estimates **$0.002953**. Four paid gateway streams omitted usage, so that figure
is incomplete. A conservative token allowance for **all 47 attempts**, including
failures, is **$0.083637** using 5,000 input tokens plus each request's output cap.
These are estimates, not reconciled invoices; local compute costs are excluded.

The runner persisted a $1 reservation before each sequential request and retained
reservations for failures. It used $47 of the $500 authorization as a guardrail,
not as billed spend. Every request had a 30-second deadline and at most 512 output
tokens; all successful probes used a 128-token cap. No automatic retry could issue
another request. Testing stopped after accessible combinations passed.

Use `npm run test:conformance` to replay the corpus without network access, and
`npm run test:conformance:release` to show the remaining release blockers.
