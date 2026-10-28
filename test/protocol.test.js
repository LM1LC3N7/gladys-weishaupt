// -----------------------------------------------------------------------------
// The Modbus PDUs (pure): the blocks against the register list of
// weishaupt_modbus, the special values, the write requests and their bounds.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BLOCKS, CIRCUITS, FC, LIMITS } from '../src/constants.js';
import { codeOf, dhwPushOf, interpret, partyPauseOf } from '../src/model.js';
import { commandOf, ROLES } from '../src/devices.js';
import {
  circuitBlocks,
  decodeBlock,
  isWriteEcho,
  parseRead,
  pctOf,
  pollBlocks,
  readRequest,
  setpointOf,
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

test('the Weishaupt addresses (datapoint list 83807301, 1/2025-11)', () => {
  const at = Object.fromEntries(BLOCKS.flatMap((b) => b.points.map(([a, t, k]) => [k, [a, t]])));
  assert.deepEqual(at.outdoor, [30001, 'temp']);
  assert.deepEqual(at.outdoor2, [30002, 'temp']);
  assert.deepEqual(at.error, [30003, 'word']);
  assert.deepEqual(at.display, [30006, 'word']);
  assert.deepEqual(at.systemMode, [40001, 'word']);
  assert.deepEqual(at.hpFaultFree, [33102, 'word']);
  assert.deepEqual(at.flow, [33104, 'temp']);
  assert.deepEqual(at.buffer, [33110, 'temp']);
  assert.deepEqual(at.dhwTarget, [32101, 'set']);
  assert.deepEqual(at.dhw, [32102, 'temp']);
  assert.deepEqual(at.dhwPush, [42102, 'word']);
  assert.deepEqual(at.dhwNormal, [42103, 'set']);
  assert.deepEqual(at.dhwSetback, [42104, 'set']);
  assert.deepEqual(at.e2, [34105, 'word']);
  for (const a of [41101, 41102, 41104, 42101, 33106, 33107, 34103]) {
    assert.ok(
      BLOCKS.filter((b) => b.core).every((b) => b.points.every(([x]) => x !== a)),
      `${a} is not in a core block`,
    );
  }
  const blocks = Object.fromEntries(circuitBlocks(['1', '3']).map((b) => [b.key, b]));
  assert.deepEqual(
    blocks['circuit-3-mode'].points.map(([a]) => a),
    [41303],
  );
  assert.equal(blocks['circuit-3-party-pause'].core, false, 'not in the list: optional');
  assert.deepEqual(
    blocks['circuit-1-setpoints'].points.map(([a]) => a),
    [41105, 41106, 41107],
  );
  assert.deepEqual(
    blocks['circuit-3-values'].points.map(([a]) => a),
    [31301, 31302, 31303, 31304, 31305],
  );
  assert.equal(blocks['circuit-2-values'], undefined);
  assert.deepEqual(circuitBlocks([]), []);
  assert.deepEqual(CIRCUITS, ['1', '2', '3', '4']);
  assert.equal(commandOf('circuit-4-mode').address, 41403);
  assert.equal(commandOf('circuit-2-setpoint-setback').address, 41207);
  assert.equal(commandOf('dhw-push').address, 42102);
});

test('the address of the list goes as is in the PDU, function 4 or 3', () => {
  assert.deepEqual([...readRequest(BLOCKS[0])], [4, 0x75, 0x31, 0, 5]);
  const mode = BLOCKS.find((b) => b.key === 'system-mode');
  assert.deepEqual([...readRequest(mode)], [3, 0x9c, 0x41, 0, 1]);
});

test('sensors: 0.1 °C signed; no sensor, open, short and digital states are not temperatures', () => {
  assert.equal(tempOf(215), 21.5);
  assert.equal(tempOf(0xffe7), -2.5);
  for (const special of [-32768, -32767, -32766, -32758, -32757]) {
    assert.equal(tempOf(special + 0x10000), undefined, `${special}`);
  }
  assert.equal(tempOf(0x10000 - 501), undefined, 'below -50.0 °C');
  assert.equal(tempOf(0), 0, 'zero is a temperature');
  assert.equal(pctOf(0xffff), undefined);
  assert.equal(pctOf(101), undefined);
  assert.equal(pctOf(0), 0);
});

test('setpoints: 1 and -32768 are "no setpoint demand", never 0.1 °C', () => {
  assert.equal(setpointOf(1), undefined);
  assert.equal(setpointOf(0x8000), undefined);
  assert.equal(setpointOf(49), undefined);
  assert.equal(setpointOf(50), 5);
  assert.equal(setpointOf(500), 50);
  const v = interpret({
    dhwTarget: setpointOf(1),
    dhwNormal: setpointOf(1),
    'circuit.1.roomTarget': setpointOf(1),
    'circuit.1.flowTarget': setpointOf(1),
  });
  assert.deepEqual(v, {});
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
    outdoor2: 130,
    error: 0xffff,
    warning: 13,
    faultFree: 0,
    hpFaultFree: 1,
    display: 44,
    operation: 19,
    systemMode: 9,
    dhwPush: 240,
    secondGenerator: 2,
    'circuit.1.mode': 4,
    'circuit.1.partyPause': 1,
    'circuit.2.partyPause': 27,
    'circuit.1.normal': 41,
  });
  assert.equal(v.outdoor, -1, 'a real -1 °C');
  assert.equal(v.outdoor2, undefined, 'out of range');
  assert.equal(v.errorCode, 'none');
  assert.equal(v.warningCode, '13');
  assert.equal(v.fault, 0, 'from 33102, not 30005');
  assert.equal(v.operatingState, undefined, '44 is not in the list');
  assert.equal(v.heatPumpState, 'heating');
  assert.equal(v.systemMode, undefined);
  assert.equal(v.dhwPush, '240-min');
  assert.equal(v.secondGenerator, undefined);
  assert.equal(v['circuit.1.mode'], 'standby');
  assert.equal(v['circuit.1.partyPause'], 'pause-720-min');
  assert.equal(v['circuit.2.partyPause'], 'party-60-min');
  assert.equal(v['circuit.1.normal'], undefined, 'a room setpoint of 41 °C is not one');
  assert.equal(codeOf(0), '0');
  assert.equal(partyPauseOf(25), 'automatic');
  assert.equal(partyPauseOf(50), undefined);
  assert.equal(dhwPushOf(37), '37-min');
  assert.equal(dhwPushOf(241), undefined);
  assert.equal(dhwPushOf(3), undefined);
  assert.equal(interpret({ hpFaultFree: 0 }).fault, 1);
  assert.equal(interpret({ hpFaultFree: 2 }).fault, undefined);
});

test('writes: function 6, one register; hot water never above 65 °C', () => {
  const req = writeRequest(42103, 'set', 55);
  assert.deepEqual([...req], [6, 0xa4, 0x77, 0x02, 0x26]);
  assert.throws(() => writeRequest(42103, 'set', 65.5), /out of bounds/);
  assert.throws(() => writeRequest(42104, 'set', 66), /out of bounds/);
  assert.throws(() => writeRequest(42103, 'set', 5), /out of bounds/);
  assert.deepEqual([...writeRequest(42104, 'set', 65)], [6, 0xa4, 0x78, 0x02, 0x8a]);
  assert.throws(() => writeRequest(40001, 'word', 0xffff));
  assert.throws(() => writeRequest(30001, 'word', 1), /holding/);
  assert.throws(() => writeRequest(41106, 'set', Number.NaN));
  assert.deepEqual([...writeRequest(41106, 'temp', -2.5)], [6, 0xa0, 0x92, 0xff, 0xe7]);
  assert.ok(isWriteEcho(req, Buffer.from(req)));
  assert.ok(!isWriteEcho(req, Buffer.from([6, 0xa4, 0x77, 0x02, 0x27])));
  assert.ok(!isWriteEcho(req, req.subarray(0, 4)));
});
