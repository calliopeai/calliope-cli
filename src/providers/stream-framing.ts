import { StreamProtocolError } from '../errors.js';

/** Observe frame boundaries only, without storing raw response contents or changing transport authority. */
export class StreamFramingWitness {
  private observed = false;
  private invalid = false;
  private finalized = false;
  private decoder = new TextDecoder('utf-8', { fatal: true });
  private lineLength = 0;
  private comment = false;
  private framePending = false;
  private skipLF = false;
  readonly fetch: typeof globalThis.fetch;
  constructor(baseFetch = globalThis.fetch) {
    this.fetch = async (input, init) => {
      const response = await baseFetch(input, init);
      if (!response.ok || !response.body || !response.headers.get('content-type')?.toLowerCase().includes('text/event-stream')) return response;
      if (this.observed) throw new StreamProtocolError('Provider stream transport repeated without new admission.');
      this.observed = true;
      const reader = response.body.getReader();
      const release = () => { try { reader.releaseLock(); } catch {} };
      const body = new ReadableStream<Uint8Array>({
        pull: async controller => {
          try {
            const value = await reader.read();
            if (value.done) { this.finish(); controller.close(); release(); return; }
            try { this.consume(this.decoder.decode(value.value, { stream: true })); }
            catch { this.invalid = true; throw new StreamProtocolError('Provider stream contains invalid UTF-8; its reservation remains charged.'); }
            controller.enqueue(value.value);
          } catch (error) {
            this.finish();
            if (error instanceof TypeError && this.invalid) error = new StreamProtocolError('Provider stream contains invalid UTF-8; its reservation remains charged.');
            controller.error(error); release();
          }
        },
        cancel: async reason => { this.finish(); try { await reader.cancel(reason); } finally { release(); } },
      }, { highWaterMark: 0 });
      const wrapped = new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
      Object.defineProperty(wrapped, 'url', { value: response.url });
      return wrapped;
    };
  }
  private consume(text: string): void {
    for (const character of text) {
      if (this.skipLF) { this.skipLF = false; if (character === '\n') continue; }
      if (character === '\r' || character === '\n') {
        if (!this.lineLength) this.framePending = false;
        else if (!this.comment) this.framePending = true;
        this.lineLength = 0; this.comment = false; this.skipLF = character === '\r';
      } else { if (!this.lineLength) this.comment = character === ':'; this.lineLength++; }
    }
  }
  private finish(): void {
    if (this.finalized) return;
    this.finalized = true;
    try { this.consume(this.decoder.decode()); } catch { this.invalid = true; }
  }
  assertInterruptionBoundary(): void {
    if (this.observed) this.assertBoundary();
  }
  assertBoundary(): void {
    this.finish();
    if (!this.observed || this.invalid || this.lineLength || this.framePending)
      throw new StreamProtocolError('Provider stream has an incomplete or invalid frame; its reservation remains charged.');
  }
}
