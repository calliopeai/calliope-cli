import { approvalDisplayText } from '../approvals/index.js';
import type { ActivityState } from './types.js';
export interface ActiveTool { id: string; name: string; phase: 'pending' | 'running' | 'retrying'; startTime: number; detail?: string }
/** Bound display state and retain start times across output chunks. */
export class ToolProgress {
  private tools = new Map<string, ActiveTool>();
  private omitted = 0;
  constructor(private readonly now = () => Date.now()) {}
  start(id: string, name: string): void {
    if (this.tools.has(id)) return;
    if (this.tools.size >= 256) { this.omitted++; return; }
    this.tools.set(id, { id, name: approvalDisplayText(name), phase: 'pending', startTime: this.now() });
  }
  running(id: string): void { const tool = this.tools.get(id); if (tool) { tool.phase = 'running'; tool.startTime = this.now(); } }
  retry(id: string): void { const tool = this.tools.get(id); if (tool) tool.phase = 'retrying'; }
  output(id: string, chunk: string): void {
    const tool = this.tools.get(id); if (!tool) return;
    tool.detail = approvalDisplayText(chunk.slice(-512).trimEnd().split('\n').at(-1) ?? '').slice(0, 100);
  }
  finish(id: string): void { if (!this.tools.delete(id)) this.omitted = Math.max(0, this.omitted - 1); }
  clear(): void { this.tools.clear(); this.omitted = 0; }
  snapshot(): ActivityState | null {
    const tools = [...this.tools.values()]; if (!tools.length && !this.omitted) return null;
    return { action: `${tools.length + this.omitted} active tool${tools.length + this.omitted === 1 ? '' : 's'}`, startTime: Math.min(this.now(), ...tools.map(tool => tool.startTime)),
      target: tools.slice(0, 3).map(tool => tool.name).join(', '), tools: tools.slice(0, 8).map(tool => ({ ...tool })), omittedTools: Math.max(0, tools.length - 8) + this.omitted };
  }
}
