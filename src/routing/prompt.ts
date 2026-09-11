import { getSystemPromptForProvider } from '../local-model.js';
import type { LLMProvider, Message } from '../types.js';

/** Replace only a recognized built-in prefix, preserving trusted context and custom prompts. */
export function adaptRoutingPrompt(messages: Message[], provider: LLMProvider): Message[] {
  const first = messages[0];
  if (first?.role !== 'system' || typeof first.content !== 'string') return messages;
  const base = [getSystemPromptForProvider('auto'), getSystemPromptForProvider('ollama')]
    .find(value => first.content === value || (typeof first.content === 'string' && first.content.startsWith(value + '\n')));
  if (!base) return messages;
  const content = getSystemPromptForProvider(provider) + first.content.slice(base.length);
  return content === first.content ? messages : [{ ...first, content }, ...messages.slice(1)];
}
