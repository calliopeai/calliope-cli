# Configuration

Calliope stores its configuration through the `conf` library (a JSON file under
your platform's config directory, e.g. `~/.config/calliope/config.json`). Print
the exact path and current state with:

```
calliope --config
```

Most users never edit the file by hand — the setup wizard writes it, and a
handful of settings are changed at runtime with `/config set`. The full key
reference is below.

## Config keys

There are 16 keys. Defaults are the values applied when a key is absent.

| Key | Type | Default | Description |
|-----|------|---------|-------------|
| `setupComplete` | boolean | `false` | Whether first-run setup has finished. |
| `defaultProvider` | string | `auto` | Provider used at startup (`auto` picks the first configured one). |
| `defaultModel` | string | *(unset)* | Model used at startup; falls back to the provider's default. |
| `providers` | object | *(unset)* | Per-provider credentials. See [Provider credentials](#provider-credentials). |
| `fleet` | object | *(unset)* | `{ "enabled": boolean }`. When absent, fleet mode is off. See [Fleet mode](./fleet.md). |
| `maxIterations` | number | `0` | Max agent-loop iterations (`0` = unlimited; range 0-1000000). |
| `maxIterationTime` | number | `600` | Max seconds per iteration (`0` = no limit; range 0-3600). |
| `autoSaveHistory` | boolean | `true` | Auto-save conversation history for `/resume`. |
| `autoUpgrade` | boolean | `true` | Prompt to upgrade on startup when a new version is available. |
| `collapseTools` | boolean | `false` | Auto-collapse tool output in the TUI. |
| `toolDisplayLimit` | number | `0` | Show the last N tool calls expanded (`0` = all; range 0-100). |
| `diffStyle` | string | `inline` | Diff display: `inline`, `unified`, or `side-by-side`. |
| `circuitBreakersEnabled` | boolean | `false` | Enable runaway-loop guardrails. See [Features](./features.md#circuit-breakers). |
| `sandboxMode` | string | `auto` | Code/shell sandbox: `auto`, `native`, `docker`, or `off`. |
| `routing` | object | *(unset)* | `{ "enabled": boolean, "costSensitivity": 0-1 }`. Smart model routing (costSensitivity `0` = best quality, `1` = cheapest). |
| `sessionLogLimit` | number | `0` | Cap retained session-log items (`0` = unlimited; range 0-100000). |

### Runtime changes with `/config set`

`/config set` changes a subset of keys during a session without editing the file:

```
/config set maxIterations 50
/config set sessionLogLimit 500
/config set collapseTools true
/config set toolDisplayLimit 5
/config set diffStyle side-by-side
/config set sandboxMode docker
/config set routing.enabled true
/config set routing.costSensitivity 0.3
/config set theme light
```

The remaining keys (`setupComplete`, `defaultProvider`, `defaultModel`,
`providers`, `fleet`, `maxIterationTime`, `autoSaveHistory`, `autoUpgrade`,
`circuitBreakersEnabled`) are set by the setup wizard, environment variables,
or by editing the config file directly.

> `theme` is accepted by `/config set` but is **not** stored in the config file.
> It persists separately in `~/.calliope-cli/themes/current.txt`. See
> [Themes](#themes).

## Provider credentials

Credentials live in the nested `providers` map, keyed by provider name. Each
entry is a subset of these fields:

| Field | Applies to | Notes |
|-------|-----------|-------|
| `apiKey` | most providers | The API key/token. |
| `baseUrl` | ollama, litellm, bedrock (gateway), openai-compat | Server or proxy URL. |
| `model` | any | Pins a default model for the provider (no environment fallback). |
| `region` | bedrock | AWS region for the native Bedrock backend. |
| `profile` | bedrock | AWS named profile for the native Bedrock backend. |

Example:

```json
{
  "defaultProvider": "anthropic",
  "providers": {
    "anthropic": { "apiKey": "sk-ant-..." },
    "ollama": { "baseUrl": "http://localhost:11434" },
    "bedrock": { "region": "us-east-1", "profile": "dev" },
    "openai-compat": { "baseUrl": "http://localhost:1234/v1" }
  }
}
```

### Environment-variable fallbacks

Every provider resolves credentials from `providers.<name>` **and** from
environment variables. Environment variables take precedence over stored config
for every field except the `openai-compat` base URL (where the stored value
wins). The `model` field has no environment fallback.

| Provider | API key env | Base URL env | Other |
|----------|-------------|--------------|-------|
| anthropic | `ANTHROPIC_API_KEY` | — | — |
| google | `GOOGLE_API_KEY` | — | — |
| openai | `OPENAI_API_KEY` | — | — |
| openrouter | `OPENROUTER_API_KEY` | — | — |
| together | `TOGETHER_API_KEY` | — | — |
| groq | `GROQ_API_KEY` | — | — |
| fireworks | `FIREWORKS_API_KEY` | — | — |
| mistral | `MISTRAL_API_KEY` | — | — |
| ai21 | `AI21_API_KEY` | — | — |
| huggingface | `HUGGINGFACE_API_KEY` | — | — |
| ollama | — | `OLLAMA_BASE_URL` | — |
| litellm | `LITELLM_API_KEY` | `LITELLM_BASE_URL` | — |
| bedrock | `BEDROCK_API_KEY` | `BEDROCK_BASE_URL` | `AWS_REGION` / `AWS_DEFAULT_REGION` (region), `AWS_PROFILE` (profile) |
| openai-compat | `OPENAI_COMPAT_API_KEY` | `OPENAI_COMPAT_BASE_URL` | — |

Calliope also reads `.env` and `cli.env` files from the current directory (and
`.env` from your home directory) at startup, so exported keys need not be global.

See [Providers](./providers.md) for how each backend uses these values.

## Themes

Three built-in themes ship with Calliope:

- `dark` — default
- `light` — for light terminal backgrounds
- `no-color` — monochrome output

Switch with:

```
/config set theme light
```

The current theme is stored in `~/.calliope-cli/themes/current.txt` and applied
on the next startup.

## Migration

Configs from v2 are migrated automatically the first time v3 starts. The
migration is idempotent (running it again is a no-op) and does not touch keys
that are already in the current format:

- Flat credential keys (e.g. `anthropicApiKey`, `ollamaBaseUrl`, `awsRegion`)
  are folded into the nested `providers.<name>` map.
- The old smart-routing keys are folded into the `routing` object.
- Keys that no longer exist in v3 are dropped.

When credentials are migrated, Calliope prints a one-line notice to stderr.
Nothing else is required on your part.

## Command-line flags

```
calliope --config     # show config path and status
calliope --setup      # run the setup wizard (reconfigure)
calliope --reset      # clear all configuration
```

See [Getting started](./getting-started.md) for the full flag list.
