/**
 * Calliope CLI Setup Wizard
 *
 * Interactive first-run setup for API keys and preferences.
 */

import { input, select, confirm, password } from '@inquirer/prompts';
import * as config from './config.js';
import type { LLMProvider, AgentPersona } from './config.js';

// ANSI colors
const colors = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  magenta: '\x1b[35m',
  brightCyan: '\x1b[96m',
};

function c(text: string, color: keyof typeof colors): string {
  return `${colors[color]}${text}${colors.reset}`;
}

const BANNER = `
${c('  ╭─────────────────────────────────────────────────────────────────╮', 'cyan')}
${c('  │', 'cyan')}                                                                   ${c('│', 'cyan')}
${c('  │', 'cyan')}    ${c(' ██████╗ █████╗ ██╗     ██╗     ██╗ ██████╗ ██████╗ ███████╗', 'brightCyan')}  ${c('│', 'cyan')}
${c('  │', 'cyan')}    ${c('██╔════╝██╔══██╗██║     ██║     ██║██╔═══██╗██╔══██╗██╔════╝', 'brightCyan')}  ${c('│', 'cyan')}
${c('  │', 'cyan')}    ${c('██║     ███████║██║     ██║     ██║██║   ██║██████╔╝█████╗  ', 'cyan')}  ${c('│', 'cyan')}
${c('  │', 'cyan')}    ${c('██║     ██╔══██║██║     ██║     ██║██║   ██║██╔═══╝ ██╔══╝  ', 'cyan')}  ${c('│', 'cyan')}
${c('  │', 'cyan')}    ${c('╚██████╗██║  ██║███████╗███████╗██║╚██████╔╝██║     ███████╗', 'brightCyan')}  ${c('│', 'cyan')}
${c('  │', 'cyan')}    ${c(' ╚═════╝╚═╝  ╚═╝╚══════╝╚══════╝╚═╝ ╚═════╝ ╚═╝     ╚══════╝', 'cyan')}  ${c('│', 'cyan')}
${c('  │', 'cyan')}                                                                   ${c('│', 'cyan')}
${c('  │', 'cyan')}              ${c('The Muse of Digital Eloquence', 'dim')}                    ${c('│', 'cyan')}
${c('  │', 'cyan')}                                                                   ${c('│', 'cyan')}
${c('  ╰─────────────────────────────────────────────────────────────────╯', 'cyan')}
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
      { value: 'auto', name: 'Auto (use first available)', description: 'Automatically select based on available keys' },
    ],
    default: envProviders[0] || 'anthropic',
  });

  config.set('defaultProvider', providerChoice as LLMProvider);

  // API Key setup (if not in env)
  const needsKey = providerChoice !== 'auto' && !envProviders.includes(providerChoice);

  if (needsKey) {
    console.log();
    console.log(c(`  You'll need an API key for ${providerChoice}.`, 'dim'));

    const apiKeyUrls: Record<string, string> = {
      anthropic: 'https://console.anthropic.com/settings/keys',
      google: 'https://aistudio.google.com/apikey',
      openai: 'https://platform.openai.com/api-keys',
      openrouter: 'https://openrouter.ai/keys',
      together: 'https://api.together.xyz/settings/api-keys',
      groq: 'https://console.groq.com/keys',
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
      { value: 'calliope', name: 'Calliope (Poetic)', description: 'The Muse - creative with artistic flair' },
      { value: 'professional', name: 'Professional', description: 'Clear, concise, and thorough' },
      { value: 'minimal', name: 'Minimal', description: 'Extremely brief and efficient' },
    ],
    default: 'calliope',
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
