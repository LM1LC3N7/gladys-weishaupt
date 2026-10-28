// -----------------------------------------------------------------------------
// The integration: the heat pump typed in the configuration (its IP address
// and Modbus unit id), one read of its registers every poll interval over one
// Modbus TCP connection, the Gladys device and its states, the transport
// badge, the "Test the connection" button, and the commands. index.js only
// wires the SDK handlers to it (src/handlers.js).
//
// One Modbus connection at a time (the "line"), one request at a time on it:
// a poll is one session of a few reads, closed after; the commands take the
// line from a poll (the poll is dropped, nothing of it published); a stop
// takes it from anything.
//
// Reads:
//   - never sooner than the interval after the last one: not for the test
//     button, a Discovery scan, a reconnection to Gladys, a configuration
//     saved unchanged, nor a restart (the time of the last read is kept in
//     /data, written at most once a minute, BEFORE the read);
//   - an answer for an old configuration (generation) publishes nothing; a
//     read begun before a command left is not applied; a value not read this
//     time is never republished as new, nor values older than 2 minutes.
//
// Commands (system mode, circuit mode, hot water push, hot water and room
// setpoints):
//   - refused unless "Allow the commands" is on, checked on arrival and again
//     right before the write (nothing runs in between);
//   - bounded on arrival and right before the write: hot water 5.5 °C to the
//     lowest of 60 °C, the ceiling of the configuration and 65 °C; room
//     16-28 °C; by 0.5 °C; the order comfort >= normal >= setback (hot water
//     normal >= setback) kept on the values read just before;
//   - decided on a fresh read of the registers concerned, in the same
//     session, never on the state in memory; refused when it cannot be read;
//     not written when already so (unless a guard says a previous command
//     may not show yet);
//   - refused while a stop sent to the heat pump is held (not confirmed),
//     except a new choice on the very register of that stop;
//   - at most LIMITS.eepromWritesPerHour writes per register and hour and
//     LIMITS.eepromWritesPerDay per 24 h, kept in /data (the heat pump keeps
//     them in EEPROM: 100,000 writes in its life), never for a lower setpoint;
//   - one at a time, in their order of arrival (a scene setting several
//     values sets them all, one after the other on the same connection);
//     confirmed only by the echo of the write and a read back equal to the
//     value asked; else "sent, without confirmation" and spaced reads;
//   - answered to Gladys by 3.5 s; a command still waiting its turn then goes
//     on (15 s at most after its arrival), and the answer says so;
//   - the ack never waits for a publication to Gladys.
// Stops (system mode "standby", a heating circuit "standby", hot water push
// "off") protect: never held back by the option, the bounds, a command or a
// read in progress, a failed read, a backoff, a device never read, nor a
// configuration not read yet (after a restart, a stop kept in /data is sent
// again before it); every command that arrived before a stop and has not
// left is dropped; a refused connection is tried again every 250 ms for 3 s.
// A stop not confirmed is held (in /data, with the value of before): checked
// every 15 s for 3 minutes, then every minute, whatever the interval; sent
// again while the heat pump still shows the value of before (three times,
// then every 10 minutes at most); it ends only when a read shows it, when a
// newer command to the same register leaves (a click with the option), when
// another value is read twice in a row (set at the heat pump), or when the
// configuration names another heat pump: never by the time. One lock for the
// line: a session opens only once the previous one is closed.
//
// In-memory times (deadlines, guards, the time of the last read) are on a
// monotonic clock (`clock`); the wall clock (`now`) only for /data.
// -----------------------------------------------------------------------------

import { DEVICE_TRANSPORTS, createLogger } from '@gladysassistant/integration-sdk';
import { addressKey, normalizeConfig } from './config.js';
import {
  BOUNDS,
  DAY,
  HOUR,
  ILLEGAL_DATA_ADDRESS,
  LIMITS,
  NOT_APPLIED_EXCEPTIONS,
  SECOND,
  TIMINGS,
} from './constants.js';
import {
  buildDevice,
  commandOf,
  deviceStates,
  dhwTop,
  ids,
  parseFeatureId,
  rolesToBuild,
  rolesWithValues,
  stopRoles,
} from './devices.js';
import { ERRORS, T, age, join, word } from './i18n.js';
import { interpret } from './model.js';
import { ERROR_KINDS, ModbusError, errorReason, openSession, tcpConnect } from './modbus/client.js';
import {
  decodeBlock,
  isWriteEcho,
  parseRead,
  pollBlocks,
  readRequest,
  writeRequest,
} from './modbus/protocol.js';
import { StatePublisher } from './publisher.js';
import { fileStore, normalizeMemory } from './store.js';

/** A refusal: the message Gladys shows. */
class Refusal extends Error {}

const freshUnit = () => ({
  /** The values of the last read (only those read that time), and when it started. */
  values: undefined,
  readAt: -Infinity,
  online: undefined,
  failures: 0,
  wait: undefined,
  error: undefined,
  /** The blocks that failed in the last read. */
  failed: [],
  timer: undefined,
  running: undefined,
  followUps: new Set(),
});

const monotonic = () => performance.now();

/** Register -> role of the stops (system standby, circuit standby, hot water push off). */
const STOP_ROLES = stopRoles();

const sameTarget = (a, b) =>
  Boolean(a && b) && a.host === b.host && a.port === b.port && a.unitId === b.unitId;

export class WeishauptApp {
  constructor({
    gladys,
    logger = createLogger({ name: 'weishaupt' }),
    connect = tcpConnect,
    now = Date.now,
    clock = monotonic,
    timers = globalThis,
    store = fileStore(),
  }) {
    this.gladys = gladys;
    this.logger = logger;
    this.connect = connect;
    this.now = now;
    this.clock = clock;
    this.timers = timers;
    this.store = store;
    this.publisher = new StatePublisher({ gladys, logger, now: clock, timers });
    this.config = normalizeConfig();
    this.memory = normalizeMemory(null, now());
    /** /data could not be read: never overwritten (a guess would lose what it holds). */
    this.memoryUnreadable = false;
    this.memoryLoaded = undefined;
    this.unit = freshUnit();
    this.generation = 0;
    this.started = false;
    /** The time of the last read sent to the heat pump (monotonic). */
    this.lastAttemptAt = -Infinity;
    this.lastStatus = undefined;
    this.published = undefined;
    this.badge = undefined;
    /** Roles that had a value during this run (their features are built). */
    this.seen = new Set();
    /** Optional blocks the controller does not serve (until a restart), and those answered once. */
    this.absent = new Set();
    this.answered = new Set();
    /** The session on the line: { kind: 'read' | 'command' | 'protect', abort(), done }. */
    this.active = undefined;
    /** Commands and stops waiting for the line (a poll does not start meanwhile). */
    this.reserved = 0;
    /** The commands waiting, in order, and the worker running them. */
    this.queue = [];
    this.worker = undefined;
    /** The stops waiting, and their worker. */
    this.stops = [];
    this.stopWorker = undefined;
    /** The register whose stop guard is being checked, if any. */
    this.checking = undefined;
    /** Counts the stops: a command that arrived before the current count gives way. */
    this.protectSeq = 0;
    /** When the last write left (a read begun before it is not applied). */
    this.lastSentAt = -Infinity;
    /** Register -> when the last command (not a stop) left for it. */
    this.lastWriteAt = new Map();
    /** Register -> times of the writes of the last hour (EEPROM quota). */
    this.writes = new Map();
    /** Value key -> { from, expected, moved, until, register }: a command sent, not seen yet. */
    this.guards = new Map();
    /** Register -> a stop not confirmed (see protect). */
    this.stopGuards = new Map();
  }

  /** The monotonic clock (every in-memory time). */
  mono() {
    return this.clock();
  }

  /** The heat pump of the configuration: { host, port, unitId }, or undefined. */
  target() {
    const a = this.config.address;
    return a ? { host: a.host, port: a.port, unitId: this.config.unitId } : undefined;
  }

  // --- /data ----------------------------------------------------------------

  /** Loads /data once (the stops kept there belong to the whole run). */
  loadMemory() {
    if (!this.memoryLoaded) {
      this.memoryLoaded = (async () => {
        let result;
        try {
          result = await this.store.load();
        } catch {
          result = { unreadable: true };
        }
        if (result?.unreadable) {
          this.memoryUnreadable = true;
          this.logger.warn(
            'Weishaupt: /data/weishaupt-state.json cannot be read: it is never overwritten',
          );
          this.memory = normalizeMemory(null, this.now());
          return;
        }
        this.memory = normalizeMemory(result?.data ?? null, this.now());
        // The writes of the last 24 h (wall times in /data) back on the monotonic clock.
        for (const [register, list] of Object.entries(this.memory.writes)) {
          this.writes.set(
            Number(register),
            list.map((t) => this.mono() - (this.now() - t)),
          );
        }
      })();
    }
    return this.memoryLoaded;
  }

  async saveMemory() {
    if (this.memoryUnreadable) {
      return false;
    }
    try {
      await this.store.save(this.memory);
      return true;
    } catch (err) {
      this.logger.warn(`Weishaupt: saving the state to /data failed: ${err.message}`);
      return false;
    }
  }

  /** The stops not confirmed, in /data (wall times). */
  persistStops() {
    const stops = [];
    for (const [register, g] of this.stopGuards) {
      stops.push({
        ...g.target,
        register,
        since: this.now() - (this.mono() - g.since),
        sentAt: g.sentAt === undefined ? null : this.now() - (this.mono() - g.sentAt),
        reasserts: g.reasserts,
        written: g.written,
        before: g.before.slice(0, 2),
      });
    }
    if (JSON.stringify(stops) === JSON.stringify(this.memory.stops ?? [])) {
      return;
    }
    this.memory.stops = stops;
    this.saveMemory().catch(() => {});
  }

  /**
   * At the start of the container, before the configuration is read: the
   * stops kept in /data (not confirmed before the restart) are checked at
   * once on the heat pump they were sent to, and sent again unless it shows
   * the stop or another value than the one before it twice in a row (set on
   * the heat pump meanwhile); then checked until the stop shows: never
   * dropped by the time.
   */
  async boot() {
    await this.loadMemory();
    for (const kept of this.memory.stops ?? []) {
      const plan = this.stopPlan(kept.register);
      if (!plan) {
        continue;
      }
      const target = { host: kept.host, port: kept.port, unitId: kept.unitId };
      const guard = this.ensureStopGuard(kept.register, plan, target);
      Object.assign(guard, {
        before: [...kept.before],
        written: kept.written,
        reasserts: kept.reasserts,
        since: this.mono() - Math.max(0, this.now() - kept.since),
        // The heat pump had the time to apply it: no delay before the check
        // (the time of the last write still paces the slow resends).
        sentAt: undefined,
        lastWriteAt:
          kept.sentAt === null ? undefined : this.mono() - Math.max(0, this.now() - kept.sentAt),
        // A command sent before the restart may still land: the stop showing
        // does not end the guard for the life of a command guard.
        sticky: true,
        stickyUntil: this.mono() + TIMINGS.guard,
      });
      this.logger.warn(
        `Weishaupt: a stop kept in /data (register ${kept.register}) is checked again after the restart`,
      );
      this.runCheck(kept.register).catch((err) =>
        this.logger.warn(`Weishaupt: check after the restart: ${err.message}`),
      );
    }
    this.persistStops();
  }

  /** The plan of a stop of `register` (40001 standby, 41x03 circuit standby, 42102 push off). */
  stopPlan(register) {
    const role = STOP_ROLES.get(register);
    const command = role ? commandOf(role) : undefined;
    if (!command || command.kind !== 'select') {
      return undefined;
    }
    // The register value of the stop, from the table (never a guess: 0 is "automatic" here).
    const [written] = Object.entries(command.table).find(([, key]) => key === command.protective);
    return { role, command, written: Number(written), expected: command.protective };
  }

  // --- Lifecycle -------------------------------------------------------------

  /**
   * `fresh`: started for a new address while running (a read may go at
   * once); otherwise (container start) the first read waits for the
   * interval after the last read kept in /data.
   */
  async start(raw = {}, { fresh = false } = {}) {
    this.stop();
    // Set at once: a `connected` or a configuration saved during this start
    // compares with it (never a restart, never a read before the interval).
    this.config = normalizeConfig(raw);
    const generation = this.generation;
    await this.unit.running;
    await this.loadMemory();
    if (generation !== this.generation) {
      return;
    }
    this.unit = freshUnit();
    this.dropOtherTargets();
    this.absent.clear();
    this.answered.clear();
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.publisher.start();
    if (!this.config.address) {
      // The device already created is shown unreachable.
      await this.publishAll();
      return;
    }
    await this.setStatus(false, this.status());
    if (generation !== this.generation) {
      return;
    }
    const wait = fresh ? 0 : this.firstWait();
    if (wait > 0) {
      this.schedule(wait);
      await this.publishAll();
      return;
    }
    await this.tick();
  }

  /** The wait before the first read after a container start, from the time kept in /data. */
  firstWait() {
    if (this.memoryUnreadable) {
      // The time of the last read is unknown: a whole interval.
      return this.interval;
    }
    const stored = this.memory.lastAttemptAt;
    if (stored === null) {
      return 0;
    }
    this.lastAttemptAt = Math.max(this.lastAttemptAt, this.mono() - (this.now() - stored));
    // A read may have left up to a minute after the time kept (written at most once a minute).
    const due = stored + TIMINGS.attemptWriteEvery + this.interval;
    return Math.min(this.interval, Math.max(0, due - this.now()));
  }

  /**
   * A configuration read from Gladys with another heat pump (address, port,
   * unit id): the stops held for the previous one end (the user moved to
   * another heat pump). An empty or invalid address ends none.
   */
  dropOtherTargets() {
    const target = this.target();
    if (!this.configRead || !target) return;
    for (const [register, guard] of [...this.stopGuards]) {
      if (!sameTarget(guard.target, target)) {
        this.logger.info(
          `Weishaupt: the stop of register ${register} was for another heat pump: no longer held`,
        );
        this.dropStopGuard(register);
      }
    }
  }

  stop() {
    this.generation += 1;
    this.clearTimer();
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    for (const handle of this.unit.followUps) {
      this.timers.clearTimeout(handle);
    }
    this.unit.followUps.clear();
    // A read or a command of this configuration ends; a stop or a check has its own target.
    if (this.active && ['read', 'command'].includes(this.active.kind)) {
      this.active.abort('stopped');
    }
    this.publisher.stop();
    // Guards of commands belong to this configuration only (stops keep theirs: their own target).
    this.guards.clear();
  }

  /** The container stops: every timer, the checks of the stops too (they are in /data). */
  shutdown() {
    this.stop();
    for (const guard of this.stopGuards.values()) {
      if (guard.timer) this.timers.clearTimeout(guard.timer);
      guard.timer = undefined;
    }
  }

  clearTimer() {
    if (this.unit.timer) {
      this.timers.clearTimeout(this.unit.timer);
      this.unit.timer = undefined;
    }
  }

  /**
   * Connected to Gladys. The first time, start; after a reconnection, resend
   * what Gladys keeps in memory only (status, Discovery list, badge) and the
   * recent states, without reading the heat pump.
   */
  async connected(raw = {}) {
    this.configRead = true;
    if (!this.started) {
      this.started = true;
      await this.start(raw);
      return;
    }
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.published = undefined;
    this.badge = undefined;
    this.lastStatus = undefined;
    this.gladys.forgetPublishedStates?.();
    this.rescheduleOnNewInterval(previous);
    await this.publishAll();
  }

  /**
   * Connected to Gladys: reads the configuration, tried again every 30 s
   * while it fails (with a status), then `connected`.
   */
  async onConnected(getConfig) {
    if (this.configTimer) {
      this.timers.clearTimeout(this.configTimer);
      this.configTimer = undefined;
    }
    let raw;
    try {
      raw = await getConfig();
    } catch (err) {
      this.logger.warn(`Weishaupt: reading the configuration failed: ${err.message}`);
      await this.setStatus(false, T.configUnreadable);
      this.configTimer = this.timers.setTimeout(() => {
        this.configTimer = undefined;
        this.onConnected(getConfig).catch(() => {});
      }, TIMINGS.configRetry);
      return;
    }
    await this.connected(raw);
  }

  /** A new address, unit id or circuit list restarts (an interval only reschedules). */
  needsRestart(raw) {
    const next = normalizeConfig(raw);
    return (
      JSON.stringify(next.address ?? null) !== JSON.stringify(this.config.address ?? null) ||
      next.invalid !== this.config.invalid ||
      next.unitId !== this.config.unitId ||
      next.circuits.join() !== this.config.circuits.join()
    );
  }

  rescheduleOnNewInterval(previous) {
    const u = this.unit;
    if (
      this.config.pollInterval !== previous.pollInterval &&
      this.config.address &&
      !u.running &&
      u.online !== false &&
      u.timer
    ) {
      this.schedule();
    }
  }

  async configUpdated(raw = {}) {
    if (this.needsRestart(raw)) {
      await this.start(raw, { fresh: true });
      return;
    }
    const previous = this.config;
    this.config = normalizeConfig(raw);
    this.rescheduleOnNewInterval(previous);
    if (this.config.allowCommands !== previous.allowCommands) {
      this.logger.info(`Weishaupt commands ${this.config.allowCommands ? 'allowed' : 'disabled'}`);
    }
    if (this.config.language !== previous.language) {
      this.published = undefined;
    }
    await this.publishAll();
  }

  async setStatus(connected, message) {
    const key = JSON.stringify([connected, message ?? null]);
    if (key === this.lastStatus) {
      return;
    }
    this.lastStatus = key;
    await this.gladys
      .setConnectionStatus(connected, message)
      .catch((err) => this.logger.warn(`setConnectionStatus failed: ${err.message}`));
  }

  // --- The line (one Modbus connection at a time) ------------------------------

  /**
   * Runs `fn(session)` on its own connection to `target`; the line is held
   * until it ends. The only lock of the line: a session opens only once no
   * other holds it (a stop ends any other session first and waits for its
   * end). `yieldTo()`: checked right before the line is taken, with no
   * `await` in between; true gives the turn up (a command or a read before
   * a stop waiting). `retryUntil`: a refused connection is tried again every
   * 250 ms until then (nothing is sent before the connection, so this never
   * repeats a write).
   */
  async useLine(kind, target, timeoutMs, fn, { retryUntil, yieldTo } = {}) {
    while (this.active) {
      if (kind === 'protect' && this.active.kind !== 'protect') {
        this.active.abort('line taken');
      }
      await this.active.done;
    }
    if (yieldTo?.()) {
      throw Object.assign(new ModbusError(ERROR_KINDS.ABORTED, 'turn given up'), {
        yielded: true,
      });
    }
    let finish;
    const record = {
      kind,
      aborted: false,
      opener: undefined,
      session: undefined,
      done: new Promise((resolve) => {
        finish = resolve;
      }),
      abort: (message) => {
        record.aborted = true;
        record.opener?.abort();
        record.session?.abort(message);
      },
    };
    this.active = record;
    try {
      let session;
      for (;;) {
        const attemptMs =
          retryUntil === undefined
            ? timeoutMs
            : Math.min(timeoutMs, Math.max(100, retryUntil - this.mono()));
        record.opener = openSession({
          host: target.host,
          port: target.port,
          unitId: target.unitId,
          connect: this.connect,
          timeoutMs: attemptMs,
          timers: this.timers,
          now: () => this.mono(),
        });
        try {
          session = await record.opener.promise;
          break;
        } catch (err) {
          const again =
            err.kind === ERROR_KINDS.UNREACHABLE &&
            !record.aborted &&
            retryUntil !== undefined &&
            this.mono() + TIMINGS.connectRetry < retryUntil;
          if (!again) {
            throw err;
          }
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
        if (record.aborted) {
          throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
        }
      }
      record.session = session;
      if (record.aborted) {
        session.abort();
        throw new ModbusError(ERROR_KINDS.ABORTED, 'line taken');
      }
      return await fn(session, record);
    } finally {
      // The line is free only once the connection is closed (never two at once).
      await record.session?.close();
      if (this.active === record) {
        this.active = undefined;
      }
      finish();
    }
  }

  /** Ends the session on the line when it is one of `kinds`, and waits for its end. */
  async takeLine(kinds) {
    const current = this.active;
    if (current && kinds.includes(current.kind)) {
      current.abort('line taken');
      await current.done;
    }
  }

  /** Waits until no session holds the line. */
  async freeLine() {
    while (this.active) {
      await this.active.done;
    }
  }

  /** One block read in `session`: its raw words decoded (src/modbus/protocol.js). */
  async readBlock(session, block, options) {
    const pdu = await session.request(readRequest(block), options);
    const words = parseRead(block, pdu);
    if (words === undefined) {
      // An answer of the wrong size: the session is not trusted any more.
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'answer of the wrong size', { sent: true });
    }
    return decodeBlock(block, words);
  }

  /** The values of a command's block, read now (interpreted: only those known). */
  async readValues(session, command, options) {
    return interpret(await this.readBlock(session, command.block, options));
  }

  /** The value of one command's register, read now (interpreted), or undefined. */
  async readPoint(session, command, options) {
    return (await this.readValues(session, command, options))[command.read];
  }

  // --- Polling ---------------------------------------------------------------

  get interval() {
    return this.config.pollInterval * SECOND;
  }

  /** The earliest time the next polling read may go: the interval after the last one. */
  get due() {
    return this.lastAttemptAt + this.interval;
  }

  /** The next read: after its backoff, else the interval; never sooner than the interval after the last read. */
  schedule(delay) {
    const u = this.unit;
    this.clearTimer();
    let wait = delay ?? (u.online === false ? u.wait : this.interval);
    wait = Math.max(wait ?? this.interval, Math.min(this.interval, this.due - this.mono()), 0);
    const generation = this.generation;
    u.timer = this.timers.setTimeout(() => {
      u.timer = undefined;
      if (generation === this.generation && u === this.unit) {
        this.tick().catch(() => this.logger.error('Weishaupt refresh failed'));
      }
    }, wait);
  }

  /** One read at a time: a tick during a read joins it. */
  tick() {
    const u = this.unit;
    if (!u.running) {
      u.running = this.run().finally(() => {
        u.running = undefined;
      });
    }
    return u.running;
  }

  /** Keeps the time of this read; in /data BEFORE the read, at most once a minute. */
  async noteAttempt() {
    this.lastAttemptAt = this.mono();
    const now = this.now();
    const stored = this.memory.lastAttemptAt;
    if (stored === null || now - stored >= TIMINGS.attemptWriteEvery || now < stored) {
      this.memory.lastAttemptAt = now;
      await this.saveMemory();
    }
  }

  async run() {
    const generation = this.generation;
    const target = this.target();
    if (!target) {
      return;
    }
    if (this.active || this.reserved > 0) {
      // A command or a stop holds the line: the poll waits for the next turn.
      this.schedule();
      return;
    }
    await this.noteAttempt();
    if (generation !== this.generation) {
      return;
    }
    if (this.active || this.reserved > 0) {
      this.schedule();
      return;
    }
    const startedAt = this.mono();
    let result;
    let failure;
    try {
      result = await this.useLine(
        'read',
        target,
        TIMINGS.connectTimeout,
        (session) => this.readAll(session),
        { yieldTo: () => this.reserved > 0 || this.stops.length > 0 },
      );
    } catch (err) {
      failure = err;
    }
    if (generation !== this.generation) {
      return;
    }
    let delay;
    if (failure?.kind === ERROR_KINDS.ABORTED) {
      this.logger.debug('Weishaupt: read dropped, a command took the line');
    } else if (failure) {
      delay = this.failed(failure);
    } else if (startedAt <= this.lastSentAt) {
      // Begun before a command left: it may show the state before it.
      this.logger.debug('Weishaupt: read begun before a command, not applied');
    } else {
      this.applyRead(result, startedAt);
    }
    await this.publishAll();
    if (generation === this.generation) {
      this.schedule(delay);
    }
  }

  /**
   * Every block, one after the other. A core block refused fails the read;
   * an optional block refused with "illegal data address" before it was ever
   * answered is not served by this controller (not read again until a
   * restart); any other refusal leaves its values unknown this time. A
   * timeout, a closed connection or a wrong answer fails the whole read.
   */
  async readAll(session) {
    const raw = {};
    const failed = [];
    for (const block of pollBlocks(this.config.circuits)) {
      if (this.absent.has(block.key)) {
        continue;
      }
      let values;
      try {
        values = await this.readBlock(session, block, { timeoutMs: TIMINGS.requestTimeout });
      } catch (err) {
        if (err.kind !== ERROR_KINDS.REFUSED || block.core) {
          throw err;
        }
        if (err.code === ILLEGAL_DATA_ADDRESS && !this.answered.has(block.key)) {
          this.absent.add(block.key);
          this.logger.info(`Weishaupt: the controller does not serve the ${block.key} registers`);
        } else {
          failed.push(block.key);
          this.logger.warn(
            `Weishaupt: reading the ${block.key} registers failed (${errorReason(err)})`,
          );
        }
        continue;
      }
      this.answered.add(block.key);
      Object.assign(raw, values);
    }
    return { values: interpret(raw), failed };
  }

  /** A read: the values of this read only (a value not read is unknown). */
  applyRead({ values, failed }, startedAt) {
    const u = this.unit;
    u.online = true;
    u.failures = 0;
    u.wait = undefined;
    u.error = undefined;
    u.values = values;
    u.readAt = startedAt;
    u.failed = failed;
    for (const role of rolesWithValues(values)) {
      this.seen.add(role);
    }
    const target = this.target();
    if (!sameTarget(target, this.memory.target)) {
      this.memory.target = target;
      this.saveMemory().catch(() => {});
    }
    this.observe(values, startedAt);
  }

  /** A failed read: the delay before the next one. */
  failed(err) {
    const u = this.unit;
    const reason = errorReason(err);
    const wait = Math.max(
      this.interval,
      TIMINGS.backoff[Math.min(u.failures, TIMINGS.backoff.length - 1)],
    );
    u.failures += 1;
    u.online = false;
    u.wait = wait;
    u.error = reason;
    this.logger.warn(`Weishaupt: ${reason}; next try in ${Math.round(wait / 1000)} s`);
    return wait;
  }

  /** The connection status of the configuration screen. */
  status() {
    const u = this.unit;
    const c = this.config;
    const notes = (text) => (c.badCircuits ? join(text, T.badCircuits) : text);
    if (!c.address) {
      if (c.invalid) return T.invalid(c.invalid);
      return c.badUnitId ? T.badUnitId : T.noHost;
    }
    if (u.online === false) {
      const wait = age(u.wait ?? this.interval);
      return notes(
        [ERROR_KINDS.UNREACHABLE, ERROR_KINDS.TIMEOUT, ERROR_KINDS.CLOSED].includes(u.error)
          ? T.unreachable(addressKey(c.address), wait)
          : T.failing(u.error ?? 'error', wait),
      );
    }
    if (u.online === undefined) {
      return notes(
        u.timer && this.due > this.mono() ? T.waiting(age(this.due - this.mono())) : T.connecting,
      );
    }
    let text = T.connected(T.summary(u.values ?? {}));
    if (u.failed.length > 0) {
      text = join(text, T.missingBlocks(u.failed.join(', ')));
    }
    return notes(text);
  }

  async updateStatus() {
    await this.setStatus(this.unit.online === true && Boolean(this.config.address), this.status());
  }

  // --- Gladys ----------------------------------------------------------------

  createdDevice() {
    const id = ids(this.gladys).device;
    return (this.gladys.devices ?? []).find((d) => d?.external_id === id);
  }

  async publishAll() {
    const generation = this.generation;
    await this.publishDevices();
    if (generation !== this.generation) {
      return;
    }
    this.queueStates();
    await this.flush();
    if (generation !== this.generation) {
      return;
    }
    await this.publishBadge();
    if (generation !== this.generation) {
      return;
    }
    await this.updateStatus();
  }

  async flush() {
    await this.publisher
      .flush()
      .catch((err) => this.logger.warn(`Sending to Gladys failed: ${err.message}`));
  }

  /** The roles of the created device (a republished device never loses one). */
  createdRoles() {
    const roles = new Set();
    for (const f of this.createdDevice()?.features ?? []) {
      const role = parseFeatureId(f?.external_id);
      if (role) roles.add(role);
    }
    return roles;
  }

  /** The device, once the heat pump answered. */
  async publishDevices() {
    if (this.unit.online !== true) {
      return;
    }
    const roles = rolesToBuild({
      circuits: this.config.circuits,
      seen: this.seen,
      created: this.createdRoles(),
    });
    const devices = [
      buildDevice(this.gladys, {
        language: this.config.language,
        roles,
        dhwCap: this.config.dhwCap,
      }),
    ];
    const json = JSON.stringify(devices);
    if (json === this.published) {
      return;
    }
    try {
      await this.gladys.publishDiscoveredDevices(devices);
      this.published = json;
    } catch (err) {
      this.logger.warn(`Publishing the discovered devices failed: ${err.message}`);
    }
  }

  createdFeatures() {
    return new Set((this.createdDevice()?.features ?? []).map((f) => f?.external_id));
  }

  /** Pushes the given values (only these) to the created features. */
  queueValues(values, created = this.createdFeatures(), at = this.mono()) {
    for (const { device_feature_external_id: id, ...value } of deviceStates(
      ids(this.gladys),
      values,
    )) {
      if (created.has(id)) {
        this.publisher.push(id, value, at);
      }
    }
  }

  /** The last values, only when recent (never an old read republished as new). */
  queueStates(created) {
    const u = this.unit;
    if (u.online === true && u.values && this.mono() - u.readAt <= TIMINGS.freshFor) {
      this.queueValues(u.values, created, u.readAt);
    }
  }

  async publishBadge() {
    const device = this.createdDevice();
    const online = this.unit.online;
    if (!device || (online === undefined && this.config.address)) {
      return;
    }
    const entries = [
      {
        external_id: device.external_id,
        transport: online === true ? DEVICE_TRANSPORTS.LOCAL : DEVICE_TRANSPORTS.UNREACHABLE,
      },
    ];
    const json = JSON.stringify(entries);
    if (json === this.badge) {
      return;
    }
    try {
      await this.gladys.publishTransports(entries);
      this.badge = json;
    } catch (err) {
      this.logger.warn(`Transport badge failed: ${err.message}`);
    }
  }

  /** A device was created (or updated): send its recent values at once. */
  async deviceCreated(device) {
    this.badge = undefined;
    const created = this.createdFeatures();
    for (const f of device?.features ?? []) {
      created.add(f?.external_id);
    }
    this.queueStates(created);
    await this.flush();
    await this.publishBadge();
  }

  async deviceDeleted(device) {
    this.badge = undefined;
    if (typeof device?.external_id === 'string') {
      this.publisher.forget(device.external_id);
    }
  }

  /** The Discovery tab asks for a scan: the device sent again (no read). */
  async scan() {
    this.published = undefined;
    await this.publishDevices();
  }

  // --- Configuration button ------------------------------------------------------

  /** A read now, unless the last one is more recent than the interval (then its result). */
  async testConnection() {
    if (!this.config.address) {
      return this.status();
    }
    const u = this.unit;
    const current = () => JSON.parse(this.lastStatus ?? '[false,null]')[1] ?? this.status();
    if (u.running) {
      await u.running;
      return current();
    }
    if (this.mono() < this.due) {
      const waited = T.waiting(age(this.due - this.mono()));
      return Number.isFinite(this.lastAttemptAt) && u.online !== undefined
        ? join(join(current(), T.lastRead(age(this.mono() - this.lastAttemptAt))), waited)
        : waited;
    }
    this.clearTimer();
    await this.tick();
    return current();
  }

  // --- Commands --------------------------------------------------------------------

  refusal(text) {
    return new Refusal(word(text, this.config.language));
  }

  /** The value of a command, checked strictly; returns `{ written, expected }`. */
  parseValue(command, value) {
    if (command.kind === 'select') {
      // Strictly one of the keys of the select: never trimmed, re-cased nor a number.
      const known = Object.entries(command.table).find(([, key]) => key === value);
      if (typeof value !== 'string' || !known) {
        throw this.refusal(ERRORS.badValue);
      }
      if (!command.writable.includes(value)) {
        throw this.refusal(ERRORS.notWritable);
      }
      return { written: Number(known[0]), expected: value };
    }
    const number =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^-?\d{1,3}(\.\d{1,3})?$/.test(value)
          ? Number(value)
          : undefined;
    if (!Number.isFinite(number)) {
      throw this.refusal(ERRORS.badNumber);
    }
    const { step } = command.kind === 'dhw' ? BOUNDS.dhw : BOUNDS.room;
    if (Math.abs(number / step - Math.round(number / step)) > 1e-9) {
      throw this.refusal(ERRORS.badStep(step));
    }
    if (command.kind === 'dhw') {
      this.checkDhw(number);
      return { written: number, expected: number };
    }
    const { min, max } = BOUNDS.room;
    if (number < min || number > max) {
      throw this.refusal(ERRORS.outOfRange(min, max));
    }
    return { written: number, expected: number };
  }

  /**
   * The hot water bounds, on the configuration of now: 5.5 °C to the lowest
   * of 60 °C (the heat pump), the ceiling of the configuration and 65 °C.
   */
  checkDhw(number) {
    if (number < BOUNDS.dhw.min || number > BOUNDS.dhw.max) {
      throw this.refusal(ERRORS.outOfRange(BOUNDS.dhw.min, BOUNDS.dhw.max));
    }
    if (number > dhwTop(this.config.dhwCap)) {
      throw this.refusal(ERRORS.dhwCap(this.config.dhwCap));
    }
  }

  /**
   * The order the controller keeps between the setpoints of a block, on the
   * values read just before: refused when one of them is unknown or when the
   * new value would break it.
   */
  checkOrder(command, written, values) {
    for (const key of [...command.atLeast, ...command.atMost]) {
      if (values[key] === undefined) {
        throw this.refusal(ERRORS.unknownValue);
      }
    }
    if (
      command.atLeast.some((key) => written < values[key]) ||
      command.atMost.some((key) => written > values[key])
    ) {
      throw this.refusal(ERRORS.order);
    }
  }

  async setValue(_device, feature, value) {
    // The deadlines count from the arrival of the command, before any wait.
    const received = this.mono();
    const role = parseFeatureId(feature?.external_id);
    const command = role ? commandOf(role) : undefined;
    if (!command) {
      throw this.refusal(ERRORS.readOnly);
    }
    const { written, expected } = this.parseValue(command, value);
    const plan = { role, command, written, expected };
    if (command.kind === 'select' && expected === command.protective) {
      // A stop: never held back by the option, the configuration of circuits or a read;
      // before the configuration is read (Gladys unreachable), to the last heat pump read.
      const target = this.target() ?? (this.configRead ? undefined : this.memory.target);
      if (!target) {
        throw this.refusal(ERRORS.noHost);
      }
      return this.protect(plan, received, target);
    }
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (command.circuit && !this.config.circuits.includes(command.circuit)) {
      throw this.refusal(ERRORS.noCircuit);
    }
    if (!this.target()) {
      throw this.refusal(ERRORS.noHost);
    }
    if (this.queue.length >= 16) {
      throw this.refusal(ERRORS.busy);
    }
    return this.enqueue(plan, received);
  }

  /**
   * Queues a command; answers by 3.5 s after its arrival: its outcome, or,
   * when it is still waiting its turn or its answer, what is known then (it
   * goes on in the background).
   */
  async enqueue(plan, received) {
    const job = {
      plan,
      received,
      seq: this.protectSeq,
      generation: this.generation,
      target: this.target(),
      state: { written: false },
    };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.queue.push(job);
    this.runQueue();
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let timer;
    const outcome = await new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      job.done.then(resolve);
    });
    this.timers.clearTimeout(timer);
    if (outcome.late) {
      job.done.then((o) => {
        if (o.error) this.logger.warn(`Weishaupt: ${plan.role} after the ack: ${o.error.message}`);
      });
      if (!job.state.written) {
        throw this.refusal(ERRORS.queued);
      }
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.noAnswerYet, this.config.language)));
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return undefined;
  }

  /** The worker of the commands: one session, the jobs one after the other. */
  runQueue() {
    if (this.worker) {
      return;
    }
    this.reserved += 1;
    this.worker = (async () => {
      try {
        while (this.queue.length > 0) {
          // The stops first, all of them.
          while (this.stopWorker) {
            await this.stopWorker;
          }
          await this.takeLine(['read']);
          if (this.queue.length === 0) break;
          const job = this.queue[0];
          if (!sameTarget(job.target, this.target()) || job.generation !== this.generation) {
            this.queue.shift();
            job.resolve({ error: this.refusal(ERRORS.configChanged) });
            continue;
          }
          try {
            await this.useLine(
              'command',
              job.target,
              TIMINGS.commandConnectMax,
              (session) => this.drain(session, job.target),
              // Checked right before the line is taken: a stop arrived meanwhile goes first.
              { yieldTo: () => this.stops.length > 0 || Boolean(this.stopWorker) },
            );
          } catch (err) {
            if (err.yielded) {
              continue;
            }
            // The connection failed or was taken: the job in front answers it.
            const front = this.queue[0];
            if (front && front === job && !job.started) {
              this.queue.shift();
              job.resolve({ error: this.commandError(err, job) });
            }
          }
        }
      } finally {
        this.reserved -= 1;
        this.worker = undefined;
      }
    })();
  }

  /** Runs the queued jobs for `target` on one session. */
  async drain(session, target) {
    while (this.queue.length > 0) {
      if (this.stops.length > 0) {
        // A stop waits: the session ends, the stop goes, the queue after it.
        return;
      }
      const job = this.queue[0];
      if (!sameTarget(job.target, target)) {
        return;
      }
      this.queue.shift();
      job.started = true;
      let outcome;
      try {
        await this.commandSession(session, job);
        outcome = {};
      } catch (err) {
        outcome = { error: this.commandError(err, job) };
        if ((!(err instanceof Refusal) || err.sessionDead) && !err?.beforeSend) {
          // The session failed: the next jobs open a new one.
          job.resolve(outcome);
          return;
        }
      }
      job.resolve(outcome);
    }
  }

  /** The answer to Gladys of a command that did not end confirmed. */
  commandError(err, job) {
    if (err instanceof Refusal || err?.beforeSend) {
      return err;
    }
    const { plan, state } = job;
    const reason = errorReason(err);
    const what = `${plan.role} ${plan.written}`;
    if (!state.written) {
      this.logger.warn(`Weishaupt: command NOT sent (${what}): ${reason}`);
      if (err?.kind === ERROR_KINDS.LATE) {
        return this.refusal(ERRORS.tooSlow);
      }
      if (err?.kind === ERROR_KINDS.ABORTED) {
        return this.refusal(
          job.seq !== this.protectSeq ? ERRORS.protectMeanwhile : ERRORS.configChanged,
        );
      }
      return this.refusal(ERRORS.notSent(reason));
    }
    if (state.refused) {
      // Not applied: it can no longer land after a stop.
      this.guards.delete(plan.command.read);
      this.logger.warn(`Weishaupt: command refused by the heat pump (${what}): ${reason}`);
      return this.refusal(ERRORS.refused(reason));
    }
    return this.unconfirmed(plan, state, reason);
  }

  /** A command that may have reached the heat pump: guard, spaced reads, "sent, without confirmation". */
  unconfirmed(plan, state, reason) {
    this.guards.set(plan.command.read, {
      from: state.from,
      expected: plan.expected,
      moved: false,
      until: this.mono() + TIMINGS.guard,
      register: plan.command.address,
    });
    this.followUp();
    this.logger.warn(`Weishaupt: command sent, NOT confirmed (${plan.role}): ${reason}`);
    return this.refusal(ERRORS.sentUnconfirmed(reason));
  }

  /** The checks before the write, on the latest configuration. */
  checkCommand(job) {
    const { plan } = job;
    if (!this.config.allowCommands) {
      throw this.refusal(ERRORS.disabled);
    }
    if (job.generation !== this.generation || !sameTarget(job.target, this.target())) {
      throw this.refusal(ERRORS.configChanged);
    }
    if (job.seq !== this.protectSeq) {
      throw this.refusal(ERRORS.protectMeanwhile);
    }
    if (plan.command.circuit && !this.config.circuits.includes(plan.command.circuit)) {
      throw this.refusal(ERRORS.noCircuit);
    }
    if (plan.command.kind === 'dhw') {
      // The ceiling may have been lowered since the command arrived.
      this.checkDhw(plan.written);
    }
    // A stop held (not confirmed yet) on this heat pump: only a newer choice
    // on its own register (a click that lifts it) may go, nothing else.
    for (const [register, guard] of this.stopGuards) {
      if (register !== plan.command.address && sameTarget(guard.target, job.target)) {
        throw this.refusal(ERRORS.stopHeld);
      }
    }
  }

  /** Writes of the last 24 h to `register` (EEPROM, monotonic times), the older ones forgotten. */
  dayWrites(register) {
    const since = this.mono() - DAY;
    const list = (this.writes.get(register) ?? []).filter((t) => t > since);
    this.writes.set(register, list);
    return list;
  }

  /** Writes of the last hour to `register`. */
  recentWrites(register) {
    const since = this.mono() - HOUR;
    return this.dayWrites(register).filter((t) => t > since);
  }

  /**
   * A command written to `register` (synchronous, in `beforeSend`): counted,
   * and kept in /data (wall times) so a restart does not reset the daily
   * budget of the EEPROM.
   */
  noteWrite(register, at) {
    this.dayWrites(register).push(at);
    const writes = {};
    for (const [r, list] of this.writes) {
      if (list.length > 0) writes[r] = list.map((t) => Math.round(this.now() - (this.mono() - t)));
    }
    this.memory.writes = writes;
    this.saveMemory().catch(() => {});
  }

  async commandSession(session, job) {
    const { plan, state } = job;
    const { command } = plan;
    // A queued command starts within 15 s of its arrival, or never.
    const startBy = job.received + TIMINGS.queueWindow;
    const readMs = Math.min(TIMINGS.commandReadMax, startBy - this.mono());
    if (readMs < TIMINGS.commandMinRead) {
      throw this.refusal(ERRORS.tooSlow);
    }
    this.checkCommand(job);
    // The value just before acting, read now in this session, never the one in memory.
    let fresh;
    let around;
    try {
      around = await this.readValues(session, command, { timeoutMs: readMs });
      fresh = around[command.read];
    } catch (err) {
      if (err.kind === ERROR_KINDS.ABORTED) {
        throw err;
      }
      const sessionDead = err.kind !== ERROR_KINDS.REFUSED;
      const refusal = this.refusal(ERRORS.unknownState(errorReason(err)));
      if (sessionDead) {
        refusal.sessionDead = true;
      }
      throw refusal;
    }
    if (fresh === undefined) {
      throw this.refusal(ERRORS.unknownValue);
    }
    this.checkCommand(job);
    if (command.kind !== 'select') {
      this.checkOrder(command, plan.written, around);
    }
    this.noteValues({ [command.read]: fresh });
    state.from = fresh;
    // A guard (a command or a stop not seen yet) makes it written anyway: the
    // value read may not show the previous one yet, and a stop kept for
    // this register is cancelled only by a newer command that left.
    if (
      fresh === plan.expected &&
      !this.guardActive(command.read) &&
      !this.stopGuards.has(command.address)
    ) {
      this.logger.info(`Weishaupt: ${plan.role} already so, nothing sent`);
      return;
    }
    const lower = command.kind !== 'select' && plan.written < fresh;
    const recent = this.recentWrites(command.address);
    if (!lower && recent.length >= LIMITS.eepromWritesPerHour) {
      throw this.refusal(ERRORS.quota(recent.length));
    }
    const day = this.dayWrites(command.address);
    if (!lower && day.length >= LIMITS.eepromWritesPerDay) {
      throw this.refusal(ERRORS.quotaDay(day.length));
    }
    const request = writeRequest(command.address, command.type, plan.written);
    this.logger.info(`Weishaupt: ${plan.role} (${plan.written})`);
    const sendBy = this.mono() + TIMINGS.commandMinSend + TIMINGS.commandMinRead;
    let echo;
    try {
      echo = await session.request(request, {
        timeoutMs: TIMINGS.requestTimeout,
        startBy: Math.min(sendBy, startBy + TIMINGS.commandMinSend),
        beforeSend: () => {
          // The option, the configuration, the bounds and a stop, right before the write.
          this.checkCommand(job);
          state.written = true;
          const at = this.mono();
          this.lastSentAt = at;
          this.lastWriteAt.set(command.address, at);
          this.noteWrite(command.address, at);
          // Marked at once: a stop clicked while this write is on its way holds against it.
          this.guards.set(command.read, {
            from: fresh,
            expected: plan.expected,
            moved: false,
            until: at + TIMINGS.guard,
            register: command.address,
          });
          // A newer command for this register left: an older stop is never sent again after it.
          this.dropStopGuard(command.address);
        },
      });
    } catch (err) {
      if (err.kind === ERROR_KINDS.REFUSED && NOT_APPLIED_EXCEPTIONS.has(err.code)) {
        state.refused = true;
      }
      throw err;
    }
    if (!isWriteEcho(request, echo)) {
      session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
      throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', { sent: true });
    }
    // Confirmed only by the value read back equal to the value asked.
    const back = await this.readPoint(session, command, { timeoutMs: TIMINGS.requestTimeout });
    if (back !== plan.expected) {
      if (back !== undefined) {
        this.noteValues({ [command.read]: back });
      }
      throw new ModbusError(
        ERROR_KINDS.PROTOCOL,
        word(ERRORS.readBackDiffers, this.config.language),
        { sent: true },
      );
    }
    this.guards.delete(command.read);
    this.noteValues({ [command.read]: back });
    this.logger.info(`Weishaupt: ${plan.role} confirmed by the heat pump`);
  }

  /** The values a command read or confirmed: in memory and to Gladys in the background. */
  noteValues(values) {
    if (this.unit.online !== true || !this.unit.values) {
      return;
    }
    Object.assign(this.unit.values, values);
    this.queueValues(values);
    this.flush().catch(() => {});
  }

  // --- The stops (protective) ---------------------------------------------------

  /**
   * A stop clicked: queued with the other clicks (never behind a command, a
   * read or a check: it ends them), answered by 3.5 s after the click. A second press of the same
   * stop while one waits joins it.
   */
  async protect(plan, received, target) {
    // Every command that arrived before this stop and has not left gives way.
    this.protectSeq += 1;
    const job = this.queueStop({
      plan,
      register: plan.command.address,
      target,
      received,
    });
    const answerIn = Math.max(0, received + TIMINGS.commandAnswerBy - this.mono());
    let timer;
    const outcome = await new Promise((resolve) => {
      timer = this.timers.setTimeout(() => resolve({ late: true }), answerIn);
      job.done.then(resolve);
    });
    this.timers.clearTimeout(timer);
    if (outcome.late) {
      if (!job.state.written) {
        throw this.refusal(ERRORS.stopPending);
      }
      throw this.refusal(ERRORS.sentUnconfirmed(word(ERRORS.noAnswerYet, this.config.language)));
    }
    if (outcome.error) {
      throw outcome.error;
    }
    return undefined;
  }

  /**
   * Queues a click of a stop: before every check, in the order of the clicks.
   * A click of the same register and target still waiting is joined (never
   * a check: a click is always written and read back). The poll, a command
   * or a check on the line is ended at once (synchronously); a check is
   * done again at its next turn.
   */
  queueStop({ plan, register, target, received }) {
    let job = this.stops.find(
      (j) => !j.running && j.register === register && sameTarget(j.target, target),
    );
    if (job) {
      return job;
    }
    job = { plan, register, target, received, state: { written: false, sentAt: undefined } };
    job.done = new Promise((resolve) => {
      job.resolve = resolve;
    });
    this.stops.push(job);
    if (this.active && this.active.kind !== 'protect') {
      this.active.abort('line taken');
    }
    this.runStops();
    return job;
  }

  /** The worker of the clicks of stops: before anything else on the line. */
  runStops() {
    if (this.stopWorker) {
      return;
    }
    this.reserved += 1;
    this.stopWorker = (async () => {
      try {
        while (this.stops.length > 0) {
          const job = this.stops[0];
          job.running = true;
          try {
            await this.sendStop(job);
          } catch (err) {
            this.logger.warn(`Weishaupt: stop failed: ${err.message}`);
            job.resolve({ error: this.refusal(ERRORS.stopNotSent(errorReason(err))) });
          }
          this.stops.shift();
        }
      } finally {
        this.reserved -= 1;
        this.stopWorker = undefined;
        if (this.queue.length > 0) this.runQueue();
      }
    })();
  }

  /**
   * What a value read by a check or a poll says of a stop guard: 'done' (the
   * stop shows), 'wait', 'drop' (another value than the one before the stop,
   * read twice in a row: someone changed it on the heat pump, never
   * overridden) or 'resend'. When the value of before is unknown (a stop
   * clicked before any read), the first value read after the stop is taken
   * as that value: an unknown value never counts as "changed elsewhere". A
   * stop written is sent again only once the heat pump had the time to apply
   * it (20 s), three times at most per click (the EEPROM of the heat pump
   * takes 100,000 writes in its life): after that the stop stays held (the
   * other commands refused) without writing, until a read shows it, a click
   * or a change made at the heat pump; a stop that never left is tried again
   * at every check. Never 'drop' by the time. The values of before are only
   * read after the click (never the memory of an older poll); a hot water
   * push counts down, so any running push is one value ("running").
   */
  decideStop(stop, raw, readStartedAt) {
    if (raw === undefined) {
      return 'wait';
    }
    const value = stop.classOf(raw);
    if (value === stop.stopValue) {
      stop.others = 0;
      return stop.sticky && this.mono() < stop.stickyUntil ? 'wait' : 'done';
    }
    if (stop.sentAt !== undefined && readStartedAt < stop.sentAt + TIMINGS.applyDelay) {
      return 'wait';
    }
    if (stop.before.length === 0) {
      stop.before.push(value);
    } else if (!stop.before.includes(value)) {
      stop.others += 1;
      return stop.others >= TIMINGS.stopOtherReads ? 'drop' : 'wait';
    }
    stop.others = 0;
    return !stop.written || stop.reasserts < TIMINGS.stopReasserts ? 'resend' : 'wait';
  }

  /**
   * A command to the register of a stop, written and not confirmed, may still
   * land after the stop: its value counts as a value of before and the stop
   * stays held while it can land. Checked once the stop holds the line (a
   * command cut by the stop has marked its write by then: synchronously in
   * its `beforeSend`).
   */
  notePending(guard, plan) {
    const pending = this.guardActive(plan.command.read)
      ? this.guards.get(plan.command.read)
      : undefined;
    if (!pending) return;
    const value = guard.classOf(pending.expected);
    if (value !== plan.expected && !guard.before.includes(value)) {
      guard.before.push(value);
    }
    guard.sticky = true;
    guard.stickyUntil = Math.max(guard.stickyUntil ?? -Infinity, pending.until);
  }

  /**
   * One click of a stop: one write without a fresh read, then the read back
   * that alone confirms it. A refused connection, a closed connection, a
   * timeout or a wrong answer is tried again every 250 ms until 3 s after
   * the click (the write is idempotent). A new click renews the guard of
   * its register: three resends again. The value read back, when it is not
   * the stop, is a value of before (read after the click).
   */
  async sendStop(job) {
    const { plan, target, register, state } = job;
    const retryUntil = Math.max(job.received, this.mono()) + TIMINGS.commandSendBy;
    const guard = this.ensureStopGuard(register, plan, target);
    // A new click renews the guard: fast checks and three resends again.
    guard.since = this.mono();
    guard.reasserts = 0;
    guard.others = 0;
    let back;
    const attempt = async (session) => {
      // The line is ours: a command cut by this stop has marked its write by now.
      if (this.stopGuards.get(register) === guard) this.notePending(guard, plan);
      const request = writeRequest(register, plan.command.type, plan.written);
      const echo = await session.request(request, {
        timeoutMs: Math.max(250, Math.min(TIMINGS.requestTimeout, retryUntil - this.mono())),
        beforeSend: () => {
          state.written = true;
          state.sentAt = this.mono();
          this.lastSentAt = state.sentAt;
          const current = this.stopGuards.get(register);
          if (current) {
            current.written = true;
            current.sentAt = state.sentAt;
            current.lastWriteAt = state.sentAt;
          }
        },
      });
      if (!isWriteEcho(request, echo)) {
        session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
        throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', { sent: true });
      }
      back = await this.readPoint(session, plan.command);
    };
    const AGAIN = [ERROR_KINDS.CLOSED, ERROR_KINDS.TIMEOUT, ERROR_KINDS.PROTOCOL];
    let failure;
    this.logger.info(`Weishaupt: stop ${plan.role}`);
    for (;;) {
      try {
        await this.useLine('protect', target, TIMINGS.connectTimeout, attempt, { retryUntil });
        failure = undefined;
        break;
      } catch (err) {
        failure = err;
        if (!AGAIN.includes(err?.kind) || this.mono() + TIMINGS.connectRetry >= retryUntil) {
          break;
        }
        await new Promise((resolve) => this.timers.setTimeout(resolve, TIMINGS.connectRetry));
      }
    }
    const confirmed = back === plan.expected;
    const current = this.stopGuards.get(register);
    if (current && back !== undefined && !confirmed && current.before.length === 0) {
      current.before.push(current.classOf(back));
    }
    if (current) {
      if (confirmed && !(current.sticky && this.mono() < current.stickyUntil)) {
        this.dropStopGuard(register);
      } else {
        this.persistStops();
        this.armStopCheck(register);
      }
    }
    if (state.written) {
      this.followUp();
    }
    if (sameTarget(target, this.target()) && back !== undefined) {
      this.noteValues({ [plan.command.read]: back });
    }
    let result;
    if (confirmed) {
      this.logger.info(`Weishaupt: stop ${plan.role} confirmed by the heat pump`);
      result = {};
    } else if (failure) {
      const reason = errorReason(failure);
      this.logger.warn(`Weishaupt: stop ${plan.role} failed (${reason})`);
      if (!state.written) {
        result = { error: this.refusal(ERRORS.stopNotSent(reason)) };
      } else if (failure.kind === ERROR_KINDS.REFUSED && NOT_APPLIED_EXCEPTIONS.has(failure.code)) {
        result = { error: this.refusal(ERRORS.refused(reason)) };
      } else {
        result = { error: this.refusal(ERRORS.sentUnconfirmed(reason)) };
      }
    } else {
      result = {
        error: this.refusal(
          ERRORS.sentUnconfirmed(word(ERRORS.readBackDiffers, this.config.language)),
        ),
      };
    }
    job.resolve(result);
  }

  /** Whether a click or a command waits or runs: a check gives way to them (they are newer). */
  checkMustYield() {
    return (
      this.stops.length > 0 ||
      Boolean(this.stopWorker) ||
      this.queue.length > 0 ||
      Boolean(this.worker)
    );
  }

  /**
   * The periodic check of a stop guard: reads the register, then writes the
   * stop again only when `decideStop` says so. Never ends another session:
   * it waits for the line, and gives its turn up (tried again a second
   * later) to a click or a command waiting or running, which are newer; a
   * click ends it. Right before its write, it gives way again if a click or
   * a command arrived meanwhile. Not answered to anyone: no ack.
   */
  async runCheck(register) {
    const guard = this.stopGuards.get(register);
    if (!guard) return;
    if (this.checkMustYield() || this.checking !== undefined) {
      this.armStopCheck(register, TIMINGS.checkYield);
      return;
    }
    const plan = this.stopPlan(register);
    const outcome = { decision: undefined, back: undefined, written: false };
    this.checking = register;
    try {
      await this.useLine(
        'check',
        guard.target,
        TIMINGS.connectTimeout,
        async (session) => {
          const startedAt = this.mono();
          const value = await this.readPoint(session, plan.command);
          if (this.stopGuards.get(register) !== guard) return;
          outcome.back = value;
          outcome.decision = this.decideStop(guard, value, startedAt);
          if (outcome.decision !== 'resend') return;
          const request = writeRequest(register, plan.command.type, plan.written);
          const echo = await session.request(request, {
            timeoutMs: TIMINGS.requestTimeout,
            beforeSend: () => {
              if (this.checkMustYield() || this.stopGuards.get(register) !== guard) {
                throw Object.assign(new Error('a newer click or command'), { yielded: true });
              }
              this.logger.warn(
                `Weishaupt: ${plan.role} still ${value} after a stop: stop sent again`,
              );
              outcome.written = true;
              if (guard.written) guard.reasserts += 1;
              guard.written = true;
              guard.sentAt = this.mono();
              guard.lastWriteAt = guard.sentAt;
              this.lastSentAt = guard.sentAt;
            },
          });
          if (!isWriteEcho(request, echo)) {
            session.fail(new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write'));
            throw new ModbusError(ERROR_KINDS.PROTOCOL, 'not the echo of the write', {
              sent: true,
            });
          }
          outcome.back = await this.readPoint(session, plan.command);
        },
        { yieldTo: () => this.checkMustYield() },
      );
    } catch (err) {
      if (!err?.yielded && err?.kind !== ERROR_KINDS.ABORTED) {
        this.logger.warn(`Weishaupt: check of the stop ${plan.role} failed (${errorReason(err)})`);
      }
    } finally {
      this.checking = undefined;
    }
    if (this.stopGuards.get(register) !== guard) return;
    if (
      outcome.decision === 'done' ||
      (outcome.back === guard.stopValue && !(guard.sticky && this.mono() < guard.stickyUntil))
    ) {
      this.dropStopGuard(register);
    } else if (outcome.decision === 'drop') {
      this.logger.info(
        `Weishaupt: ${plan.role} changed after the stop (not by Gladys): the stop is not sent again`,
      );
      this.dropStopGuard(register);
    } else {
      this.persistStops();
      if (outcome.written) this.followUp();
      this.armStopCheck(register);
    }
    if (sameTarget(guard.target, this.target()) && outcome.back !== undefined) {
      this.noteValues({ [plan.command.read]: outcome.back });
    }
  }

  /** The guard of a stop of `register` (created when none runs for this target). */
  ensureStopGuard(register, plan, target) {
    let guard = this.stopGuards.get(register);
    if (!guard || !sameTarget(guard.target, target)) {
      if (guard) this.dropStopGuard(register);
      guard = {
        classOf: plan.command.beforeKey ?? ((value) => value),
        readKey: plan.command.read,
        stopValue: plan.expected,
        target,
        before: [],
        written: false,
        sentAt: undefined,
        lastWriteAt: undefined,
        since: this.mono(),
        reasserts: 0,
        others: 0,
        sticky: false,
        stickyUntil: -Infinity,
        timer: undefined,
      };
      this.stopGuards.set(register, guard);
    }
    return guard;
  }

  dropStopGuard(register) {
    const guard = this.stopGuards.get(register);
    if (!guard) return;
    if (guard.timer) this.timers.clearTimeout(guard.timer);
    this.stopGuards.delete(register);
    this.persistStops();
  }

  /**
   * The next check of a stop guard: every 15 s for 3 minutes after the click,
   * then every minute until the stop shows, whatever the refresh interval and
   * even when the reads fail.
   */
  armStopCheck(register, wait) {
    const guard = this.stopGuards.get(register);
    if (!guard) return;
    const delay =
      wait ??
      (this.mono() < guard.since + TIMINGS.stopFastChecks
        ? TIMINGS.stopRetry
        : TIMINGS.stopSlowRetry);
    if (guard.timer) this.timers.clearTimeout(guard.timer);
    guard.timer = this.timers.setTimeout(() => {
      guard.timer = undefined;
      if (this.stopGuards.get(register) !== guard) return;
      this.runCheck(register).catch((err) => this.logger.warn(`Weishaupt: check: ${err.message}`));
    }, delay);
  }

  // --- Guards --------------------------------------------------------------------

  guardActive(key) {
    const guard = this.guards.get(key);
    if (guard && this.mono() >= guard.until) {
      this.guards.delete(key);
      return false;
    }
    return Boolean(guard);
  }

  /**
   * A read through the guards. A command guard lifts when the value moved
   * from the start value to the one asked (never on an unknown value). A
   * stop guard: lifted when the read shows the stop (a sticky one once the
   * command that may still land is too old), or when a newer command to its
   * register left, or when two reads in a row show another value (someone
   * changed it on the heat pump: never overridden). The resending is the job
   * of the checks (`runCheck`).
   */
  observe(values, readStartedAt) {
    for (const key of [...this.guards.keys()]) {
      if (!this.guardActive(key) || values[key] === undefined) {
        continue;
      }
      const guard = this.guards.get(key);
      if (values[key] !== guard.from) {
        guard.moved = true;
      }
      if (guard.moved && values[key] === guard.expected) {
        this.guards.delete(key);
      }
    }
    for (const [register, stop] of [...this.stopGuards]) {
      if (!sameTarget(stop.target, this.target())) {
        continue;
      }
      // A read lifts a guard or ends it; the resending is the job of the checks.
      const decision = this.decideStop(stop, values[stop.readKey], readStartedAt);
      if (decision === 'done') {
        this.dropStopGuard(register);
      } else if (decision === 'drop') {
        this.logger.info(
          `Weishaupt: ${stop.readKey} changed after the stop (not by Gladys): the stop is not sent again`,
        );
        this.dropStopGuard(register);
      } else {
        this.persistStops();
      }
    }
  }

  /**
   * Spaced reads after a command: its effect, then a check. One series
   * pending at a time (a scene pressing in a loop never multiplies them).
   */
  followUp() {
    const generation = this.generation;
    const u = this.unit;
    for (const handle of u.followUps) {
      this.timers.clearTimeout(handle);
    }
    u.followUps.clear();
    for (const delay of TIMINGS.followUps) {
      const handle = this.timers.setTimeout(() => {
        u.followUps.delete(handle);
        if (generation === this.generation && u === this.unit) {
          Promise.resolve(u.running)
            .then(() => this.tick())
            .catch(() => this.logger.error('Weishaupt refresh failed'));
        }
      }, delay);
      u.followUps.add(handle);
    }
  }
}
