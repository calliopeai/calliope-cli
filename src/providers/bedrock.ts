import { BedrockBlocks } from './bedrock-blocks.js';
import { assertBedrockReasoning, assertToolArgumentObject, assertTerminalReason, assertBedrockUsage, assertBedrockTerminalResponse } from './stream-validation.js';
/**
 * AWS Bedrock Provider - Native Converse API
 *
 * Uses the Bedrock Converse API directly with AWS Signature V4 signing.
 * AWS SDK resolves renewable identity; signing and transport use crypto and fetch.
 */

import { createHmac, createHash } from 'crypto';
import { crc32 } from 'node:zlib';
import { existsSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as config from '../config.js';
import { interruptCompletedResponse } from './response-retention.js';
import { StreamProtocolError } from '../errors.js';
import {resolveBedrockCredentials} from './bedrock-auth.js';
import { throwIfCancelled } from '../cancellation.js';
import type { Message, Tool, LLMResponse, ToolCall, TextContent, ImageContent, MessageContent } from '../types.js';
import { normalizeFinishReason, getTextContent, calculateMaxTokens, debugLog, type StreamCallback } from './types.js';

// ---------------------------------------------------------------------------
// AWS Credential Resolution
// ---------------------------------------------------------------------------

interface AWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Get the AWS region to use.
 */
function getAWSRegion(): string {
  return config.getProviderCred('bedrock').region || 'us-east-1';
}

// ---------------------------------------------------------------------------
// AWS Signature V4
// ---------------------------------------------------------------------------

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmacSha256(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data).digest();
}

function getSigningKey(secretKey: string, dateStamp: string, region: string, service: string): Buffer {
  const kDate = hmacSha256('AWS4' + secretKey, dateStamp);
  const kRegion = hmacSha256(kDate, region);
  const kService = hmacSha256(kRegion, service);
  return hmacSha256(kService, 'aws4_request');
}

interface SignedRequest {
  url: string;
  headers: Record<string, string>;
}

function signRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string,
  credentials: AWSCredentials,
  region: string,
  service: string
): SignedRequest {
  const parsedUrl = new URL(url);
  const now = new Date();
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  const dateStamp = amzDate.slice(0, 8);

  // Set required headers
  headers['x-amz-date'] = amzDate;
  headers['host'] = parsedUrl.host;
  if (credentials.sessionToken) {
    headers['x-amz-security-token'] = credentials.sessionToken;
  }

  // Canonical request. AWS SigV4 requires the canonical URI to be URI-encoded
  // TWICE for non-S3 services. parsedUrl.pathname is already once-encoded, so
  // we re-encode each segment (path separators kept unencoded).
  const canonicalUri = parsedUrl.pathname
    .split('/')
    .map(segment => encodeURIComponent(segment))
    .join('/');
  const canonicalQuerystring = parsedUrl.search ? parsedUrl.search.slice(1) : '';

  const signedHeaderKeys = Object.keys(headers)
    .map(k => k.toLowerCase())
    .sort();
  const signedHeaders = signedHeaderKeys.join(';');
  const canonicalHeaders = signedHeaderKeys
    .map(k => `${k}:${headers[Object.keys(headers).find(h => h.toLowerCase() === k)!]!.trim()}`)
    .join('\n') + '\n';

  const payloadHash = sha256(body);
  const canonicalRequest = [
    method,
    canonicalUri,
    canonicalQuerystring,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  // String to sign
  const credentialScope = `${dateStamp}/${region}/${service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    credentialScope,
    sha256(canonicalRequest),
  ].join('\n');

  // Signing key & signature
  const signingKey = getSigningKey(credentials.secretAccessKey, dateStamp, region, service);
  const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

  // Authorization header
  headers['Authorization'] =
    `AWS4-HMAC-SHA256 Credential=${credentials.accessKeyId}/${credentialScope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return { url, headers };
}

// ---------------------------------------------------------------------------
// Bedrock Converse API Message Conversion
// ---------------------------------------------------------------------------

interface BedrockContentBlock {
  text?: string;
  image?: {
    format: string;
    source: { bytes: string };
  };
  toolUse?: {
    toolUseId: string;
    name: string;
    input: Record<string, unknown>;
  };
  toolResult?: {
    toolUseId: string;
    content: Array<{ text: string }>;
  };
}

interface BedrockMessage {
  role: 'user' | 'assistant';
  content: BedrockContentBlock[];
}

/**
 * Convert internal messages to Bedrock Converse API format.
 * Returns { system, messages } — system is extracted separately.
 */
function toBedrockMessages(messages: Message[]): { system: Array<{ text: string }>; messages: BedrockMessage[] } {
  const systemParts: Array<{ text: string }> = [];
  const bedrockMessages: BedrockMessage[] = [];

  for (const msg of messages) {
    if (msg.role === 'system') {
      systemParts.push({ text: getTextContent(msg.content) });
      continue;
    }

    if (msg.role === 'tool') {
      // Tool results become user messages with toolResult content blocks.
      // Bedrock requires ALL toolResults for a preceding assistant's toolUses
      // to live in ONE user message (no two user messages in a row, and every
      // toolUseId must have a paired toolResult). If the last pushed message
      // is already a user/toolResult message, append to it instead of making
      // a new one — otherwise we get a 400 "Expected toolResult blocks at ...".
      const resultBlock: BedrockContentBlock = {
        toolResult: {
          toolUseId: msg.toolCallId || '',
          content: [{ text: typeof msg.content === 'string' ? msg.content : JSON.stringify(msg.content) }],
        },
      };
      const last = bedrockMessages[bedrockMessages.length - 1];
      if (last && last.role === 'user' && last.content.every(b => b.toolResult)) {
        last.content.push(resultBlock);
      } else {
        bedrockMessages.push({ role: 'user', content: [resultBlock] });
      }
      continue;
    }

    if (msg.role === 'assistant') {
      const blocks: BedrockContentBlock[] = [];
      const text = getTextContent(msg.content);
      if (text) blocks.push({ text });

      if (msg.toolCalls) {
        for (const tc of msg.toolCalls) {
          blocks.push({
            toolUse: {
              toolUseId: tc.id,
              name: tc.name,
              input: tc.arguments,
            },
          });
        }
      }

      const reasoning = msg.providerMetadata?.bedrock &&
        (msg.providerMetadata.bedrock as { reasoningContent?: unknown }).reasoningContent;
      const reasoningBlocks = reasoning
        ? (Array.isArray(reasoning) ? reasoning : [reasoning]).map(block => ({ reasoningContent: block })) as BedrockContentBlock[]
        : [];
      const orderedBlocks = [...reasoningBlocks, ...blocks];
      if (orderedBlocks.length > 0) {
        bedrockMessages.push({ role: 'assistant', content: orderedBlocks });
      }
      continue;
    }

    // User messages
    const blocks: BedrockContentBlock[] = [];
    if (typeof msg.content === 'string') {
      blocks.push({ text: msg.content || '(continued)' });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block.type === 'text') {
          blocks.push({ text: (block as TextContent).text });
        } else if (block.type === 'image') {
          const img = block as ImageContent;
          blocks.push({
            image: {
              format: img.mediaType.split('/')[1] as string,
              source: { bytes: img.data },
            },
          });
        }
      }
    }
    if (blocks.length > 0) {
      bedrockMessages.push({ role: 'user', content: blocks });
    }
  }

  return { system: systemParts, messages: bedrockMessages };
}

/**
 * Convert internal Tool definitions to Bedrock toolConfig format.
 */
function toBedrockToolConfig(tools: Tool[]): object | undefined {
  if (tools.length === 0) return undefined;
  return {
    tools: tools.map(t => ({
      toolSpec: {
        name: t.name,
        description: t.description,
        inputSchema: { json: t.parameters },
      },
    })),
  };
}

// ---------------------------------------------------------------------------
// Main Chat Function
// ---------------------------------------------------------------------------

/**
 * Chat with AWS Bedrock using the native Converse API.
 */
export async function chatBedrock(
  messages: Message[],
  tools: Tool[],
  model: string,
  onToken?: StreamCallback,
  signal?: AbortSignal,
  maxOutputTokens?: number,
  retainCompletedResponse = false,
): Promise<LLMResponse> {
  if (maxOutputTokens !== undefined && (!Number.isInteger(maxOutputTokens) || maxOutputTokens < 1)) throw new Error('maxOutputTokens must be a positive integer');
  const region = getAWSRegion();
  const credentials = await resolveBedrockCredentials(signal);
  const service = 'bedrock';

  // URL-encode the model ID (colons in model IDs need encoding)
  const encodedModel = encodeURIComponent(model);
  const isStreaming = !!onToken;
  const endpoint = isStreaming ? 'converse-stream' : 'converse';
  const baseUrl = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodedModel}/${endpoint}`;

  const { system, messages: bedrockMessages } = toBedrockMessages(messages);

  // Calculate dynamic max tokens
  const dynamicMaxTokens = calculateMaxTokens('bedrock', model, messages, tools, maxOutputTokens);
  debugLog(`Bedrock request: model=${model}, region=${region}, max_tokens=${dynamicMaxTokens}, streaming=${isStreaming}`);

  const requestBody: Record<string, unknown> = {
    messages: bedrockMessages,
    inferenceConfig: {
      maxTokens: Math.min(dynamicMaxTokens, maxOutputTokens ?? dynamicMaxTokens),
    },
  };

  if (system.length > 0) {
    requestBody.system = system;
  }

  const toolConfig = toBedrockToolConfig(tools);
  if (toolConfig) {
    requestBody.toolConfig = toolConfig;
  }

  const bodyStr = JSON.stringify(requestBody);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'Accept': isStreaming ? 'application/vnd.amazon.eventstream' : 'application/json',
  };

  const signed = signRequest('POST', baseUrl, headers, bodyStr, credentials, region, service);
  debugLog(`Bedrock signed request: url=${baseUrl}, host=${new URL(baseUrl).host}, body_sha256=${sha256(bodyStr)}, has_session_token=${!!credentials.sessionToken}, signed_headers=${Object.keys(signed.headers).filter(k => k !== 'Authorization').sort().join(';')}`);

  if (isStreaming) {
    return chatBedrockStreaming(signed.url, signed.headers, bodyStr, onToken!, signal, maxOutputTokens !== undefined, retainCompletedResponse);
  }

  // Non-streaming request
  const response = await fetch(signed.url, {
    method: 'POST',
    ...(signal ? { signal } : {}),
    headers: signed.headers,
    body: bodyStr,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw Object.assign(new Error(`Bedrock API error (${response.status}): ${errorBody}`), {status:response.status});
  }

  const data = await response.json() as {
    output?: {
      message?: {
        role: string;
        content: Array<{
          text?: string;
          toolUse?: { toolUseId: string; name: string; input: Record<string, unknown> };
          reasoningContent?: unknown;
        }>;
      };
    };
    stopReason?: string;
    usage?: { inputTokens: number; outputTokens: number };
  };

  if (retainCompletedResponse) assertBedrockTerminalResponse(data);

  // Parse response
  let content = '';
  const toolCalls: ToolCall[] = [];
  const reasoningContent: unknown[] = [];

  if (data.output?.message?.content) {
    for (const block of data.output.message.content) {
      if (block.text) {
        content += block.text;
      } else if (block.toolUse) {
        toolCalls.push({
          id: block.toolUse.toolUseId,
          name: block.toolUse.name,
          arguments: block.toolUse.input,
        });
      }
      if (block.reasoningContent) reasoningContent.push(block.reasoningContent);
    }
  }

  // Map stop reasons
  const finishReason = normalizeFinishReason(data.stopReason, toolCalls.length > 0);

  // Output limit inside a tool block: the cut-off call must not run (#487).
  const blocks = data.output?.message?.content;
  const truncatedToolCalls = finishReason === 'length' && Boolean(blocks?.[blocks.length - 1]?.toolUse);
  if (truncatedToolCalls) toolCalls.pop();

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    ...(truncatedToolCalls ? { truncatedToolCalls: true } : {}),
    ...(reasoningContent.length > 0 ? { providerMetadata: { bedrock: { reasoningContent } } } : {}),
    usage: data.usage ? {
      inputTokens: data.usage.inputTokens,
      outputTokens: data.usage.outputTokens,
    } : undefined,
  };
}

// ---------------------------------------------------------------------------
// Streaming Support (Bedrock Event Stream)
// ---------------------------------------------------------------------------

/**
 * Parse Bedrock event stream (AWS binary event stream protocol).
 *
 * Bedrock converse-stream returns `application/vnd.amazon.eventstream` which
 * is a binary framing protocol. However, for simplicity and to avoid pulling
 * in a binary parser, we request the streaming endpoint and parse the
 * line-delimited JSON events that Bedrock also supports via the
 * `x-amzn-bedrock-*` event headers.
 *
 * The actual event stream uses a binary format with prelude (8 bytes),
 * headers, and payload. We parse it manually.
 */
async function chatBedrockStreaming(
  url: string,
  headers: Record<string, string>,
  body: string,
  onToken: StreamCallback,
  signal?: AbortSignal,
  bounded = false,
  retainCompletedResponse = false
): Promise<LLMResponse> {
  const response = await fetch(url, {
    method: 'POST',
    ...(signal ? { signal } : {}),
    headers,
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw Object.assign(new Error(`Bedrock streaming API error (${response.status}): ${errorBody}`), { status: response.status });
  }

  let content = '';
  const toolCalls: ToolCall[] = [];
  const reasoningContent: unknown[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let usageSeen = false;
  let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';
  let currentToolId = '';
  const unparsedToolIds = new Set<string>();
  let currentToolName = '';
  let currentToolInput = '';
  const blocks = retainCompletedResponse ? new BedrockBlocks() : undefined;

  let messageStarted = false, contentStarted = false;
  let completed = false;
  const normalized = (): LLMResponse => {
    const assembled = blocks?.result(finishReason);
    let truncatedToolCalls = assembled?.truncatedToolCalls ?? false;
    let keptToolCalls = assembled?.toolCalls ?? toolCalls;
    const keptReasoning = assembled?.reasoningContent ?? reasoningContent;
    if (!blocks && finishReason === 'length') {
      truncatedToolCalls = unparsedToolIds.size > 0 || Boolean(currentToolId);
      keptToolCalls = toolCalls.filter((tc) => !unparsedToolIds.has(tc.id));
    }
    if (retainCompletedResponse && finishReason !== 'length' && (unparsedToolIds.size || currentToolId))
      throw new StreamProtocolError('Malformed or incomplete provider tool arguments; its reservation remains charged.');
    return {
      content,
      toolCalls: keptToolCalls.length > 0 ? keptToolCalls : undefined,
      finishReason: blocks ? normalizeFinishReason(finishReason, keptToolCalls.length > 0) : finishReason,
      ...(truncatedToolCalls ? { truncatedToolCalls: true } : {}),
      ...(keptReasoning.length > 0 ? { providerMetadata: { bedrock: { reasoningContent: keptReasoning } } } : {}),
      usage: bounded && !usageSeen ? undefined : { inputTokens, outputTokens },
    };
  };

  // Read the response body as a stream of bytes and parse events
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Bedrock streaming response has no body');
  }

  let buffer = Buffer.alloc(0);
  const decode = (bytes: Uint8Array): string => {
    if (!retainCompletedResponse) return Buffer.from(bytes).toString('utf-8');
    try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes); }
    catch { throw new StreamProtocolError('Bedrock stream contains invalid UTF-8; its reservation remains charged.'); }
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer = Buffer.concat([buffer, Buffer.from(value)]);

      // Parse complete events from the buffer.
      // AWS event stream binary format:
      //   Prelude: total_length (4 bytes BE) + headers_length (4 bytes BE) + prelude_crc (4 bytes BE)
      //   Headers: variable length
      //   Payload: variable length
      //   Message CRC: 4 bytes
      while (buffer.length >= 12) {
        if (crc32(buffer.subarray(0, 8)) !== buffer.readUInt32BE(8))
          throw new StreamProtocolError('Bedrock stream has an invalid prelude checksum; its reservation remains charged.');
        const totalLength = buffer.readUInt32BE(0);
        const headersLength = buffer.readUInt32BE(4);
        if (totalLength < 16 || headersLength > totalLength - 16)
          throw new StreamProtocolError('Bedrock stream has invalid frame lengths; its reservation remains charged.');

        if (buffer.length < totalLength) break; // Wait for more data
        if (crc32(buffer.subarray(0, totalLength - 4)) !== buffer.readUInt32BE(totalLength - 4))
          throw new StreamProtocolError('Bedrock stream has an invalid message checksum; its reservation remains charged.');

        const headersStart = 12;
        const headersEnd = headersStart + headersLength;
        const payloadStart = headersEnd;
        const payloadEnd = totalLength - 4; // Last 4 bytes are message CRC

        // Parse headers to find :event-type
        let eventType = '';
        let pos = headersStart;
        const take = (length: number): number => {
          if (length < 0 || pos + length > headersEnd)
            throw new StreamProtocolError('Bedrock stream header exceeds its frame; its reservation remains charged.');
          const start = pos; pos += length; return start;
        };
        while (pos < headersEnd) {
          const nameLen = buffer.readUInt8(take(1));
          const nameStart = take(nameLen);
          const name = decode(buffer.subarray(nameStart, pos));
          const headerType = buffer.readUInt8(take(1));
          if (headerType === 7) {
            const valueLen = buffer.readUInt16BE(take(2));
            const valueStart = take(valueLen);
            const val = decode(buffer.subarray(valueStart, pos));
            if (name === ':event-type') eventType = val;
            if (name === ':exception-type') eventType = 'exception:' + val;
          } else if (headerType === 0 || headerType === 1) {
            // Boolean header values have no additional bytes.
          } else if (headerType === 2) take(1);
          else if (headerType === 3) take(2);
          else if (headerType === 4) take(4);
          else if (headerType === 5 || headerType === 8) take(8);
          else if (headerType === 6) { const length = buffer.readUInt16BE(take(2)); take(length); }
          else if (headerType === 9) take(16);
          else {
            if (retainCompletedResponse) throw new StreamProtocolError('Bedrock stream has unsupported header encoding; its reservation remains charged.');
            break;
          }
        }

        // Extract payload
        const payload = decode(buffer.subarray(payloadStart, payloadEnd));

        // Advance buffer past this event
        buffer = buffer.subarray(totalLength);

        // Handle exceptions
        if (eventType.startsWith('exception:')) {
          completed = false;
          try {
            const errData = JSON.parse(payload);
            throw new Error(`Bedrock stream error (${eventType}): ${errData.message || payload}`);
          } catch (e) {
            if (e instanceof Error && e.message.startsWith('Bedrock stream error')) throw e;
            throw new Error(`Bedrock stream error (${eventType}): ${payload}`);
          }
        }

        // Skip empty payloads
        if (!payload.trim()) {
          if (retainCompletedResponse) {
            completed = false;
            throw new StreamProtocolError('Bedrock stream has an empty event payload; its reservation remains charged.');
          }
          continue;
        }

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload);
        } catch {
          if (retainCompletedResponse) {
            completed = false;
            throw new StreamProtocolError('Bedrock stream has malformed JSON; its reservation remains charged.');
          }
          debugLog('Failed to parse Bedrock event payload:', payload);
          continue;
        }

        if (!event || typeof event !== 'object' || Array.isArray(event)) {
          completed = false;
          throw new StreamProtocolError('Bedrock stream has an invalid event object; its reservation remains charged.');
        }
        const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
        const invalidEvent = () => new StreamProtocolError('Bedrock stream has invalid event fields; its reservation remains charged.');
        if (eventType === 'contentBlockDelta' && (!object(event.delta) ||
            (event.delta.text !== undefined && typeof event.delta.text !== 'string') ||
            (event.delta.toolUse !== undefined && (!object(event.delta.toolUse) || typeof event.delta.toolUse.input !== 'string')))) throw invalidEvent();
        if (eventType === 'contentBlockStart' && event.start !== undefined && (!object(event.start) ||
            (event.start.toolUse !== undefined && (!object(event.start.toolUse) || typeof event.start.toolUse.toolUseId !== 'string' || typeof event.start.toolUse.name !== 'string')))) throw invalidEvent();
        if (retainCompletedResponse && eventType === 'messageStart') {
          if (messageStarted || contentStarted || event.role !== 'assistant') throw invalidEvent();
          messageStarted = true;
        }
        if (retainCompletedResponse && ['contentBlockStart','contentBlockDelta','contentBlockStop'].includes(eventType)) contentStarted = true;
        if (eventType === 'messageStop' && (typeof event.stopReason !== 'string' || !event.stopReason)) throw invalidEvent();
        if (retainCompletedResponse && eventType === 'messageStop') assertTerminalReason(event.stopReason, 'bedrock');
        if (eventType === 'metadata' && event.usage !== undefined && (!object(event.usage) ||
            [event.usage.inputTokens, event.usage.outputTokens].some(value => typeof value !== 'number' || !Number.isFinite(value) || value < 0))) throw invalidEvent();

        if (retainCompletedResponse && eventType === 'contentBlockDelta' && object(event.delta) && event.delta.reasoningContent !== undefined)
          assertBedrockReasoning(event.delta.reasoningContent,true);
        if (retainCompletedResponse && eventType === 'metadata' && event.usage !== undefined)
          assertBedrockUsage(event.usage, usageSeen ? { inputTokens, outputTokens } : undefined);

        if(retainCompletedResponse && completed && eventType!=='metadata') throw new StreamProtocolError('Bedrock data followed terminal proof; its reservation remains charged.');

        // Process event based on type
        switch (eventType) {
          case 'contentBlockStart': {
            const start = event as { contentBlockIndex?: number; start?: { toolUse?: { toolUseId: string; name: string } } };
            if (start.start?.toolUse) {
              if (blocks) { blocks.startTool(start.contentBlockIndex, start.start.toolUse.toolUseId, start.start.toolUse.name); break; }
              currentToolId = start.start.toolUse.toolUseId;
              currentToolName = start.start.toolUse.name;
              currentToolInput = '';
            }
            break;
          }
          case 'contentBlockDelta': {
            const delta = event as { delta?: { text?: string; toolUse?: { input?: string }; reasoningContent?: unknown } };
            if (blocks) {
              const fields = ['text','toolUse','reasoningContent'].filter(key => (event.delta as Record<string, unknown>)[key] !== undefined);
              if (fields.length !== 1) throw invalidEvent();
              if (delta.delta?.text !== undefined) {
                blocks.textDelta(event.contentBlockIndex);
                content += delta.delta.text;
                if (delta.delta.text) onToken(delta.delta.text);
              } else if (delta.delta?.toolUse !== undefined) blocks.toolDelta(event.contentBlockIndex, delta.delta.toolUse.input);
              else blocks.reasoningDelta(event.contentBlockIndex, delta.delta?.reasoningContent);
              break;
            }
            if (delta.delta?.text) {
              content += delta.delta.text;
              onToken(delta.delta.text);
            }
            if (delta.delta?.toolUse?.input) {
              currentToolInput += delta.delta.toolUse.input;
            }
            if (delta.delta?.reasoningContent) reasoningContent.push(delta.delta.reasoningContent);
            break;
          }
          case 'contentBlockStop': {
            if (blocks) { blocks.stop(event.contentBlockIndex); break; }
            if (currentToolId && currentToolName) {
              try {
                const parsed = JSON.parse(currentToolInput || '{}');
                if (retainCompletedResponse) assertToolArgumentObject(parsed);
                toolCalls.push({
                  id: currentToolId,
                  name: currentToolName,
                  arguments: parsed,
                });
              } catch {
                unparsedToolIds.add(currentToolId);
                toolCalls.push({
                  id: currentToolId,
                  name: currentToolName,
                  arguments: {},
                });
              }
              currentToolId = '';
              currentToolName = '';
              currentToolInput = '';
            }
            break;
          }
          case 'messageStop': {
            const stop = event as { stopReason?: string };
            finishReason = normalizeFinishReason(stop.stopReason, toolCalls.length > 0);
            blocks?.result(finishReason);
            completed = typeof stop.stopReason === 'string' && !!stop.stopReason;
            break;
          }
          case 'metadata': {
            const meta = event as { usage?: { inputTokens: number; outputTokens: number } };
            if (meta.usage) {
              usageSeen = typeof meta.usage.inputTokens === 'number' && typeof meta.usage.outputTokens === 'number';
              inputTokens = meta.usage.inputTokens;
              outputTokens = meta.usage.outputTokens;
            }
            break;
          }
          default:
            // messageStart, other events — ignore
            break;
        }
      }
    }
    throwIfCancelled(signal);
    if (retainCompletedResponse && buffer.length) completed = false;
    if (retainCompletedResponse && !completed) throw new StreamProtocolError('Bedrock stream ended without terminal proof; its reservation remains charged.');
    return normalized();
  } catch (error) {
    if (retainCompletedResponse && buffer.length && !(error instanceof StreamProtocolError))
      throw new StreamProtocolError('Bedrock stream has an incomplete frame; its reservation remains charged.');
    if (retainCompletedResponse && completed && buffer.length === 0) interruptCompletedResponse(normalized(), error);
    throw error;
  } finally {
    reader.releaseLock();
  }

}

/**
 * Detect declared AWS credential sources; the SDK validates identity at use.
 */
export function hasAWSCredentials(): boolean {
  // Prefer the live HOME override. Test workers and embedded callers may
  // redirect HOME after node:os has been imported; os.homedir() can otherwise
  // keep pointing at the caller's real profile and make an unrelated AWS
  // profile appear configured.
  const awsHome = process.env.HOME || process.env.USERPROFILE || homedir();
  // Check env vars
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return true;
  if (process.env.AWS_CONTAINER_CREDENTIALS_FULL_URI || process.env.AWS_CONTAINER_CREDENTIALS_RELATIVE_URI) return true;
  if (process.env.AWS_ROLE_ARN && process.env.AWS_WEB_IDENTITY_TOKEN_FILE) return true;

  // Check for named profile
  if (process.env.AWS_PROFILE) {
    const awsDir = join(awsHome, '.aws');
    if (existsSync(process.env.AWS_SHARED_CREDENTIALS_FILE || join(awsDir, 'credentials')) || existsSync(process.env.AWS_CONFIG_FILE || join(awsDir, 'config'))) {
      return true;
    }
  }

  // Check default profile
  const credPath = process.env.AWS_SHARED_CREDENTIALS_FILE || join(awsHome, '.aws', 'credentials');
  const configPath = process.env.AWS_CONFIG_FILE || join(awsHome, '.aws', 'config');
  if (existsSync(credPath) || existsSync(configPath)) return true;

  return false;
}
