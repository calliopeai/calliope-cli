# AI Providers

Calliope CLI supports 13+ AI providers. This document details each provider, their models, and configuration.

## Quick Comparison

| Provider | Best For | Context | Speed | Cost |
|----------|----------|---------|-------|------|
| Anthropic | Complex reasoning | 200K | Medium | $$ |
| OpenAI | General purpose | 128K | Fast | $$ |
| Google | Long context | 2M | Fast | $ |
| Groq | Speed | 128K | Fastest | $ |
| Mistral | European hosting | 128K | Fast | $ |
| Ollama | Privacy (local) | Varies | Varies | Free |
| OpenRouter | Model variety | Varies | Varies | Varies |

---

## Anthropic (Claude)

The default provider. Claude excels at complex reasoning, coding, and nuanced tasks.

### Setup
```bash
export ANTHROPIC_API_KEY=sk-ant-...
```

### Models

| Model | Description | Context | Best For |
|-------|-------------|---------|----------|
| `claude-opus-4-5-20251101` | Most capable | 200K | Complex analysis, research |
| `claude-sonnet-4-20250514` | Balanced | 200K | Daily coding (default) |
| `claude-3-5-sonnet-20241022` | Previous flagship | 200K | General tasks |
| `claude-3-5-haiku-20241022` | Fast & cheap | 200K | Simple tasks, high volume |

### Usage
```bash
/provider anthropic
/model claude-sonnet-4-20250514
```

### Pricing (per 1M tokens)
- Input: $3.00 (Sonnet), $15.00 (Opus)
- Output: $15.00 (Sonnet), $75.00 (Opus)

---

## OpenAI (GPT)

Industry standard with strong tool use and broad capabilities.

### Setup
```bash
export OPENAI_API_KEY=sk-...
```

### Models

| Model | Description | Context | Best For |
|-------|-------------|---------|----------|
| `gpt-4o` | Flagship multimodal | 128K | Complex tasks, vision |
| `gpt-4o-mini` | Fast & cheap | 128K | Simple tasks |
| `gpt-4-turbo` | Previous flagship | 128K | Legacy compatibility |
| `o1` | Reasoning model | 128K | Math, logic, planning |
| `o1-mini` | Fast reasoning | 128K | Quick reasoning tasks |
| `o3-mini` | Next-gen reasoning | 128K | Advanced reasoning |

### Usage
```bash
/provider openai
/model gpt-4o
```

### Pricing (per 1M tokens)
- Input: $2.50 (GPT-4o), $0.15 (GPT-4o-mini)
- Output: $10.00 (GPT-4o), $0.60 (GPT-4o-mini)

---

## Google (Gemini)

Massive context windows and competitive pricing.

### Setup
```bash
export GOOGLE_API_KEY=...
```

### Models

| Model | Description | Context | Best For |
|-------|-------------|---------|----------|
| `gemini-2.5-pro-preview-06-05` | Most capable | 1M | Complex reasoning |
| `gemini-2.5-flash-preview-05-20` | Fast next-gen | 1M | Speed + quality |
| `gemini-2.0-flash` | Multimodal | 1M | General use |
| `gemini-1.5-pro-latest` | Long context | 2M | Large codebases |
| `gemini-1.5-flash-latest` | Fast | 1M | High volume |

### Usage
```bash
/provider google
/model gemini-2.0-flash
```

### Pricing (per 1M tokens)
- Input: $1.25 (Pro), $0.075 (Flash)
- Output: $5.00 (Pro), $0.30 (Flash)

---

## Groq

Fastest inference speeds via custom LPU hardware.

### Setup
```bash
export GROQ_API_KEY=gsk_...
```

### Models

| Model | Description | Context | Best For |
|-------|-------------|---------|----------|
| `llama-3.3-70b-versatile` | Best quality | 128K | Complex tasks |
| `llama-3.1-70b-versatile` | Previous gen | 128K | General use |
| `mixtral-8x7b-32768` | MoE model | 32K | Fast inference |
| `llama-3.2-90b-vision-preview` | Vision | 128K | Image tasks |

### Usage
```bash
/provider groq
/model llama-3.3-70b-versatile
```

### Pricing
- Free tier available
- Paid: ~$0.59-$0.79 per 1M tokens

---

## Mistral

European AI provider with strong open-weight models.

### Setup
```bash
export MISTRAL_API_KEY=...
```

### Models

| Model | Description | Context | Best For |
|-------|-------------|---------|----------|
| `mistral-large-latest` | Most capable | 128K | Complex tasks |
| `mistral-medium-latest` | Balanced | 128K | General use |
| `mistral-small-latest` | Fast | 128K | Simple tasks |
| `codestral-latest` | Code-focused | 32K | Coding |

### Usage
```bash
/provider mistral
/model mistral-large-latest
```

---

## Ollama (Local)

Run models locally for privacy and offline use.

### Setup
1. Install Ollama: https://ollama.ai
2. Pull models: `ollama pull llama3.2`
3. Ollama runs on `http://localhost:11434` by default

```bash
# Optional: custom URL
export OLLAMA_BASE_URL=http://localhost:11434
```

### Models

Pull any model from Ollama's library:
```bash
ollama pull llama3.2
ollama pull codellama
ollama pull mistral
ollama pull deepseek-coder
```

### Usage
```bash
/provider ollama
/model llama3.2
```

### Benefits
- No API costs
- Complete privacy
- Works offline
- No rate limits

---

## OpenRouter

Access 100+ models through a single API.

### Setup
```bash
export OPENROUTER_API_KEY=sk-or-...
```

### Popular Models

| Model | Provider | Best For |
|-------|----------|----------|
| `anthropic/claude-3.5-sonnet` | Anthropic | General |
| `openai/gpt-4o` | OpenAI | Multimodal |
| `google/gemini-pro-1.5` | Google | Long context |
| `meta-llama/llama-3.1-405b` | Meta | Open source |
| `deepseek/deepseek-coder` | DeepSeek | Coding |

### Usage
```bash
/provider openrouter
/model anthropic/claude-3.5-sonnet
```

### Benefits
- Single API for all models
- Pay-per-use pricing
- Model fallback support
- Usage tracking

---

## DeepSeek

Chinese AI lab with strong coding models.

### Setup
```bash
export DEEPSEEK_API_KEY=sk-...
```

### Models

| Model | Description | Best For |
|-------|-------------|----------|
| `deepseek-chat` | General chat | Conversation |
| `deepseek-coder` | Code-focused | Programming |
| `deepseek-r1` | Reasoning | Complex logic |

### Usage
```bash
/provider deepseek
/model deepseek-coder
```

---

## xAI (Grok)

Elon Musk's AI company.

### Setup
```bash
export XAI_API_KEY=xai-...
```

### Models

| Model | Description |
|-------|-------------|
| `grok-beta` | Latest Grok model |
| `grok-2` | Grok 2 |

### Usage
```bash
/provider xai
/model grok-beta
```

---

## Cerebras

Ultra-fast inference on custom wafer-scale chips.

### Setup
```bash
export CEREBRAS_API_KEY=...
```

### Usage
```bash
/provider cerebras
/model llama3.1-70b
```

---

## Fireworks AI

Fast inference for open models.

### Setup
```bash
export FIREWORKS_API_KEY=...
```

### Usage
```bash
/provider fireworks
/model accounts/fireworks/models/llama-v3p1-70b-instruct
```

---

## LiteLLM (Proxy)

Use LiteLLM as a unified proxy for multiple providers.

### Setup
1. Run LiteLLM proxy: https://docs.litellm.ai/docs/proxy
2. Configure endpoint:

```bash
export LITELLM_BASE_URL=http://localhost:4000
export LITELLM_API_KEY=sk-...
```

### Usage
```bash
/provider litellm
/model gpt-4  # Or any model configured in your proxy
```

---

## GitHub Models

Access models via GitHub's API (requires GitHub account).

### Setup
```bash
export GITHUB_TOKEN=ghp_...
```

### Usage
```bash
/provider github
/model gpt-4o
```

---

## Auto-Routing

Let Calliope automatically select the best model based on task complexity.

### Enable
```bash
/route on
```

### How It Works
- Simple queries → Fast/cheap model (Flash, Haiku)
- Complex tasks → Capable model (Sonnet, GPT-4o)
- Coding tasks → Code-specialized model

### Test Routing
```bash
/route test "Explain quantum computing"
```

---

## Provider Profiles

Quick-switch between configurations:

```bash
/profile fast    # Groq for speed
/profile smart   # Claude for quality
/profile cheap   # Gemini for cost
/profile local   # Ollama for privacy
```

---

## Environment Variables Summary

```bash
# Primary providers
ANTHROPIC_API_KEY=sk-ant-...
OPENAI_API_KEY=sk-...
GOOGLE_API_KEY=...

# Additional providers
MISTRAL_API_KEY=...
GROQ_API_KEY=gsk_...
XAI_API_KEY=xai-...
CEREBRAS_API_KEY=...
FIREWORKS_API_KEY=...
DEEPSEEK_API_KEY=sk-...
OPENROUTER_API_KEY=sk-or-...

# Local/proxy
OLLAMA_BASE_URL=http://localhost:11434
LITELLM_BASE_URL=http://localhost:4000
LITELLM_API_KEY=...

# GitHub
GITHUB_TOKEN=ghp_...
```
