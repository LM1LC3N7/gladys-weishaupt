# Weishaupt heat pump (built-in Modbus TCP)

This integration shows your Weishaupt heat pump in Gladys through its **built-in Modbus TCP**
interface on your local network, without any cloud. If you allow it, it can also change the modes
and setpoints and start a hot water push.

> **Never tested with a real device.** The integration follows the register list Weishaupt gave to
> the users of the Home Assistant integration `weishaupt_modbus` (as kept in that project), and was
> tested against a simulated heat pump only. Not affiliated with Weishaupt.

## What you need

- A Weishaupt heat pump whose controller has **Modbus TCP built in** (WBB and other recent models,
  depending on the software of the controller). Heat pumps that only offer the **separate Weishaupt
  Modbus module** are **not supported** (another product, another register map). The Weishaupt WEM
  portal (cloud) is not used.
- **Modbus TCP enabled** on the heat pump: "User" → "Settings" → "Modbus TCP", "Parameter: On", and
  in "Network" / "Netmask" a range that contains the address of Gladys (safest: allow only the IP
  address of Gladys).
- A fixed IP address for the heat pump (reserve it in your router).
- Modbus TCP has **no password**: any allowed device can read and write the settings of the heat
  pump. Keep it on a **trusted network**, never exposed to the Internet.

## Configuration

| Field                       | Role                                                                           |
| --------------------------- | ------------------------------------------------------------------------------ |
| IP address of the heat pump | IPv4 or host name, port 502 unless you add one (`192.168.1.60:502`).           |
| Modbus unit id              | 1.                                                                             |
| Heating circuits            | The numbers of your circuits, 1 to 5, separated by commas (`1` by default).    |
| Allow the commands          | Off by default (see below).                                                    |
| Hot water ceiling (°C)      | The highest hot water setpoint Gladys may send: 65 °C by default, 30 to 65 °C. |
| Refresh interval            | 60 s by default, 30 s to 1 h.                                                  |
| Language                    | Language of the device names, the status and the messages.                     |

Save, then add the heat pump from the **Discovery** tab. The "Test the connection" button reads the
heat pump again, never more often than the interval.

## What you see

- System operating mode (automatic, heating, cooling, summer, standby, second heat generator), system
  state and heat pump state (heating, hot water, defrost, standby, utility lock, frost protection…, as
  stable texts such as `heating`, `hot-water`, `defrost`).
- Fault (0/1), error code and warning code (`none`, or the code number as a text: look it up in the
  manual of the heat pump).
- Power demand (%), temperatures: outdoor, air intake, heat pump flow and return, evaporation,
  compressor suction gas, hydraulic switch, hot water and hot water target in force.
- Hot water setpoints (normal, setback) and hot water push (off, or 5 to 235 minutes).
- Second heat generator and electric heaters 1 and 2 (on/off), when the heat pump gives them.
- For each configured circuit: mode, party/pause (`automatic`, `pause-90-min`, `party-60-min`…),
  room setpoints (comfort, normal, setback), room temperature and humidity, room target in force,
  flow and flow target temperatures.

A feature shows once a value of it was read. The special values are never published as measures:
"no sensor" (0x8000) and "sensor broken" (0x8001) on a temperature, 0xFFFF on a percentage, a state
outside its list, a value out of range. A text (state, code) is never published as a number.

Not shown: the energy statistics of the heat pump (kWh per day, month and year: they restart at each
period, they are not a meter index), the heat output computed by `weishaupt_modbus` from a power map
of one model, the inputs/outputs and the installer settings.

## The commands

Off by default. With "Allow the commands", Gladys may change:

- the system operating mode (automatic, heating, cooling, summer, second heat generator);
- the mode of a configured circuit (automatic, comfort, normal, setback);
- the room setpoints of a circuit (comfort, normal, setback), 16 to 28 °C by 0.5 °C, keeping comfort
  ≥ normal ≥ setback as read on the heat pump just before;
- the hot water setpoints (normal, setback), 5.5 °C to the lowest of 60 °C (the heat pump), the
  ceiling of the configuration and 65 °C, by 0.5 °C, keeping normal ≥ setback. **Nothing above 65 °C
  is ever sent**, whatever is typed;
- the hot water push (5 to 235 minutes).

Each command first reads the current values on the heat pump, writes nothing when it is already
right, then reads the written value back: it succeeds only when the read back shows the value asked.
Otherwise Gladys answers "sent, without confirmation" and reads the heat pump 5 s, 25 s and 60 s
after.

A command is refused, nothing sent, when: the option is off (also checked right before the write),
the value is out of range, above the ceiling or breaks the order of the setpoints, the circuit is not
in the configuration, the current values could not be read, the configuration changed meanwhile, a
stop was sent after it arrived, a stop sent to this heat pump is not confirmed yet (only a new choice
on that very setting goes then), 16 commands are already waiting, or this setting was already changed
6 times in the last hour. That last limit protects the memory of the heat pump, which keeps these
settings with limited write cycles; it never applies to a lower setpoint nor to a stop.

The commands go one at a time, in their order of arrival, on one connection. A scene setting several
values sets them all: a command still waiting its turn after 3.5 s gets the answer "waiting" and goes
within 15 s of the click, or not at all.

## The stops

Setting the system operating mode to **Standby**, a circuit to **Standby** or the hot water push to
**Off** does not depend on the commands option, the bounds, a read in progress or failing, a heat
pump not read yet, nor a waiting command. A stop goes before anything; every command that arrived
before it and has not left is dropped. A refused connection is tried again every 250 ms for 3 s;
Gladys gets its answer within 3.5 s.

A stop not confirmed is **held** in `/data` (with the value of before) until a read shows it: it is
not dropped after some time. The integration checks the heat pump every 15 s for 3 minutes, then
every minute, whatever the refresh interval: a stop that could not leave is tried again at each
check; a stop written but not shown yet is sent again while the heat pump still shows the value of
before (at least 20 s after the last write; three times, then once every 10 minutes at most, each one
a write in the memory of the heat pump). A check never interrupts a command; a new click on a stop
interrupts a check and is written and read back like any click. After a restart, the check runs at once,
before even reading the configuration. Stops are never limited by the hourly quota of the commands.

While a stop is held, the other commands to the same heat pump are refused.

A stop can fail or be no longer held in these cases:

- no valid address in the configuration (or, before the configuration is read, no heat pump read
  before): refused, nothing sent;
- the heat pump stays unreachable for 3 s: "not sent", then tried again at every check until it can
  be sent;
- the heat pump answers a Modbus exception: "refused" or "sent, without confirmation" depending on the
  code;
- the read back does not show the stop yet: "sent, without confirmation", then held;
- it is no longer held once a read shows it, once a newer Gladys command for the same setting left (a
  click with the option on), once two reads in a row show another value than the one before the stop
  (set at the heat pump; for a stop clicked before any read, the first value read after it is the
  value of before), or once the configuration names another heat pump (address, port or unit id);
- `/data` holding a stop dated in the future (a clock set back): it is invalid and not replayed.

Gladys never starts the heat pump again by itself.

## Known limits

- No serial number over Modbus: the device is tied to the integration, not to the IP address
  (changing the address keeps the device and its history), and another Modbus device at the same
  address would not be detected.
- The register list comes from `weishaupt_modbus`; Weishaupt's own shared copy is no longer public,
  so it could not be read again for the current software. The time a written value takes to show
  is not documented (the integration allows 20 s before sending a stop again).
- Two Modbus clients at once (Home Assistant and Gladys) may not be accepted by the heat pump.
