# TODO — Weishaupt heat pump v1

Handoff document: what is done, what was decided, what comes next. Keep it up
to date at the end of every milestone.

## Working method

- One milestone at a time, one commit per milestone, tests green before moving on.
- After each milestone: `gi ci` (Prettier, ESLint, tests Node 24 and 22,
  Docker build, store validator), `npm run audit`, then update README,
  `docs/en.md`, `docs/fr.md`, `CHANGELOG.md` and this file.
- No forum post, no GitHub release, no topic from a module session.

## Status

- [x] **Milestone 1 — core** (2026-10-28, lot 18): the heat pump by IP address
      and unit id, documented blocks read every interval over one connection
      (never sooner, even after a restart), one device, commands behind
      `allow_commands` (off), stops never held back and held until confirmed
      (in /data, never dropped by the time), EEPROM quota, test button, docs
      en/fr, cover. Built from gladys-idm (lot 17, approved in r3: line,
      session client, queue, stops, store, publisher). Tested against a fake
      heat pump only (virtual clock, and a real-clock test x20 on a local TCP
      server).
- [ ] **Review r1** (xhigh).
- [ ] **Milestone 2 — real heat pump**: run against a real WBB (see "To check").
- [ ] **Milestone 3 — more**: energy statistics (36xxx: kWh per day, month
      and year, restarting at each period: never as a meter index; perhaps the
      electrical energy of yesterday through `publishEnergyConsumption` on a
      `daily-consumption` feature, needs a newer Gladys), SG Ready and PV
      setpoint (40002, 42105, 35101-35102), constant temperatures and heating
      curve (41108-41112), bivalence temperatures (44104-44106).

## To check on a real heat pump

- That the PDU address is the number of the list (30001 sent as 0x7531), as
  weishaupt_modbus and the YAML of the field do; that reads of up to five
  registers are answered; what a heat pump answers for circuits 2-5 not
  fitted (0x8000? exception 2?).
- How long a written setting takes to show in a read (the integration waits
  20 s before sending a stop again; the follow-up reads are at 5, 25, 60 s).
- Whether the controller refuses (exception 3) a setpoint that breaks the
  order comfort >= normal >= setback, or a hot water setpoint above 60 °C.
- Whether "summer" and "second heat generator" (40001 = 3, 5) are accepted as
  writes on every model; whether the push register (42102) runs down by
  itself (minutes left) or keeps the duration set.
- Whether two Modbus clients at once (Home Assistant and Gladys) are accepted.

## Decisions

- **Version 0.1.0 set by hand** in `package.json`, `package-lock.json`, the
  manifest and `docker_image` (`ghcr.io/lm1lc3n7/gladys-weishaupt:0.1.0`). The
  manifest test checks the semver shape and that the four agree, never a
  pinned value.
- **SDK 0.16.0** (`dist-tags.latest` on 2026-10-28, the template's).
- **Reference**: weishaupt_modbus 1.0.19 (OStrama, MIT, LICENSE read:
  "Copyright (c) 2024 OStrama"), commit 891bea3 of 2026-10-08, cloned read only
  in `~/code/ref/lot18/weishaupt_modbus`. Notice and full license in
  `THIRD_PARTY_NOTICES.md`, copied in the image.
- **Register map**: Weishaupt's own document is not public. weishaupt_modbus
  points to a shared copy of the datapoint list Weishaupt gave to a user (a
  Google Sheet): it answers 410 (gone) on 2026-10-28, so it could not be read
  for the current software. The map is therefore the list kept in
  `hpconst.py` of weishaupt_modbus (both copies in the repository agree),
  used by its users since 2024; only its documented addresses are used
  (`Adr. 31106`, `Adr. 36801` and the "UNKNOWN" inputs/outputs are left out),
  read by groups of at most five as it does. Said in the docs.
- **Not ported** (candidate line): the experimental WebIF, the heat output of
  the WBB 12 power map, the computed values; the separate Weishaupt Modbus
  module is another product (said in the docs and the manifest); the
  read-only installer settings (4310x, 4510x) are not shown.
- **Formats**: temperatures signed in 0.1 °C, 0x8000 "no sensor" and 0x8001
  "sensor broken" unknown (weishaupt_modbus shows -99.9 °C for the second:
  never a measure here); percentages 0xFFFF unknown; error and warning
  0xFFFF = text `none`, a code = its number as a text; states and modes
  outside their lists unknown; a text never published as a number.
- **Commands**: system mode (all six choices), circuit mode (all five), room
  setpoints comfort/normal/setback 16-28 °C by 0.5 (weishaupt_modbus bounds,
  with its dynamic order comfort >= normal >= setback checked on the fresh
  read of 41x05-41x07), hot water normal/setback 5.5 °C to min(60 °C, ceiling,
  65 °C) by 0.5 (normal >= setback on the fresh read of 42103-42104), hot water
  push 5-235 min. `text/select`, `water-heater/target-temperature`,
  `thermostat/target-temperature`: never a switch. No protective "floor"
  setpoint: the stops cover stopping; a lower setpoint is a command (behind
  the option) but never limited by the EEPROM quota.
- **Stops**: 40001 = 4 (standby), 41x03 = 4 (circuit standby), 42102 = 0
  (push off). The value written is taken from the table (a stop never writes
  0 = "automatic" on a mode register: tested). Held until a read shows the
  stop (lot 17 rule "a held stop is never lifted by the time"): checks every
  15 s for 3 min then every minute, resends while the value of before shows
  (three at least 20 s apart, then every 10 min at most: EEPROM), lifted by a
  newer command that left on its register (a click with the option), by
  another value read twice in a row (set at the heat pump; a value of before
  unknown is never "changed": the first value read is taken as it), or by a
  configuration read from Gladys that names another heat pump (an empty or
  invalid address lifts nothing). While a stop is held, every other command to
  that heat pump is refused (a command could otherwise start what the stop
  stopped). /data: `since` (wall time of the click) and `sentAt`; a click
  dated in the future is invalid; no age limit.
- **/data and the commands**: no command guard is persisted (only the stops,
  which are never refused), so a failed `save()` does not gate the commands; a
  /data that cannot be read is never overwritten and the first read then waits
  a whole interval (tested).
- **EEPROM quota**: 6 writes per register and rolling hour (in memory, reset
  by a restart), never for a lower setpoint; stops neither count nor are
  limited by it.
- **Identity**: no serial or version register over Modbus: the device id is
  the integration's; another device at the same address is not detected
  (documented).
- No `keywords` or `countries` in the manifest (DE, AT, CH would fit; left
  out per the lot rules). Category: `climate` (no energy feature in v1).
- Neighbour modules: gladys-idm (structure, line, stops, store, tests),
  gladys-lambda-heat-pump (held stops of lot 17) read only.
