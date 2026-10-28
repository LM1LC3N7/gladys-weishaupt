// -----------------------------------------------------------------------------
// What the raw values of a poll mean (pure): plausibility ranges, the special
// values that are not measures, the texts of the states and modes.
//
// Special values (never published as measures):
//   - temperatures 0x8000 "no sensor" and 0x8001 "sensor broken" (protocol.js
//     already drops them: weishaupt_modbus shows the second as -99.9 °C);
//   - percentages 0xFFFF;
//   - a state or a mode outside its list: unknown, never a number;
//   - error and warning 0xFFFF: "none" (a text, never 0).
// A value outside its plausible range is unknown, never published.
// -----------------------------------------------------------------------------

import {
  CIRCUITS,
  CIRCUIT_MODES,
  DHW_PUSH,
  LIMITS,
  NO_ERROR,
  OPERATING,
  SYSTEM_MODES,
} from './constants.js';

const within = (value, [min, max]) =>
  Number.isFinite(value) && value >= min && value <= max ? value : undefined;

const TEMPERATURES = [
  'outdoor',
  'airIntake',
  'flow',
  'return',
  'evaporation',
  'suctionGas',
  'hydraulicSwitch',
  'dhw',
  'dhwTarget',
];

const temperature = (value) => within(value, LIMITS.temperature);

/** A setpoint read back: within the range a controller can hold, else unknown. */
const setpoint = (value, range) => within(value, range);

const lookup = (table, value) =>
  Number.isInteger(value) && Object.hasOwn(table, value) ? table[value] : undefined;

/** 1 "no fault" -> 0, 0 "fault" -> 1, anything else unknown. */
const faultOf = (faultFree) => (faultFree === 1 ? 0 : faultFree === 0 ? 1 : undefined);

const flag = (value) => (value === 0 || value === 1 ? value : undefined);

/** Error and warning codes: "none", or the code as a text ("13"). */
export function codeOf(value) {
  if (value === NO_ERROR) return 'none';
  return Number.isInteger(value) && value >= 1 && value <= 999 ? String(value) : undefined;
}

/**
 * Party / pause of a heating circuit (41x04): 1-24 pause of 12 h down to
 * 0.5 h, 25 automatic, 26-49 party of 0.5 h up to 12 h; as a stable text.
 */
export function partyPauseOf(value) {
  if (!Number.isInteger(value) || value < 1 || value > 49) return undefined;
  if (value === 25) return 'automatic';
  return value < 25 ? `pause-${(25 - value) * 30}-min` : `party-${(value - 25) * 30}-min`;
}

/**
 * The values of a poll, by key: only those known this time. `raw`: what the
 * blocks gave (src/modbus/protocol.js decodeBlock), keyed alike.
 */
export function interpret(raw) {
  const values = {};
  const put = (key, value) => {
    if (value !== undefined) values[key] = value;
  };
  for (const key of TEMPERATURES) put(key, temperature(raw[key]));
  put('systemMode', lookup(SYSTEM_MODES, raw.systemMode));
  put('operatingState', lookup(OPERATING, raw.display));
  put('heatPumpState', lookup(OPERATING, raw.operation));
  put('fault', faultOf(raw.faultFree));
  put('errorCode', codeOf(raw.error));
  put('warningCode', codeOf(raw.warning));
  put('powerDemand', raw.powerDemand);
  put('dhwPush', lookup(DHW_PUSH, raw.dhwPush));
  put('dhwNormal', setpoint(raw.dhwNormal, [0, 90]));
  put('dhwSetback', setpoint(raw.dhwSetback, [0, 90]));
  put('secondGenerator', flag(raw.secondGenerator));
  put('e1', flag(raw.e1));
  put('e2', flag(raw.e2));
  for (const c of CIRCUITS) {
    const at = (key) => raw[`circuit.${c}.${key}`];
    const into = (key, value) => put(`circuit.${c}.${key}`, value);
    into('mode', lookup(CIRCUIT_MODES, at('mode')));
    into('partyPause', partyPauseOf(at('partyPause')));
    for (const key of ['comfort', 'normal', 'setback']) into(key, setpoint(at(key), [5, 40]));
    for (const key of ['room', 'roomTarget', 'flow', 'flowTarget']) {
      into(key, temperature(at(key)));
    }
    into('humidity', at('humidity'));
  }
  return values;
}
