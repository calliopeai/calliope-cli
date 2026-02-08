/**
 * Calliope CLI Setup Wizard
 *
 * Interactive first-run setup for API keys and preferences.
 */

import { input, select, confirm, password } from '@inquirer/prompts';
import * as config from './config.js';
import type { LLMProvider, AgentPersona } from './config.js';
import { color as c } from './styles.js';

const BANNER = `
${c(' ██████╗ █████╗ ██╗     ██╗     ██╗ ██████╗ ██████╗ ███████╗', 'brightCyan')}
${c('██╔════╝██╔══██╗██║     ██║     ██║██╔═══██╗██╔══██╗██╔════╝', 'brightCyan')}
${c('██║     ███████║██║     ██║     ██║██║   ██║██████╔╝█████╗  ', 'cyan')}
${c('██║     ██╔══██║██║     ██║     ██║██║   ██║██╔═══╝ ██╔══╝  ', 'cyan')}
${c('╚██████╗██║  ██║███████╗███████╗██║╚██████╔╝██║     ███████╗', 'brightCyan')}
${c(' ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝     ╚══════╝', 'cyan')}

        ${c('Multi-Model AI Agent CLI', 'dim')}
`;

/**
 * Run the setup wizard
 */
export async function runSetup(force = false): Promise<boolean> {
  // Check if already set up
  if (config.isSetupComplete() && !force) {
    return true;
  }

  console.log(BANNER);
  console.log();
  console.log(c('  Welcome to Calliope!', 'bold'));
  console.log(c('  Let\'s set up your AI providers and preferences.', 'dim'));
  console.log();

  // Check for existing environment variables
  const envProviders: string[] = [];
  if (process.env.ANTHROPIC_API_KEY) envProviders.push('anthropic');
  if (process.env.GOOGLE_API_KEY) envProviders.push('google');
  if (process.env.OPENAI_API_KEY) envProviders.push('openai');
  if (process.env.TOGETHER_API_KEY) envProviders.push('together');
  if (process.env.OPENROUTER_API_KEY) envProviders.push('openrouter');
  if (process.env.GROQ_API_KEY) envProviders.push('groq');
  if (process.env.MISTRAL_API_KEY) envProviders.push('mistral');
  if (process.env.OLLAMA_BASE_URL) envProviders.push('ollama');
  if (process.env.AI21_API_KEY) envProviders.push('ai21');
  if (process.env.HUGGINGFACE_API_KEY) envProviders.push('huggingface');
  if (process.env.LITELLM_BASE_URL) envProviders.push('litellm');
  if (process.env.BEDROCK_API_KEY || process.env.BEDROCK_BASE_URL) envProviders.push('bedrock');

  if (envProviders.length > 0) {
    console.log(c(`  Found API keys in environment: ${envProviders.join(', ')}`, 'green'));
    console.log();
  }

  // Provider selection
  const providerChoice = await select({
    message: 'Which AI provider would you like to use?',
    choices: [
      { value: 'anthropic', name: 'Anthropic Claude (Recommended)', description: 'Claude 4 Sonnet - best for coding' },
      { value: 'google', name: 'Google Gemini', description: 'Gemini 2.0 Flash - fast and capable' },
      { value: 'openai', name: 'OpenAI GPT', description: 'GPT-4o - versatile' },
      { value: 'openrouter', name: 'OpenRouter', description: 'Access multiple models via one API' },
      { value: 'together', name: 'Together AI', description: 'Open source models (Llama, Mixtral)' },
      { value: 'groq', name: 'Groq', description: 'Ultra-fast inference' },
      { value: 'mistral', name: 'Mistral AI', description: 'Mistral Large - European AI' },
      { value: 'ollama', name: 'Ollama (Local)', description: 'Run models locally - no API key needed' },
      { value: 'litellm', name: 'LiteLLM Proxy', description: 'Unified proxy for multiple providers' },
      { value: 'bedrock', name: 'AWS Bedrock', description: 'AWS Bedrock via gateway/proxy' },
      { value: 'ai21', name: 'AI21 Labs', description: 'Jamba models' },
      { value: 'huggingface', name: 'HuggingFace', description: 'Open source model inference' },
      { value: 'auto', name: 'Auto (use first available)', description: 'Automatically select based on available keys' },
    ],
    default: envProviders[0] || 'anthropic',
  });

  config.set('defaultProvider', providerChoice as LLMProvider);

  // API Key or Base URL setup (if not in env)
  const needsKey = providerChoice !== 'auto' && !envProviders.includes(providerChoice);

  // Special handling for Ollama and LiteLLM (use base URL, not API key)
  if (providerChoice === 'ollama' && needsKey) {
    console.log();
    console.log(c(`  Ollama runs locally and doesn't need an API key.`, 'dim'));
    const baseUrl = await input({
      message: 'Enter your Ollama base URL:',
      default: 'http://localhost:11434',
    });
    config.set('ollamaBaseUrl', baseUrl);
  } else if (providerChoice === 'litellm' && needsKey) {
    console.log();
    console.log(c(`  LiteLLM is a proxy server for multiple providers.`, 'dim'));
    const baseUrl = await input({
      message: 'Enter your LiteLLM proxy URL:',
      default: 'http://localhost:4000',
    });
    config.set('litellmBaseUrl', baseUrl);

    const needsApiKey = await confirm({
      message: 'Does your LiteLLM proxy require an API key?',
      default: false,
    });
    if (needsApiKey) {
      const apiKey = await password({
        message: 'Enter your LiteLLM API key:',
        mask: '*',
      });
      if (apiKey && apiKey.length > 0) {
        config.set('litellmApiKey', apiKey);
      }
    }
  } else if (providerChoice === 'bedrock' && needsKey) {
    console.log();
    console.log(c(`  AWS Bedrock requires a gateway/proxy with an OpenAI-compatible API.`, 'dim'));
    const baseUrl = await input({
      message: 'Enter your Bedrock gateway/proxy URL:',
      default: 'http://localhost:8080',
    });
    config.set('bedrockBaseUrl', baseUrl);

    const needsApiKey = await confirm({
      message: 'Does your Bedrock gateway require an API key?',
      default: false,
    });
    if (needsApiKey) {
      const apiKey = await password({
        message: 'Enter your Bedrock gateway API key:',
        mask: '*',
      });
      if (apiKey && apiKey.length > 0) {
        config.set('bedrockApiKey', apiKey);
      }
    }
  } else if (needsKey) {
    console.log();
    console.log(c(`  You'll need an API key for ${providerChoice}.`, 'dim'));

    const apiKeyUrls: Record<string, string> = {
      anthropic: 'https://console.anthropic.com/settings/keys',
      google: 'https://aistudio.google.com/apikey',
      openai: 'https://platform.openai.com/api-keys',
      openrouter: 'https://openrouter.ai/keys',
      together: 'https://api.together.xyz/settings/api-keys',
      groq: 'https://console.groq.com/keys',
      mistral: 'https://console.mistral.ai/api-keys',
      ai21: 'https://studio.ai21.com/account/api-keys',
      huggingface: 'https://huggingface.co/settings/tokens',
    };

    if (apiKeyUrls[providerChoice]) {
      console.log(c(`  Get one at: ${apiKeyUrls[providerChoice]}`, 'cyan'));
    }
    console.log();

    // Provider-specific key patterns
    const keyPatterns: Record<string, { prefix?: string; minLen: number }> = {
      anthropic: { prefix: 'sk-ant-', minLen: 40 },
      openai: { prefix: 'sk-', minLen: 40 },
      google: { minLen: 30 },
      openrouter: { prefix: 'sk-or-', minLen: 40 },
      together: { minLen: 40 },
      groq: { prefix: 'gsk_', minLen: 40 },
      mistral: { minLen: 30 },
      ai21: { minLen: 30 },
      huggingface: { prefix: 'hf_', minLen: 30 },
    };

    const pattern = keyPatterns[providerChoice] || { minLen: 20 };

    const apiKey = await password({
      message: `Enter your ${providerChoice} API key:`,
      mask: '*',
      validate: (value) => {
        if (!value || value.length < pattern.minLen) {
          return `API key too short (expected ${pattern.minLen}+ characters)`;
        }
        if (pattern.prefix && !value.startsWith(pattern.prefix)) {
          return `${providerChoice} keys usually start with "${pattern.prefix}"`;
        }
        return true;
      },
    });

    // Store the key
    const keyMap: Record<string, keyof config.CalliopeConfig> = {
      anthropic: 'anthropicApiKey',
      google: 'googleApiKey',
      openai: 'openaiApiKey',
      openrouter: 'openrouterApiKey',
      together: 'togetherApiKey',
      groq: 'groqApiKey',
      fireworks: 'fireworksApiKey',
      mistral: 'mistralApiKey',
      ai21: 'ai21ApiKey',
      huggingface: 'huggingfaceApiKey',
    };

    if (keyMap[providerChoice]) {
      config.set(keyMap[providerChoice], apiKey);
    }
  }

  // Persona selection
  console.log();
  const personaChoice = await select({
    message: 'Choose Calliope\'s personality:',
    choices: [
      { value: 'professional', name: 'Professional (Recommended)', description: 'Clear, concise, and thorough' },
      { value: 'calliope', name: 'Calliope (Poetic)', description: 'Creative with artistic flair' },
      { value: 'minimal', name: 'Minimal', description: 'Extremely brief and efficient' },
    ],
    default: 'professional',
  });

  config.set('persona', personaChoice as AgentPersona);

  // Fancy output
  console.log();
  const fancyOutput = await confirm({
    message: 'Enable fancy terminal output (colors, spinners, ASCII art)?',
    default: true,
  });

  config.set('fancyOutput', fancyOutput);

  // Optional: Additional providers
  console.log();
  const addMore = await confirm({
    message: 'Would you like to configure additional AI providers?',
    default: false,
  });

  if (addMore) {
    await configureAdditionalProviders(envProviders);
  }

  // Mark setup complete
  config.markSetupComplete();

  // Summary
  console.log();
  console.log(c('  ─────────────────────────────────────────', 'dim'));
  console.log(c('  Setup complete!', 'green'));
  console.log();
  console.log(`  ${c('Provider:', 'dim')} ${c(providerChoice, 'cyan')}`);
  console.log(`  ${c('Persona:', 'dim')} ${c(personaChoice, 'magenta')}`);
  console.log(`  ${c('Config:', 'dim')} ${c(config.getConfigPath(), 'dim')}`);
  console.log();
  console.log(c('  Type your first message to begin, or /help for commands.', 'dim'));
  console.log(c('  ─────────────────────────────────────────', 'dim'));
  console.log();

  return true;
}

/**
 * Configure additional providers
 */
async function configureAdditionalProviders(existingEnvProviders: string[]): Promise<void> {
  const providers = [
    { id: 'anthropic', name: 'Anthropic Claude', envKey: 'ANTHROPIC_API_KEY', configKey: 'anthropicApiKey' },
    { id: 'google', name: 'Google Gemini', envKey: 'GOOGLE_API_KEY', configKey: 'googleApiKey' },
    { id: 'openai', name: 'OpenAI GPT', envKey: 'OPENAI_API_KEY', configKey: 'openaiApiKey' },
    { id: 'openrouter', name: 'OpenRouter', envKey: 'OPENROUTER_API_KEY', configKey: 'openrouterApiKey' },
    { id: 'together', name: 'Together AI', envKey: 'TOGETHER_API_KEY', configKey: 'togetherApiKey' },
    { id: 'groq', name: 'Groq', envKey: 'GROQ_API_KEY', configKey: 'groqApiKey' },
    { id: 'mistral', name: 'Mistral AI', envKey: 'MISTRAL_API_KEY', configKey: 'mistralApiKey' },
    { id: 'ai21', name: 'AI21 Labs', envKey: 'AI21_API_KEY', configKey: 'ai21ApiKey' },
    { id: 'huggingface', name: 'HuggingFace', envKey: 'HUGGINGFACE_API_KEY', configKey: 'huggingfaceApiKey' },
  ];

  for (const provider of providers) {
    // Skip if already configured via env or selected as primary
    if (existingEnvProviders.includes(provider.id)) {
      continue;
    }

    const existing = config.get(provider.configKey as keyof config.CalliopeConfig);
    if (existing) {
      continue;
    }

    const configure = await confirm({
      message: `Configure ${provider.name}?`,
      default: false,
    });

    if (configure) {
      const apiKey = await password({
        message: `Enter your ${provider.name} API key:`,
        mask: '*',
      });

      if (apiKey && apiKey.length > 10) {
        config.set(provider.configKey as keyof config.CalliopeConfig, apiKey);
        console.log(c(`  ✓ ${provider.name} configured`, 'green'));
      }
    }
  }
}

/**
 * Quick reconfigure (for /setup command)
 */
export async function reconfigure(): Promise<void> {
  console.log();
  console.log(c('  Reconfiguring Calliope...', 'cyan'));
  console.log();

  await runSetup(true);
}

export default runSetup;
