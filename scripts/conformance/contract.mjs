/** Provider adapter matrix. Model strings used by tests are protocol selectors,
 * never a model catalogue. Live captures require an explicit model argument. */
export const BACKENDS = [
  { id: 'anthropic', provider: 'anthropic', protocol: 'anthropic' },
  { id: 'google', provider: 'google', protocol: 'google' },
  { id: 'openai-chat', provider: 'openai', protocol: 'chat' },
  { id: 'openai-responses', provider: 'openai', protocol: 'responses' },
  { id: 'ollama', provider: 'ollama', protocol: 'ollama' },
  { id: 'bedrock-native', provider: 'bedrock', protocol: 'bedrock' },
  ...['openrouter', 'together', 'groq', 'fireworks', 'mistral', 'deepseek', 'xai', 'cerebras', 'huggingface', 'litellm', 'bedrock-compat', 'openai-compat'].map(id => ({ id, provider: id === 'bedrock-compat' ? 'bedrock' : id, protocol: 'chat' })),
];
export const TOOL = { name: 'echo', description: 'Echo a string. Conformance probe only; never executes.', parameters: { type: 'object', properties: { text: { type: 'string', description: 'Text to echo' } }, required: ['text'] } };
export const PROBE_TEXT = 'Hello π';
export function probeMessages(scenario) {
  return [{ role: 'user', content: scenario === 'tool' ? 'Call echo exactly once with text="hello". Do not write prose.' : `Reply with exactly: ${PROBE_TEXT}` }];
}
export function normalize(response) {
  return { content: response.content, finishReason: response.finishReason, usage: response.usage ?? null,
    tools: (response.toolCalls ?? []).map(call => ({ name: call.name, arguments: call.arguments })) };
}
/** Dispatch directly to adapters so retry policy cannot disguise wire failures. */
export async function invoke(adapters, backend, model, messages, tools, onToken, signal, limits) {
  const boundedLimits = limits ? { ...limits, bounded: true } : undefined;
  if (backend.protocol === 'anthropic') return adapters.anthropic.chatAnthropic(messages, tools, model, onToken, signal, boundedLimits);
  if (backend.protocol === 'google') return adapters.google.chatGoogle(messages, tools, model, onToken, signal, boundedLimits);
  if (backend.protocol === 'ollama') return adapters.ollama.chatOllama(messages, tools, model, onToken, { signal, ...boundedLimits });
  if (backend.protocol === 'bedrock') return adapters.bedrock.chatBedrock(messages, tools, model, onToken, signal, limits?.maxOutputTokens);
  if (backend.provider === 'openai') return adapters.openai.chatOpenAI(messages, tools, model, onToken, signal, boundedLimits);
  return adapters.compat.chatOpenAICompatible(backend.provider, messages, tools, model, onToken, signal, boundedLimits);
}
