/**
 * UI Module - Render Probe (test/automation instrumentation)
 *
 * Region components call `probeRender(name)` at the top of their render and
 * `probeMount(name)` from a mount effect. Both are no-ops in production (the
 * probe is disabled), so the overhead is a single boolean check per render.
 *
 * The render-isolation test enables the probe, renders the decomposed tree,
 * drives stdin, and asserts which regions re-rendered — this is how we prove a
 * keystroke touches only the input region and that resetSession() resets state
 * without remounting (mount count stays 1).
 */

let enabled = false;
const renderCounts: Record<string, number> = Object.create(null);
const mountCounts: Record<string, number> = Object.create(null);

/** Enable (and reset) or disable render/mount counting. */
export function enableRenderProbe(on = true): void {
  enabled = on;
  if (on) {
    for (const k of Object.keys(renderCounts)) delete renderCounts[k];
    for (const k of Object.keys(mountCounts)) delete mountCounts[k];
  }
}

export function isRenderProbeEnabled(): boolean {
  return enabled;
}

/** Count one render of the named component. No-op unless the probe is enabled. */
export function probeRender(name: string): void {
  if (enabled) renderCounts[name] = (renderCounts[name] ?? 0) + 1;
}

/** Count one mount of the named component. No-op unless the probe is enabled. */
export function probeMount(name: string): void {
  if (enabled) mountCounts[name] = (mountCounts[name] ?? 0) + 1;
}

export function getRenderCount(name: string): number {
  return renderCounts[name] ?? 0;
}

export function getMountCount(name: string): number {
  return mountCounts[name] ?? 0;
}
