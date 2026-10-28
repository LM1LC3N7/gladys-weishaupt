// -----------------------------------------------------------------------------
// The Modbus PDUs of the Weishaupt heat pump (pure): the read requests of the
// blocks, what their answers mean, and the write requests. Every decoder
// returns undefined when the answer has not the exact size asked or a value
// is a special value: an unknown value is never a value.
// -----------------------------------------------------------------------------

import {
  BLOCKS,
  BOUNDS,
  CIRCUITS,
  CIRCUIT_BLOCKS,
  CIRCUIT_STEP,
  DHW_CAP,
  FC,
  LIMITS,
} from '../constants.js';

/** The first register and the count of a block (every point is one register). */
export function spanOf(block) {
  const [first] = block.points[0];
  const [last] = block.points.at(-1);
  return { address: first, count: last + 1 - first };
}

/** The blocks of a heating circuit: those of circuit 1, moved by 100 per circuit. */
export function circuitBlocks(circuits) {
  return CIRCUITS.filter((c) => circuits.includes(c)).flatMap((c) => {
    const offset = (Number(c) - 1) * CIRCUIT_STEP;
    return CIRCUIT_BLOCKS.map((b) => ({
      key: `circuit-${c}-${b.key}`,
      fc: b.fc,
      core: Boolean(b.core),
      points: b.points.map(([address, type, key]) => [
        address + offset,
        type,
        `circuit.${c}.${key}`,
      ]),
    }));
  });
}

/** Every block of a poll, for the configured circuits. */
export const pollBlocks = (circuits) => [...BLOCKS, ...circuitBlocks(circuits)];

const READS = new Set([FC.READ_INPUT, FC.READ_HOLDING]);

/** The read request of a block (function 4 or 3). */
export function readRequest(block) {
  const { address, count } = spanOf(block);
  if (count < 1 || count > LIMITS.registersPerRead || count !== block.points.length) {
    throw new RangeError(`block ${block.key}: ${count} registers`);
  }
  if (!READS.has(block.fc)) {
    throw new RangeError(`block ${block.key}: not a read`);
  }
  const pdu = Buffer.alloc(5);
  pdu[0] = block.fc;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(count, 3);
  return pdu;
}

/** The words of a read answer, or undefined when it is not exactly what was asked. */
export function parseRead(block, pdu) {
  const { count } = spanOf(block);
  if (!Buffer.isBuffer(pdu) || pdu.length < 2 || pdu[0] !== block.fc) return undefined;
  const bytes = pdu[1];
  if (bytes !== count * 2 || pdu.length !== 2 + bytes) return undefined;
  const words = [];
  for (let i = 0; i < count; i += 1) words.push(pdu.readUInt16BE(2 + i * 2));
  return words;
}

const signedOf = (word) =>
  Number.isInteger(word) && word >= 0 && word <= 0xffff
    ? word >= 0x8000
      ? word - 0x10000
      : word
    : undefined;

/**
 * "Format Sensor" (Weishaupt): signed 0.1 °C, -50.0 to 500.0 °C; -32768 no
 * sensor, -32767 open circuit, -32766 short circuit, -32758 / -32757 digital
 * state off / on: never temperatures (all below -500, so out of the range).
 */
export function tempOf(word) {
  const signed = signedOf(word);
  return signed !== undefined && signed >= -500 && signed <= 5000 ? signed / 10 : undefined;
}

/**
 * "FormatSollwert" (Weishaupt): 50 to 5000 = 5.0 to 500.0 °C; -32768 and 1
 * "no setpoint demand" (never 0.1 °C), anything else unknown.
 */
export function setpointOf(word) {
  const signed = signedOf(word);
  return signed !== undefined && signed >= 50 && signed <= 5000 ? signed / 10 : undefined;
}

/** A percentage register: 0-100, 0xFFFF (and anything above 100) unknown. */
export const pctOf = (word) =>
  Number.isInteger(word) && word >= 0 && word <= 100 ? word : undefined;

/** A state or code register: 0-65535 as read (the model reads its lists). */
export const wordOf = (word) =>
  Number.isInteger(word) && word >= 0 && word <= 0xffff ? word : undefined;

const DECODERS = { temp: tempOf, set: setpointOf, pct: pctOf, word: wordOf };

/** The raw values of a block, by key; only those decodable. */
export function decodeBlock(block, words) {
  const values = {};
  if (!Array.isArray(words)) return values;
  const { address: start, count } = spanOf(block);
  if (words.length !== count) return values;
  for (const [address, type, key] of block.points) {
    const value = DECODERS[type]?.(words[address - start]);
    if (value !== undefined) values[key] = value;
  }
  return values;
}

/** The hot water setpoints (42103 normal, 42104 setback): checked once more in `writeRequest`. */
export const DHW_REGISTERS = new Set([42103, 42104]);

/**
 * The write request of one register (function 6): a temperature in °C
 * (written in 0.1 °C, signed) or a state. The hot water setpoints are checked
 * here once more: never above DHW_CAP.max (65 °C),
 * whatever the caller asked.
 */
export function writeRequest(address, type, value) {
  if (!Number.isInteger(address) || address < 40001 || address > 49999) {
    throw new RangeError('Only holding registers 4xxxx are written');
  }
  let word;
  if (type === 'temp' || type === 'set') {
    if (!Number.isFinite(value)) throw new RangeError('A temperature is a finite number');
    if (DHW_REGISTERS.has(address)) {
      if (value > DHW_CAP.max || value < BOUNDS.dhw.min) {
        throw new RangeError('Hot water setpoint out of bounds');
      }
    }
    const tenths = Math.round(value * 10);
    if (tenths < -0x7ffe || tenths > 0x7fff) throw new RangeError('Temperature out of range');
    word = tenths < 0 ? tenths + 0x10000 : tenths;
  } else if (type === 'word') {
    if (!Number.isInteger(value) || value < 0 || value > 0xfffe) {
      throw new RangeError('A state is 0-65534');
    }
    word = value;
  } else {
    throw new RangeError('Not a writable type');
  }
  const pdu = Buffer.alloc(5);
  pdu[0] = FC.WRITE_SINGLE;
  pdu.writeUInt16BE(address, 1);
  pdu.writeUInt16BE(word, 3);
  return pdu;
}

/** A write single register is answered by its exact echo (function, address, value). */
export const isWriteEcho = (request, answer) =>
  Buffer.isBuffer(answer) && answer.length === 5 && request.equals(answer);

/** A block of documented holding registers `[address, type, key]` (the reads of a command). */
export const holdingBlock = (key, points) => ({ key, fc: FC.READ_HOLDING, points });
