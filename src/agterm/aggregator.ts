/**
 * AGTerm Aggregator
 *
 * Aggregates results from completed swarm subtasks using various strategies.
 */

import type { AggregationStrategy, SwarmSubtask } from './swarm-types.js';

/**
 * Aggregate subtask results using the specified strategy
 */
export function aggregateResults(
  subtasks: SwarmSubtask[],
  strategy: AggregationStrategy,
  originalPrompt: string
): string {
  const completed = subtasks
    .filter(s => s.status === 'completed' && s.result)
    .sort((a, b) => a.index - b.index);

  const failed = subtasks.filter(s => s.status === 'failed');

  if (completed.length === 0) {
    const errors = failed.map(s => `  Subtask ${s.index + 1}: ${s.error || 'unknown error'}`);
    return `All subtasks failed.\n${errors.join('\n')}`;
  }

  let result: string;

  switch (strategy) {
    case 'concatenate':
      result = aggregateConcatenate(completed);
      break;
    case 'merge-dedupe':
      result = aggregateMergeDedupe(completed);
      break;
    case 'summarize':
      result = aggregateSummarize(completed, originalPrompt);
      break;
    case 'structured':
      result = aggregateStructured(completed, originalPrompt);
      break;
    default:
      result = aggregateConcatenate(completed);
  }

  // Append failure summary if any subtasks failed
  if (failed.length > 0) {
    result += `\n\n---\nNote: ${failed.length} subtask(s) failed:\n`;
    for (const f of failed) {
      result += `  - Subtask ${f.index + 1} (${f.prompt.slice(0, 60)}...): ${f.error || 'unknown'}\n`;
    }
  }

  return result;
}

/**
 * Concatenate: Simple ordered concatenation with headers
 */
function aggregateConcatenate(subtasks: SwarmSubtask[]): string {
  return subtasks
    .map(s => {
      const header = subtasks.length > 1
        ? `## Subtask ${s.index + 1}: ${s.prompt.slice(0, 80)}\n\n`
        : '';
      return `${header}${s.result}`;
    })
    .join('\n\n---\n\n');
}

/**
 * Merge-Dedupe: Combine results and remove duplicate content
 */
function aggregateMergeDedupe(subtasks: SwarmSubtask[]): string {
  const seenLines = new Set<string>();
  const mergedLines: string[] = [];

  for (const subtask of subtasks) {
    if (!subtask.result) continue;
    const lines = subtask.result.split('\n');
    for (const line of lines) {
      const normalized = line.trim().toLowerCase();
      if (normalized.length === 0) {
        mergedLines.push('');
        continue;
      }
      if (!seenLines.has(normalized)) {
        seenLines.add(normalized);
        mergedLines.push(line);
      }
    }
  }

  return mergedLines.join('\n');
}

/**
 * Summarize: Create a summary with key points from each subtask
 */
function aggregateSummarize(subtasks: SwarmSubtask[], originalPrompt: string): string {
  const sections: string[] = [
    `# Summary: ${originalPrompt.slice(0, 100)}`,
    '',
  ];

  for (const subtask of subtasks) {
    if (!subtask.result) continue;
    // Extract first paragraph or first 300 chars as key finding
    const firstParagraph = subtask.result.split('\n\n')[0] || subtask.result.slice(0, 300);
    sections.push(`**${subtask.prompt.slice(0, 80)}:**`);
    sections.push(firstParagraph);
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * Structured: Organize results into a structured report
 */
function aggregateStructured(subtasks: SwarmSubtask[], originalPrompt: string): string {
  const sections: string[] = [
    `# ${originalPrompt.slice(0, 100)}`,
    '',
    `**Tasks completed:** ${subtasks.length}`,
    '',
    '---',
    '',
  ];

  for (const subtask of subtasks) {
    if (!subtask.result) continue;
    sections.push(`### ${subtask.index + 1}. ${subtask.prompt.slice(0, 100)}`);
    sections.push('');
    sections.push(subtask.result);
    sections.push('');
  }

  return sections.join('\n');
}

/**
 * Build an aggregation prompt for the overseer to synthesize results
 * (Used when strategy is 'summarize' and we want LLM-powered aggregation)
 */
export function buildAggregationPrompt(
  originalPrompt: string,
  subtaskResults: { prompt: string; result: string }[]
): string {
  let prompt = `You are an aggregation agent. Your job is to synthesize the results of multiple subtasks into a cohesive response.

Original task: ${originalPrompt}

Subtask results:
`;

  for (let i = 0; i < subtaskResults.length; i++) {
    prompt += `\n--- Subtask ${i + 1}: ${subtaskResults[i].prompt} ---\n`;
    prompt += subtaskResults[i].result;
    prompt += '\n';
  }

  prompt += `\n---\n\nSynthesize these results into a single, coherent response that addresses the original task. Remove redundancy, resolve conflicts, and present findings clearly.`;

  return prompt;
}
