# Providers

Calliope supports 13 provider backends, plus a generic OpenAI-compatible
endpoint for any other server that speaks the OpenAI chat-completions API.
Models are discovered live from each provider — there are no hardcoded model
lists. Use `/model` to browse what a provider offers.

## Backends at a glance

| Backend | Kind | Credential | Notes |
|---------|------|-----------|-------|
| `anthropic` | Native SDK | API key | Claude models. |
| `google` | Native SDK | API key | Gemini models. |
| `openai` | Native SDK | API key | GPT / o-series models. |
| `bedrock` | AWS | region + profile, or gateway URL | AWS Bedrock, native or via gateway. |
| `ollama` | Local | base URL | Local models; no API key. |
| `litellm` | Proxy | base URL (+ optional key) | Unified proxy for many providers. |
| `openrouter` | OpenAI-compatible | API key | Aggregator for many models. |
| `together` | OpenAI-compatible | API key | Open-weight models. |
| `groq` | OpenAI-compatible | API key | Fast inference. |
| `fireworks` | OpenAI-compatible | API key | Open-weight models. |
| `mistral` | OpenAI-compatible | API key | Mistral models. |
| `ai21` | OpenAI-compatible | API key | Jamba models. |
| `huggingface` | OpenAI-compatible | API key | Hosted inference. |
| `openai-compat` | Generic | base URL (+ optional key) | Any OpenAI-compatible server. |

Select a provider in a session with `/provider <name>`, or set `defaultProvider`
during setup. `auto` selects the first configured provider (priority order:
anthropic, openai, google, mistral, openrouter, together, groq, fireworks, ai21,
huggingface, bedrock, ollama, litellm).

## How credentials resolve

For every provider, Calliope merges two sources:

1. Stored config under `providers.<name>` (written by the setup wizard).
2. Environment variables.

Environment variables take precedence, except for the `openai-compat` base URL
where the stored value wins. The full environment-variable table is in
[Configuration → Environment-variable fallbacks](./configuration.md#environment-variable-fallbacks).

## Native SDK backends

`anthropic`, `google`, and `openai` use each vendor's own API. Provide an API key:

```
export ANTHROPIC_API_KEY=sk-ant-...
export GOOGLE_API_KEY=...
export OPENAI_API_KEY=sk-...
```

Or store them via the setup wizard, which writes them to `providers.<name>.apiKey`.

## Hosted OpenAI-compatible backends

`openrouter`, `together`, `groq`, `fireworks`, `mistral`, `ai21`, and
`huggingface` speak the OpenAI chat-completions API and each have a built-in
base URL, so you only supply an API key:

| Provider | Base URL |
|----------|----------|
| openrouter | `https://openrouter.ai/api/v1` |
| together | `https://api.together.xyz/v1` |
| groq | `https://api.groq.com/openai/v1` |
| fireworks | `https://api.fireworks.ai/inference/v1` |
| mistral | `https://api.mistral.ai/v1` |
| ai21 | `https://api.ai21.com/studio/v1` |
| huggingface | `https://api-inference.huggingface.co/v1` |

```
export GROQ_API_KEY=gsk_...
```

## Ollama and local models

`ollama` runs models on your machine and needs no API key — its "credential" is
the base URL. The default is `http://localhost:11434`.

```
# install and pull a model
ollama pull llama3.3

# optional: point Calliope at a non-default host
export OLLAMA_BASE_URL=http://localhost:11434
```

```
/provider ollama
/model llama3.3
```

Local models run offline, cost nothing, and keep data on your machine.

## LiteLLM proxy

`litellm` targets a [LiteLLM](https://docs.litellm.ai/docs/proxy) proxy that
fronts other providers. Point Calliope at the proxy URL (default
`http://localhost:4000`) and, if the proxy requires it, an API key:

```
export LITELLM_BASE_URL=http://localhost:4000
export LITELLM_API_KEY=...      # only if your proxy requires it
```

## Generic OpenAI-compatible servers

`openai-compat` connects to any server implementing the OpenAI chat-completions
API — for example LM Studio, vLLM, Jan, LocalAI, or AnythingLLM. Supply the base
URL, plus a key if the server requires one:

```
export OPENAI_COMPAT_BASE_URL=http://localhost:1234/v1
export OPENAI_COMPAT_API_KEY=...   # only if required
```

The base URL you store in config is preferred over the environment variable for
this backend.

## AWS Bedrock

`bedrock` has two modes:

- **Native** — calls the Bedrock Converse API directly. Provide an AWS region and
  (optionally) a named profile, via config or the environment:

  ```
  export AWS_REGION=us-east-1        # or AWS_DEFAULT_REGION
  export AWS_PROFILE=dev             # optional named profile
  ```

  Standard AWS credential resolution applies (`AWS_ACCESS_KEY_ID` /
  `AWS_PROFILE` are detected automatically).

- **Gateway** — if you set a Bedrock gateway/proxy base URL, Calliope treats it
  as an OpenAI-compatible endpoint instead:

  ```
  export BEDROCK_BASE_URL=http://localhost:8080
  export BEDROCK_API_KEY=...         # only if the gateway requires it
  ```

Store region and profile permanently under `providers.bedrock.region` and
`providers.bedrock.profile`.

## Default models

Each provider has an offline emergency-fallback model used only when live
discovery is unavailable (for example, with no network). In normal use the model
is chosen by discovery or by your `/model` selection, not from a fixed list.
