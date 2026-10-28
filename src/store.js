// -----------------------------------------------------------------------------
// What must survive a restart, in /data (the only writable place of the
// container):
//   - the time of the last read of the heat pump (written at most once a
//     minute, BEFORE the read), so a restart never reads it sooner than the
//     interval;
//   - the stops not confirmed yet (standby, a heating circuit standby, the
//     hot water push off): their target (address, port, unit id, register),
//     when they were clicked and last written, the values read before them
//     and how many times they were sent again. They are held until a read
//     shows them (never dropped by the time): a restart checks them again at
//     once, before the configuration is even read.
// No secret (the Modbus interface has none), no personal data. The file is
// readable by the container user only (0600), bounded and repaired when read.
// A file that cannot be read is not an empty one: `load()` says so, and the
// app then never overwrites it with a guess.
// -----------------------------------------------------------------------------

import { readFile, rename, writeFile } from 'node:fs/promises';
import {
  CIRCUITS,
  CIRCUIT_MODES,
  CIRCUIT_STEP,
  DHW_PUSH,
  SYSTEM_MODES,
  TIMINGS,
  UNIT_ID,
} from './constants.js';

export const STATE_FILE = '/data/weishaupt-state.json';
const MAX_BYTES = 8 * 1024;
const MAX_STOPS = 8;

export function fileStore(path = STATE_FILE) {
  // One write at a time: two saves never share the temporary file.
  let chain = Promise.resolve();
  return {
    /** `{ data }`, `{ data: null }` (no file) or `{ unreadable: true }`. */
    async load() {
      let text;
      try {
        text = await readFile(path, 'utf8');
      } catch (err) {
        return err?.code === 'ENOENT' ? { data: null } : { unreadable: true };
      }
      if (text.length > MAX_BYTES) return { unreadable: true };
      try {
        return { data: JSON.parse(text) };
      } catch {
        return { unreadable: true };
      }
    },
    save(data) {
      const text = JSON.stringify(data);
      const write = chain.then(async () => {
        const temporary = `${path}.tmp`;
        await writeFile(temporary, text, { mode: 0o600 });
        await rename(temporary, path);
      });
      chain = write.catch(() => {});
      return write;
    },
  };
}

/** For the tests: the same JSON round trip as the file. */
export function memoryStore(initial = null, { unreadable = false, failSave = false } = {}) {
  return {
    data: initial === null ? null : JSON.parse(JSON.stringify(initial)),
    saves: 0,
    unreadable,
    failSave,
    async load() {
      if (this.unreadable) return { unreadable: true };
      return { data: this.data === null ? null : JSON.parse(JSON.stringify(this.data)) };
    },
    async save(data) {
      if (this.failSave) throw new Error('disk full');
      this.data = JSON.parse(JSON.stringify(data));
      this.saves += 1;
    },
  };
}

/** A short text of printable ASCII, bounded, else undefined. */
const shortText = (value, max) =>
  typeof value === 'string' &&
  value.length > 0 &&
  value.length <= max &&
  /^[\x21-\x7e]*$/.test(value)
    ? value
    : undefined;

const intIn = (value, min, max) =>
  Number.isInteger(value) && value >= min && value <= max ? value : undefined;

/** The registers a stop may write, with the keys of the values they may hold. */
const STOP_REGISTERS = new Map([
  [40001, Object.values(SYSTEM_MODES)],
  [42102, Object.values(DHW_PUSH)],
  ...CIRCUITS.map((c) => [41103 + (Number(c) - 1) * CIRCUIT_STEP, Object.values(CIRCUIT_MODES)]),
]);

function normalizeStop(raw, now) {
  if (!raw || typeof raw !== 'object') return undefined;
  const host = shortText(raw.host, 253);
  const port = intIn(raw.port, 1, 65535);
  const unitId = intIn(raw.unitId, UNIT_ID.min, UNIT_ID.max);
  const register = intIn(raw.register, 0, 0xffff);
  if (!host || !/^[a-z0-9.-]+$/.test(host) || !port || !unitId || !STOP_REGISTERS.has(register)) {
    return undefined;
  }
  // A click dated in the future: the clock was set back (or the file is not
  // ours): invalid, never replayed. A stop is never dropped for its age.
  if (!Number.isFinite(raw.since) || raw.since > now + 1000) {
    return undefined;
  }
  const keys = STOP_REGISTERS.get(register);
  const sentAt =
    Number.isFinite(raw.sentAt) && raw.sentAt <= now + 1000 ? Math.min(raw.sentAt, now) : null;
  return {
    host,
    port,
    unitId,
    register,
    since: Math.min(raw.since, now),
    sentAt,
    written: raw.written === true,
    // The values read before the stop (keys of its register): another value read later was set at the heat pump.
    before: Array.isArray(raw.before)
      ? raw.before.filter((v) => typeof v === 'string' && keys.includes(v)).slice(0, 2)
      : [],
    reasserts: Number.isInteger(raw.reasserts)
      ? Math.min(TIMINGS.stopReasserts, Math.max(0, raw.reasserts))
      : 0,
  };
}

/**
 * The persisted state, repaired and bounded:
 * - `lastAttemptAt`: wall time of the last read, or null (a time in the
 *   future counts as now: never a longer wait than the interval);
 * - `stops`: the stops not confirmed, still running;
 * - `target`: the heat pump of the last read (address, port, unit id).
 */
export function normalizeMemory(raw, now) {
  const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const stops = Array.isArray(data.stops)
    ? data.stops
        .slice(0, MAX_STOPS)
        .map((s) => normalizeStop(s, now))
        .filter(Boolean)
    : [];
  const target = data.target && typeof data.target === 'object' ? data.target : {};
  const host = shortText(target.host, 253);
  const port = intIn(target.port, 1, 65535);
  const unitId = intIn(target.unitId, UNIT_ID.min, UNIT_ID.max);
  return {
    /** The heat pump of the last read: where a stop goes while the configuration is not read. */
    target: host && /^[a-z0-9.-]+$/.test(host) && port && unitId ? { host, port, unitId } : null,
    lastAttemptAt: Number.isFinite(data.lastAttemptAt) ? Math.min(data.lastAttemptAt, now) : null,
    stops,
  };
}
