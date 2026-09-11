import { AsyncLocalStorage } from 'node:async_hooks';

const session = new AsyncLocalStorage<string>();
/** Pin legacy session-scoped tools to the calling runtime, including parallel turns. */
export function withSession<T>(id: string, action: () => T): T { return session.run(id, action); }
export function activeSessionId(): string | undefined { return session.getStore(); }
