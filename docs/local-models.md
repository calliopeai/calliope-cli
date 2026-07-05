# Local models

Calliope aims to be the best terminal harness for **self-hosted 7-70B models** —
the ones you run yourself with Ollama, vLLM, LM Studio, llama.cpp, or a local
LiteLLM proxy. Small and mid-size open-weight models are more sensitive than
frontier cloud models to prompt bloat, verbose tool schemas, and the occasional
malformed tool call. Calliope detects a local backend and quietly adapts.

None of this changes cloud behaviour: every adaptation below is gated on backend
detection and is a no-op for Anthropic, OpenAI, Google, Bedrock, and hosted
OpenAI-compatible providers.

## What "local" means here

A backend is treated as local when:

- the provider is **`ollama`** (always local), or
- the provider is **`litellm`** or **`openai-compat`** and its base URL is a
  loopback host — `localhost`, `127.0.0.1`, `0.0.0.0`, `::1`,
  `host.docker.internal`, or a `*.local` hostname (e.g. a box running vLLM).

Hosted proxies (a `litellm` pointed at a remote URL, OpenRouter, Together, …)
are treated as cloud.

## What the harness does for local models

### 1. Simplified tool schemas

The full tool schemas Calliope sends to a model are verbose — long descriptions,
multi-paragraph help, big enum listings. For a local model that all competes with
the actual task for context. When the backend is local, Calliope sends a
**simplified** schema:

- tool and parameter descriptions trimmed to their first sentence,
- enum listings capped,
- (for `edit_file`) an extra optional `anchor_hash` parameter (see below).

This is **lossless for execution**: the real argument validation runs
server-side in the tool layer, so trimming what the model is *shown* can never
break a valid call.

### 2. One-shot malformed-tool-call repair

Small models occasionally emit a tool call that is almost-but-not-quite right: a
misspelled tool name, or a call missing a required parameter (this is also how an
unparseable arguments blob presents — it arrives as `{}`). Instead of surfacing
the error immediately, Calliope spends **one** corrective round-trip:

> Your tool call to "reae_file" was malformed: unknown tool "reae_file"; did you
> mean "read_file"?. Reply with ONLY the corrected tool call, nothing else.

If the model returns a valid call, it executes normally. If the repair is still
malformed, the error surfaces as usual — there is no second repair for the same
call. Each repair is recorded in the iteration ledger.

### 3. Grammar-constrained repair (Ollama)

On the repair round-trip only, and only when the backend is Ollama, Calliope
passes Ollama's `format` parameter — a JSON schema of the tool-call envelope
(`{ name, arguments }`) — to *force* a well-formed reply. Constraining every
turn would break prose, so this applies to the repair turn alone. If the Ollama
build rejects the schema, Calliope silently retries the request without it.

### 4. Hash-anchored edits (stale-view protection)

Long agent loops can drift: a model edits a file based on a copy it read many
turns ago, after the file has changed. For local backends, `read_file` output
ends with a short content hash:

```
[anchor_hash: 1a2b3c4d — pass as anchor_hash to edit_file to confirm this view is current]
```

The model can echo that value back as `edit_file`'s optional `anchor_hash`
argument. If it no longer matches the file's current content, the edit is
rejected with a message telling the model to re-read the file first. The
parameter is optional and inert when omitted, so cloud edits are unaffected.

### 5. Compact system prompt

Local backends receive a compact system prompt: the non-negotiable `[SAFETY]`
rules block is kept **verbatim**, while the verbose grounding section and long
base prompt collapse to one tight paragraph. The compact prompt is under 40% of
the full prompt's tokens. Cloud providers keep the full prompt.

### 6. Capability detection

Calliope probes a local model's capabilities once per session
(`getLocalModelProfile`):

- **context length** — from Ollama's `/api/show` (`model_info`, or a `num_ctx`
  Modelfile override), else a family default;
- **native tool calls** — from Ollama's `capabilities` list when present
  (`"tools"`), else a heuristic by model family;
- **JSON-schema `format` support** — true for native Ollama, false elsewhere.

The circuit breaker also relaxes its cost/token limits for `ollama` and
`litellm`, since self-hosted inference is effectively free.

## Configuration

Point Calliope at a local backend during `calliope --setup`, or directly:

```bash
# Ollama (native /api/chat — best tool-calling support)
export OLLAMA_BASE_URL=http://localhost:11434
calliope --provider ollama --model gemma4:31b

# Any OpenAI-compatible local server (vLLM, LM Studio, llama.cpp, …)
export OPENAI_COMPAT_BASE_URL=http://localhost:8000
calliope --provider openai-compat

# Local LiteLLM proxy
export LITELLM_BASE_URL=http://localhost:4000
calliope --provider litellm
```

Notes:

- The compact prompt and schema simplification apply automatically once the
  provider is a local backend. If you run `defaultProvider: auto` with *only* a
  local backend configured, set the provider explicitly (`--provider ollama`) to
  get the compact prompt from the first turn.
- `OPENAI_COMPAT_SHIM` still applies for quirky local servers (LM Studio,
  AnythingLLM, vLLM, Jan, LocalAI) — see [Providers](./providers.md).

## Observed behaviour: `gemma4:31b` on Ollama

Measured live against a local Ollama (`ollama` provider, native `/api/chat`):

| Probe | Result |
|-------|--------|
| `/api/show` capabilities | `["completion", "vision", "tools", "thinking"]` |
| Reported context length | 262144 (256K) |
| Chat round-trip | Works; clean `finishReason: stop`, token usage reported. |
| **Native tool calls** | **Yes** — returns a structured `tool_calls` entry (`finishReason: tool_use`) with correct arguments, empty text content. No XML/text fallback needed. |
| `format` param (JSON schema) | **Accepted** (HTTP 200). Produces exactly the constrained envelope, e.g. `{"name":"read_file","arguments":{"path":"./README.md"}}`. |
| Repair round-trip | With a typo'd tool name + corrective message + `format`, the model returned a corrected **native** tool call (`read_file` with the right args); Calliope extracted it and confirmed it was no longer malformed. |

Takeaways: gemma4:31b is a strong local harness target — it does reliable native
tool calls through Ollama, honours the `format` grammar constraint, and responds
well to the one-shot repair. When both `tools` and `format` are supplied on the
repair turn it prefers native `tool_calls`; Calliope's extractor handles both the
native path and the JSON envelope.

Other families are handled by the same code paths. Models whose `/api/show`
capabilities omit `"tools"` (e.g. a vision-only model) fall back to text-based
tool-call parsing; models Ollama doesn't report capabilities for fall back to a
family heuristic (llama 3.1+, qwen 2.5+, mistral, devstral, command-r, …).
