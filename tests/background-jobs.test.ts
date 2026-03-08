import { describe, it, expect, beforeEach, vi } from 'vitest';
import type {
  BackgroundJob,
  JobStatus,
} from '../src/background-jobs.js';

// We dynamically import the module to get fresh state per test suite
let mod: typeof import('../src/background-jobs.js');

beforeEach(async () => {
  vi.resetModules();
  mod = await import('../src/background-jobs.js');
});

describe('createJob', () => {
  it('creates a job with pending status', () => {
    const job = mod.createJob('test prompt');
    expect(job.status).toBe('pending');
    expect(job.prompt).toBe('test prompt');
    expect(job.iterations).toBe(0);
    expect(job.id).toMatch(/^bg-\d+$/);
    expect(job.createdAt).toBeTruthy();
  });

  it('assigns incremental IDs', () => {
    const job1 = mod.createJob('first');
    const job2 = mod.createJob('second');
    const id1 = parseInt(job1.id.replace('bg-', ''));
    const id2 = parseInt(job2.id.replace('bg-', ''));
    expect(id2).toBe(id1 + 1);
  });

  it('stores provider and model options', () => {
    const job = mod.createJob('prompt', { provider: 'openai', model: 'gpt-4' });
    expect(job.provider).toBe('openai');
    expect(job.model).toBe('gpt-4');
  });

  it('has no provider/model when options omitted', () => {
    const job = mod.createJob('prompt');
    expect(job.provider).toBeUndefined();
    expect(job.model).toBeUndefined();
  });

  it('is retrievable via getJob after creation', () => {
    const job = mod.createJob('hello');
    const fetched = mod.getJob(job.id);
    expect(fetched).toBe(job);
  });
});

describe('runJob', () => {
  it('transitions through running → completed on success', async () => {
    const job = mod.createJob('do something');
    let capturedStatus: JobStatus | undefined;

    const result = await mod.runJob(job.id, async (prompt, _signal) => {
      capturedStatus = mod.getJob(job.id)!.status;
      expect(prompt).toBe('do something');
      return { result: 'done', iterations: 3 };
    });

    expect(capturedStatus).toBe('running');
    expect(result.status).toBe('completed');
    expect(result.result).toBe('done');
    expect(result.iterations).toBe(3);
    expect(result.startedAt).toBeTruthy();
    expect(result.completedAt).toBeTruthy();
  });

  it('transitions to failed status when executor throws', async () => {
    const job = mod.createJob('fail task');

    const result = await mod.runJob(job.id, async () => {
      throw new Error('something broke');
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('something broke');
    expect(result.completedAt).toBeTruthy();
  });

  it('handles non-Error throws', async () => {
    const job = mod.createJob('fail task');

    const result = await mod.runJob(job.id, async () => {
      throw 'string error';
    });

    expect(result.status).toBe('failed');
    expect(result.error).toBe('string error');
  });

  it('throws if job ID not found', async () => {
    await expect(
      mod.runJob('bg-nonexistent', async () => ({ result: '', iterations: 0 }))
    ).rejects.toThrow('Job bg-nonexistent not found');
  });

  it('sets startedAt when running begins', async () => {
    const job = mod.createJob('task');
    await mod.runJob(job.id, async () => ({ result: 'ok', iterations: 1 }));
    expect(job.startedAt).toBeTruthy();
    expect(new Date(job.startedAt!).getTime()).not.toBeNaN();
  });
});

describe('cancelJob', () => {
  it('cancels a running job via abort controller', async () => {
    const job = mod.createJob('long task');

    const runPromise = mod.runJob(job.id, async (_prompt, signal) => {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => resolve({ result: 'done', iterations: 1 }), 5000);
        signal.addEventListener('abort', () => {
          clearTimeout(timer);
          reject(new DOMException('Aborted', 'AbortError'));
        });
      });
    });

    // Allow the executor to start
    await new Promise(r => setTimeout(r, 10));

    const cancelled = mod.cancelJob(job.id);
    expect(cancelled).toBe(true);

    const result = await runPromise;
    expect(result.status).toBe('cancelled');
    expect(result.completedAt).toBeTruthy();
  });

  it('cancels a pending job directly', () => {
    const job = mod.createJob('pending task');
    expect(job.status).toBe('pending');

    const cancelled = mod.cancelJob(job.id);
    expect(cancelled).toBe(true);
    expect(job.status).toBe('cancelled');
    expect(job.completedAt).toBeTruthy();
  });

  it('returns false for unknown job ID', () => {
    expect(mod.cancelJob('bg-999')).toBe(false);
  });

  it('returns false for already completed job', async () => {
    const job = mod.createJob('done task');
    await mod.runJob(job.id, async () => ({ result: 'ok', iterations: 1 }));
    expect(mod.cancelJob(job.id)).toBe(false);
  });
});

describe('getJob', () => {
  it('returns undefined for unknown ID', () => {
    expect(mod.getJob('bg-unknown')).toBeUndefined();
  });

  it('returns the job object for a valid ID', () => {
    const job = mod.createJob('hello');
    expect(mod.getJob(job.id)).toBe(job);
  });
});

describe('listJobs', () => {
  it('returns empty array when no jobs exist', () => {
    expect(mod.listJobs()).toEqual([]);
  });

  it('returns all jobs without filter', () => {
    mod.createJob('a');
    mod.createJob('b');
    mod.createJob('c');
    expect(mod.listJobs()).toHaveLength(3);
  });

  it('filters by status', async () => {
    const job1 = mod.createJob('a');
    mod.createJob('b');
    await mod.runJob(job1.id, async () => ({ result: 'ok', iterations: 1 }));

    const completed = mod.listJobs('completed');
    expect(completed).toHaveLength(1);
    expect(completed[0].id).toBe(job1.id);

    const pending = mod.listJobs('pending');
    expect(pending).toHaveLength(1);
  });

  it('sorts by createdAt descending (newest first) when no filter', () => {
    const j1 = mod.createJob('first');
    const j2 = mod.createJob('second');
    const j3 = mod.createJob('third');

    // Manually set distinct timestamps to verify sort order
    j1.createdAt = '2024-01-01T00:00:00.000Z';
    j2.createdAt = '2024-01-02T00:00:00.000Z';
    j3.createdAt = '2024-01-03T00:00:00.000Z';

    const all = mod.listJobs();
    expect(all.map(j => j.id)).toEqual([j3.id, j2.id, j1.id]);
  });
});

describe('activeJobCount', () => {
  it('returns 0 when no jobs', () => {
    expect(mod.activeJobCount()).toBe(0);
  });

  it('counts pending jobs', () => {
    mod.createJob('a');
    mod.createJob('b');
    expect(mod.activeJobCount()).toBe(2);
  });

  it('counts running jobs', async () => {
    const job = mod.createJob('task');
    let resolveExecutor!: (v: { result: string; iterations: number }) => void;
    const executorPromise = new Promise<{ result: string; iterations: number }>(r => {
      resolveExecutor = r;
    });

    const runPromise = mod.runJob(job.id, async () => executorPromise);

    // Let executor start
    await new Promise(r => setTimeout(r, 10));
    expect(mod.activeJobCount()).toBe(1);

    resolveExecutor({ result: 'ok', iterations: 1 });
    await runPromise;
    expect(mod.activeJobCount()).toBe(0);
  });

  it('does not count completed or failed jobs', async () => {
    const j1 = mod.createJob('ok');
    const j2 = mod.createJob('fail');
    await mod.runJob(j1.id, async () => ({ result: 'ok', iterations: 1 }));
    await mod.runJob(j2.id, async () => { throw new Error('nope'); });
    expect(mod.activeJobCount()).toBe(0);
  });
});

describe('clearFinishedJobs', () => {
  it('returns 0 when no jobs', () => {
    expect(mod.clearFinishedJobs()).toBe(0);
  });

  it('clears completed, failed, and cancelled jobs', async () => {
    const j1 = mod.createJob('done');
    const j2 = mod.createJob('err');
    const j3 = mod.createJob('cancel');
    const j4 = mod.createJob('still pending');

    await mod.runJob(j1.id, async () => ({ result: 'ok', iterations: 1 }));
    await mod.runJob(j2.id, async () => { throw new Error('fail'); });
    mod.cancelJob(j3.id);

    const cleared = mod.clearFinishedJobs();
    expect(cleared).toBe(3);

    expect(mod.getJob(j1.id)).toBeUndefined();
    expect(mod.getJob(j2.id)).toBeUndefined();
    expect(mod.getJob(j3.id)).toBeUndefined();
    expect(mod.getJob(j4.id)).toBeDefined();
  });

  it('does not clear pending or running jobs', () => {
    mod.createJob('pending');
    expect(mod.clearFinishedJobs()).toBe(0);
    expect(mod.listJobs()).toHaveLength(1);
  });
});

describe('formatJob', () => {
  it('formats a pending job', () => {
    const job = mod.createJob('do something');
    const output = mod.formatJob(job);
    expect(output).toContain(job.id);
    expect(output).toContain('do something');
    expect(output).toContain('[pending]');
  });

  it('formats a completed job with iterations', async () => {
    const job = mod.createJob('task');
    await mod.runJob(job.id, async () => ({ result: 'ok', iterations: 5 }));
    const output = mod.formatJob(job);
    expect(output).toContain('[completed]');
    expect(output).toContain('5 iterations');
  });

  it('formats a failed job with error', async () => {
    const job = mod.createJob('bad task');
    await mod.runJob(job.id, async () => { throw new Error('oops'); });
    const output = mod.formatJob(job);
    expect(output).toContain('[failed]');
    expect(output).toContain('Error: oops');
  });

  it('truncates long prompts at 60 chars', () => {
    const longPrompt = 'a'.repeat(100);
    const job = mod.createJob(longPrompt);
    const output = mod.formatJob(job);
    expect(output).toContain('a'.repeat(57) + '...');
    expect(output).not.toContain('a'.repeat(58) + '...');
  });

  it('does not truncate prompts at or under 60 chars', () => {
    const prompt = 'a'.repeat(60);
    const job = mod.createJob(prompt);
    const output = mod.formatJob(job);
    expect(output).toContain(prompt);
    expect(output).not.toContain('...');
  });

  it('does not show iterations when zero', () => {
    const job = mod.createJob('task');
    const output = mod.formatJob(job);
    expect(output).not.toContain('iterations');
  });
});

describe('formatJobsList', () => {
  it('returns "No background jobs." when empty', () => {
    expect(mod.formatJobsList()).toBe('No background jobs.');
  });

  it('formats multiple jobs', () => {
    mod.createJob('first');
    mod.createJob('second');
    const output = mod.formatJobsList();
    expect(output).toContain('first');
    expect(output).toContain('second');
    expect(output.split('\n').length).toBeGreaterThanOrEqual(2);
  });
});

describe('multiple concurrent jobs', () => {
  it('runs multiple jobs concurrently', async () => {
    const job1 = mod.createJob('task 1');
    const job2 = mod.createJob('task 2');

    const [result1, result2] = await Promise.all([
      mod.runJob(job1.id, async () => {
        await new Promise(r => setTimeout(r, 20));
        return { result: 'r1', iterations: 1 };
      }),
      mod.runJob(job2.id, async () => {
        await new Promise(r => setTimeout(r, 10));
        return { result: 'r2', iterations: 2 };
      }),
    ]);

    expect(result1.status).toBe('completed');
    expect(result1.result).toBe('r1');
    expect(result2.status).toBe('completed');
    expect(result2.result).toBe('r2');
    expect(mod.activeJobCount()).toBe(0);
  });

  it('one failure does not affect other jobs', async () => {
    const job1 = mod.createJob('good');
    const job2 = mod.createJob('bad');

    const [r1, r2] = await Promise.all([
      mod.runJob(job1.id, async () => ({ result: 'ok', iterations: 1 })),
      mod.runJob(job2.id, async () => { throw new Error('boom'); }),
    ]);

    expect(r1.status).toBe('completed');
    expect(r2.status).toBe('failed');
  });

  it('cancelling one job does not affect others', async () => {
    const job1 = mod.createJob('keep');
    const job2 = mod.createJob('cancel me');

    let resolveJob1!: (v: { result: string; iterations: number }) => void;

    const run1 = mod.runJob(job1.id, async () =>
      new Promise<{ result: string; iterations: number }>(r => { resolveJob1 = r; })
    );
    const run2 = mod.runJob(job2.id, async (_p, signal) =>
      new Promise<{ result: string; iterations: number }>((resolve, reject) => {
        const t = setTimeout(() => resolve({ result: 'done', iterations: 1 }), 5000);
        signal.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); });
      })
    );

    await new Promise(r => setTimeout(r, 10));
    mod.cancelJob(job2.id);
    resolveJob1({ result: 'kept', iterations: 1 });

    const [r1, r2] = await Promise.all([run1, run2]);
    expect(r1.status).toBe('completed');
    expect(r2.status).toBe('cancelled');
  });
});
