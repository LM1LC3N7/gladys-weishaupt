# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## weishaupt_modbus

<https://github.com/OStrama/weishaupt_modbus> (Home Assistant custom
integration "Weishaupt Modbus", version 1.0.19, commit 891bea3 of
2026-10-08), by OStrama. MIT License; its `LICENSE` file names the
copyright holder. Full text below.

Ported in `src/constants.js`, `src/modbus/protocol.js` and `src/model.js`
(each checked against Weishaupt's own datapoint list "Modbus TCP (WWP)"
83807301, 1/2025-11, which is the reference of the register map): the
input/holding split (function 4 for 3xxxx, 3 for 4xxxx, write single register
for the settings), the address sent as listed, the reads by groups of five
registers at most, the party/pause register of a circuit (41x04, not in
Weishaupt's list: read apart, optional), its decoding (pause 12 h down to
0.5 h, automatic, party 0.5 h up to 12 h), and the bounds of the room
setpoints (16-28 °C by 0.5 °C, with their order comfort >= normal >=
setback).

Changed: the formats and special values are Weishaupt's (no sensor, open,
short, digital states, "no setpoint demand"), never -99.9 °C; the hot water
setpoints are capped by the configuration (65 °C at most) instead of 60 °C;
the fault comes from 33102; every write is decided on a fresh read and
confirmed by a read back; the writes are limited per hour and per day
(EEPROM); stops (standby, circuit standby, hot water push off) are never held
back and are held until confirmed. Not ported: the experimental WebIF, the
heat output computed from a power map ("Kennfeld", WBB 12), the computed
values (spread, performance factors), the energy statistics (36xxx), the
inputs/outputs (35xxx, 45xxx), the registers not in Weishaupt's list (33106,
33107, 34103, 41x01, 41x02, 42101, 42105, 4310x, 4510x) and circuit 5.
Nothing of its Home Assistant code (entities, coordinator, config flow) is
used.

```
MIT License

Copyright (c) 2024 OStrama

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## gladys-testkit (tests only)

`test/kit/` is copied from gladys-testkit (Apache-2.0, same author as this
integration): fake TCP device and clocks, used by the tests only, not in the
image.
