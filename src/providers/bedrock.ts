/**
 * AWS Bedrock Provider - Native Converse API
 *
 * Uses the Bedrock Converse API directly with AWS Signature V4 signing.
 * No AWS SDK dependency required — uses built-in crypto, fetch, and fs.
 */

import { createHmac, createHash } from 'crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';
import * as config from '../config.js';
import type { Message, Tool, LLMResponse, ToolCall, TextContent, ImageContent, MessageContent } from '../types.js';
import { getTextContent, calculateMaxTokens, debugLog, type StreamCallback } from './types.js';

// ---------------------------------------------------------------------------
// AWS Credential Resolution
// ---------------------------------------------------------------------------

interface AWSCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

/**
 * Parse an INI-style AWS config/credentials file into sections.
 */
function parseIniFile(filePath: string): Record<string, Record<string, string>> {
  if (!existsSync(filePath)) return {};
  const content = readFileSync(filePath, 'utf-8');
  const sections: Record<string, Record<string, string>> = {};
  let currentSection = '';

  for (const rawLine of content.split('\n')) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#') || line.startsWith(';')) continue;
    const sectionMatch = line.match(/^\[(.+)\]$/);
    if (sectionMatch) {
      currentSection = sectionMatch[1].replace(/^profile\s+/, '');
      sections[currentSection] = sections[currentSection] || {};
      continue;
    }
    const kvMatch = line.match(/^([^=]+?)\s*=\s*(.+)$/);
    if (kvMatch && currentSection) {
      sections[currentSection][kvMatch[1].trim()] = kvMatch[2].trim();
    }
  }
  return sections;
}

/**
 * Shell out to the AWS CLI to resolve credentials for a profile. This covers
 * SSO profiles, role-assumption profiles, and anything else AWS CLI supports.
 */
async function resolveCredentialsViaCli(profile: string): Promise<AWSCredentials | null> {
  try {
    const { execFileSync } = await import('child_process');
    // Prefer `--format env-no-export` (simpler KEY=value), fall back to `env`.
    let output = '';
    try {
      output = execFileSync(
        'aws',
        ['configure', 'export-credentials', '--profile', profile, '--format', 'env-no-export'],
        { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    } catch {
      output = execFileSync(
        'aws',
        ['configure', 'export-credentials', '--profile', profile, '--format', 'env'],
        { encoding: 'utf-8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'] }
      );
    }
    const envs: Record<string, string> = {};
    for (const rawLine of output.split(/\r?\n/)) {
      const line = rawLine.trim();
      // Matches both "export KEY=value" and "KEY=value"
      const match = line.match(/^(?:export\s+)?([A-Z_]+)\s*=\s*(.+)$/);
      if (!match) continue;
      // Strip exactly one pair of surrounding quotes (not all quotes).
      let val = match[2].trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      envs[match[1]] = val;
    }
    if (envs.AWS_ACCESS_KEY_ID && envs.AWS_SECRET_ACCESS_KEY) {
      return {
        accessKeyId: envs.AWS_ACCESS_KEY_ID,
        secretAccessKey: envs.AWS_SECRET_ACCESS_KEY,
        sessionToken: envs.AWS_SESSION_TOKEN,
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Resolve AWS credentials from environment variables, shared credential files,
 * or the AWS CLI (for SSO / role-assumption profiles).
 */
async function getAWSCredentials(): Promise<AWSCredentials> {
  // 1. Explicit env vars
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) {
    return {
      accessKeyId: process.env.AWS_ACCESS_KEY_ID,
      secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY,
      sessionToken: process.env.AWS_SESSION_TOKEN,
    };
  }

  // 2. Named profile from env or config
  const profile = config.getProviderCred('bedrock').profile || 'default';
  const awsDir = join(homedir(), '.aws');

  // Check credentials file
  const credSections = parseIniFile(join(awsDir, 'credentials'));
  const cred = credSections[profile];
  if (cred?.aws_access_key_id && cred?.aws_secret_access_key) {
    return {
      accessKeyId: cred.aws_access_key_id,
      secretAccessKey: cred.aws_secret_access_key,
      sessionToken: cred.aws_session_token,
    };
  }

  // Check config file (some setups put creds here)
  const configSections = parseIniFile(join(awsDir, 'config'));
  const cfg = configSections[profile];
  if (cfg?.aws_access_key_id && cfg?.aws_secret_access_key) {
    return {
      accessKeyId: cfg.aws_access_key_id,
      secretAccessKey: cfg.aws_secret_access_key,
      sessionToken: cfg.aws_session_token,
    };
  }

  // 3. Ask the AWS CLI (handles SSO, role assumption, etc.).
  const cliCreds = await resolveCredentialsViaCli(profile);
  if (cliCreds) return cliCreds;

  throw new Error(
    `AWS credentials not found for profile "${profile}". ` +
    `For SSO: run \`aws sso login --profile ${profile}\`. ` +
    `For static keys: set AWS_ACCESS_KEY_ID + AWS_SECRET_ACCESS_KEY, ` +
    `or configure ~/.aws/credentials.`
  );
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
    .map(k => `${k}:${headers[Object.keys(headers).find(h => h.toLowerCase() === k)!].trim()}`)
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

      if (blocks.length > 0) {
        bedrockMessages.push({ role: 'assistant', content: blocks });
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
  onToken?: StreamCallback
): Promise<LLMResponse> {
  const credentials = await getAWSCredentials();
  const region = getAWSRegion();
  const service = 'bedrock';

  // URL-encode the model ID (colons in model IDs need encoding)
  const encodedModel = encodeURIComponent(model);
  const isStreaming = !!onToken;
  const endpoint = isStreaming ? 'converse-stream' : 'converse';
  const baseUrl = `https://bedrock-runtime.${region}.amazonaws.com/model/${encodedModel}/${endpoint}`;

  const { system, messages: bedrockMessages } = toBedrockMessages(messages);

  // Calculate dynamic max tokens
  const dynamicMaxTokens = calculateMaxTokens('bedrock', model, messages, tools);
  debugLog(`Bedrock request: model=${model}, region=${region}, max_tokens=${dynamicMaxTokens}, streaming=${isStreaming}`);

  const requestBody: Record<string, unknown> = {
    messages: bedrockMessages,
    inferenceConfig: {
      maxTokens: dynamicMaxTokens,
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
  debugLog(`Bedrock signed request: url=${baseUrl}, host=${new URL(baseUrl).host}, body_sha256=${sha256(bodyStr)}, access_key_prefix=${credentials.accessKeyId.slice(0, 4)}, has_session_token=${!!credentials.sessionToken}, signed_headers=${Object.keys(signed.headers).filter(k => k !== 'Authorization').sort().join(';')}`);

  if (isStreaming) {
    return chatBedrockStreaming(signed.url, signed.headers, bodyStr, onToken!);
  }

  // Non-streaming request
  const response = await fetch(signed.url, {
    method: 'POST',
    headers: signed.headers,
    body: bodyStr,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Bedrock API error (${response.status}): ${errorBody}`);
  }

  const data = await response.json() as {
    output?: {
      message?: {
        role: string;
        content: Array<{
          text?: string;
          toolUse?: { toolUseId: string; name: string; input: Record<string, unknown> };
        }>;
      };
    };
    stopReason?: string;
    usage?: { inputTokens: number; outputTokens: number };
  };

  // Parse response
  let content = '';
  const toolCalls: ToolCall[] = [];

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
    }
  }

  // Map stop reasons
  let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';
  if (data.stopReason === 'tool_use') {
    finishReason = 'tool_use';
  } else if (data.stopReason === 'max_tokens') {
    finishReason = 'length';
  }

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
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
  onToken: StreamCallback
): Promise<LLMResponse> {
  const response = await fetch(url, {
    method: 'POST',
    headers,
    body,
  });

  if (!response.ok) {
    const errorBody = await response.text();
    throw new Error(`Bedrock streaming API error (${response.status}): ${errorBody}`);
  }

  let content = '';
  const toolCalls: ToolCall[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  let finishReason: 'stop' | 'tool_use' | 'length' | 'error' = 'stop';
  let currentToolId = '';
  let currentToolName = '';
  let currentToolInput = '';

  // Read the response body as a stream of bytes and parse events
  const reader = response.body?.getReader();
  if (!reader) {
    throw new Error('Bedrock streaming response has no body');
  }

  let buffer = Buffer.alloc(0);

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
        const totalLength = buffer.readUInt32BE(0);
        const headersLength = buffer.readUInt32BE(4);
        // prelude CRC at offset 8 (4 bytes) — we skip validation

        if (buffer.length < totalLength) break; // Wait for more data

        const headersStart = 12;
        const headersEnd = headersStart + headersLength;
        const payloadStart = headersEnd;
        const payloadEnd = totalLength - 4; // Last 4 bytes are message CRC

        // Parse headers to find :event-type
        let eventType = '';
        let pos = headersStart;
        while (pos < headersEnd) {
          const nameLen = buffer.readUInt8(pos);
          pos += 1;
          const name = buffer.toString('utf-8', pos, pos + nameLen);
          pos += nameLen;
          const headerType = buffer.readUInt8(pos);
          pos += 1;

          if (headerType === 7) {
            // String type
            const valueLen = buffer.readUInt16BE(pos);
            pos += 2;
            const val = buffer.toString('utf-8', pos, pos + valueLen);
            pos += valueLen;
            if (name === ':event-type') eventType = val;
            if (name === ':exception-type') eventType = 'exception:' + val;
          } else if (headerType === 0) {
            // Bool true
            // no additional bytes
          } else if (headerType === 1) {
            // Bool false
            // no additional bytes
          } else if (headerType === 2) {
            // Byte
            pos += 1;
          } else if (headerType === 3) {
            // Short
            pos += 2;
          } else if (headerType === 4) {
            // Int
            pos += 4;
          } else if (headerType === 5) {
            // Long
            pos += 8;
          } else if (headerType === 6) {
            // Bytes
            const bLen = buffer.readUInt16BE(pos);
            pos += 2 + bLen;
          } else if (headerType === 8) {
            // Timestamp
            pos += 8;
          } else if (headerType === 9) {
            // UUID
            pos += 16;
          } else {
            // Unknown header type, skip to end of headers
            break;
          }
        }

        // Extract payload
        const payload = buffer.toString('utf-8', payloadStart, payloadEnd);

        // Advance buffer past this event
        buffer = buffer.subarray(totalLength);

        // Handle exceptions
        if (eventType.startsWith('exception:')) {
          try {
            const errData = JSON.parse(payload);
            throw new Error(`Bedrock stream error (${eventType}): ${errData.message || payload}`);
          } catch (e) {
            if (e instanceof Error && e.message.startsWith('Bedrock stream error')) throw e;
            throw new Error(`Bedrock stream error (${eventType}): ${payload}`);
          }
        }

        // Skip empty payloads
        if (!payload.trim()) continue;

        let event: Record<string, unknown>;
        try {
          event = JSON.parse(payload);
        } catch {
          debugLog('Failed to parse Bedrock event payload:', payload);
          continue;
        }

        // Process event based on type
        switch (eventType) {
          case 'contentBlockStart': {
            const start = event as { contentBlockIndex?: number; start?: { toolUse?: { toolUseId: string; name: string } } };
            if (start.start?.toolUse) {
              currentToolId = start.start.toolUse.toolUseId;
              currentToolName = start.start.toolUse.name;
              currentToolInput = '';
            }
            break;
          }
          case 'contentBlockDelta': {
            const delta = event as { delta?: { text?: string; toolUse?: { input?: string } } };
            if (delta.delta?.text) {
              content += delta.delta.text;
              onToken(delta.delta.text);
            }
            if (delta.delta?.toolUse?.input) {
              currentToolInput += delta.delta.toolUse.input;
            }
            break;
          }
          case 'contentBlockStop': {
            if (currentToolId && currentToolName) {
              try {
                toolCalls.push({
                  id: currentToolId,
                  name: currentToolName,
                  arguments: JSON.parse(currentToolInput || '{}'),
                });
              } catch {
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
            if (stop.stopReason === 'tool_use') {
              finishReason = 'tool_use';
            } else if (stop.stopReason === 'max_tokens') {
              finishReason = 'length';
            }
            break;
          }
          case 'metadata': {
            const meta = event as { usage?: { inputTokens: number; outputTokens: number } };
            if (meta.usage) {
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
  } finally {
    reader.releaseLock();
  }

  return {
    content,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    finishReason,
    usage: { inputTokens, outputTokens },
  };
}

/**
 * Check if native AWS credentials are available (for provider detection).
 */
export function hasAWSCredentials(): boolean {
  // Check env vars
  if (process.env.AWS_ACCESS_KEY_ID && process.env.AWS_SECRET_ACCESS_KEY) return true;

  // Check for named profile
  if (process.env.AWS_PROFILE) {
    const awsDir = join(homedir(), '.aws');
    if (existsSync(join(awsDir, 'credentials')) || existsSync(join(awsDir, 'config'))) {
      return true;
    }
  }

  // Check default profile
  const credPath = join(homedir(), '.aws', 'credentials');
  if (existsSync(credPath)) return true;

  return false;
}
