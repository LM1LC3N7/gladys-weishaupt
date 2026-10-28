import { test } from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import assert from 'node:assert/strict';
import { dhwCapOf, normalizeConfig, parseAddress, parseCircuits } from '../src/config.js';
import { MAX_BYTES, fileStore, normalizeMemory } from '../src/store.js';

test('addresses: IPv4 or host name, optional port; never broadcast, multicast nor 0.x', () => {
  assert.deepEqual(parseAddress('192.168.1.60'), { host: '192.168.1.60', port: 502 });
  assert.deepEqual(parseAddress(' wbb.local:1502 '), { host: 'wbb.local', port: 1502 });
  for (const bad of [
    '0.0.0.0',
    '224.0.0.1',
    '255.255.255.255',
    '192.168.1.255',
    'a..b',
    'http://x',
    'x:0',
    'x:70000',
    'x\r\n',
    '',
  ]) {
    assert.equal(parseAddress(bad), undefined, bad);
  }
});

test('circuits: numbers 1 to 4 only (Weishaupt list), nothing guessed', () => {
  assert.deepEqual(parseCircuits('1, 2 ;3'), { circuits: ['1', '2', '3'], invalid: false });
  assert.deepEqual(parseCircuits('1, 5, A'), { circuits: ['1'], invalid: true });
  assert.deepEqual(parseCircuits('3 1'), { circuits: ['1', '3'], invalid: false });
  assert.deepEqual(parseCircuits(''), { circuits: [], invalid: false });
  assert.deepEqual(parseCircuits(42), { circuits: [], invalid: false });
});

test('hot water ceiling: 65 °C by default, 30 to 65 °C, rounded down', () => {
  assert.equal(dhwCapOf(undefined), 65);
  assert.equal(dhwCapOf(''), 65);
  assert.equal(dhwCapOf(null), 65);
  assert.equal(dhwCapOf(90), 65);
  assert.equal(dhwCapOf(65.5), 65);
  assert.equal(dhwCapOf('64.9'), 64);
  assert.equal(dhwCapOf(10), 30);
});

test('the configuration: commands off unless strictly true, unit id checked', () => {
  const c = normalizeConfig({ host: '192.168.1.60', allow_commands: 'yes', unit_id: '' });
  assert.equal(c.allowCommands, false);
  assert.equal(c.address, undefined, 'no valid unit id: nothing read');
  assert.equal(normalizeConfig({ host: 'x', allow_commands: 'true' }).allowCommands, true);
  assert.equal(normalizeConfig({ host: 'not valid!' }).invalid, 10, 'only the length is kept');
  assert.equal(normalizeConfig({ host: '192.168.1.60\r\n' }).address, undefined, 'CR LF refused');
  assert.equal(normalizeConfig({ poll_interval: 5 }).pollInterval, 30);
  assert.deepEqual(normalizeConfig({}).circuits, ['1']);
});

test('/data: repaired and bounded; a stop is never dropped for its age; a click in the future is invalid', () => {
  const now = Date.UTC(2026, 9, 28);
  const m = normalizeMemory(
    {
      lastAttemptAt: now + 1e9,
      stops: [
        { host: '192.168.1.60', port: 502, unitId: 1, register: 40001, since: now + 1e9 },
        {
          host: '192.168.1.60',
          port: 502,
          unitId: 1,
          register: 40001,
          since: now - 30 * 86_400_000,
          sentAt: now - 60_000,
          reasserts: 9,
          written: true,
          before: ['automatic', 'Bad Value', 'heating', 'summer'],
        },
        { host: '192.168.1.60', port: 502, unitId: 1, register: 42103, since: now },
        { host: 'evil\r\nhost', port: 502, unitId: 1, register: 40001, since: now },
        {
          host: '192.168.1.60',
          port: 502,
          unitId: 1,
          register: 41403,
          since: now,
          before: ['running'],
        },
        {
          host: '192.168.1.60',
          port: 502,
          unitId: 1,
          register: 42102,
          since: now,
          before: ['running', '60-min'],
        },
        {
          host: '192.168.1.60',
          port: 502,
          unitId: 1,
          register: 41503,
          since: now,
        },
      ],
      target: { host: '192.168.1.60', port: 502, unitId: 1 },
      writes: {
        42103: [now - 1000, now - 2 * 86_400_000, now + 1e9, 'x'],
        30001: [now],
        abc: [now],
      },
    },
    now,
  );
  assert.deepEqual(m.writes, { 42103: [now - 1000] }, 'last 24 h, holding registers only');
  assert.equal(m.lastAttemptAt, now);
  assert.deepEqual(
    m.stops.map((s) => s.register),
    [40001, 41403, 42102],
    'known stop registers, clean hosts, not in the future, whatever their age',
  );
  assert.equal(m.stops[0].since, now - 30 * 86_400_000);
  assert.equal(m.stops[0].sentAt, now - 60_000);
  assert.equal(m.stops[0].reasserts, 3);
  assert.equal(m.stops[0].written, true);
  assert.deepEqual(
    m.stops[0].before,
    ['automatic', 'heating'],
    'keys of the register, two at most',
  );
  assert.deepEqual(m.stops[1].before, [], 'a push value is not a circuit mode; no circuit 5');
  assert.deepEqual(m.stops[2].before, ['running']);
  assert.equal(m.stops[1].sentAt, null);
  assert.deepEqual(m.target, { host: '192.168.1.60', port: 502, unitId: 1 });
  assert.deepEqual(normalizeMemory('garbage', now), {
    target: null,
    lastAttemptAt: null,
    stops: [],
    writes: {},
  });
});

test('r2-n1 the largest /data written is read back (never "unreadable" for its size)', async (t) => {
  const dir = await mkdtemp(join(tmpdir(), 'weishaupt-data-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const now = Date.UTC(2026, 9, 28);
  const host = `${'a'.repeat(63)}.`.repeat(3) + 'a'.repeat(61);
  const registers = [40001, 42102, 42103, 42104];
  for (let c = 0; c < 4; c += 1)
    for (const a of [41103, 41105, 41106, 41107]) registers.push(a + c * 100);
  const writes = Object.fromEntries(
    registers.map((r) => [
      r,
      Array.from({ length: 20 }, (_, i) => now - 23 * 3_600_000 + i * 60_000),
    ]),
  );
  const stops = [40001, 42102, 41103, 41203, 41303, 41403].map((register) => ({
    host,
    port: 65535,
    unitId: 247,
    register,
    since: now - 1,
    sentAt: now - 1,
    reasserts: 3,
    written: true,
    before: register === 42102 ? ['running', 'off'] : ['second-generator', 'automatic'],
  }));
  const memory = normalizeMemory(
    { lastAttemptAt: now, target: { host, port: 65535, unitId: 247 }, stops, writes },
    now,
  );
  assert.equal(memory.stops.length, 6);
  assert.equal(Object.keys(memory.writes).length, 20);
  assert.ok(Buffer.byteLength(JSON.stringify(memory)) < MAX_BYTES / 2, 'room left');
  const store = fileStore(join(dir, 'state.json'));
  await store.save(memory);
  const back = await store.load();
  assert.equal(back.unreadable, undefined);
  assert.deepEqual(normalizeMemory(back.data, now), memory);
});
