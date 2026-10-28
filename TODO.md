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
- [x] **Review r1** (xhigh, REFUSÉ, 2026-10-28): fixed in "Fix r1 review": B1 the
      values of before only from reads after the click (never the memory); I1 map
      checked against Weishaupt's public list 83807301 (core blocks on listed
      registers only, 41x04 apart and optional, 30002 = outdoor 2, 33108-33111,
      34101-34102/34104-34105, circuits 1-4, fault from 33102); I2 a command write
      marked in its `beforeSend`, checked by the stop once it holds the line; I3
      hot water up to the configured ceiling (65 °C at most), 60 °C was not a
      limit, refusal of the heat pump answered "refused"; I4 three resends per
      click, then held without writing; I5 tests for the four surviving guards;
      I6 "no setpoint demand" (1) never 0.1 °C. Minors: m1 20 writes a day per
      register kept in /data; m2 push 5-240 read as a timer (a running push is
      one value of before); m3 circuits 1-4; m4 fault from 33102, 30005 read not
      shown; m5 "stop not sent yet, tried again"; m6 busy text. Tests named
      `r1-…`.
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
  registers are answered (Weishaupt warns some software shifts addresses by
  one); what a heat pump answers for circuits 2-4 not fitted and for 41x04
  (only in weishaupt_modbus).
- How long a written setting takes to show in a read (the integration waits
  20 s before sending a stop again; the follow-up reads are at 5, 25, 60 s).
- Whether the controller refuses (exception 3) a setpoint that breaks the
  order comfort >= normal >= setback, or a hot water setpoint above its
  installer maximum (60 °C from the factory; answered "refused" then).
- Whether "summer" and "second heat generator" (40001 = 3, 5) are accepted as
  writes on every model; how the push timer (42102) runs down (a running push
  is one value for the stop guard either way).
- What 30005 "Fehlerfrei" holds: an error code (Weishaupt's list) or 0/1
  (weishaupt_modbus); read, not shown.
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
- **Register map**: Weishaupt's datapoint list "Modbus TCP (WWP)" 83807301
  (1/2025-11, public: weishaupt.de/uploads/tx_weishaupt_documents/documents/
  83807301.pdf, read in `~/code/ref/lot18/weishaupt-doc`), for WAB, WBB, WSB,
  WGB: every register of a core block is in it; weishaupt_modbus (its
  `hpconst.py`) only adds 41x04 (party/pause), read alone in an optional block.
  The shared Google Sheet weishaupt_modbus points to is gone (410). Reads of 5
  contiguous listed registers at most ("fortlaufend belegt"). WBB manual
  83315301 (1/2026-09) § 6.7.4.3/6.7.4.5/11.5 read by the reviewer for the hot
  water maximum and the EEPROM.
- **Not ported** (candidate line): the experimental WebIF, the heat output of
  the WBB 12 power map, the computed values; the separate Weishaupt Modbus
  module is another product (said in the docs and the manifest); the
  registers not in Weishaupt's list (33106, 33107, 34103, 41x01, 41x02, 42101,
  42105, 4310x, 4510x) and circuit 5 are not read.
- **Formats** (Weishaupt): sensors signed 0.1 °C -50.0..500.0, every special
  value (-32768 no sensor, -32767 open, -32766 short, -32758/-32757 digital)
  unknown; setpoints 5.0..500.0 °C, 1 and -32768 "no setpoint demand"
  unknown (never 0.1 °C); percentages 0xFFFF unknown; error and warning
  0xFFFF = text `none`, a code = its number as a text; states and modes
  outside their lists unknown; a text never published as a number. Fault from
  33102 (0 fault, 1 none); 30005 read, not shown (formats disagree).
- **Commands**: system mode (all six choices), circuit mode (all five), room
  setpoints comfort/normal/setback 16-28 °C by 0.5 (weishaupt_modbus bounds,
  with its dynamic order comfort >= normal >= setback checked on the fresh
  read of 41x05-41x07), hot water normal/setback 5.5 °C to min(ceiling, 65 °C)
  by 0.5 (normal >= setback on the fresh read of 42103-42104; above its
  installer maximum the heat pump answers exception 3: "refused"), hot water
  push 5-240 min by 5 (any minute 5-240 read). `text/select`, `water-heater/target-temperature`,
  `thermostat/target-temperature`: never a switch. No protective "floor"
  setpoint: the stops cover stopping; a lower setpoint is a command (behind
  the option) but never limited by the EEPROM quota.
- **Stops**: 40001 = 4 (standby), 41x03 = 4 (circuit standby), 42102 = 0
  (push off). The value written is taken from the table (a stop never writes
  0 = "automatic" on a mode register: tested). Held until a read shows the
  stop (lot 17 rule "a held stop is never lifted by the time"): checks every
  15 s for 3 min then every minute (reads only), resends while the value of
  before shows, three at most per click, at least 20 s apart (Weishaupt:
  100,000 EEPROM writes in a life; review r1 I4), then held without writing
  (the other commands still refused) until a read shows it, a new click (three
  resends again), a newer command that left on its register (a click with the
  option), another value read twice in a row (set at the heat pump), or a
  configuration read from Gladys that names another heat pump (an empty or
  invalid address lifts nothing). The values of before come only from reads
  made after the click (the read back of the stop, then the checks), never
  from the memory of an older poll (review r1 B1); a value of before unknown
  is never "changed elsewhere". A command whose write left (marked in its
  `beforeSend`) and is not confirmed adds its value to the values of before
  and keeps the stop held while it can land (2 min); checked once the stop
  holds the line (review r1 I2). A running hot water push counts down: any
  running push is one value of before ("running"). /data: `since` (wall time
  of the click) and `sentAt`; a click dated in the future is invalid; no age
  limit.
- **/data and the commands**: no command guard is persisted (only the stops,
  which are never refused), so a failed `save()` does not gate the commands; a
  /data that cannot be read is never overwritten and the first read then waits
  a whole interval (tested).
- **EEPROM quota**: 6 writes per register and rolling hour, 20 per 24 h kept
  in /data (wall times, back on the monotonic clock at the start), never for a
  lower setpoint; stops neither count nor are limited by it (three resends per
  click at most).
- **Identity**: no serial or version register over Modbus: the device id is
  the integration's; another device at the same address is not detected
  (documented).
- No `keywords` or `countries` in the manifest (DE, AT, CH would fit; left
  out per the lot rules). Category: `climate` (no energy feature in v1).
- Neighbour modules: gladys-idm (structure, line, stops, store, tests),
  gladys-lambda-heat-pump (held stops of lot 17) read only.
