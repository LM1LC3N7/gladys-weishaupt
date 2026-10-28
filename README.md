# gladys-weishaupt

[Gladys Assistant](https://gladysassistant.com) external integration for **Weishaupt heat pumps with a
built-in Modbus TCP interface** (WBB and other recent models), on the local network (port 502, no
cloud, no password): temperatures, system and heat pump state, fault, error and warning codes, power
demand, heating circuits 1 to 5, hot water, second heat generator; mode, setpoint and hot water push
commands behind an off-by-default option (hot water capped at 60 °C and at the configured ceiling,
65 °C at most), standby, circuit standby and push off never behind that option. The separate
Weishaupt Modbus module is not supported. **Never tested with a real device. Not affiliated with
Weishaupt.** Modbus TCP has no authentication: keep the heat pump on a trusted network.

User documentation: [docs/en.md](docs/en.md) · [docs/fr.md](docs/fr.md).

## How it works

```
Gladys ⇄ SDK ⇄ src/handlers.js ⇄ src/app.js (WeishauptApp)
                                  ├─ src/modbus/client.js    one Modbus TCP session at a time, bounded MBAP frames
                                  ├─ src/modbus/protocol.js  blocks, requests, temperature words, writes (pure)
                                  ├─ src/model.js            special values, plausible ranges, state texts (pure)
                                  ├─ src/devices.js          the device, its commands and states (pure)
                                  ├─ src/publisher.js        states within 300/min
                                  └─ src/store.js            /data/weishaupt-state.json (last read, stops held)
```

- **Reads**: one connection per poll (every 60 s, 30 s – 1 h): function 4 on the input registers
  (3xxxx) and function 3 on the holding registers (4xxxx), by runs of at most five documented
  registers, then closed. The test button, Discovery, a reconnection and a restart never read sooner
  than the interval (time kept in `/data` before the read); only a command (its fresh read, its read
  back) and the reads 5 s, 25 s and 60 s after it do.
- **Device**: `ext:<selector>:weishaupt:heatpump` (no serial number over Modbus). Commands and main
  states always built; sensors once a value was read, or already created.
- **Commands** (`allow_commands`, off by default): system mode (40001), hot water push (42102), hot
  water setpoints (42103-42104), circuit mode (41x03), room setpoints (41x05-41x07). Fresh read of
  the registers concerned (order of the setpoints kept), already-so check, EEPROM quota (6 per
  register and hour, never for a lower setpoint), function 6 write, echo and read back; one at a time
  in order on one session (a scene sets them all); refused while a stop is held.
- **Stops** (protective): system standby, circuit standby, push off; never behind the option, the
  bounds, a read or a command; drop every command that arrived before; retried for 3 s; held in
  `/data` with the value of before until a read shows them (never dropped by the time), checked every
  15 s then every minute, sent again while the value of before shows; lifted by a newer command to
  the same register, by another value read twice in a row, or by a configuration naming another heat
  pump. One lock for the line: a session opens only once the previous one is closed.

## Development

```bash
npm install
npm test
npm run lint && npm run format:check
gi ci          # the whole CI locally (VM tooling)
```

Register map: the register list of [weishaupt_modbus](https://github.com/OStrama/weishaupt_modbus)
1.0.19 (MIT, see `THIRD_PARTY_NOTICES.md`), taken from the datapoint list Weishaupt gave its users.

## License

Apache-2.0, see [LICENSE](LICENSE).
