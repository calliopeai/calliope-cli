/** Persist a conservative reservation before each paid probe. Fail closed on contention. */
import { closeSync, existsSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';

export function reserveProbe(file, { maxCostUsd, inputRate, outputRate, maxInputTokens = 5000, maxOutputTokens }) {
  if (![maxCostUsd, inputRate, outputRate].every(n => Number.isFinite(n) && n >= 0) ||
      ![maxInputTokens, maxOutputTokens].every(n => Number.isSafeInteger(n) && n > 0) || maxOutputTokens > 512) {
    throw new Error('Invalid probe dollar, pricing or token budget');
  }
  // Rounded upward to integer nanodollars; failed/unknown requests keep their reservation.
  const reservedNanoUsd = Math.ceil((maxInputTokens * inputRate + maxOutputTokens * outputRate) * 1000);
  const limitNanoUsd = Math.floor(maxCostUsd * 1e9);
  if (!Number.isSafeInteger(reservedNanoUsd) || !Number.isSafeInteger(limitNanoUsd)) throw new Error('Probe budget exceeds safe accounting range');
  const lock = `${file}.lock`;
  const descriptor = openSync(lock, 'wx', 0o600);
  const temp = `${file}.${randomUUID()}.tmp`;
  let released = false;
  function release() {
    if (released) return;
    released = true;
    closeSync(descriptor); unlinkSync(lock);
    if (existsSync(temp)) unlinkSync(temp);
  }
  try {
    const ledger = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : { version: 1, limitNanoUsd, reservations: [] };
    if (ledger.version !== 1 || ledger.limitNanoUsd !== limitNanoUsd || !Array.isArray(ledger.reservations) ||
        ledger.reservations.length >= 1000 || ledger.reservations.some(r => !Number.isSafeInteger(r.reservedNanoUsd) || r.reservedNanoUsd < 0)) {
      throw new Error('Invalid or full probe ledger, or dollar limit changed; review before continuing');
    }
    const total = ledger.reservations.reduce((sum, r) => sum + r.reservedNanoUsd, 0) + reservedNanoUsd;
    if (!Number.isSafeInteger(total) || total > limitNanoUsd) throw new Error('Probe dollar budget exhausted');
    const reservation = { id: randomUUID(), at: new Date().toISOString(), reservedNanoUsd,
      maxInputTokens, maxOutputTokens, inputRate, outputRate, status: 'reserved' };
    ledger.reservations.push(reservation);
    function save() {
      writeFileSync(temp, JSON.stringify(ledger, null, 2) + '\n', { mode: 0o600 });
      renameSync(temp, file);
    }
    save();
    return { id: reservation.id, finish(status) {
      if (released) throw new Error('Probe reservation already closed');
      try {
        if (!['captured', 'failed', 'cancelled'].includes(status)) throw new Error('Invalid probe outcome');
        reservation.status = status; save();
      } finally { release(); }
    } };
  } catch (error) { release(); throw error; }
}
