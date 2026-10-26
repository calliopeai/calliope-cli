import type {AnyMessage} from '@agentclientprotocol/sdk';
/** Bound untrusted message complexity before the SDK's schema validators run. */
export const ACP_INPUT_LIMITS = {
  depth: 64,
  nodes: 16384,
  collection: 4096,
  stringBytes: 32 * 1024 * 1024,
} as const;

export function assertAcpInputBounds(message: unknown): void {
  const pending = [{value: message, depth: 0}];
  let nodes = 0, stringBytes = 0;
  const refuse = (): never => { throw new RangeError('ACP message exceeds the input complexity limit.'); };
  while (pending.length) {
    const {value, depth} = pending.pop()!;
    if (++nodes > ACP_INPUT_LIMITS.nodes || depth > ACP_INPUT_LIMITS.depth) refuse();
    if (typeof value === 'string') {
      stringBytes += Buffer.byteLength(value);
      if (stringBytes > ACP_INPUT_LIMITS.stringBytes) refuse();
    } else if (value && typeof value === 'object') {
      if (Array.isArray(value) && value.length > ACP_INPUT_LIMITS.collection) refuse();
      const keys = Object.keys(value);
      if (keys.length > ACP_INPUT_LIMITS.collection || nodes + pending.length + keys.length > ACP_INPUT_LIMITS.nodes) refuse();
      for (const key of keys) {
        stringBytes += Buffer.byteLength(key);
        if (stringBytes > ACP_INPUT_LIMITS.stringBytes) refuse();
        pending.push({value: (value as Record<string, unknown>)[key], depth: depth + 1});
      }
    }
  }
}

export const ACP_INPUT_LIMIT_METHOD = '_calliope/input_limit';
export function boundAcpInput(input: ReadableStream<AnyMessage>): ReadableStream<AnyMessage> {
  return input.pipeThrough(new TransformStream<AnyMessage, AnyMessage>({
    transform(message, controller) {
      try { assertAcpInputBounds(message); }
      catch {
        // Reject through the SDK without sending the oversized value to Zod.
        // Notifications have no response; an oversized reply rejects its waiter.
        if ('id' in message && (typeof message.id === 'number' || message.id === null || typeof message.id === 'string' && message.id.length <= 256)) {
          if ('method' in message) controller.enqueue({jsonrpc:'2.0',id:message.id,method:ACP_INPUT_LIMIT_METHOD});
          else controller.enqueue({jsonrpc:'2.0',id:message.id,error:{code:-32602,message:'ACP input complexity limit exceeded.'}});
        }
        return;
      }
      controller.enqueue(message);
    },
  }));
}
