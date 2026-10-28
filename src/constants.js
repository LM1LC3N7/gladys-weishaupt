// -----------------------------------------------------------------------------
// Weishaupt constants: the Modbus TCP map of the heat pumps with a built-in
// Modbus TCP interface (WAB, WBB, WSB, WGB), manifest keys, feature roles,
// limits and timings.
//
// The heat pump answers Modbus TCP on port 502, unit id 1, without
// authentication, once "Modbus TCP" is on (Settings > Modbus TCP, "Access:
// On", with the network and netmask allowed to connect). The separate
// Weishaupt Modbus module is another product, not covered.
//
// The registers are those of Weishaupt's own datapoint list "Datenpunktliste
// Modbus TCP (WWP)" 83807301 (1/2025-11, public on weishaupt.de), cross-
// checked with weishaupt_modbus 1.0.19 (MIT, OStrama). Every register read in
// a core block is in Weishaupt's list; the party/pause of a circuit (41x04),
// only in weishaupt_modbus, is read alone in an optional block. The address of
// the list is sent as is in the PDU (30001 -> 0x7531), as weishaupt_modbus and
// the field configurations do (the list warns some software shifts it by one).
// Only these requests are ever sent:
//   - read input registers (function 4) of the 3xxxx blocks below and read
//     holding registers (function 3) of the 4xxxx blocks below, each block a
//     run of contiguous listed registers, five at most (Weishaupt: "maximal
//     5 Datenpunkte am Stück, fortlaufend belegt");
//   - write single register (function 6) at 40001 (system mode), 42102 (hot
//     water push), 42103-42104 (hot water setpoints), 41x03 (mode of heating
//     circuit x) and 41x05-41x07 (room setpoints of heating circuit x).
// Weishaupt: every setting is kept in EEPROM, 100,000 writes in the life of
// the heat pump, write as little as possible: the writes are counted per hour
// and per day (LIMITS), the stops are sent again three times at most.
//
// Formats (Weishaupt): "Format Sensor" signed 0.1 °C, -500..5000, with
// -32768 no sensor, -32767 open, -32766 short, -32758/-32757 digital state
// (never temperatures); "FormatSollwert" 50..5000 (5.0-500.0 °C), with
// -32768 and 1 "no setpoint demand"; humidity 0-100, 65535 none; error codes
// 65535 none; states and modes as listed.
// -----------------------------------------------------------------------------

export const DEFAULT_PORT = 502;

/** Modbus function codes used (nothing else is ever sent). */
export const FC = {
  READ_HOLDING: 0x03,
  READ_INPUT: 0x04,
  WRITE_SINGLE: 0x06,
};

/** The MBAP header (7 bytes) and the largest frame Modbus TCP allows (260 bytes). */
export const MBAP_SIZE = 7;
export const MAX_FRAME = 260;

/** Heating circuits 1 to 4 (Weishaupt "Heizkreis 1" ... "4"): 100 registers apart. */
export const CIRCUITS = ['1', '2', '3', '4'];
export const CIRCUIT_STEP = 100;

/**
 * The blocks read at each poll, in this order. `fc`: the function (input or
 * holding); `points`: `[address, type, key]`, contiguous (checked by the
 * tests). `core`: a Modbus exception on it fails the poll; otherwise an
 * "illegal data address" on a block never answered means the controller does
 * not have it (not read again until a restart), any other exception leaves
 * its values unknown this time. Circuit blocks are built for the configured
 * circuits (src/modbus/protocol.js circuitBlocks).
 */
export const BLOCKS = [
  {
    key: 'system',
    fc: FC.READ_INPUT,
    core: true,
    points: [
      [30001, 'temp', 'outdoor'],
      [30002, 'temp', 'outdoor2'],
      [30003, 'word', 'error'],
      [30004, 'word', 'warning'],
      [30005, 'word', 'faultFree'],
    ],
  },
  { key: 'display', fc: FC.READ_INPUT, core: true, points: [[30006, 'word', 'display']] },
  { key: 'system-mode', fc: FC.READ_HOLDING, core: true, points: [[40001, 'word', 'systemMode']] },
  {
    key: 'heat-pump',
    fc: FC.READ_INPUT,
    core: true,
    points: [
      [33101, 'word', 'operation'],
      [33102, 'word', 'hpFaultFree'],
      [33103, 'pct', 'powerDemand'],
      [33104, 'temp', 'flow'],
      [33105, 'temp', 'return'],
    ],
  },
  {
    key: 'heat-pump-2',
    fc: FC.READ_INPUT,
    points: [
      [33108, 'temp', 'hydraulicSwitch'],
      [33109, 'temp', 'regenerative'],
      [33110, 'temp', 'buffer'],
      [33111, 'temp', 'totalFlow'],
    ],
  },
  {
    key: 'dhw',
    fc: FC.READ_INPUT,
    core: true,
    points: [
      [32101, 'set', 'dhwTarget'],
      [32102, 'temp', 'dhw'],
    ],
  },
  { key: 'dhw-push', fc: FC.READ_HOLDING, core: true, points: [[42102, 'word', 'dhwPush']] },
  {
    key: 'dhw-setpoints',
    fc: FC.READ_HOLDING,
    core: true,
    points: [
      [42103, 'set', 'dhwNormal'],
      [42104, 'set', 'dhwSetback'],
    ],
  },
  {
    key: 'second-generator',
    fc: FC.READ_INPUT,
    points: [
      [34101, 'word', 'secondGenerator'],
      [34102, 'word', 'secondGeneratorHours'],
    ],
  },
  {
    key: 'electric-heaters',
    fc: FC.READ_INPUT,
    points: [
      [34104, 'word', 'e1'],
      [34105, 'word', 'e2'],
    ],
  },
];

/**
 * The blocks of heating circuit 1, keyed `circuit.<n>.<key>`: circuit n adds
 * (n - 1) * 100 to every address (Weishaupt's list).
 */
export const CIRCUIT_BLOCKS = [
  {
    key: 'values',
    fc: FC.READ_INPUT,
    points: [
      [31101, 'set', 'roomTarget'],
      [31102, 'temp', 'room'],
      [31103, 'pct', 'humidity'],
      [31104, 'set', 'flowTarget'],
      [31105, 'temp', 'flow'],
    ],
  },
  { key: 'mode', fc: FC.READ_HOLDING, core: true, points: [[41103, 'word', 'mode']] },
  // Only in weishaupt_modbus, not in Weishaupt's list: optional, read alone.
  { key: 'party-pause', fc: FC.READ_HOLDING, points: [[41104, 'word', 'partyPause']] },
  {
    key: 'setpoints',
    fc: FC.READ_HOLDING,
    core: true,
    points: [
      [41105, 'set', 'comfort'],
      [41106, 'set', 'normal'],
      [41107, 'set', 'setback'],
    ],
  },
];

/** Register 40001, the system mode (Weishaupt "Systembetriebsart"). */
export const SYSTEM_MODES = {
  0: 'automatic',
  1: 'heating',
  2: 'cooling',
  3: 'summer',
  4: 'standby',
  5: 'second-generator',
};

/** Registers 41x03, the mode of a heating circuit ("Betriebsart"). */
export const CIRCUIT_MODES = {
  0: 'automatic',
  1: 'comfort',
  2: 'normal',
  3: 'setback',
  4: 'standby',
};

/**
 * Register 42102, the hot water push ("Warmwasser Push", a timer): 0 off,
 * else 5 to 240 minutes (any minute is read; the choices offered go by 5).
 */
export const DHW_PUSH = Object.fromEntries([
  [0, 'off'],
  ...Array.from({ length: 48 }, (_, i) => [(i + 1) * 5, `${(i + 1) * 5}-min`]),
]);
export const DHW_PUSH_MAX = 240;

/** Registers 30006 and 33101, what the system and the heat pump do ("Betriebsanzeige"). */
export const OPERATING = {
  0: 'undefined',
  1: 'relay-test',
  2: 'emergency-stop',
  3: 'diagnosis',
  4: 'manual',
  5: 'manual-heating',
  6: 'manual-cooling',
  7: 'manual-defrost',
  8: 'defrost',
  9: 'second-generator',
  10: 'utility-lock',
  11: 'sg-tariff',
  12: 'sg-maximum',
  13: 'tariff-charging',
  14: 'increased',
  15: 'idle-time',
  16: 'standby',
  17: 'flushing',
  18: 'frost-protection',
  19: 'heating',
  20: 'hot-water',
  21: 'legionella-protection',
  22: 'switching-heating-cooling',
  23: 'cooling',
  24: 'passive-cooling',
  25: 'summer',
  26: 'swimming-pool',
  27: 'holiday',
  28: 'screed-program',
  29: 'locked',
  30: 'locked-outdoor-temperature',
  31: 'locked-summer',
  32: 'locked-winter',
  33: 'operating-limit',
  34: 'circuit-locked',
  35: 'ready',
  36: 'regenerative',
  37: 'sg-ready-3-heating',
  38: 'sg-ready-3-cooling',
  39: 'sg-ready-3-hot-water',
  40: 'sg-ready-4-heating',
  41: 'sg-ready-4-cooling',
  42: 'sg-ready-4-hot-water',
  43: 'oil-return',
};

/** Error and warning codes (30003, 30004): 0xFFFF "no error", else a code of the list. */
export const NO_ERROR = 0xffff;

/**
 * Modbus exception codes that mean the request was not applied (illegal
 * function, address, value). Any other code (4 device failure, 5 acknowledge,
 * 6 busy…) may come from a write applied anyway: "sent, without confirmation".
 */
export const NOT_APPLIED_EXCEPTIONS = new Set([1, 2, 3]);

/** Modbus exception code 2: the register is not served by this controller. */
export const ILLEGAL_DATA_ADDRESS = 2;

/** Feature roles (the last part of the feature external ids): frozen. */
export const FEATURES = {
  SYSTEM_MODE: 'system-mode',
  OPERATING_STATE: 'operating-state',
  HEAT_PUMP_STATE: 'heat-pump-state',
  FAULT: 'fault',
  ERROR_CODE: 'error-code',
  WARNING_CODE: 'warning-code',
  POWER_DEMAND: 'power-demand',
  TEMP_OUTDOOR: 'temperature-outdoor',
  TEMP_OUTDOOR_2: 'temperature-outdoor-2',
  TEMP_FLOW: 'temperature-flow',
  TEMP_RETURN: 'temperature-return',
  TEMP_HYDRAULIC_SWITCH: 'temperature-hydraulic-switch',
  TEMP_REGENERATIVE: 'temperature-regenerative',
  TEMP_BUFFER: 'temperature-buffer',
  TEMP_TOTAL_FLOW: 'temperature-total-flow',
  TEMP_DHW: 'temperature-dhw',
  TEMP_DHW_TARGET: 'temperature-dhw-target',
  DHW_SETPOINT: 'dhw-setpoint',
  DHW_SETBACK: 'dhw-setpoint-setback',
  DHW_PUSH: 'dhw-push',
  SECOND_GENERATOR: 'second-generator',
  E1: 'electric-heater-1',
  E2: 'electric-heater-2',
};

/** The roles of a heating circuit: `circuit-<n>-<suffix>`. */
export const CIRCUIT_FEATURES = {
  MODE: 'mode',
  PARTY_PAUSE: 'party-pause',
  SETPOINT_COMFORT: 'setpoint-comfort',
  SETPOINT_NORMAL: 'setpoint-normal',
  SETPOINT_SETBACK: 'setpoint-setback',
  TEMP_ROOM: 'temperature-room',
  TEMP_ROOM_TARGET: 'temperature-room-target',
  HUMIDITY: 'humidity',
  TEMP_FLOW: 'temperature-flow',
  TEMP_FLOW_TARGET: 'temperature-flow-target',
};

export const circuitRole = (circuit, suffix) => `circuit-${circuit}-${suffix}`;

/**
 * The bounds of the values written, never wider than weishaupt_modbus (room
 * 16-28 °C by 0.5) and the rule of the lot: hot water 5.5 °C up to the ceiling
 * of the configuration, 65 °C at most (DHW_CAP); the heat pump refuses more
 * than its own hot water maximum (installer setting, 60 °C from the factory,
 * WBB manual 83315301 § 6.7.4.5). The order the controller keeps (comfort >=
 * normal >= setback; hot water normal >= setback) is checked on the values
 * read just before the write.
 */
export const BOUNDS = {
  dhw: { min: 5.5, max: 65, step: 0.5 },
  room: { min: 16, max: 28, step: 0.5 },
};

/** The hot water ceiling of the configuration, in °C: never above 65 °C. */
export const DHW_CAP = { min: 30, max: 65, default: 65 };

export const ACTIONS = {
  TEST_CONNECTION: 'test_connection',
};

/** The poll interval of the configuration, in seconds (weishaupt_modbus: 30 s). */
export const POLL_INTERVAL = { min: 30, max: 3600, default: 60 };

/** The Modbus unit id (slave id) of the configuration. */
export const UNIT_ID = { min: 1, max: 247, default: 1 };

export const LIMITS = {
  /** Gladys: 300 states per minute for the whole integration. */
  statesPerMinute: 300,
  statesPerRequest: 100,
  /** Registers in one read (weishaupt_modbus groups 5 at most). */
  registersPerRead: 5,
  /**
   * EEPROM writes of the commands that are not protective nor a lower
   * setpoint, per register and rolling hour: refused beyond.
   */
  eepromWritesPerHour: 6,
  /** And per 24 h (kept in /data): 20 a day are 7,300 a year for 100,000 in a life. */
  eepromWritesPerDay: 20,
  /** Plausible ranges: a value outside is not a measure. */
  temperature: [-50, 120],
};

export const SECOND = 1_000;
export const MINUTE = 60 * SECOND;
export const HOUR = 60 * MINUTE;
export const DAY = 24 * HOUR;

export const TIMINGS = {
  /** Opening the TCP connection of a poll. */
  connectTimeout: 3 * SECOND,
  /** A session closed gracefully waits this long for the heat pump to close its side. */
  closeWait: 500,
  /** One answer. */
  requestTimeout: 2 * SECOND,
  /** A refused connection of a stop is tried again this often, until its deadline. */
  connectRetry: 250,
  /** Failed reads: 30 s, 1, 2, then 5 minutes, never shorter than the interval. */
  backoff: [30 * SECOND, MINUTE, 2 * MINUTE, 5 * MINUTE],
  /** The time of the last read goes to /data at most once a minute. */
  attemptWriteEvery: MINUTE,
  /** The publisher sends what is pending every second; unchanged states again every 30 min. */
  flushInterval: SECOND,
  stateHeartbeat: 30 * MINUTE,
  /** The "Test the connection" button never reads sooner than this after the last read. */
  testCooldown: 10 * SECOND,
  /**
   * Gladys waits 5 s for the ack: every click is answered by 3.5 s (a command
   * or a stop still running goes on, and the answer says what is known);
   * a stop is tried (connection refused, closed, timeout) until 3 s after
   * its start.
   */
  commandSendBy: 3_000,
  commandAnswerBy: 3_500,
  commandConnectMax: 2_000,
  commandReadMax: 1_500,
  commandMinRead: 300,
  commandMinSend: 300,
  /** A command waiting its turn (a scene setting several values) starts within 15 s, or never. */
  queueWindow: 15 * SECOND,
  /** The configuration could not be read from Gladys: tried again this often. */
  configRetry: 30 * SECOND,
  /**
   * The delay a written value may take to show in a read (not documented by
   * Weishaupt: taken wide). Reads after a command: 5 s, 25 s, 60 s.
   */
  applyDelay: 20 * SECOND,
  followUps: [5 * SECOND, 25 * SECOND, 60 * SECOND],
  /** A sent command keeps its guard until a read shows what it asked, or 2 min. */
  guard: 2 * MINUTE,
  /**
   * A stop not confirmed is held (in /data) until a read shows it, a newer
   * command to its register leaves, or another value is read twice in a row:
   * never lifted by the time. Checked every 15 s for 3 minutes, then every
   * minute (reads only); sent again while the value of before shows, three
   * times at most per click (EEPROM), then held without writing.
   */
  stopFastChecks: 3 * MINUTE,
  stopRetry: 15 * SECOND,
  stopSlowRetry: MINUTE,
  stopReasserts: 3,
  /** Another value read this many times in a row lifts a stop (changed at the heat pump). */
  stopOtherReads: 2,
  /** A check that gave its turn up to a click or a command is tried again this soon. */
  checkYield: SECOND,
  /** A stop sent again by a read leaves at least this long after the read closed the line. */
  reassertDelay: SECOND,
  /** Last values older than this are never sent again to Gladys (connected, device created). */
  freshFor: 2 * MINUTE,
};
