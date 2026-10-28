// -----------------------------------------------------------------------------
// The integration end to end: fake Gladys, fake Weishaupt heat pump, virtual
// clock.
// -----------------------------------------------------------------------------

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEVICE_TRANSPORTS } from '@gladysassistant/integration-sdk';
import { memoryStore } from '../src/store.js';
import { BLOCKS } from '../src/constants.js';
import { ALLOW, CFG, DEVICE, MINUTE, SECOND, feature, setup } from './helpers.js';
import { HOST, NOW, fakeWeishaupt, t as tw } from './fixtures/fakeWeishaupt.js';
import { testClock } from './kit/clock.mjs';

const SYSTEM = 40001;
const CIRCUIT1 = 41103;
const PUSH = 42102;
const DHW = 42103;
const DHW_SETBACK = 42104;
const NORMAL1 = 41106;
const STANDBY = 4;

const writesTo = (hp, address) => hp.writes().filter((w) => w.address === address);

test('discovery: one device, the values read and published, special values left out', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const [device] = ctx.gladys.fake.discoveredDevices;
  assert.equal(device.external_id, DEVICE);
  const types = device.features.map((f) => `${f.category}/${f.type}`);
  assert.ok(!types.some((x) => x.startsWith('switch/')), 'never a switch');
  for (const f of device.features.filter((f) => !f.read_only)) {
    assert.ok(
      ['text/select', 'water-heater/target-temperature', 'thermostat/target-temperature'].includes(
        `${f.category}/${f.type}`,
      ),
      `${f.external_id} is writable`,
    );
  }
  const roles = device.features.map((f) => f.external_id.slice(DEVICE.length + 1));
  assert.ok(
    roles.includes('circuit-1-mode') && !roles.includes('circuit-2-mode'),
    'circuit 1 only',
  );
  assert.ok(!roles.includes('temperature-room') && roles.includes('circuit-1-temperature-room'));
  const dhw = device.features.find((f) => f.external_id === feature('dhw-setpoint'));
  assert.equal(dhw.max, 65, 'hot water: the ceiling of the configuration, 65 °C by default');
  assert.equal(ctx.state('temperature-outdoor').state, 4.5);
  assert.equal(ctx.state('temperature-outdoor-2').state, 5.1);
  assert.equal(ctx.state('temperature-buffer').state, -2.5);
  assert.equal(ctx.state('temperature-regenerative'), undefined, 'no sensor');
  assert.equal(ctx.state('temperature-dhw').state, 47.3);
  assert.equal(ctx.state('dhw-setpoint').state, 50);
  assert.equal(ctx.state('dhw-setpoint-setback').state, 40);
  assert.equal(ctx.state('dhw-push').text, 'off');
  assert.equal(ctx.state('system-mode').text, 'automatic');
  assert.equal(ctx.state('operating-state').text, 'heating');
  assert.equal(ctx.state('error-code').text, 'none');
  assert.equal(ctx.state('fault').state, 0);
  assert.equal(ctx.state('power-demand').state, 42);
  assert.equal(ctx.state('circuit-1-mode').text, 'automatic');
  assert.equal(ctx.state('circuit-1-party-pause').text, 'automatic');
  assert.equal(ctx.state('circuit-1-setpoint-normal').state, 21);
  assert.equal(ctx.state('circuit-1-temperature-room').state, 20.6);
  assert.equal(ctx.state('circuit-1-humidity').state, 48);
  assert.equal(ctx.state('second-generator').state, 0);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  const badge = ctx.gladys.fake.transports.at(-1);
  assert.equal(badge.transport, DEVICE_TRANSPORTS.LOCAL);
  // Only documented reads (the fake answers exception 2 otherwise), one connection, closed after.
  assert.ok(!ctx.lines.some((l) => /failed|does not serve/.test(l)), ctx.lines.join('\n'));
  assert.equal(ctx.hp.open.size, 0);
  assert.equal(ctx.hp.maxOpen, 1);
  assert.ok(ctx.hp.reads().every((r) => r.count <= 5));
});

test('special values never published: sensors absent, open, short, digital; "no setpoint demand"', async (t) => {
  const clock = testClock({ start: NOW });
  const hp = fakeWeishaupt({ timers: clock.timers });
  hp.set(30002, 0x8000);
  hp.set(33108, 0x10000 - 32767);
  hp.set(33110, 0x10000 - 32766);
  hp.set(33111, 0x10000 - 32757);
  for (const a of [32101, 31101, 31104, 42104]) hp.set(a, 1);
  hp.set(30004, 0);
  const ctx = await setup({ clock, hp });
  t.after(ctx.stop);
  for (const role of [
    'temperature-outdoor-2',
    'temperature-hydraulic-switch',
    'temperature-buffer',
    'temperature-total-flow',
    'temperature-dhw-target',
    'circuit-1-temperature-room-target',
    'circuit-1-temperature-flow-target',
    'dhw-setpoint-setback',
  ]) {
    assert.equal(ctx.state(role), undefined, role);
  }
  assert.equal(ctx.state('warning-code').text, '0', 'a code is a text');
  for (const s of ctx.gladys.fake.states) {
    assert.ok(!('state' in s && 'text' in s));
  }
});

test('the commands are off by default: refused, nothing written; the stops still go', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const ack = await ctx.press('system-mode', 'heating');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /Autoriser les commandes/);
  assert.equal((await ctx.press('dhw-setpoint', 52)).success, false);
  assert.equal((await ctx.press('dhw-push', '30-min')).success, false);
  assert.equal((await ctx.press('circuit-1-setpoint-normal', 21.5)).success, false);
  assert.deepEqual(ctx.hp.writes(), []);
  const stop = await ctx.press('system-mode', 'standby');
  assert.equal(stop.success, true, String(stop.error));
  assert.deepEqual(
    ctx.hp.writes().map((w) => [w.address, w.value]),
    [[SYSTEM, STANDBY]],
  );
  const off = await ctx.press('circuit-1-mode', 'standby');
  assert.equal(off.success, true, String(off.error));
  assert.equal(ctx.hp.get(CIRCUIT1), STANDBY);
  ctx.hp.set(PUSH, 60);
  const push = await ctx.press('dhw-push', 'off');
  assert.equal(push.success, true, String(push.error));
  assert.equal(ctx.hp.get(PUSH), 0);
});

test('a mode: decided on a fresh read, written, confirmed by the read back', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  const ack = await ctx.press('system-mode', 'summer');
  assert.equal(ack.success, true, String(ack.error));
  const log = ctx.hp.log.slice(-3);
  assert.deepEqual(
    log.map((r) => [r.fc, r.address]),
    [
      [3, SYSTEM],
      [6, SYSTEM],
      [3, SYSTEM],
    ],
  );
  assert.equal(ctx.hp.get(SYSTEM), 3);
  assert.equal(ctx.state('system-mode').text, 'summer');
  for (const bad of ['Summer', ' summer', 3, 'holiday', '']) {
    assert.equal((await ctx.press('system-mode', bad, 200)).success, false, `${bad}`);
  }
});

test('hot water: bounded by the ceiling, never above 65 °C, whatever the configuration', async (t) => {
  const ctx = await setup({ config: { ...ALLOW, dhw_max_temperature: 90 } });
  t.after(ctx.stop);
  for (const value of [65.5, 66, 95, 5, 50.3, '', null, 'abc', '55.0.1']) {
    const ack = await ctx.press('dhw-setpoint', value, 200);
    assert.equal(ack.success, false, `${value} refused`);
  }
  assert.deepEqual(ctx.hp.writes(), []);
  // Above its own maximum (installer setting) the heat pump answers exception 3.
  ctx.hp.writeExceptions.set(DHW, 3);
  const refused = await ctx.press('dhw-setpoint', 62);
  assert.match(String(refused.error), /a refusé la commande/);
  ctx.hp.writeExceptions.delete(DHW);
  const ack = await ctx.press('dhw-setpoint', 65);
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(ctx.hp.temp(DHW), 65);
  await ctx.app.configUpdated({ ...ALLOW, dhw_max_temperature: 50 });
  const capped = await ctx.press('dhw-setpoint', 52);
  assert.match(String(capped.error), /plafond/);
  const setback = await ctx.press('dhw-setpoint-setback', 50.5);
  assert.match(String(setback.error), /plafond/);
  assert.equal(ctx.hp.temp(DHW), 65);
  assert.equal(ctx.hp.temp(DHW_SETBACK), 40);
  const slider = ctx.gladys.fake.discoveredDevices
    .at(-1)
    .features.find((f) => f.external_id === feature('dhw-setpoint'));
  assert.equal(slider.max, 50);
});

test('setpoints keep their order on the values read just before', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  // comfort 22, normal 21, setback 18; hot water normal 50, setback 40.
  for (const [role, value] of [
    ['circuit-1-setpoint-normal', 22.5],
    ['circuit-1-setpoint-normal', 17.5],
    ['circuit-1-setpoint-comfort', 20.5],
    ['circuit-1-setpoint-setback', 21.5],
    ['dhw-setpoint', 39.5],
    ['dhw-setpoint-setback', 50.5],
  ]) {
    const ack = await ctx.press(role, value, 500);
    assert.match(String(ack.error), /garder leur ordre/, `${role} ${value}`);
  }
  assert.deepEqual(ctx.hp.writes(), []);
  // Changed at the heat pump meanwhile: the fresh read decides, not the memory.
  ctx.hp.set(41105, tw(24));
  const ack = await ctx.press('circuit-1-setpoint-normal', 23.5);
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(ctx.hp.temp(NORMAL1), 23.5);
  for (const value of [15.5, 28.5, 21.3]) {
    assert.equal((await ctx.press('circuit-1-setpoint-setback', value, 200)).success, false);
  }
});

test('room setpoint unknown around it: refused, nothing written', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.set(41107, 0x8000);
  const ack = await ctx.press('circuit-1-setpoint-normal', 21.5);
  assert.match(String(ack.error), /n’a pas pu être relue/);
  assert.deepEqual(ctx.hp.writes(), []);
});

test('a write not applied: "sent, without confirmation", then spaced reads', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.ignoreWrites = true;
  const reads = ctx.hp.reads().length;
  const ack = await ctx.press('dhw-setpoint', 52);
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
  await ctx.advance(30 * SECOND, 100);
  assert.ok(ctx.hp.reads().length >= reads + 2 + 2 * BLOCKS.length, 'follow-up reads');
});

// --- Stops -----------------------------------------------------------------------

test('a stop takes the line from a read stuck on the heat pump', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.delay = 1900;
  ctx.app.tick();
  await ctx.advance(300, 10);
  assert.equal(ctx.hp.open.size, 1, 'a read is waiting for its answer');
  ctx.hp.delay = 10;
  const ack = await ctx.press('system-mode', 'standby', 1000);
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(ctx.hp.get(SYSTEM), STANDBY);
  assert.equal(ctx.hp.maxOpen, 1, 'never two connections');
});

test('a stop is tried again while the connection is refused, within 3.5 s', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.down = true;
  const ack = ctx.fire('circuit-1-mode', 'standby');
  await ctx.advance(1200, 50);
  ctx.hp.down = false;
  await ctx.advance(4 * SECOND, 50);
  assert.equal((await ack).success, true, String((await ack).error));
  assert.ok(ctx.hp.refused >= 2);
  assert.equal(ctx.hp.get(CIRCUIT1), STANDBY);
});

test('a stop goes during a backoff, before any successful read, without the option', async (t) => {
  const clock = testClock({ start: NOW });
  const hp = fakeWeishaupt({ timers: clock.timers });
  hp.down = true;
  const ctx = await setup({ clock, hp, create: false });
  t.after(ctx.stop);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  hp.down = false;
  const ack = await ctx.press('system-mode', 'standby');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(hp.get(SYSTEM), STANDBY);
});

test('a stop goes on a circuit not in the configuration, and while the queue is full', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.delay = 500;
  const acks = [];
  for (let i = 0; i < 17; i += 1) acks.push(ctx.fire('dhw-setpoint', 41 + (i % 8)));
  await ctx.advance(200, 10);
  const stop = ctx.fire('circuit-3-mode', 'standby');
  await ctx.advance(6 * SECOND, 50);
  assert.equal((await stop).success, true, String((await stop).error));
  assert.equal(ctx.hp.get(41303), STANDBY);
  await ctx.advance(20 * SECOND, 100);
  await Promise.all(acks);
  const order = ctx.hp.writes().map((w) => w.address);
  assert.deepEqual(order.slice(order.indexOf(41303) + 1), [], `nothing after the stop: ${order}`);
});

test('a stop not confirmed is held, never lifted by the time; three resends at most per click', async (t) => {
  const store = memoryStore();
  const ctx = await setup({ store, config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.ignoreWrites = true;
  const ack = await ctx.press('system-mode', 'standby');
  assert.equal(ack.success, false);
  assert.match(String(ack.error), /sans confirmation/);
  assert.equal(store.data.stops.length, 1);
  assert.equal(store.data.stops[0].register, SYSTEM);
  await ctx.advance(4 * MINUTE, 200);
  assert.equal(writesTo(ctx.hp, SYSTEM).length, 4, 'the click and three resends');
  await ctx.advance(60 * MINUTE, 1000);
  assert.equal(writesTo(ctx.hp, SYSTEM).length, 4, 'then held without writing (EEPROM)');
  assert.equal(store.data.stops.length, 1, 'still held after an hour');
  assert.ok(
    ctx.hp.writes().every((w) => w.value === STANDBY),
    'never another mode',
  );
  assert.match(String((await ctx.press('dhw-push', '30-min')).error), /pas encore confirmé/);
  // A new click: three resends again, then shown by the heat pump.
  await ctx.press('system-mode', 'standby');
  assert.equal(writesTo(ctx.hp, SYSTEM).length, 5);
  ctx.hp.set(SYSTEM, STANDBY);
  await ctx.advance(2 * MINUTE, 500);
  assert.deepEqual(store.data.stops, [], 'lifted once a read shows it');
});

test('a stop held refuses the other commands, a new choice on its register lifts it', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.ignoreWrites = true;
  await ctx.press('system-mode', 'standby');
  ctx.hp.ignoreWrites = false;
  const push = await ctx.press('dhw-push', '30-min');
  assert.match(String(push.error), /pas encore confirmé/);
  const setpoint = await ctx.press('circuit-1-setpoint-normal', 21.5);
  assert.match(String(setpoint.error), /pas encore confirmé/);
  assert.deepEqual(writesTo(ctx.hp, PUSH), []);
  const ack = await ctx.press('system-mode', 'heating');
  assert.equal(ack.success, true, String(ack.error));
  await ctx.advance(3 * MINUTE, 200);
  assert.deepEqual(
    writesTo(ctx.hp, SYSTEM).map((w) => w.value),
    [STANDBY, 1],
  );
  assert.equal(ctx.app.stopGuards.size, 0);
  assert.equal((await ctx.press('dhw-push', '30-min')).success, true);
});

test('another value read once does not lift a stop; twice in a row does', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.ignoreWrites = true;
  await ctx.press('system-mode', 'standby');
  await ctx.advance(25 * SECOND, 100);
  // Set at the heat pump for one read only, then back.
  ctx.hp.set(SYSTEM, 3);
  await ctx.advance(15 * SECOND, 100);
  ctx.hp.set(SYSTEM, 0);
  await ctx.advance(15 * SECOND, 100);
  assert.equal(ctx.app.stopGuards.size, 1, 'one read of another value: still held');
  const sent = writesTo(ctx.hp, SYSTEM).length;
  assert.ok(sent >= 2, 'sent again over the value of before');
  ctx.hp.set(SYSTEM, 3);
  await ctx.advance(40 * SECOND, 100);
  assert.equal(ctx.app.stopGuards.size, 0, 'two reads of another value: changed at the heat pump');
  await ctx.advance(30 * MINUTE, 1000);
  assert.equal(writesTo(ctx.hp, SYSTEM).length, sent, 'never over the heat pump');
  assert.equal(ctx.hp.get(SYSTEM), 3);
});

test('the resends of a circuit standby and of a push off write the stop value', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.set(PUSH, 60);
  ctx.hp.ignoreWrites = true;
  await ctx.press('circuit-1-mode', 'standby');
  await ctx.press('dhw-push', 'off');
  await ctx.advance(2 * MINUTE, 200);
  assert.ok(writesTo(ctx.hp, CIRCUIT1).length >= 2);
  assert.ok(writesTo(ctx.hp, PUSH).length >= 2);
  assert.ok(writesTo(ctx.hp, CIRCUIT1).every((w) => w.value === STANDBY));
  assert.ok(writesTo(ctx.hp, PUSH).every((w) => w.value === 0));
});

test('a command sent before a stop that lands after it: the stop is written again over it', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.applyDelay = 25 * SECOND;
  const command = await ctx.press('system-mode', 'heating', 4 * SECOND);
  assert.match(String(command.error), /sans confirmation/);
  ctx.hp.applyDelay = 0;
  const stop = await ctx.press('system-mode', 'standby', 4 * SECOND);
  assert.equal(stop.success, true, String(stop.error));
  assert.equal(ctx.hp.get(SYSTEM), STANDBY);
  // The heating command lands at 25 s, after the stop showed.
  await ctx.advance(2 * MINUTE, 200);
  assert.equal(ctx.hp.get(SYSTEM), STANDBY, 'the stop is sent again over the late command');
  await ctx.advance(3 * MINUTE, 500);
  assert.equal(ctx.app.stopGuards.size, 0, 'lifted once the late command can no longer land');
});

test('a newer command that left cancels the resending of a stop', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.ignoreWrites = true;
  await ctx.press('circuit-1-mode', 'standby');
  ctx.hp.ignoreWrites = false;
  const ack = await ctx.press('circuit-1-mode', 'comfort');
  assert.equal(ack.success, true, String(ack.error));
  await ctx.advance(3 * MINUTE, 200);
  assert.deepEqual(
    writesTo(ctx.hp, CIRCUIT1).map((w) => w.value),
    [STANDBY, 1],
  );
});

test('after a restart, a stop kept in /data goes before the configuration is read', async (t) => {
  const clock = testClock({ start: NOW });
  const hp = fakeWeishaupt({ timers: clock.timers });
  const store = memoryStore({
    lastAttemptAt: NOW - 10 * SECOND,
    stops: [
      {
        host: HOST,
        port: 502,
        unitId: 1,
        register: CIRCUIT1,
        since: NOW - 2 * 60 * MINUTE,
        reasserts: 0,
      },
    ],
  });
  const ctx = await setup({ clock, hp, store, boot: true, getConfigFails: 100, create: false });
  t.after(ctx.stop);
  assert.deepEqual(
    writesTo(hp, CIRCUIT1).map((w) => w.value),
    [STANDBY],
    'a stop of two hours ago is still held',
  );
  assert.equal(hp.get(CIRCUIT1), STANDBY);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /configuration n’a pas pu être lue/);
});

test('before the configuration is read, a stop goes to the last heat pump read', async (t) => {
  const clock = testClock({ start: NOW });
  const hp = fakeWeishaupt({ timers: clock.timers });
  const store = memoryStore({
    lastAttemptAt: NOW,
    stops: [],
    target: { host: HOST, port: 502, unitId: 1 },
  });
  const ctx = await setup({ clock, hp, store, boot: true, getConfigFails: 100, create: false });
  t.after(ctx.stop);
  const ack = await ctx.press('system-mode', 'standby');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(hp.get(SYSTEM), STANDBY);
});

test('getConfig() failing in `connected` is tried again until it works', async (t) => {
  const ctx = await setup({ getConfigFails: 1, create: false });
  t.after(ctx.stop);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /configuration n’a pas pu être lue/);
  assert.equal(ctx.hp.reads().length, 0);
  await ctx.advance(31 * SECOND, 500);
  assert.ok(ctx.hp.reads().length > 0, 'read once the configuration is read');
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  // Again after a reconnection to Gladys: the reads go on, the retry too.
  let fails = 2;
  const original = ctx.gladys.getConfig.bind(ctx.gladys);
  const getConfig = async () => {
    if (fails > 0) {
      fails -= 1;
      throw new Error('Gladys unreachable');
    }
    return original();
  };
  await ctx.app.onConnected(getConfig);
  assert.match(ctx.gladys.fake.connectionStatus.message.fr, /configuration n’a pas pu être lue/);
  await ctx.advance(61 * SECOND, 500);
  assert.equal(fails, 0);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
});

test('a configuration naming another heat pump ends the stops held for the previous one', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.ignoreWrites = true;
  await ctx.press('system-mode', 'standby');
  assert.equal(ctx.app.stopGuards.size, 1);
  const save = async (config) => {
    const saved = ctx.app.configUpdated(config);
    await ctx.advance(5 * SECOND, 50);
    await saved;
  };
  await save({ host: '' });
  assert.equal(ctx.app.stopGuards.size, 1, 'an empty address ends nothing');
  await save({ host: '192.168.1.61' });
  assert.equal(ctx.app.stopGuards.size, 0);
});

test('a stop drops the commands that arrived before it and have not left', async (t) => {
  const ctx = await setup({ config: { ...ALLOW, circuits: '1, 2, 3' } });
  t.after(ctx.stop);
  ctx.hp.delay = 300;
  const acks = [
    ctx.fire('dhw-setpoint', 52),
    ctx.fire('circuit-2-mode', 'normal'),
    ctx.fire('circuit-3-mode', 'comfort'),
  ];
  await ctx.advance(350, 10);
  const stop = ctx.fire('system-mode', 'standby');
  await ctx.advance(6 * SECOND, 50);
  assert.equal((await stop).success, true, String((await stop).error));
  const order = ctx.hp.writes().map((w) => w.address);
  const at = order.indexOf(SYSTEM);
  assert.ok(at >= 0);
  assert.deepEqual(order.slice(at + 1), [], `nothing after the stop: ${order}`);
  const results = await Promise.all(acks);
  assert.ok(results.some((r) => /arrêt a été envoyé entre-temps/.test(String(r.error))));
});

// --- Commands --------------------------------------------------------------------

test('a scene setting five values on a slow heat pump sets them all', async (t) => {
  const ctx = await setup({ config: { ...ALLOW, circuits: '1,2,3,4' } });
  t.after(ctx.stop);
  ctx.hp.delay = 700;
  const acks = [
    ctx.fire('circuit-1-setpoint-normal', 21.5),
    ctx.fire('circuit-2-setpoint-normal', 20),
    ctx.fire('circuit-3-setpoint-normal', 20.5),
    ctx.fire('circuit-4-setpoint-normal', 19.5),
    ctx.fire('dhw-setpoint', 52),
  ];
  await ctx.advance(25 * SECOND, 50);
  const results = await Promise.all(acks);
  assert.ok(
    results.every((r) => r.success || /attente|sans confirmation/.test(String(r.error))),
    JSON.stringify(results),
  );
  assert.equal(ctx.hp.temp(41106), 21.5);
  assert.equal(ctx.hp.temp(41206), 20);
  assert.equal(ctx.hp.temp(41306), 20.5);
  assert.equal(ctx.hp.temp(41406), 19.5);
  assert.equal(ctx.hp.temp(DHW), 52);
  assert.equal(ctx.hp.maxOpen, 1);
});

test('EEPROM: six changes of a register an hour, then refused; a lower setpoint always goes', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  for (const value of [44, 49, 45, 50, 46, 51]) {
    const ack = await ctx.press('dhw-setpoint', value);
    assert.equal(ack.success, true, `${value}: ${ack.error}`);
  }
  const refused = await ctx.press('dhw-setpoint', 55);
  assert.match(String(refused.error), /mémoire à nombre d’écritures limité/);
  const lower = await ctx.press('dhw-setpoint', 48);
  assert.equal(lower.success, true, String(lower.error));
  await ctx.advance(61 * MINUTE, 1000);
  assert.equal((await ctx.press('dhw-setpoint', 55)).success, true);
});

test('already so: nothing written', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  const ack = await ctx.press('circuit-1-mode', 'automatic');
  assert.equal(ack.success, true);
  assert.equal((await ctx.press('dhw-setpoint', 50)).success, true);
  assert.deepEqual(ctx.hp.writes(), []);
});

test('the option turned off while a command waits: not written', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.delay = 400;
  const ack = ctx.fire('dhw-setpoint', 52);
  await ctx.advance(200, 10);
  await ctx.app.configUpdated(CFG);
  await ctx.advance(5 * SECOND, 50);
  assert.equal((await ack).success, false);
  assert.deepEqual(ctx.hp.writes(), []);
});

test('the hot water ceiling lowered while a command waits: not written', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.delay = 400;
  const ack = ctx.fire('dhw-setpoint', 54);
  await ctx.advance(200, 10);
  await ctx.app.configUpdated({ ...ALLOW, dhw_max_temperature: 50 });
  await ctx.advance(5 * SECOND, 50);
  assert.match(String((await ack).error), /plafond/);
  assert.deepEqual(ctx.hp.writes(), []);
});

test('configurations saved in a row apply one by one, the last one wins', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const saves = [
    ctx.app.configUpdated({ host: '192.168.1.61' }),
    ctx.app.configUpdated({ host: HOST, poll_interval: 120 }),
    ctx.app.configUpdated({ host: HOST, poll_interval: 300, allow_commands: true }),
  ];
  await ctx.advance(2 * SECOND, 50);
  await Promise.all(saves);
  assert.equal(ctx.app.config.address.host, HOST);
  assert.equal(ctx.app.config.pollInterval, 300);
  assert.equal(ctx.app.config.allowCommands, true);
});

// --- Reads, restarts, /data -------------------------------------------------------

test('a restart never reads sooner than the interval after the last read', async (t) => {
  const clock = testClock({ start: NOW });
  const store = memoryStore({ lastAttemptAt: NOW - 20 * SECOND, stops: [] });
  const ctx = await setup({ clock, store, create: false });
  t.after(ctx.stop);
  assert.equal(ctx.hp.reads().length, 0);
  await ctx.advance(95 * SECOND, 500);
  assert.ok(ctx.hp.reads().length > 0);
});

test('/data unreadable: never overwritten, the first read waits a whole interval', async (t) => {
  const clock = testClock({ start: NOW });
  const store = memoryStore(null, { unreadable: true });
  const ctx = await setup({ clock, store, create: false });
  t.after(ctx.stop);
  assert.equal(ctx.hp.reads().length, 0);
  await ctx.advance(61 * SECOND, 500);
  assert.ok(ctx.hp.reads().length > 0);
  assert.equal(store.saves, 0);
});

test('nothing stale republished: a reconnection to Gladys long after the last read', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.down = true;
  await ctx.advance(3 * MINUTE, 1000);
  const count = ctx.gladys.fake.states.length;
  await ctx.app.connected(CFG);
  await ctx.advance(2 * SECOND, 100);
  assert.equal(ctx.gladys.fake.states.length, count);
});

test('an optional block refused does not stop the poll; a target refused does not stop a scene', async (t) => {
  const clock = testClock({ start: NOW });
  const hp = fakeWeishaupt({ timers: clock.timers });
  hp.exceptions.set(34101, 2);
  hp.exceptions.set(33106, 4);
  const ctx = await setup({ clock, hp, config: { ...ALLOW, circuits: '1,2' } });
  t.after(ctx.stop);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.equal(ctx.state('temperature-outdoor').state, 4.5);
  assert.equal(ctx.state('second-generator'), undefined);
  hp.exceptions.set(41106, 4);
  const acks = [
    ctx.fire('circuit-1-setpoint-normal', 21.5),
    ctx.fire('circuit-2-setpoint-normal', 20.5),
    ctx.fire('dhw-setpoint', 52),
  ];
  await ctx.advance(10 * SECOND, 50);
  const [a, b, dhw] = await Promise.all(acks);
  assert.equal(a.success, false);
  assert.equal(b.success, true, String(b.error));
  assert.equal(dhw.success, true, String(dhw.error));
  assert.equal(hp.temp(41206), 20.5);
});

test('an answer longer than a Modbus frame ends the read before it is all received', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  const original = ctx.hp.handle;
  ctx.hp.handle = (socket) => {
    socket.emit('data', Buffer.alloc(300, 1));
  };
  await ctx.advance(61 * SECOND, 500);
  ctx.hp.handle = original;
  assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  assert.ok(
    ctx.lines.some((l) => /protocol/.test(l)),
    ctx.lines.join('\n'),
  );
});

// --- Line, ordering, deadlines (lessons of earlier Modbus reviews) -------------------------

const firstWriteAfter = (hp, from) => hp.log.slice(from).find((r) => r.fc === 6);

for (const readInFlight of [false, true]) {
  test(`a command and a stop in the same turn (${readInFlight ? 'read in flight' : 'line idle'}): one connection, the stop first`, async (t) => {
    const ctx = await setup({ config: ALLOW });
    t.after(ctx.stop);
    ctx.hp.delay = 30;
    if (readInFlight) {
      ctx.app.tick();
      await ctx.advance(20, 5);
    }
    const from = ctx.hp.log.length;
    const acks = [
      ctx.fire('dhw-setpoint', 52),
      ctx.fire('dhw-push', 'off'),
      ctx.fire('dhw-setpoint', 54),
    ];
    await ctx.advance(6 * SECOND, 20);
    const [before, stop, after] = await Promise.all(acks);
    assert.equal(stop.success, true, String(stop.error));
    assert.equal(ctx.hp.maxOpen, 1, 'never two connections');
    assert.equal(firstWriteAfter(ctx.hp, from).address, PUSH, 'the stop is written first');
    assert.equal(before.success, false, 'the command before the stop is dropped');
    assert.equal(after.success, true, String(after.error));
    assert.equal(ctx.hp.temp(DHW), 54);
  });
}

test('a single-client slow heat pump: the stop goes within 3.5 s, before newer commands', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.singleClient = true;
  ctx.hp.delay = 900;
  const from = ctx.hp.log.length;
  const acks = [
    ctx.fire('dhw-setpoint', 52),
    ctx.fire('system-mode', 'standby'),
    ctx.fire('dhw-setpoint', 54),
  ];
  await ctx.advance(3500, 20);
  assert.equal(ctx.hp.get(SYSTEM), STANDBY, 'stopped within 3.5 s');
  assert.equal(firstWriteAfter(ctx.hp, from).address, SYSTEM);
  await ctx.advance(30 * SECOND, 50);
  await Promise.all(acks);
  assert.equal(ctx.hp.refused, 0, 'never a second connection');
});

for (const interval of [300, 3600]) {
  test(`a stop that could not leave is tried again within 20 s (interval ${interval} s)`, async (t) => {
    const ctx = await setup({ config: { host: HOST, poll_interval: interval } });
    t.after(ctx.stop);
    ctx.hp.down = true;
    const ack = ctx.fire('system-mode', 'standby');
    await ctx.advance(5 * SECOND, 50);
    assert.equal((await ack).success, false);
    ctx.hp.down = false;
    await ctx.advance(16 * SECOND, 100);
    assert.equal(ctx.hp.get(SYSTEM), STANDBY);
    assert.equal(writesTo(ctx.hp, SYSTEM).length, 1);
  });

  test(`a stop that cannot leave for an hour still goes when the heat pump is back (interval ${interval} s)`, async (t) => {
    const ctx = await setup({ config: { host: HOST, poll_interval: interval } });
    t.after(ctx.stop);
    ctx.hp.down = true;
    ctx.fire('circuit-1-mode', 'standby');
    await ctx.advance(60 * MINUTE, 1000);
    ctx.hp.down = false;
    await ctx.advance(70 * SECOND, 500);
    assert.equal(ctx.hp.get(CIRCUIT1), STANDBY);
    assert.equal(ctx.app.stopGuards.size, 0);
  });
}

test('after a restart, a value set at the heat pump meanwhile is never overridden', async (t) => {
  const clock = testClock({ start: NOW });
  const hp = fakeWeishaupt({ timers: clock.timers });
  hp.set(SYSTEM, 3); // summer, set at the heat pump after the stop
  const store = memoryStore({
    lastAttemptAt: NOW - 10 * SECOND,
    stops: [
      {
        host: HOST,
        port: 502,
        unitId: 1,
        register: SYSTEM,
        since: NOW - MINUTE,
        sentAt: NOW - MINUTE,
        reasserts: 1,
        written: true,
        before: ['automatic'],
      },
    ],
  });
  const ctx = await setup({ clock, hp, store, boot: true, create: false });
  t.after(ctx.stop);
  await ctx.advance(2 * MINUTE, 500);
  assert.deepEqual(writesTo(hp, SYSTEM), []);
  assert.deepEqual(store.data.stops, []);
});

test('a stop clicked before any value is known: the first value read is the value of before', async (t) => {
  const clock = testClock({ start: NOW });
  const hp = fakeWeishaupt({ timers: clock.timers });
  const store = memoryStore({
    lastAttemptAt: NOW - 10 * SECOND,
    stops: [
      {
        host: HOST,
        port: 502,
        unitId: 1,
        register: SYSTEM,
        since: NOW - 10 * SECOND,
        reasserts: 0,
        written: true,
        before: [],
      },
    ],
  });
  hp.ignoreWrites = true;
  const ctx = await setup({ clock, hp, store, boot: true, create: false });
  t.after(ctx.stop);
  assert.equal(writesTo(hp, SYSTEM).length, 1, 'sent again at the start, never "changed"');
  hp.set(SYSTEM, 3);
  await ctx.advance(2 * MINUTE, 500);
  assert.equal(writesTo(hp, SYSTEM).length, 1, 'never over the heat pump');
});

test('a value read while Gladys was unreachable is not published 10 minutes later', async (t) => {
  const ctx = await setup({ config: { host: HOST, poll_interval: 600 } });
  t.after(ctx.stop);
  const publish = ctx.gladys.publishChangedStates.bind(ctx.gladys);
  let down = true;
  ctx.gladys.publishChangedStates = async (...args) => {
    if (down) throw new Error('Gladys unreachable');
    return publish(...args);
  };
  ctx.hp.set(30001, tw(12.3));
  await ctx.advance(13 * MINUTE, 1000);
  ctx.hp.down = true;
  down = false;
  await ctx.advance(5 * SECOND, 100);
  assert.notEqual(ctx.state('temperature-outdoor').state, 12.3);
});

test('the time of a read is in /data before the read', async (t) => {
  const store = memoryStore();
  const ctx = await setup({ store, create: false });
  t.after(ctx.stop);
  const first = store.data.lastAttemptAt;
  ctx.hp.silent.add(30001);
  for (let i = 0; i < 700 && ctx.hp.open.size === 0; i += 1) await ctx.advance(100, 100);
  assert.equal(ctx.hp.open.size, 1, 'the next read is waiting for its answer');
  assert.ok(store.data.lastAttemptAt > first, 'already in /data');
});

test('an old read is not republished at connected, the heat pump online', async (t) => {
  const ctx = await setup({ config: { host: HOST, poll_interval: 600 } });
  t.after(ctx.stop);
  await ctx.advance(3 * MINUTE, 1000);
  const count = ctx.gladys.fake.states.length;
  await ctx.app.connected({ host: HOST, poll_interval: 600 });
  await ctx.app.deviceCreated(ctx.gladys.fake.discoveredDevices[0]);
  await ctx.advance(2 * SECOND, 100);
  assert.equal(ctx.gladys.fake.states.length, count);
});

for (const role of ['dhw-setpoint', 'system-mode']) {
  test(`a write answered by something else than its echo is not confirmed (${role})`, async (t) => {
    const ctx = await setup({ config: ALLOW });
    t.after(ctx.stop);
    ctx.hp.badEcho = true;
    const ack = await ctx.press(role, role === 'dhw-setpoint' ? 52 : 'standby');
    assert.equal(ack.success, false);
    assert.match(String(ack.error), /sans confirmation/);
  });
}

for (const flag of ['wrongTransaction', 'wrongUnit']) {
  test(`an answer to another request (${flag}) is never taken`, async (t) => {
    const clock = testClock({ start: NOW });
    const hp = fakeWeishaupt({ timers: clock.timers });
    hp[flag] = true;
    const ctx = await setup({ clock, hp, create: false });
    t.after(ctx.stop);
    assert.equal(ctx.gladys.fake.discoveredDevices.length, 0);
    assert.equal(ctx.gladys.fake.connectionStatus.connected, false);
  });
}

/** Advances until `cond()` holds (10 ms steps), at most `max` ms. */
async function until(ctx, cond, max = 60 * SECOND) {
  for (let e = 0; e < max && !cond(); e += 10) await ctx.advance(10, 10);
  assert.ok(cond(), 'condition reached');
}

const checkRunning = (ctx, register) =>
  ctx.app.checking === register && ctx.app.active?.kind === 'check';

test('a click during a running check is written and read back', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.ignoreWrites = true;
  await ctx.press('system-mode', 'standby');
  ctx.app.stopGuards.get(SYSTEM).reasserts = 3;
  ctx.hp.delay = 1000;
  await until(ctx, () => checkRunning(ctx, SYSTEM));
  ctx.hp.ignoreWrites = false;
  const from = ctx.hp.log.length;
  const ack = ctx.fire('system-mode', 'standby');
  await ctx.advance(4 * SECOND, 20);
  assert.equal((await ack).success, true, String((await ack).error));
  const after = ctx.hp.log.slice(from);
  assert.ok(
    after.some((r) => r.fc === 6 && r.address === SYSTEM),
    'written',
  );
  assert.ok(
    after.some((r) => r.fc === 3 && r.address === SYSTEM),
    'read back',
  );
  assert.equal(ctx.hp.get(SYSTEM), STANDBY);
});

test('a check never interrupts a newer command, nor sends the stop over it', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.ignoreWrites = true;
  await ctx.press('system-mode', 'standby');
  ctx.hp.ignoreWrites = false;
  ctx.hp.delay = 900;
  await ctx.advance(9 * SECOND, 50);
  const ack = ctx.fire('system-mode', 'heating');
  await ctx.advance(6 * SECOND, 50);
  assert.equal((await ack).success, true, String((await ack).error));
  await ctx.advance(3 * MINUTE, 500);
  assert.deepEqual(
    writesTo(ctx.hp, SYSTEM).map((w) => w.value),
    [STANDBY, 1],
  );
  assert.equal(ctx.hp.get(SYSTEM), 1);
});

test('a click never waits behind the check of another stop', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.ignoreWrites = true;
  await ctx.press('circuit-1-mode', 'standby');
  ctx.hp.ignoreWrites = false;
  ctx.hp.delay = 1400;
  await until(ctx, () => checkRunning(ctx, CIRCUIT1));
  const from = ctx.hp.log.length;
  const ack = ctx.fire('system-mode', 'standby');
  await ctx.advance(100, 10);
  assert.ok(
    ctx.hp.log.slice(from).some((r) => r.fc === 6 && r.address === SYSTEM),
    'written at once',
  );
  await ctx.advance(4 * SECOND, 50);
  assert.equal((await ack).success, true, String((await ack).error));
});

test('a stop ends a session still closing at once', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.closeDelay = 2000;
  const ends = ctx.hp.ends;
  ctx.app.tick();
  await until(ctx, () => ctx.hp.ends > ends);
  const from = ctx.hp.log.length;
  ctx.fire('system-mode', 'standby');
  await ctx.advance(100, 10);
  assert.ok(ctx.hp.log.slice(from).some((r) => r.fc === 6 && r.address === SYSTEM));
  assert.equal(ctx.hp.maxOpen, 1);
});

test('a stop not applied is sent again only 20 s after it was written', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.ignoreWrites = true;
  ctx.fire('system-mode', 'standby');
  await ctx.advance(29 * SECOND, 100);
  assert.equal(writesTo(ctx.hp, SYSTEM).length, 1, 'not at the 15 s check');
  await ctx.advance(6 * SECOND, 100);
  assert.equal(writesTo(ctx.hp, SYSTEM).length, 2, 'at the 30 s check');
});

test('sessions end gracefully (FIN, then the heat pump closes)', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  assert.ok(ctx.hp.ends > 0);
  assert.equal(ctx.hp.clientDestroys, 0);
});

test('a stop is answered at 3.5 s on a heat pump that answers late', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.delay = 1900;
  const start = ctx.clock.elapsed;
  let at;
  ctx.fire('system-mode', 'standby').then(() => {
    at = ctx.clock.elapsed - start;
  });
  await until(ctx, () => at !== undefined, 10 * SECOND);
  assert.ok(at >= 3400 && at <= 3600, `${at} ms`);
});

test('a stop is tried for 3 s, not longer', async (t) => {
  const ctx = await setup({ config: { host: HOST, poll_interval: 3600 } });
  t.after(ctx.stop);
  ctx.hp.now = () => ctx.clock.elapsed;
  ctx.hp.down = true;
  const start = ctx.clock.elapsed;
  ctx.fire('system-mode', 'standby');
  await ctx.advance(10 * SECOND, 50);
  const tries = ctx.hp.connectAt.map((x) => x - start).filter((x) => x < 10 * SECOND);
  assert.ok(tries.length >= 5, `${tries.length} tries`);
  assert.ok(Math.max(...tries) >= 2500 && Math.max(...tries) <= 3000, `${tries.at(-1)} ms`);
});

test('/data that cannot be saved never blocks a stop', async (t) => {
  const store = memoryStore(null, { failSave: true });
  const ctx = await setup({ store });
  t.after(ctx.stop);
  const ack = await ctx.press('system-mode', 'standby');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(ctx.hp.get(SYSTEM), STANDBY);
});

// --- Review r1 -------------------------------------------------------------------

for (const variant of ['unreachable at the click', 'first write not applied']) {
  test(`r1-B1 the value of before is read after the click, never the memory (${variant})`, async (t) => {
    const store = memoryStore();
    const ctx = await setup({ store, config: { host: HOST, poll_interval: 300 } });
    t.after(ctx.stop);
    assert.equal(ctx.state('system-mode').text, 'automatic');
    // Set at the heat pump after the last read: Gladys still shows "automatic".
    ctx.hp.set(SYSTEM, 1);
    await ctx.advance(30 * SECOND, 500);
    if (variant === 'unreachable at the click') ctx.hp.down = true;
    else ctx.hp.ignoreWrites = true;
    const ack = await ctx.press('system-mode', 'standby');
    assert.equal(ack.success, false);
    assert.ok(!ctx.app.stopGuards.get(SYSTEM).before.includes('automatic'), 'not from memory');
    assert.deepEqual(
      ctx.app.stopGuards.get(SYSTEM).before,
      variant === 'unreachable at the click' ? [] : ['heating'],
      'only a value read after the click (the read back)',
    );
    ctx.hp.down = false;
    ctx.hp.ignoreWrites = false;
    await ctx.advance(90 * SECOND, 200);
    assert.equal(ctx.hp.get(SYSTEM), STANDBY, 'the stop ends up applied');
    assert.deepEqual(store.data.stops, []);
  });
}

test('r1-I2 a command on its way when a stop is clicked, landing after it, is overwritten', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.applyClosedWrites = true;
  // The heating write: its echo is 1.5 s late, it lands 0.8 s after its answer was due.
  ctx.hp.delayFor = (fc, address, value) => (fc === 6 && value === 1 ? 1500 : 10);
  ctx.hp.late = (address, value) => (value === 1 ? 800 : 0);
  const command = ctx.fire('system-mode', 'heating');
  for (let i = 0; i < 300 && !writesTo(ctx.hp, SYSTEM).length; i += 1) await ctx.advance(10, 10);
  await ctx.advance(200, 10);
  const stop = ctx.fire('system-mode', 'standby');
  await ctx.advance(4 * SECOND, 50);
  assert.equal((await stop).success, true, String((await stop).error));
  await command;
  await ctx.advance(3 * MINUTE, 200);
  assert.equal(ctx.hp.get(SYSTEM), STANDBY, 'the stop wins over the earlier command');
  assert.deepEqual(
    writesTo(ctx.hp, SYSTEM)
      .map((w) => w.value)
      .slice(0, 2),
    [1, STANDBY],
  );
});

test('r1-I2 a command write is marked as it leaves, before its answer', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.delayFor = (fc) => (fc === 6 ? 1500 : 10);
  const command = ctx.fire('system-mode', 'heating');
  for (let i = 0; i < 300 && !writesTo(ctx.hp, SYSTEM).length; i += 1) await ctx.advance(10, 10);
  assert.equal(ctx.app.guards.get('systemMode')?.expected, 'heating', 'marked while on its way');
  await ctx.advance(5 * SECOND, 50);
  await command;
});

test('r1-I2 a command refused by the heat pump does not hold the next stop', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.writeExceptions.set(SYSTEM, 3);
  assert.match(String((await ctx.press('system-mode', 'heating')).error), /a refusé/);
  ctx.hp.writeExceptions.delete(SYSTEM);
  const ack = await ctx.press('system-mode', 'standby');
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(ctx.app.stopGuards.size, 0, 'confirmed and lifted: nothing can land after it');
});

test('r1-I5 a stop whose connection is dropped is tried again within its 3 s', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.dropNext = 1;
  const ack = await ctx.press('system-mode', 'standby', 3500);
  assert.equal(ack.success, true, String(ack.error));
  assert.equal(ctx.hp.get(SYSTEM), STANDBY);
});

test('r1-I5 a mode read back outside its list: the command is not sent', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.set(SYSTEM, 9);
  const ack = await ctx.press('system-mode', 'heating');
  assert.match(String(ack.error), /n’a pas pu être relue/);
  assert.deepEqual(ctx.hp.writes(), []);
});

test('r1-I5 a click on the value of before while a stop is held: written, never overwritten by the stop', async (t) => {
  const ctx = await setup({ config: ALLOW });
  t.after(ctx.stop);
  ctx.hp.ignoreWrites = true;
  await ctx.press('system-mode', 'standby');
  await ctx.advance(25 * SECOND, 200);
  ctx.hp.ignoreWrites = false;
  // "automatic" is what the heat pump still shows and the value of before.
  const ack = await ctx.press('system-mode', 'automatic');
  assert.equal(ack.success, true, String(ack.error));
  const after = writesTo(ctx.hp, SYSTEM).length;
  assert.equal(writesTo(ctx.hp, SYSTEM).at(-1).value, 0, 'written although already so');
  await ctx.advance(3 * MINUTE, 200);
  assert.equal(writesTo(ctx.hp, SYSTEM).length, after, 'the stop is not sent again over it');
  assert.equal(ctx.hp.get(SYSTEM), 0);
  assert.equal(ctx.app.stopGuards.size, 0);
});

test('r1-m2 the hot water push is a timer: 5-240 min read, a push counting down keeps the stop held', async (t) => {
  const ctx = await setup();
  t.after(ctx.stop);
  ctx.hp.set(PUSH, 240);
  await ctx.advance(61 * SECOND, 500);
  assert.equal(ctx.state('dhw-push').text, '240-min');
  ctx.hp.ignoreWrites = true;
  await ctx.press('dhw-push', 'off');
  for (let m = 239; m > 235; m -= 1) {
    ctx.hp.set(PUSH, m);
    await ctx.advance(30 * SECOND, 200);
  }
  assert.equal(ctx.app.stopGuards.size, 1, 'a counting timer is not "changed elsewhere"');
  assert.ok(writesTo(ctx.hp, PUSH).length >= 2);
  assert.ok(writesTo(ctx.hp, PUSH).every((w) => w.value === 0));
  ctx.hp.ignoreWrites = false;
  await ctx.press('dhw-push', 'off');
  assert.equal(ctx.hp.get(PUSH), 0);
});

test('r1-m1 EEPROM: 20 changes of a setting a day, kept in /data across a restart', async (t) => {
  const clock = testClock({ start: NOW });
  const times = Array.from({ length: 20 }, (_, i) => NOW - 20 * 60 * MINUTE + i * 30 * MINUTE);
  const store = memoryStore({
    lastAttemptAt: NOW - 2 * MINUTE,
    stops: [],
    writes: { 42103: times },
  });
  const ctx = await setup({ clock, store, config: ALLOW });
  t.after(ctx.stop);
  await ctx.advance(61 * SECOND, 500);
  const ack = await ctx.press('dhw-setpoint', 52);
  assert.match(String(ack.error), /dernières 24 heures/);
  assert.equal((await ctx.press('dhw-setpoint', 48)).success, true, 'a lower setpoint goes');
  assert.equal(store.data.writes[42103].length, 21, 'kept in /data, the lower one counted');
  assert.equal((await ctx.press('circuit-1-setpoint-normal', 21.5)).success, true);
  assert.equal(store.data.writes[41106].length, 1);
});

test('r1-I1 a party/pause register not served never fails the poll', async (t) => {
  const clock = testClock({ start: NOW });
  const hp = fakeWeishaupt({ timers: clock.timers });
  hp.exceptions.set(41104, 2);
  const ctx = await setup({ clock, hp });
  t.after(ctx.stop);
  assert.equal(ctx.gladys.fake.connectionStatus.connected, true);
  assert.equal(ctx.state('circuit-1-mode').text, 'automatic');
  assert.equal(ctx.state('circuit-1-party-pause'), undefined);
});
