/** Shared cancellation semantics for provider requests, retries, and clients. */
export function cancellationError(): Error {
  const error = new Error('Operation cancelled');
  error.name = 'AbortError';
  return error;
}

export function isCancellation(error: unknown): boolean {
  return error instanceof Error && (error.name === 'AbortError' || error.name === 'APIUserAbortError');
}

export function throwIfCancelled(signal?: AbortSignal): void {
  if (signal?.aborted) throw cancellationError();
}

/** Stop waiting on a client/SDK promise. Callers must also pass the signal to I/O. */
export function cancellable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const abort = () => reject(cancellationError());
    if (signal.aborted) abort();
    else signal.addEventListener('abort', abort, { once: true });
    promise.then(
      value => { signal.removeEventListener('abort', abort); signal.aborted ? abort() : resolve(value); },
      error => { signal.removeEventListener('abort', abort); reject(signal.aborted ? cancellationError() : error); },
    );
  });
}

export function cancellableDelay(ms: number, signal?: AbortSignal): Promise<void> {
  throwIfCancelled(signal);
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      signal?.removeEventListener('abort', abort);
      reject(cancellationError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', abort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
