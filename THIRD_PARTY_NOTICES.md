# Third-party notices

This integration is licensed under the Apache License 2.0 (see `LICENSE`). It
contains logic ported to JavaScript from the project below. The ported parts
were rewritten, not copied; the changes are described below.

## weishaupt_modbus

<https://github.com/OStrama/weishaupt_modbus> (Home Assistant custom
integration "Weishaupt Modbus", version 1.0.19, commit 891bea3 of
2026-10-08), by OStrama. MIT License; its `LICENSE` file names the
copyright holder. Full text below.

Ported in `src/constants.js`, `src/modbus/protocol.js` and `src/model.js`:
the Modbus TCP register list of the heat pumps with a built-in Modbus TCP
interface (`hpconst.py`, itself taken from the datapoint list Weishaupt gave
to its users: system 30001-30006 and 40001, heat pump 33101-33108, hot water
32101-32102 and 42101-42104, second heat generator 34101-34105, heating
circuits 31101-31105 and 41101-41107 with 100 registers between two
circuits), the input/holding split (function 4 for 3xxxx, 3 for 4xxxx,
write single register for the settings), the address sent as listed, the
formats (temperatures signed in 0.1 °C with 0x8000 "no sensor" and 0x8001
"sensor broken", percentages with 0xFFFF unknown), the lists of the states
and modes, the reads by groups of five registers at most and the bounds of
the setpoints (room 16-28 °C, hot water 5.5-60 °C, by 0.5 °C, with their
order comfort >= normal >= setback).

Changed: a broken sensor is unknown, never -99.9 °C; the hot water setpoints
are also capped by the configuration (65 °C at most); every write is decided
on a fresh read and confirmed by a read back; the writes are limited per hour
(EEPROM); stops (standby, circuit standby, hot water push off) are never held
back and are held until confirmed. Not ported: the experimental WebIF, the
heat output computed from a power map ("Kennfeld", WBB 12), the computed
values (spread, performance factors), the energy statistics (36xxx), the
inputs/outputs (35xxx, 45xxx) and the read-only settings it shows (4310x).
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
