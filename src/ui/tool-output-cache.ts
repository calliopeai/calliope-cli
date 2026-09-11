import { MAX_TOOL_OUTPUT_BYTES, MAX_TOOL_OUTPUTS, type CapturedToolOutput } from '../sessions/index.js';
/** Only failed disk writes need an in-memory fallback, scoped to one session. */
export class ToolOutputCache {
  private sessionId: string | undefined;
  private entries = new Map<string, { output: CapturedToolOutput; bytes: number }>();
  private bytes = 0;
  private bind(sessionId?: string): void { if (this.sessionId !== sessionId) { this.clear(); this.sessionId = sessionId; } }
  remember(output: CapturedToolOutput, sessionId?: string): void {
    this.bind(sessionId); if (output.saved || this.entries.has(output.record.id)) return;
    const bytes = Buffer.byteLength(JSON.stringify(output)); this.entries.set(output.record.id, { output, bytes }); this.bytes += bytes;
    while (this.entries.size > MAX_TOOL_OUTPUTS || this.bytes > MAX_TOOL_OUTPUT_BYTES) {
      const [id, entry] = this.entries.entries().next().value!; this.entries.delete(id); this.bytes -= entry.bytes;
    }
  }
  read(sessionId?: string): CapturedToolOutput[] { this.bind(sessionId); return [...this.entries.values()].map(entry => entry.output); }
  clear(): void { this.entries.clear(); this.bytes = 0; }
}
