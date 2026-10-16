/** Native parent-ledger admission shared by headless and ACP clients. */
import { mkdirSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { canonicalJson, digest, projectIdentity } from '../approvals/index.js';
import { paths } from '../storage.js';
import { type SessionExecutionBinding, validSessionExecutionBinding } from '../sessions/execution-binding.js';
import { RemoteReservationLedger } from './remote-ledger.js';
import { ExecutionGuard, type AgentExecution } from './guard.js';
import { ExecutionLimitError } from './types.js';

export interface DelegatedExecutionOptions {
  url: string;
  tokenFile: string;
  agentId: string;
  maxOutputTokens?: number;
}

export async function connectDelegatedExecution(cwd: string, options: DelegatedExecutionOptions): Promise<AgentExecution> {
  // Rotation at the same configured path must retain the verified history floor.
  mkdirSync(paths.root, { recursive: true, mode: 0o700 });
  const parent = join(realpathSync(paths.root), 'delegation-ledgers');
  try { mkdirSync(parent, { mode: 0o700 }); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const stat = lstatSync(parent);
  if (!stat.isDirectory() || stat.isSymbolicLink() || stat.mode & 0o077) throw new Error('Delegation history directory is not private.');
  const root = join(parent, digest(canonicalJson({ project: projectIdentity(cwd), tokenFile: resolve(options.tokenFile), agentId: options.agentId })));
  const ledger = await RemoteReservationLedger.connect({ url: options.url, token: readFileSync(options.tokenFile, 'utf8').trim(), root, execution: { cwd, agentId: options.agentId } });
  const execution = { ledger, manifestHash: ledger.read(cwd).projection.manifestHash, agentId: options.agentId, maxOutputTokens: options.maxOutputTokens ?? 4096 };
  new ExecutionGuard(execution, cwd).assertActive();
  return execution;
}

export function executionBinding(execution: AgentExecution): SessionExecutionBinding {
  const binding = { version: 1 as const, manifestHash: execution.manifestHash, agentId: execution.agentId };
  if (!validSessionExecutionBinding(binding)) throw new ExecutionLimitError('authority', 'Invalid session execution binding.');
  return binding;
}

export function assertExecutionBinding(binding: SessionExecutionBinding | undefined, execution: AgentExecution | undefined, requireBound = false): void {
  if (binding ? !execution || !validSessionExecutionBinding(binding)
    || canonicalJson(binding) !== canonicalJson(executionBinding(execution)) : requireBound) {
    throw new ExecutionLimitError('authority', 'Session requires its original parent ledger and account; execution binding cannot be removed or replaced.');
  }
}

/** Parse only a complete, unambiguous native delegation tuple. */
export function parseDelegatedExecutionOptions(args: string[]): DelegatedExecutionOptions | undefined {
  const flags = ['--ledger-url', '--ledger-token-file', '--ledger-agent'];
  if (args.some(value => value.startsWith('--ledger-') && !flags.includes(value))) {
    throw new Error('Unknown parent ledger option; use separate flag and value arguments.');
  }
  const values = flags.map(flag => {
    const indices = args.flatMap((value, index) => value === flag ? [index] : []);
    if (indices.length > 1) throw new Error('Repeated parent ledger option.');
    const index = indices[0];
    if (index === undefined) return undefined;
    const value = args[index + 1];
    if (!value || value.startsWith('--')) throw new Error('Parent ledger option needs a value.');
    return value;
  });
  if (values.every(value => value === undefined)) return undefined;
  if (values.some(value => value === undefined)) throw new Error('Delegated runs need --ledger-url, --ledger-token-file and --ledger-agent together.');
  return { url: values[0]!, tokenFile: values[1]!, agentId: values[2]! };
}
