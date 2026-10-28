// -----------------------------------------------------------------------------
// A fake Weishaupt heat pump behind the injected `connect` (no network), on
// the timers of the test clock: Modbus TCP framing (MBAP), function 4 reads
// of the input registers (3xxxx), function 3 reads of the holding registers
// (4xxxx) and function 6 writes, answers after a delay. Like the register
// list of weishaupt_modbus, a read must cover documented addresses of its
// table only (else exception 2); a write must hit a writable holding
// register. It counts the connections open at once (the integration must
// never open a second one). Values made up, never from a real heat pump.
// -----------------------------------------------------------------------------

import { EventEmitter } from 'node:events';
import { BLOCKS, CIRCUITS, CIRCUIT_BLOCKS, CIRCUIT_STEP } from '../../src/constants.js';

export const HOST = '192.168.1.60';
export const NOW = Date.UTC(2026, 9, 28, 10, 0, 0);

const offset = (c) => (Number(c) - 1) * CIRCUIT_STEP;

/** Every documented address (the blocks, and a few documented ones never read). */
export const DOCUMENTED = new Set([
  ...BLOCKS.flatMap((b) => b.points.map(([a]) => a)),
  ...CIRCUITS.flatMap((c) => CIRCUIT_BLOCKS.flatMap((b) => b.points.map(([a]) => a + offset(c)))),
  40002,
  42105,
  33109,
  33110,
  33111,
  34106,
  34107,
]);
const WRITABLE = new Set([
  40001,
  42102,
  42103,
  42104,
  ...CIRCUITS.flatMap((c) => [41103, 41105, 41106, 41107].map((a) => a + offset(c))),
]);

/** A temperature in °C as its register word (0.1 °C, signed). */
export const t = (celsius) => {
  const tenths = Math.round(celsius * 10);
  return tenths < 0 ? tenths + 0x10000 : tenths;
};

/** A heat pump in automatic, heating, circuit 1 on its time program. */
export function defaultValues() {
  const v = {
    30001: t(4.5),
    30002: t(5.1),
    30003: 0xffff,
    30004: 0xffff,
    30005: 1,
    30006: 19,
    40001: 0,
    40002: 0,
    33101: 19,
    33102: 1,
    33103: 42,
    33104: t(35.2),
    33105: t(30.1),
    33106: t(-2.5),
    33107: t(3.2),
    33108: t(34.9),
    33109: 0x8000,
    33110: 0x8000,
    33111: t(35.1),
    32101: t(48),
    32102: t(47.3),
    42101: 1,
    42102: 0,
    42103: t(50),
    42104: t(40),
    42105: t(5),
    34101: 0,
    34102: 12,
    34103: 3,
    34104: 0,
    34105: 0,
    34106: 2,
    34107: 1,
  };
  for (const c of CIRCUITS) {
    const o = offset(c);
    const on = c === '1';
    Object.assign(v, {
      [31101 + o]: on ? t(21) : 0x8000,
      [31102 + o]: on ? t(20.6) : 0x8000,
      [31103 + o]: on ? 48 : 0xffff,
      [31104 + o]: on ? t(34) : 0x8000,
      [31105 + o]: on ? t(33.5) : 0x8000,
      [41101 + o]: on ? 2 : 0,
      [41102 + o]: 1,
      [41103 + o]: 0,
      [41104 + o]: 25,
      [41105 + o]: t(22),
      [41106 + o]: t(21),
      [41107 + o]: t(18),
    });
  }
  return v;
}

class FakeSocket extends EventEmitter {
  constructor(hp) {
    super();
    this.hp = hp;
    this.destroyed = false;
  }

  write(bytes) {
    if (this.destroyed) throw new Error('write after destroy');
    this.hp.handle(this, Buffer.from(bytes));
    return true;
  }

  destroy() {
    if (this.destroyed) return;
    this.destroyed = true;
    if (!this.ending) this.hp.clientDestroys += 1;
    if (this.closeTimer) this.hp.timers.clearTimeout(this.closeTimer);
    // Like a real device, the heat pump sees the connection gone a moment later.
    setImmediate(() => {
      this.hp.open.delete(this);
      this.emit('close');
    });
  }

  /** A FIN: the heat pump closes its side `closeDelay` ms later (then 'close'). */
  end() {
    if (this.destroyed || this.ended) return;
    this.ended = true;
    this.hp.ends += 1;
    this.closeTimer = this.hp.timers.setTimeout(() => {
      this.ending = true;
      this.destroy();
    }, this.hp.closeDelay);
  }

  setNoDelay() {}
}

export function fakeWeishaupt({ timers, values = defaultValues(), unitId = 1 } = {}) {
  const map = new Map();
  const hp = {
    map,
    unitId,
    open: new Set(),
    maxOpen: 0,
    /** Every request: { fc, address, count?, value? }. */
    log: [],
    connections: 0,
    refused: 0,
    down: false,
    connectDelay: 5,
    delay: 10,
    /** Addresses (start of a request) that never answer, or answer an exception. */
    silent: new Set(),
    exceptions: new Map(),
    /** Writes acknowledged but not applied, or applied after `applyDelay` ms. */
    ignoreWrites: false,
    applyDelay: 0,
    /** Writes applied even when their connection closed before the answer. */
    applyClosedWrites: false,
    badEcho: false,
    ends: 0,
    closeDelay: 0,
    clientDestroys: 0,
    connectAt: [],
    now: undefined,
    timers,
    singleClient: false,
    wrongTransaction: false,
    wrongUnit: false,
    /** The raw word of a register. */
    set(address, word) {
      map.set(address, word & 0xffff);
    },
    get(address) {
      return map.get(address);
    },
    /** A temperature register in °C (undefined for a special value). */
    temp(address) {
      const w = map.get(address);
      if (w === undefined || w === 0x8000 || w === 0x8001) return undefined;
      return (w >= 0x8000 ? w - 0x10000 : w) / 10;
    },
    /** Whether a read covers documented addresses of the table of its function. */
    documented(fc, address, count) {
      const table = fc === 4 ? [30000, 39999] : [40000, 49999];
      for (let a = address; a < address + count; a += 1) {
        if (!DOCUMENTED.has(a) || a < table[0] || a > table[1]) return false;
      }
      return count >= 1;
    },
    handle(socket, frame) {
      const tid = frame.readUInt16BE(0);
      const uid = frame[6];
      const pdu = frame.subarray(7);
      const fc = pdu[0];
      const address = pdu.readUInt16BE(1);
      const second = pdu.readUInt16BE(3);
      hp.log.push(fc === 6 ? { fc, address, value: second } : { fc, address, count: second });
      if (hp.silent.has(address)) return;
      timers.setTimeout(() => {
        if (socket.destroyed) {
          if (fc === 6 && hp.applyClosedWrites && !hp.ignoreWrites) hp.set(address, second);
          return;
        }
        let answer;
        const exception = hp.exceptions.get(address);
        if (exception) {
          answer = Buffer.from([fc | 0x80, exception]);
        } else if (fc === 3 || fc === 4) {
          if (!hp.documented(fc, address, second)) {
            answer = Buffer.from([fc | 0x80, 2]);
          } else {
            answer = Buffer.alloc(2 + second * 2);
            answer[0] = fc;
            answer[1] = second * 2;
            for (let i = 0; i < second; i += 1) {
              answer.writeUInt16BE(map.get(address + i) ?? 0, 2 + i * 2);
            }
          }
        } else if (fc === 6) {
          if (!WRITABLE.has(address)) {
            answer = Buffer.from([fc | 0x80, 2]);
          } else {
            if (!hp.ignoreWrites) {
              if (hp.applyDelay > 0)
                timers.setTimeout(() => hp.set(address, second), hp.applyDelay);
              else hp.set(address, second);
            }
            answer = Buffer.from(pdu.subarray(0, 5));
            if (hp.badEcho) answer[4] ^= 1;
          }
        } else {
          answer = Buffer.from([fc | 0x80, 1]);
        }
        const out = Buffer.alloc(7 + answer.length);
        out.writeUInt16BE(hp.wrongTransaction ? (tid + 1) & 0xffff : tid, 0);
        out.writeUInt16BE(0, 2);
        out.writeUInt16BE(answer.length + 1, 4);
        out[6] = hp.wrongUnit ? (uid + 1) & 0xff : uid;
        answer.copy(out, 7);
        socket.emit('data', out);
      }, hp.delay);
    },
    connect() {
      const socket = new FakeSocket(hp);
      hp.connections += 1;
      if (hp.now) hp.connectAt.push(hp.now());
      timers.setTimeout(() => {
        if (socket.destroyed) return;
        if (hp.down || (hp.singleClient && hp.open.size > 0)) {
          hp.refused += 1;
          socket.emit('error', Object.assign(new Error('refused'), { code: 'ECONNREFUSED' }));
          return;
        }
        hp.open.add(socket);
        hp.maxOpen = Math.max(hp.maxOpen, hp.open.size);
        socket.emit('connect');
      }, hp.connectDelay);
      return socket;
    },
    writes: () => hp.log.filter((r) => r.fc === 6),
    reads: () => hp.log.filter((r) => r.fc === 3 || r.fc === 4),
  };
  for (const [address, value] of Object.entries(values)) hp.set(Number(address), value);
  hp.connectFn = () => hp.connect();
  return hp;
}
