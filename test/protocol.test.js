// -----------------------------------------------------------------------------
// The Modbus PDUs (pure): the blocks against the register list of
// weishaupt_modbus, the special values, the write requests and their bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS, CIRCUITS, FC, LIMITS } from '../src/constants.js';
import { codeOf, interpret, partyPauseOf } from '../src/model.js';
import { commandOf, ROLES } from '../src/devices.js';
import {
  circuitBlocks,
  decodeBlock,
  isWriteEcho,
  parseRead,
  pctOf,
  pollBlocks,
  readRequest,
  spanOf,
  tempOf,
  writeRequest,
} from '../src/modbus/protocol.js';
import { DOCUMENTED } from './fixtures/fakeWeishaupt.js';

test('every block is a run of documented registers of its table, 5 at most', () => {
  const blocks = [
    ...pollBlocks(CIRCUITS),
    ...[...ROLES.keys()]
      .map(commandOf)
      .filter(Boolean)
      .map((c) => c.block),
  ];
  for (const block of blocks) {
    let next = block.points[0][0];
    for (const [address] of block.points) {
      assert.equal(address, next, `${block.key}: ${address} follows the previous register`);
      next = address + 1;
    }
    const { address, count } = spanOf(block);
    assert.ok(count >= 1 && count <= LIMITS.registersPerRead, block.key);
    const input = block.fc === FC.READ_INPUT;
    assert.ok(input || block.fc === FC.READ_HOLDING, block.key);
    for (let a = address; a < address + count; a += 1) {
      assert.ok(DOCUMENTED.has(a), `${a} documented`);
      assert.ok(input ? a >= 30001 && a <= 39999 : a >= 40001 && a <= 49999, `${a} in its table`);
    }
    assert.doesNotThrow(() => readRequest(block));
  }
});

test('the Weishaupt addresses (weishaupt_modbus hpconst.py, 1.0.19)', () => {
  const at = Object.fromEntries(BLOCKS.flatMap((b) => b.points.map(([a, t, k]) => [k, [a, t]])));
  assert.deepEqual(at.outdoor, [30001, 'temp']);
  assert.deepEqual(at.error, [30003, 'word']);
  assert.deepEqual(at.faultFree, [30005, 'word']);
  assert.deepEqual(at.display, [30006, 'word']);
  assert.deepEqual(at.systemMode, [40001, 'word']);
  assert.deepEqual(at.flow, [33104, 'temp']);
  assert.deepEqual(at.dhw, [32102, 'temp']);
  assert.deepEqual(at.dhwPush, [42102, 'word']);
  assert.deepEqual(at.dhwNormal, [42103, 'temp']);
  assert.deepEqual(at.dhwSetback, [42104, 'temp']);
  assert.deepEqual(at.e2, [34105, 'word']);
  const blocks = Object.fromEntries(circuitBlocks(['1', '3']).map((b) => [b.key, b.points]));
  assert.deepEqual(
    blocks['circuit-3-settings'].map(([a]) => a),
    [41301, 41302, 41303, 41304, 41305],
  );
  assert.deepEqual(
    blocks['circuit-1-setpoints'].map(([a]) => a),
    [41106, 41107],
  );
  assert.deepEqual(
    blocks['circuit-3-values'].map(([a]) => a),
    [31301, 31302, 31303, 31304, 31305],
  );
  assert.equal(blocks['circuit-2-values'], undefined);
  assert.deepEqual(circuitBlocks([]), []);
  assert.equal(commandOf('circuit-4-mode').address, 41403);
  assert.equal(commandOf('circuit-2-setpoint-setback').address, 41207);
  assert.equal(commandOf('dhw-push').address, 42102);
});

test('the address of the list goes as is in the PDU, function 4 or 3', () => {
  assert.deepEqual([...readRequest(BLOCKS[0])], [4, 0x75, 0x31, 0, 5]);
  const mode = BLOCKS.find((b) => b.key === 'system-mode');
  assert.deepEqual([...readRequest(mode)], [3, 0x9c, 0x41, 0, 1]);
});

test('temperatures: 0.1 °C signed; 0x8000 and 0x8001 are not temperatures', () => {
  assert.equal(tempOf(215), 21.5);
  assert.equal(tempOf(0xffe7), -2.5);
  assert.equal(tempOf(0x8000), undefined, 'no sensor');
  assert.equal(tempOf(0x8001), undefined, 'sensor broken');
  assert.equal(tempOf(0), 0, 'zero is a temperature');
  assert.equal(pctOf(0xffff), undefined);
  assert.equal(pctOf(101), undefined);
  assert.equal(pctOf(0), 0);
});

test('a read answer of the wrong size or function is refused', () => {
  const block = BLOCKS[0];
  const { count } = spanOf(block);
  const pdu = Buffer.alloc(2 + count * 2);
  pdu[0] = 4;
  pdu[1] = count * 2;
  assert.equal(parseRead(block, pdu).length, count);
  assert.equal(parseRead(block, pdu.subarray(0, pdu.length - 1)), undefined);
  pdu[0] = 3;
  assert.equal(parseRead(block, pdu), undefined, 'answer of another function');
  pdu[0] = 4;
  pdu[1] = count * 2 - 2;
  assert.equal(parseRead(block, pdu), undefined);
  assert.deepEqual(decodeBlock(block, [1, 2]), {}, 'wrong count: nothing');
});

test('special values are not measures; texts are never numbers', () => {
  const v = interpret({
    outdoor: -1,
    airIntake: 130,
    error: 0xffff,
    warning: 13,
    faultFree: 1,
    display: 38,
    operation: 19,
    systemMode: 9,
    dhwPush: 7,
    secondGenerator: 2,
    'circuit.1.mode': 4,
    'circuit.1.partyPause': 1,
    'circuit.2.partyPause': 27,
    'circuit.1.normal': 41,
  });
  assert.equal(v.outdoor, -1, 'a real -1 °C');
  assert.equal(v.airIntake, undefined, 'out of range');
  assert.equal(v.errorCode, 'none');
  assert.equal(v.warningCode, '13');
  assert.equal(v.fault, 0);
  assert.equal(v.operatingState, undefined, '38 is not in the list');
  assert.equal(v.heatPumpState, 'heating');
  assert.equal(v.systemMode, undefined);
  assert.equal(v.dhwPush, undefined, 'not a step of 5 minutes');
  assert.equal(v.secondGenerator, undefined);
  assert.equal(v['circuit.1.mode'], 'standby');
  assert.equal(v['circuit.1.partyPause'], 'pause-720-min');
  assert.equal(v['circuit.2.partyPause'], 'party-60-min');
  assert.equal(v['circuit.1.normal'], undefined, 'a room setpoint of 41 °C is not one');
  assert.equal(codeOf(0), undefined);
  assert.equal(partyPauseOf(25), 'automatic');
  assert.equal(partyPauseOf(50), undefined);
  assert.equal(interpret({ faultFree: 0 }).fault, 1);
});

test('writes: function 6, one register; hot water never above 60 °C nor 65 °C', () => {
  const req = writeRequest(42103, 'temp', 55);
  assert.deepEqual([...req], [6, 0xa4, 0x77, 0x02, 0x26]);
  assert.throws(() => writeRequest(42103, 'temp', 60.5), /out of bounds/);
  assert.throws(() => writeRequest(42104, 'temp', 66), /out of bounds/);
  assert.throws(() => writeRequest(42103, 'temp', 5), /out of bounds/);
  assert.deepEqual([...writeRequest(42104, 'temp', 60)], [6, 0xa4, 0x78, 0x02, 0x58]);
  assert.throws(() => writeRequest(40001, 'word', 0xffff));
  assert.throws(() => writeRequest(30001, 'word', 1), /holding/);
  assert.throws(() => writeRequest(41106, 'temp', Number.NaN));
  assert.deepEqual([...writeRequest(41106, 'temp', -2.5)], [6, 0xa0, 0x92, 0xff, 0xe7]);
  assert.ok(isWriteEcho(req, Buffer.from(req)));
  assert.ok(!isWriteEcho(req, Buffer.from([6, 0xa4, 0x77, 0x02, 0x27])));
  assert.ok(!isWriteEcho(req, req.subarray(0, 4)));
});
