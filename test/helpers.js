// -----------------------------------------------------------------------------
// The app against the SDK's fake Gladys and a fake Weishaupt heat pump, with the exact
// wiring of the container (src/handlers.js) and the virtual clock of the kit:
// every read of the clock moves it on by 1 µs (a decision reading it twice
// sees it move), timers fire only when the test advances the time.
// -----------------------------------------------------------------------------

import { createFakeGladys } from '@gladysassistant/integration-sdk/testing';
import { WeishauptApp } from '../src/app.js';
import { registerHandlers } from '../src/handlers.js';
import { memoryStore } from '../src/store.js';
import { HOST, NOW, fakeWeishaupt } from './fixtures/fakeWeishaupt.js';
import { settle, testClock } from './kit/clock.mjs';

export const SECOND = 1000;
export const MINUTE = 60 * SECOND;
export const CFG = { host: HOST };
export const ALLOW = { host: HOST, allow_commands: true };
export const DEVICE = 'ext:test-integration:weishaupt:heatpump';
export const feature = (role) => `${DEVICE}:${role}`;

export async function setup({
  config = CFG,
  clock = testClock({ start: NOW }),
  hp,
  store = memoryStore(),
  create = true,
  boot = false,
  getConfigFails = 0,
} = {}) {
  const device = hp ?? fakeWeishaupt({ timers: clock.timers });
  const gladys = createFakeGladys({ config });
  if (getConfigFails > 0) {
    // The SDK reads the configuration once before 'connected'; the app's reads fail after.
    let left = getConfigFails;
    let calls = 0;
    const original = gladys.getConfig.bind(gladys);
    gladys.getConfig = async () => {
      calls += 1;
      if (calls > 1 && left > 0) {
        left -= 1;
        throw new Error('Gladys unreachable');
      }
      return original();
    };
  }
  const lines = [];
  const logger = Object.fromEntries(
    ['debug', 'info', 'warn', 'error'].map((l) => [
      l,
      (...a) => lines.push(`${l}: ${a.map((x) => (x instanceof Error ? x.message : x)).join(' ')}`),
    ]),
  );
  const app = new WeishauptApp({
    gladys,
    logger,
    connect: device.connectFn,
    now: clock.now,
    clock: clock.monotonic,
    timers: clock.timers,
    store,
  });
  registerHandlers(gladys, app, logger);
  const advance = async (ms, step = 10) => {
    for (let e = 0; e < ms; e += step) {
      await clock.advance(Math.min(step, ms - e));
      await settle(2);
    }
  };
  if (boot) {
    await app.boot();
  }
  const connecting = gladys.connect();
  await settle();
  await advance(500);
  await connecting;
  await advance(500);
  if (create && gladys.fake.discoveredDevices.length > 0) {
    await gladys.fake.deviceCreated(gladys.fake.discoveredDevices[0]);
    await settle();
    await advance(1100);
  }
  const fire = (role, value) => {
    const d = gladys.fake.devices.find((x) => x.external_id === DEVICE) ?? { external_id: DEVICE };
    return gladys.fake.setValue(d, { external_id: feature(role) }, value);
  };
  const press = async (role, value, wait = 5 * SECOND) => {
    const ack = fire(role, value);
    await advance(wait, 50);
    return ack;
  };
  const state = (role) =>
    gladys.fake.states.findLast((s) => s.device_feature_external_id === feature(role));
  const stop = () => app.stop();
  return { gladys, app, hp: device, clock, advance, lines, fire, press, store, state, stop };
}
