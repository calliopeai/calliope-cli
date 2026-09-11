/** Local provider diagnostics; network discovery requires an explicit --probe. */
import { parseArgs } from 'node:util';
import * as fs from 'node:fs';
import * as config from './config.js';
import { getAvailableModels } from './model-detection.js';
import { HealthStore, providerTarget, summarizeHealth, healthOutcome, healthFailure, healthRemediation,
  type HealthProvider, type HealthSettings, type HealthSnapshot, type HealthTarget } from './health/index.js';

export interface ProviderDiagnostic extends HealthSnapshot {
  endpoint: string;
  protocol: string;
  credentials: HealthTarget['credentials'];
  remediation: string[];
}
export interface DoctorReport {
  version: 1;
  type: 'provider-health';
  generatedAt: string;
  localOnly: boolean;
  settings?: HealthSettings;
  providers: ProviderDiagnostic[];
  action?: 'reset' | 'export' | 'import';
  imported?: number;
  error?: 'invalid-arguments' | 'diagnostics-unavailable' | 'cancelled' | 'probe-failed';
}
export interface DoctorOptions {
  store?: HealthStore;
  signal?: AbortSignal;
  onProgress?: (provider: HealthProvider) => void;
}
const USAGE = 'calliope doctor [providers|provider <name>] [--json] [--probe] [--timeout-ms <100..60000>] | doctor provider <name> --reset | doctor --export <file> | doctor --import <file>';

export async function diagnoseProviders(args: string[], options: DoctorOptions = {}): Promise<{ report: DoctorReport; exitCode: number }> {
  let network = false;
  const errorReport = (error: DoctorReport['error'], exitCode: number) => ({ exitCode, report: {
    version: 1 as const, type: 'provider-health' as const, generatedAt: new Date().toISOString(), localOnly: !network, providers: [], error,
  } });
  let parsed: ReturnType<typeof parseArgs>;
  try { parsed = parseArgs({ args, allowPositionals: true, options: {
    json: { type: 'boolean' }, probe: { type: 'boolean' }, reset: { type: 'boolean' },
    export: { type: 'string' }, import: { type: 'string' }, 'timeout-ms': { type: 'string' },
  } }); } catch { return errorReport('invalid-arguments', 2); }
  const { values, positionals } = parsed;
  let names = config.getProviderNames();
  if (positionals.length) {
    if (positionals[0] === 'provider' && positionals.length === 2 && names.includes(positionals[1] as HealthProvider)) names = [positionals[1] as HealthProvider];
    else if (!(positionals[0] === 'providers' && positionals.length === 1)) return errorReport('invalid-arguments', 2);
  }
  const mutations = [values.reset, values.export, values.import].filter(Boolean).length;
  if (mutations > 1 || (mutations && values.probe) || (values.reset && names.length !== 1) ||
      (values['timeout-ms'] !== undefined && !values.probe) || ((values.export || values.import) && positionals.length)) return errorReport('invalid-arguments', 2);
  const rawTimeout = values['timeout-ms'];
  if (rawTimeout !== undefined && (typeof rawTimeout !== 'string' || !/^\d+$/.test(rawTimeout) || Number(rawTimeout) < 100 || Number(rawTimeout) > 60000)) return errorReport('invalid-arguments', 2);
  try {
    if (options.signal?.aborted) return errorReport('cancelled', 130);
    const store = options.store ?? new HealthStore();
    const targets = names.map(providerTarget);
    const report: DoctorReport = { version: 1, type: 'provider-health', generatedAt: new Date().toISOString(), localOnly: true, settings: store.settings, providers: [] };
    // Read/validate before any reset or import; never hide a corrupt history.
    store.read();
    if (values.reset) {
      store.append({ provider: targets[0]!.provider, target: targets[0]!.key, type: 'reset' }); report.action = 'reset';
    }
    if (typeof values.import === 'string') {
      if (fs.statSync(values.import).size > 10 * 1024 * 1024) throw new Error('Import too large');
      report.imported = store.import(JSON.parse(fs.readFileSync(values.import, 'utf8'))); report.action = 'import';
    }
    if (typeof values.export === 'string') {
      fs.writeFileSync(values.export, JSON.stringify(store.export(), null, 2) + '\n', { flag: 'wx', mode: 0o600 }); report.action = 'export';
    }
    let exitCode = 0;
    if (values.probe) {
      network = true; report.localOnly = false;
      // A whole invocation is bounded as well as each provider; cancelled probes
      // do not launch more traffic, and inference is never used by doctor.
      const overall = AbortSignal.timeout(60000);
      for (const target of targets) {
        if (options.signal?.aborted || overall.aborted) { exitCode = options.signal?.aborted ? 130 : 1; break; }
        if (target.credentials === 'missing') { exitCode = 1; continue; }
        options.onProgress?.(target.provider);
        const deadline = AbortSignal.timeout(rawTimeout ? Number(rawTimeout) : store.settings.probeTimeoutMs);
        const signal = AbortSignal.any([deadline, overall, ...(options.signal ? [options.signal] : [])]);
        const started = Date.now();
        try {
          const models = await getAvailableModels(target.provider, { signal, throwOnError: true, quiet: true });
          store.append({ provider: target.provider, target: target.key, type: 'discovery', outcome: 'success', durationMs: Date.now() - started, modelCount: models.length });
        } catch (error) {
          const outcome = healthOutcome(error, signal);
          store.append({ provider: target.provider, target: target.key, type: 'discovery', outcome, durationMs: Math.min(86400000, Date.now() - started),
            ...(outcome === 'cancelled' ? {} : { ...healthFailure(error), ...(outcome === 'timeout' ? { failure: 'timeout' as const } : {}) }) });
          exitCode = options.signal?.aborted ? 130 : 1;
        }
      }
    }
    const events = store.read();
    report.providers = targets.map(target => {
      const health = summarizeHealth(events, target, store.settings);
      return { ...health, endpoint: target.endpoint, protocol: target.protocol, credentials: target.credentials, remediation: healthRemediation(target, health) };
    });
    report.generatedAt = new Date().toISOString();
    if (exitCode) report.error = exitCode === 130 ? 'cancelled' : 'probe-failed';
    return { report, exitCode };
  } catch { return errorReport('diagnostics-unavailable', 1); }
}

export function formatDoctor(report: DoctorReport): string {
  if (report.error && !report.providers.length) return report.error === 'invalid-arguments' ? USAGE
    : report.error === 'cancelled' ? 'Provider diagnostics cancelled.' : 'Provider diagnostics unavailable. Check health history integrity, local file permissions and configuration; no history was reset.';
  const rate = (value: number | null) => value === null ? 'unknown' : `${(value * 100).toFixed(1)}%`;
  const lines = ['Provider health (local observations; unknown means unverified)'];
  for (const p of report.providers) {
    lines.push(`\n${p.provider}: ${p.credentials}${p.quarantine.active ? `; QUARANTINED (${p.quarantine.reason}) until ${p.quarantine.expiresAt}` : ''}`,
      `  ${p.endpoint} | ${p.protocol}`,
      `  Discovery: ${p.discovery.status}${p.discovery.at ? ` at ${p.discovery.at} (${p.discovery.modelCount ?? 'unknown'} models)` : ''}`,
      `  Last successful conformance probe: ${p.lastSuccessfulConformanceAt ?? 'unknown'}`,
      `  Latency: ${p.latencyMs === null ? 'unknown' : `${p.latencyMs}ms`}; timeouts ${rate(p.timeoutRate)}; retries ${rate(p.retryRate)}; errors ${rate(p.errorRate)} (${p.sampleCount} attempts)`,
      `  Tools: ${p.capabilities.tools}; streaming: ${p.capabilities.streaming}; cancellation: ${p.capabilities.cancellation}; usage: ${p.capabilities.usage}`,
      `  Last failure: ${p.lastFailure ? `${p.lastFailure.kind} at ${p.lastFailure.at}` : 'none recorded'}; imported diagnostic events: ${p.importedEvents}`,
      ...p.remediation.map(step => `  ${step}`));
  }
  if (report.error) lines.push(`\nProbe status: ${report.error}.`);
  return lines.join('\n');
}
export async function runDoctor(args: string[], options: DoctorOptions = {}): Promise<number> {
  const result = await diagnoseProviders(args, options);
  process.stdout.write((args.includes('--json') ? JSON.stringify(result.report) : formatDoctor(result.report)) + '\n');
  return result.exitCode;
}
