export function resolveIterationLimit(value: number | undefined | null): number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0
    ? value
    : Infinity;
}

export function isFiniteIterationLimit(value: number | undefined | null): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

export function formatIterationLimit(value: number | undefined | null): string {
  return isFiniteIterationLimit(value) ? String(value) : 'unlimited';
}

export function formatIterationProgress(iteration: number, maxIterations: number | undefined | null): string {
  return isFiniteIterationLimit(maxIterations)
    ? `${iteration}/${maxIterations}`
    : String(iteration);
}
