import type { Message } from '../types.js';

/** Display only conversation channels; protocol metadata stays private and opaque. */
export function messageText(message: Message): string {
  const content = typeof message.content === 'string' ? message.content : message.content.map(part => part.type === 'text' ? part.text : `[Image: ${part.mediaType}]`).join('\n');
  const tools = message.toolCalls?.map(call => call.name).join(', ');
  return content + (tools ? `${content ? '\n' : ''}Tool requests: ${tools}` : '');
}
export function conversationMarkdown(messages: Message[]): string {
  return '# Calliope conversation\n\n' + messages.filter(message => message.role !== 'system').map(message => `## ${message.role}\n\n${messageText(message)}\n`).join('\n');
}
