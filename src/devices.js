// -----------------------------------------------------------------------------
// The heat pump -> one Gladys device, its features, its commands and its
// states (pure).
//
// `ext:<selector>:weishaupt:heatpump`: one device per integration. FROZEN
// RULE: the Modbus map gives no serial number, so the device is keyed by the
// integration, never by its IP address (a new address keeps the device and
// its history). The feature roles (the last part of their external ids) are
// published forever: never rename them. A heating circuit's roles are
// `circuit-<1..5>-<suffix>`.
//
// Features built: the commands and the main states always; a sensor once a
// value of it was read (a heat pump without a second heat generator never
// shows its features), or when the created device already has it (a
// republished device never loses a feature).
//
// No switch, no writable binary: a "turn everything off" (Google Home, Alexa,
// HomeKit, MCP, `switch.*` scenes) never reaches the heat pump. The commands
// are `text/select` features (system mode, circuit modes, hot water push) and
// target temperatures (hot water, room setpoints of a circuit).
// -----------------------------------------------------------------------------

import {
  DEVICE_FEATURE_CATEGORIES as C,
  DEVICE_FEATURE_TYPES as T,
  DEVICE_FEATURE_UNITS as U,
} from '@gladysassistant/integration-sdk';
import {
  BOUNDS,
  CIRCUITS,
  CIRCUIT_FEATURES as CF,
  CIRCUIT_MODES,
  CIRCUIT_STEP,
  DHW_CAP,
  DHW_PUSH,
  FEATURES as F,
  SYSTEM_MODES,
  circuitRole,
} from './constants.js';
import {
  CIRCUIT_MODE_NAMES,
  DEVICE_NAME,
  DHW_PUSH_NAMES,
  FEATURE_NAMES,
  SYSTEM_MODE_NAMES,
  circuitFeatureName,
  word,
} from './i18n.js';
import { holdingBlock } from './modbus/protocol.js';

export const SERVICE = 'weishaupt';
export const PLATFORM_ID = 'heatpump';

const sensor = (definition) => ({
  read_only: true,
  has_feedback: false,
  keep_history: true,
  ...definition,
});
const binary = sensor({ category: C.UNKNOWN, type: T.SENSOR.BINARY, min: 0, max: 1 });
const text = sensor({ category: C.TEXT, type: T.TEXT.TEXT, min: 0, max: 0, keep_history: false });
const temperature = sensor({
  category: C.TEMPERATURE_SENSOR,
  type: T.SENSOR.DECIMAL,
  unit: U.CELSIUS,
  min: -50,
  max: 120,
});
const select = {
  category: C.TEXT,
  type: T.TEXT.SELECT,
  min: 0,
  max: 0,
  read_only: false,
  has_feedback: true,
  keep_history: false,
};
const dhwTarget = {
  category: C.WATER_HEATER,
  type: T.WATER_HEATER.TARGET_TEMPERATURE,
  unit: U.CELSIUS,
  min: BOUNDS.dhw.min,
  max: Math.min(BOUNDS.dhw.max, DHW_CAP.max),
  read_only: false,
  has_feedback: true,
  keep_history: true,
};
const roomTarget = {
  category: C.THERMOSTAT,
  type: T.THERMOSTAT.TARGET_TEMPERATURE,
  unit: U.CELSIUS,
  min: BOUNDS.room.min,
  max: BOUNDS.room.max,
  read_only: false,
  has_feedback: true,
  keep_history: true,
};

/** The device features (not per circuit), by role, in display order; `value`: the key read. */
const DEVICE_FEATURES = [
  [F.SYSTEM_MODE, select, 'systemMode', true],
  [F.OPERATING_STATE, text, 'operatingState', true],
  [F.HEAT_PUMP_STATE, text, 'heatPumpState', true],
  [F.FAULT, binary, 'fault', true],
  [F.ERROR_CODE, text, 'errorCode', true],
  [F.WARNING_CODE, text, 'warningCode', true],
  [
    F.POWER_DEMAND,
    sensor({ category: C.UNKNOWN, type: T.SENSOR.INTEGER, min: 0, max: 100 }),
    'powerDemand',
  ],
  [F.TEMP_OUTDOOR, temperature, 'outdoor'],
  [F.TEMP_AIR_INTAKE, temperature, 'airIntake'],
  [F.TEMP_FLOW, temperature, 'flow'],
  [F.TEMP_RETURN, temperature, 'return'],
  [F.TEMP_EVAPORATION, temperature, 'evaporation'],
  [F.TEMP_SUCTION_GAS, temperature, 'suctionGas'],
  [F.TEMP_HYDRAULIC_SWITCH, temperature, 'hydraulicSwitch'],
  [F.TEMP_DHW, temperature, 'dhw'],
  [F.TEMP_DHW_TARGET, temperature, 'dhwTarget'],
  [F.DHW_SETPOINT, dhwTarget, 'dhwNormal', true],
  [F.DHW_SETBACK, dhwTarget, 'dhwSetback', true],
  [F.DHW_PUSH, select, 'dhwPush', true],
  [F.SECOND_GENERATOR, binary, 'secondGenerator'],
  [F.E1, binary, 'e1'],
  [F.E2, binary, 'e2'],
];

/** The features of a heating circuit, by suffix; `always`: built for a configured circuit. */
const CIRCUIT_DEFS = [
  [CF.MODE, select, 'mode', true],
  [CF.PARTY_PAUSE, text, 'partyPause'],
  [CF.SETPOINT_COMFORT, roomTarget, 'comfort', true],
  [CF.SETPOINT_NORMAL, roomTarget, 'normal', true],
  [CF.SETPOINT_SETBACK, roomTarget, 'setback', true],
  [CF.TEMP_ROOM, temperature, 'room'],
  [CF.TEMP_ROOM_TARGET, temperature, 'roomTarget'],
  [
    CF.HUMIDITY,
    sensor({
      category: C.HUMIDITY_SENSOR,
      type: T.SENSOR.DECIMAL,
      unit: U.PERCENT,
      min: 0,
      max: 100,
    }),
    'humidity',
  ],
  [CF.TEMP_FLOW, temperature, 'flow'],
  [CF.TEMP_FLOW_TARGET, temperature, 'flowTarget'],
];

/** Every known role: { definition, value key, always, circuit?, suffix? }, in display order. */
export const ROLES = new Map([
  ...DEVICE_FEATURES.map(([role, definition, value, always = false]) => [
    role,
    { definition, value, always },
  ]),
  ...CIRCUITS.flatMap((circuit) =>
    CIRCUIT_DEFS.map(([suffix, definition, value, always = false]) => [
      circuitRole(circuit, suffix),
      { definition, value: `circuit.${circuit}.${value}`, always, circuit, suffix },
    ]),
  ),
]);

export const ids = (gladys) => gladys.externalIds(SERVICE, PLATFORM_ID);

/** The role of one of our feature external ids, else undefined. */
export function parseFeatureId(externalId) {
  if (typeof externalId !== 'string') return undefined;
  const match = new RegExp(`:${SERVICE}:${PLATFORM_ID}:([a-z0-9-]+)$`).exec(externalId);
  return match && ROLES.has(match[1]) ? match[1] : undefined;
}

const DHW_BLOCK = holdingBlock('dhw-setpoints', [
  [42103, 'temp', 'dhwNormal'],
  [42104, 'temp', 'dhwSetback'],
]);

const roomBlock = (circuit) => {
  const offset = (Number(circuit) - 1) * CIRCUIT_STEP;
  return holdingBlock(`circuit-${circuit}-setpoints`, [
    [41105 + offset, 'temp', `circuit.${circuit}.comfort`],
    [41106 + offset, 'temp', `circuit.${circuit}.normal`],
    [41107 + offset, 'temp', `circuit.${circuit}.setback`],
  ]);
};

/**
 * The commands, by role: the register written (address, type), the value
 * key read back, the block read just before and after the write (`block`,
 * documented registers only), and either the choices of a select (`values`,
 * with `protective` the choice that stops) or the bounds of a setpoint with
 * the order to keep with the other setpoints of the block: the value written
 * is never above the keys of `atMost` nor below those of `atLeast`.
 */
export function commandOf(role) {
  if (role === F.SYSTEM_MODE) {
    return {
      kind: 'select',
      address: 40001,
      type: 'word',
      read: 'systemMode',
      block: holdingBlock('system-mode', [[40001, 'word', 'systemMode']]),
      table: SYSTEM_MODES,
      writable: Object.values(SYSTEM_MODES),
      protective: 'standby',
    };
  }
  if (role === F.DHW_PUSH) {
    return {
      kind: 'select',
      address: 42102,
      type: 'word',
      read: 'dhwPush',
      block: holdingBlock('dhw-push', [[42102, 'word', 'dhwPush']]),
      table: DHW_PUSH,
      writable: Object.values(DHW_PUSH),
      protective: 'off',
    };
  }
  if (role === F.DHW_SETPOINT) {
    return {
      kind: 'dhw',
      address: 42103,
      type: 'temp',
      read: 'dhwNormal',
      block: DHW_BLOCK,
      atLeast: ['dhwSetback'],
      atMost: [],
    };
  }
  if (role === F.DHW_SETBACK) {
    return {
      kind: 'dhw',
      address: 42104,
      type: 'temp',
      read: 'dhwSetback',
      block: DHW_BLOCK,
      atLeast: [],
      atMost: ['dhwNormal'],
    };
  }
  const entry = ROLES.get(role);
  if (!entry?.circuit) return undefined;
  const c = entry.circuit;
  const offset = (Number(c) - 1) * CIRCUIT_STEP;
  if (entry.suffix === CF.MODE) {
    return {
      kind: 'select',
      circuit: c,
      address: 41103 + offset,
      type: 'word',
      read: entry.value,
      block: holdingBlock(`circuit-${c}-mode`, [[41103 + offset, 'word', entry.value]]),
      table: CIRCUIT_MODES,
      writable: Object.values(CIRCUIT_MODES),
      protective: 'standby',
    };
  }
  const key = (name) => `circuit.${c}.${name}`;
  const room = {
    [CF.SETPOINT_COMFORT]: [41105, [key('normal'), key('setback')], []],
    [CF.SETPOINT_NORMAL]: [41106, [key('setback')], [key('comfort')]],
    [CF.SETPOINT_SETBACK]: [41107, [], [key('normal'), key('comfort')]],
  }[entry.suffix];
  if (room) {
    return {
      kind: 'room',
      circuit: c,
      address: room[0] + offset,
      type: 'temp',
      read: entry.value,
      block: roomBlock(c),
      atLeast: room[1],
      atMost: room[2],
    };
  }
  return undefined;
}

/** The registers a stop writes, with the role of its command. */
export function stopRoles() {
  const roles = [F.SYSTEM_MODE, F.DHW_PUSH, ...CIRCUITS.map((c) => circuitRole(c, CF.MODE))];
  return new Map(roles.map((role) => [commandOf(role).address, role]));
}

const OPTIONS = {
  [F.SYSTEM_MODE]: [SYSTEM_MODES, SYSTEM_MODE_NAMES],
  [F.DHW_PUSH]: [DHW_PUSH, DHW_PUSH_NAMES],
  mode: [CIRCUIT_MODES, CIRCUIT_MODE_NAMES],
};

function nameOf(role, language) {
  const entry = ROLES.get(role);
  return word(
    entry.circuit ? circuitFeatureName(entry.circuit, entry.suffix) : FEATURE_NAMES[role],
    language,
  );
}

/**
 * The roles the device shows: the `always` ones (of the configured circuits),
 * those seen with a value in this run, and those of the created device.
 */
export function rolesToBuild({ circuits, seen = new Set(), created = new Set() }) {
  const roles = [];
  for (const [role, entry] of ROLES) {
    const configured = !entry.circuit || circuits.includes(entry.circuit);
    if ((entry.always && configured) || seen.has(role) || created.has(role)) {
      roles.push(role);
    }
  }
  return roles;
}

/** The highest hot water setpoint offered: the device's, the configuration's, 65 °C. */
export const dhwTop = (dhwCap = DHW_CAP.default) => Math.min(BOUNDS.dhw.max, DHW_CAP.max, dhwCap);

/** The Gladys device of the heat pump. */
export function buildDevice(gladys, { language, roles, dhwCap = DHW_CAP.default }) {
  const i = ids(gladys);
  return {
    name: word(DEVICE_NAME, language),
    external_id: i.device,
    model: 'Weishaupt heat pump (Modbus TCP)',
    should_poll: false,
    features: roles.map((role) => {
      const entry = ROLES.get(role);
      const options = OPTIONS[role] ?? (entry.suffix === CF.MODE ? OPTIONS.mode : undefined);
      return {
        name: nameOf(role, language),
        external_id: i.feature(role),
        ...entry.definition,
        // The hot water sliders stop at the ceiling of the configuration (65 °C at most).
        ...(entry.definition === dhwTarget ? { max: dhwTop(dhwCap) } : {}),
        ...(options
          ? {
              supported_options: Object.values(options[0]).map((value, index) => ({
                value,
                label: word(options[1](value), language),
                sort_order: index,
              })),
            }
          : {}),
      };
    }),
    params: [{ name: 'protocol', value: 'Modbus TCP' }],
  };
}

/** The roles a set of values gives a value to. */
export function rolesWithValues(values) {
  const roles = [];
  for (const [role, entry] of ROLES) {
    if (values[entry.value] !== undefined) roles.push(role);
  }
  return roles;
}

/**
 * The states of the values given (a value not read this time is left out:
 * Gladys keeps its last one, never republished as new). Texts are stable
 * English keys, whatever the language (scenes keep working). Numbers are
 * those `interpret` found plausible (src/model.js); a text is never sent as
 * a number.
 */
export function deviceStates(i, values) {
  const states = [];
  for (const [role, entry] of ROLES) {
    const value = values[entry.value];
    if (value === undefined) continue;
    const id = i.feature(role);
    if (entry.definition.category === C.TEXT) {
      if (typeof value === 'string') states.push({ device_feature_external_id: id, text: value });
    } else if (typeof value === 'number' && Number.isFinite(value)) {
      states.push({ device_feature_external_id: id, state: value });
    }
  }
  return states;
}
