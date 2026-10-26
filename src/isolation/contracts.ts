import type { ProjectPlan, ProjectTask } from '../orchestration/types.js';
import { array, fail, integer, shape, text, id } from '../orchestration/validation.js';

export interface WorktreeIsolation { version: 1; image: string }
export interface VerificationCommand { artifactId: string; argv: string[]; timeoutMs: number }
export interface TaskIsolation { mode?: 'read-only-v1'; patchArtifactId: string; commands: VerificationCommand[] }
export interface CommandEvidence {
  version: 1; kind: 'isolated-command'; argv: string[]; image: string;
  exitCode: number; outcome: 'passed' | 'failed' | 'cancelled' | 'timeout' | 'unavailable';
  stdout: string; stderr: string; truncated: boolean; durationMs: number;
  container: string; cleanupConfirmed: boolean;
  cleanup?: {version:1;removal:{outcome:'removed'|'absent'|'timeout'|'error';exitCode:number|null};
    verification?:{outcome:'absent'|'present'|'timeout'|'error';exitCode:number|null}};
}
export function validateIsolation(value: unknown): asserts value is WorktreeIsolation {
  shape(value, ['version', 'image']);
  if (value.version !== 1 || typeof value.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(value.image))
    fail('Isolated workers require version 1 and a pinned local Docker image ID (sha256:...).');
}
export function validateTaskIsolation(value: unknown, task: ProjectTask, plan: ProjectPlan): asserts value is TaskIsolation {
  shape(value, ['patchArtifactId', 'commands'], ['mode']);
  if(value.mode!==undefined&&value.mode!=='read-only-v1')fail('Unknown isolated task mode.'); id(value.patchArtifactId); array(value.commands, 8);
  const agent = plan.agents.find(a => a.id === task.agentId)!;
  const output = (name: string, kind: string) => task.outputs.some(o => o.id === name && o.kind === kind && o.path === undefined);
  if (!output(value.patchArtifactId, 'patch')) fail('An isolated task requires a declared patch artifact without a project path.');
  if(value.mode==='read-only-v1') {
    if(value.commands.length||agent.allowedTools.some(tool=>!['think','ask_question','read_file','list_files','brain_search','brain_entity'].includes(tool))||agent.allowedPaths.some(grant=>grant.access!=='read'))
      fail('Read-only tasks require read-only tools and paths, without command execution.');
    if(task.outputs.some(output=>output.path!==undefined||output.id!==value.patchArtifactId&&!['report','decision','evidence'].includes(output.kind)))
      fail('Read-only tasks return pathless reports, decisions or evidence; only the executor supplies the patch.');
  }
  const seen = new Set<string>();
  for (const command of value.commands) {
    shape(command, ['artifactId', 'argv', 'timeoutMs']); id(command.artifactId); array(command.argv, 64, 1);
    command.argv.forEach(arg => text(arg, 8192));
    if (command.argv.some(arg => String(arg).includes('\n')) || String(command.argv[0]).startsWith('-') ||
        !output(command.artifactId, 'test_result') || seen.has(command.artifactId)) fail('Invalid verification command or result artifact.');
    seen.add(command.artifactId); integer(command.timeoutMs, 1, Math.min(60000, agent.timeBudgetMs));
  }
  if (value.commands.length && !agent.allowedTools.includes('shell')) fail('Verification commands require inherited shell authority.');
  for (const grant of agent.allowedPaths) if (grant.path.split('/').some(p=>p.toLowerCase()==='.git')) fail('Git metadata cannot be granted to isolated workers.');
}
