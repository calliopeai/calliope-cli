import type { Message, Tool, TextContent } from './types.js';

/** Shared conservative request estimate, including tool schemas and call arguments. */
export function estimateInputTokens(messages: Message[], tools: Tool[]): number {
  let totalChars = 0;
  for (const message of messages) {
    totalChars += 50;
    if (typeof message.content === 'string') totalChars += message.content.length;
    else for (const block of message.content) {
      if (block.type === 'text') totalChars += (block as TextContent).text.length;
      else if (block.type === 'image') totalChars += 3000;
    }
    if (message.toolCalls) totalChars += JSON.stringify(message.toolCalls).length;
  }
  if (tools.length) totalChars += JSON.stringify(tools).length;
  return Math.ceil((totalChars / 2.5) * 1.35);
}
