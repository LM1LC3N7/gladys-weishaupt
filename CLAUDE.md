# CLAUDE.md

Project rules for coding assistants (Claude Code reads this file) and for
human contributors. Read **[TODO.md](./TODO.md) first**: status, decisions
already taken and the next milestones.

## What this is

A Gladys Assistant **external integration** of type `device`: a Node.js
service (Node 22+, ESM, no build step) in its own sandboxed Docker container,
talking to Gladys through `@gladysassistant/integration-sdk` (v0.16), its only
runtime dependency (Modbus TCP goes through `node:net`). It reads a Weishaupt
heat pump with a built-in Modbus TCP interface (port 502, no cloud, no
authentication) and shows it as one Gladys device; commands behind an
off-by-default option, stops (standby, circuit standby, push off) never
behind it. Never tested with a real device, not affiliated with Weishaupt.

## Commands

```bash
npm install
npm test                                  # node --test, the built-in runner
npm run lint                              # ESLint
npm run format:check                      # Prettier, as the CI runs it
npm run audit                             # npm audit --omit=dev
npm run cover                             # cover.png (800x534), plain Node
gi ci                                     # the whole CI locally (VM tooling)
```

## Architecture

```
index.js                  SDK bootstrap; app.boot() checks the stops kept in /data first
src/handlers.js           every SDK handler -> the app (shared with the tests)
src/app.js                WeishauptApp: the line (one session), polling, backoff, device, states,
                          badge, status, test button, command queue, stops held, guards
src/modbus/client.js      Modbus TCP session: MBAP frames, error kinds, beforeSend/startBy
src/modbus/protocol.js    blocks, requests (functions 4, 3, 6), temperature words (pure)
src/model.js              raw values -> values: special values, ranges, state texts (pure)
src/devices.js            the Gladys device, its commands and states (pure)
src/publisher.js          states within 300/min
src/store.js              /data/weishaupt-state.json: last read, last target, stops held
src/config.js             config_schema normalized
src/constants.js          register map, feature roles, limits, timings
src/i18n.js               runtime texts (en/fr)
test/fixtures/fakeWeishaupt.js  the fake heat pump behind the injected connector
test/kit/                 virtual and real clocks, fake TCP server (from gladys-testkit)
```

## Rules

- **External ids are forever**: device `weishaupt:heatpump` (no serial over
  Modbus: frozen rule), feature roles in `FEATURES`/`CIRCUIT_FEATURES` of
  `src/constants.js`, manifest keys (`host`, `unit_id`, `circuits`,
  `allow_commands`, `dhw_max_temperature`, `poll_interval`, `language`, the
  action `test_connection`).
- **Registers from the list of weishaupt_modbus only** (Weishaupt's datapoint
  list): a read covers documented registers of its table only, five at most
  (`test/protocol.test.js`, the fake refuses the rest).
- **One Modbus connection at a time, one request at a time**: everything goes
  through `useLine`; commands take the line from a poll, stops from anything.
- **Commands**: never a switch or a writable binary; refused unless
  `allow_commands` (checked on arrival and in `beforeSend`); bounded on
  arrival and in `beforeSend`; hot water never above 60 °C nor the ceiling
  nor 65 °C (also in `writeRequest`); setpoint order kept on a fresh read;
  confirmed only by the echo and a read back equal to the value asked; EEPROM
  quota; never retried; refused while a stop is held.
- **Stops** (`standby` of 40001 and 41x03, `off` of 42102): never behind the
  option, bounds, a read, a command, a backoff or a configuration not read;
  they drop the commands that arrived before them; held until a read shows
  them, never dropped by the time.
- Never read sooner than the interval (button, scan, reconnection, restart);
  only the follow-up reads after a command (5 s, 25 s, 60 s).
- **Answers are hostile**: MBAP frames bounded and checked; special values
  and implausible values unknown; never log the bytes received.
- Monotonic clock for every in-memory time; the wall clock for /data only.
- Units only from the core's `DEVICE_FEATURE_UNITS_BY_CATEGORY`.
- Files are UTF-8 without BOM (`test/encoding.test.js`); tests never touch
  the network (the real-clock test uses a local server).
- Code, comments, README in English; `docs/en.md` and `docs/fr.md` in sync.
- Every user-visible change adds a line under `## [Unreleased]` in
  `CHANGELOG.md`; versions belong to the Release workflow.
