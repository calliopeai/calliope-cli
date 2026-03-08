/**
 * Calliope CLI - Background Jobs System
 *
 * Run agent tasks in the background while continuing interactive use.
 * Commands: /bg, /jobs, /job, /cancel
 */

export type JobStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled';

export interface BackgroundJob {
  id: string;
  prompt: string;
  status: JobStatus;
  createdAt: string;
  startedAt?: string;
  completedAt?: string;
  result?: string;
  error?: string;
  provider?: string;
  model?: string;
  iterations: number;
}

// Job registry
const jobs = new Map<string, BackgroundJob>();
const jobRunners = new Map<string, AbortController>();

let nextJobId = 1;

/** Create a new background job */
export function createJob(prompt: string, options?: { provider?: string; model?: string }): BackgroundJob {
  const id = `bg-${nextJobId++}`;
  const job: BackgroundJob = {
    id,
    prompt,
    status: 'pending',
    createdAt: new Date().toISOString(),
    provider: options?.provider,
    model: options?.model,
    iterations: 0,
  };
  jobs.set(id, job);
  return job;
}

/** Start executing a job (call this with your agent runner) */
export async function runJob(
  id: string,
  executor: (prompt: string, signal: AbortSignal) => Promise<{ result: string; iterations: number }>
): Promise<BackgroundJob> {
  const job = jobs.get(id);
  if (!job) throw new Error(`Job ${id} not found`);

  const controller = new AbortController();
  jobRunners.set(id, controller);

  job.status = 'running';
  job.startedAt = new Date().toISOString();

  try {
    const { result, iterations } = await executor(job.prompt, controller.signal);
    job.status = 'completed';
    job.result = result;
    job.iterations = iterations;
  } catch (err) {
    if (controller.signal.aborted) {
      job.status = 'cancelled';
    } else {
      job.status = 'failed';
      job.error = err instanceof Error ? err.message : String(err);
    }
  } finally {
    job.completedAt = new Date().toISOString();
    jobRunners.delete(id);
  }

  return job;
}

/** Cancel a running job */
export function cancelJob(id: string): boolean {
  const controller = jobRunners.get(id);
  if (controller) {
    controller.abort();
    return true;
  }
  const job = jobs.get(id);
  if (job && job.status === 'pending') {
    job.status = 'cancelled';
    job.completedAt = new Date().toISOString();
    return true;
  }
  return false;
}

/** Get a specific job */
export function getJob(id: string): BackgroundJob | undefined {
  return jobs.get(id);
}

/** List all jobs, optionally filtered by status */
export function listJobs(statusFilter?: JobStatus): BackgroundJob[] {
  const all = Array.from(jobs.values());
  if (statusFilter) return all.filter(j => j.status === statusFilter);
  return all.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/** Get count of active (pending + running) jobs */
export function activeJobCount(): number {
  return Array.from(jobs.values()).filter(j => j.status === 'pending' || j.status === 'running').length;
}

/** Clear completed/failed/cancelled jobs */
export function clearFinishedJobs(): number {
  let cleared = 0;
  for (const [id, job] of jobs) {
    if (job.status === 'completed' || job.status === 'failed' || job.status === 'cancelled') {
      jobs.delete(id);
      cleared++;
    }
  }
  return cleared;
}

/** Format job for display */
export function formatJob(job: BackgroundJob): string {
  const statusIcons: Record<JobStatus, string> = {
    pending: '⏳',
    running: '🔄',
    completed: '✅',
    failed: '❌',
    cancelled: '🚫',
  };
  const icon = statusIcons[job.status];
  const prompt = job.prompt.length > 60 ? job.prompt.slice(0, 57) + '...' : job.prompt;
  let line = `${icon} ${job.id}: ${prompt} [${job.status}]`;
  if (job.iterations > 0) line += ` (${job.iterations} iterations)`;
  if (job.error) line += `\n   Error: ${job.error}`;
  return line;
}

/** Format jobs list for display */
export function formatJobsList(): string {
  const all = listJobs();
  if (all.length === 0) return 'No background jobs.';
  return all.map(formatJob).join('\n');
}
