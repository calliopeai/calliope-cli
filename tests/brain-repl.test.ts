import { it, expect, vi, afterEach } from 'vitest';
import { handleCommand, type CommandContext } from '../src/ui/commands.js';
import * as brain from '../src/brain/index.js';
afterEach(() => vi.restoreAllMocks());
it.each(['/brain', '/kg'])(
  'binds %s to the active project, cancellation and approval callback',
  async (command) => {
    const signal = new AbortController().signal,
      approve = vi.fn(async () => 'allow' as const),
      messages: string[] = [];
    const run = vi.spyOn(brain, 'runBrainCommand').mockImplementation(async (args, options) => {
      expect(args).toEqual(['search', 'source provenance', '--json']);
      expect(options).toMatchObject({
        cwd: '/active/project',
        signal,
        confirmation: 'mutating',
        kg: command === '/kg',
      });
      expect(await options!.approve!({} as never)).toBe('allow');
      options!.write!('Public result\n');
      return 0;
    });
    const ctx = {
      sessionRef: { current: { projectPath: '/active/project' } },
      signal,
      confirmMode: true,
      approve,
      addMessage: (_kind: string, text: string) => messages.push(text),
    } as unknown as CommandContext;
    await handleCommand(command + ' search "source provenance" --json', ctx);
    expect(run).toHaveBeenCalledOnce();
    expect(approve).toHaveBeenCalledWith({}, signal);
    expect(messages).toEqual(['Public result']);
  },
);
