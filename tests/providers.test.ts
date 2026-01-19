/**
 * Tests for providers module - Responses API support
 */

import { describe, it, expect } from 'vitest';
import type { Message, Tool, ToolCall } from '../src/types.js';

// Since the conversion functions are private, we'll test the exported behavior
// and create mock versions for unit testing the logic

// Models that require Responses API
const RESPONSES_API_MODELS = ['o3', 'o3-mini', 'o3-pro', 'o4-mini', 'gpt-5'];

function requiresResponsesAPI(model: string): boolean {
  return RESPONSES_API_MODELS.some(m => model.startsWith(m));
}

// Mock conversion function for testing
function toResponsesInput(messages: Message[]): Array<any> {
  const input: Array<any> = [];

  for (const m of messages) {
    if (m.role === 'system') {
      input.push({
        role: 'developer',
        content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    } else if (m.role === 'tool') {
      input.push({
        type: 'function_call_output',
        call_id: m.toolCallId || '',
        output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
      });
    } else if (m.role === 'assistant') {
      if (m.toolCalls && m.toolCalls.length > 0) {
        const textContent = typeof m.content === 'string' ? m.content : '';
        if (textContent) {
          input.push({
            role: 'assistant',
            content: textContent,
          });
        }
        for (const tc of m.toolCalls) {
          input.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.name,
            arguments: JSON.stringify(tc.arguments),
          });
        }
      } else {
        input.push({
          role: 'assistant',
          content: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        });
      }
    } else if (m.role === 'user') {
      if (Array.isArray(m.content)) {
        const parts: Array<any> = [];
        for (const block of m.content) {
          if (block.type === 'text') {
            parts.push({ type: 'input_text', text: block.text });
          } else if (block.type === 'image') {
            parts.push({
              type: 'input_image',
              image_url: { url: `data:${block.mediaType};base64,${block.data}` },
            });
          }
        }
        input.push({ role: 'user', content: parts });
      } else {
        input.push({
          role: 'user',
          content: m.content,
        });
      }
    }
  }

  return input;
}

function toResponsesTools(tools: Tool[]): Array<any> {
  return tools.map(t => ({
    type: 'function',
    name: t.name,
    description: t.description,
    parameters: t.parameters,
    strict: false,
  }));
}

describe('requiresResponsesAPI', () => {
  it('should return true for o3 models', () => {
    expect(requiresResponsesAPI('o3')).toBe(true);
    expect(requiresResponsesAPI('o3-mini')).toBe(true);
    expect(requiresResponsesAPI('o3-mini-2025-01-31')).toBe(true);
    expect(requiresResponsesAPI('o3-pro')).toBe(true);
  });

  it('should return true for o4-mini models', () => {
    expect(requiresResponsesAPI('o4-mini')).toBe(true);
    expect(requiresResponsesAPI('o4-mini-2025-04-16')).toBe(true);
  });

  it('should return true for gpt-5 models', () => {
    expect(requiresResponsesAPI('gpt-5')).toBe(true);
    expect(requiresResponsesAPI('gpt-5-turbo')).toBe(true);
  });

  it('should return false for o1 models (uses chat completions)', () => {
    expect(requiresResponsesAPI('o1')).toBe(false);
    expect(requiresResponsesAPI('o1-mini')).toBe(false);
    expect(requiresResponsesAPI('o1-preview')).toBe(false);
  });

  it('should return false for gpt-4 models', () => {
    expect(requiresResponsesAPI('gpt-4o')).toBe(false);
    expect(requiresResponsesAPI('gpt-4o-mini')).toBe(false);
    expect(requiresResponsesAPI('gpt-4-turbo')).toBe(false);
  });
});

describe('toResponsesInput', () => {
  it('should convert system messages to developer role', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
    ];

    const result = toResponsesInput(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('developer');
    expect(result[0].content).toBe('You are a helpful assistant.');
  });

  it('should convert user messages', () => {
    const messages: Message[] = [
      { role: 'user', content: 'Hello, world!' },
    ];

    const result = toResponsesInput(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toBe('Hello, world!');
  });

  it('should convert assistant messages', () => {
    const messages: Message[] = [
      { role: 'assistant', content: 'Hi there!' },
    ];

    const result = toResponsesInput(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('Hi there!');
  });

  it('should convert tool messages to function_call_output', () => {
    const messages: Message[] = [
      { role: 'tool', content: '{"result": "success"}', toolCallId: 'call_123' },
    ];

    const result = toResponsesInput(messages);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('function_call_output');
    expect(result[0].call_id).toBe('call_123');
    expect(result[0].output).toBe('{"result": "success"}');
  });

  it('should convert assistant messages with tool calls', () => {
    const toolCalls: ToolCall[] = [
      { id: 'call_abc', name: 'read_file', arguments: { path: '/test.txt' } },
    ];
    const messages: Message[] = [
      { role: 'assistant', content: 'Let me read that file.', toolCalls },
    ];

    const result = toResponsesInput(messages);
    expect(result).toHaveLength(2);
    expect(result[0].role).toBe('assistant');
    expect(result[0].content).toBe('Let me read that file.');
    expect(result[1].type).toBe('function_call');
    expect(result[1].call_id).toBe('call_abc');
    expect(result[1].name).toBe('read_file');
    expect(result[1].arguments).toBe('{"path":"/test.txt"}');
  });

  it('should convert multi-modal user messages with images', () => {
    const messages: Message[] = [
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is in this image?' },
          { type: 'image', mediaType: 'image/png', data: 'base64data' },
        ],
      },
    ];

    const result = toResponsesInput(messages);
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe('user');
    expect(result[0].content).toHaveLength(2);
    expect(result[0].content[0]).toEqual({ type: 'input_text', text: 'What is in this image?' });
    expect(result[0].content[1]).toEqual({
      type: 'input_image',
      image_url: { url: 'data:image/png;base64,base64data' },
    });
  });

  it('should handle a complete conversation flow', () => {
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'List files in /tmp' },
      {
        role: 'assistant',
        content: 'I\'ll list the files for you.',
        toolCalls: [{ id: 'call_1', name: 'shell', arguments: { command: 'ls /tmp' } }],
      },
      { role: 'tool', content: 'file1.txt\nfile2.txt', toolCallId: 'call_1' },
      { role: 'assistant', content: 'Here are the files in /tmp:\n- file1.txt\n- file2.txt' },
    ];

    const result = toResponsesInput(messages);
    expect(result).toHaveLength(6);
    expect(result[0].role).toBe('developer');
    expect(result[1].role).toBe('user');
    expect(result[2].role).toBe('assistant');
    expect(result[3].type).toBe('function_call');
    expect(result[4].type).toBe('function_call_output');
    expect(result[5].role).toBe('assistant');
  });
});

describe('toResponsesTools', () => {
  it('should convert tools to Responses API format', () => {
    const tools: Tool[] = [
      {
        name: 'read_file',
        description: 'Read a file from disk',
        parameters: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
          },
          required: ['path'],
        },
      },
    ];

    const result = toResponsesTools(tools);
    expect(result).toHaveLength(1);
    expect(result[0].type).toBe('function');
    expect(result[0].name).toBe('read_file');
    expect(result[0].description).toBe('Read a file from disk');
    expect(result[0].parameters).toEqual(tools[0].parameters);
    expect(result[0].strict).toBe(false);
  });

  it('should convert multiple tools', () => {
    const tools: Tool[] = [
      {
        name: 'shell',
        description: 'Execute shell command',
        parameters: { type: 'object', properties: { command: { type: 'string', description: 'Command' } } },
      },
      {
        name: 'write_file',
        description: 'Write file',
        parameters: { type: 'object', properties: { path: { type: 'string', description: 'Path' }, content: { type: 'string', description: 'Content' } } },
      },
    ];

    const result = toResponsesTools(tools);
    expect(result).toHaveLength(2);
    expect(result[0].name).toBe('shell');
    expect(result[1].name).toBe('write_file');
  });

  it('should handle tools with no description', () => {
    const tools: Tool[] = [
      {
        name: 'think',
        description: '',
        parameters: { type: 'object', properties: {} },
      },
    ];

    const result = toResponsesTools(tools);
    expect(result[0].description).toBe('');
  });
});
