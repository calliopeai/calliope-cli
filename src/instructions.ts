/** Repository instructions, scoped to trusted directories inside one checkout. */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { checkTrust } from './trust.js';

export interface RepositoryInstruction {
  path: string;
  scope: string;
  content: string;
}

/** Bound prompt growth without silently discarding controlling instructions. */
export const MAX_INSTRUCTION_BYTES = 64 * 1024;

export function loadRepositoryInstructions(directory: string): RepositoryInstruction[] {
  let cwd: string;
  try { cwd = fs.realpathSync(directory); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  const ancestry: string[] = [];
  let current = cwd;
  while (true) {
    ancestry.unshift(current);
    if (fs.existsSync(path.join(current, '.git'))) break;
    const parent = path.dirname(current);
    if (parent === current) {
      // Outside a checkout, only the explicitly selected directory is in scope.
      ancestry.splice(0, ancestry.length, cwd);
      break;
    }
    current = parent;
  }

  let trustedRoot: string | undefined;
  const instructions: RepositoryInstruction[] = [];
  let bytes = 0;
  for (const scope of ancestry) {
    const trust = checkTrust(scope);
    // An explicit refusal blocks inheritance into that subtree.
    if (!trust.trusted && trust.reason === 'Project explicitly untrusted.') return [];
    if (trust.trusted && !trustedRoot) trustedRoot = scope;
    if (!trustedRoot) continue;

    const source = path.join(scope, 'AGENTS.md');
    let resolved: string;
    try { resolved = fs.realpathSync(source); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw new Error(`Cannot load repository instructions at ${source}`, { cause: error });
    }
    const relative = path.relative(trustedRoot, resolved);
    if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
      throw new Error(`Repository instructions at ${source} point outside the trusted scope ${trustedRoot}`);
    }
    // Symlinks cannot import rules from an explicitly refused subtree.
    for (let target = path.dirname(resolved); ; target = path.dirname(target)) {
      const targetTrust = checkTrust(target);
      if (!targetTrust.trusted && targetTrust.reason === 'Project explicitly untrusted.') {
        throw new Error(`Repository instructions at ${source} point into an explicitly untrusted directory: ${target}`);
      }
      if (target === trustedRoot) break;
    }
    const stat = fs.statSync(resolved);
    if (!stat.isFile()) throw new Error(`Repository instructions must be a regular file: ${source}`);
    if (bytes + stat.size > MAX_INSTRUCTION_BYTES) {
      throw new Error(`Repository instructions exceed ${MAX_INSTRUCTION_BYTES} bytes at ${source}. Shorten the applicable AGENTS.md files; instructions were not truncated.`);
    }
    const content = fs.readFileSync(resolved, 'utf8');
    bytes += Buffer.byteLength(content);
    if (bytes > MAX_INSTRUCTION_BYTES) throw new Error(`Repository instructions grew beyond ${MAX_INSTRUCTION_BYTES} bytes while reading ${source}; retry after shortening them.`);
    instructions.push({ path: source, scope, content });
  }
  return instructions;
}

export function formatRepositoryInstructions(instructions: RepositoryInstruction[]): string {
  if (instructions.length === 0) return '';
  return [
    'Repository instructions (AGENTS.md):',
    'These instructions take precedence over conflicting project reference context. More specific directory instructions take precedence within their own subtree. User instructions and runtime policy retain priority.',
    'Only the checkout-to-working-directory chain is loaded here. Before working in a deeper directory, read its applicable AGENTS.md files. Do not apply sibling directory instructions.',
    ...instructions.flatMap(instruction => [
      `--- Instructions: ${instruction.path} (scope: ${instruction.scope}) ---`,
      instruction.content,
    ]),
  ].join('\n\n');
}
