// -----------------------------------------------------------------------------
// Runtime texts (English and French): device, feature and mode names, the
// status of the integration, the answers of the button and the command errors.
// -----------------------------------------------------------------------------

import { CIRCUIT_FEATURES as CF, FEATURES as F } from './constants.js';

const both = (en, fr) => ({ en, fr });

/** One language of a `{ en, fr }` text. */
export const word = (value, language) => (language === 'en' ? value.en : value.fr);

/** Two texts one after the other, in both languages. */
export const join = (a, b) => both(`${a.en} ${b.en}`, `${a.fr} ${b.fr}`);

/** "45 s", "5 min", "2 h", in both languages. */
export function age(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  if (seconds < 90) return both(`${seconds} s`, `${seconds} s`);
  const minutes = Math.round(seconds / 60);
  if (minutes < 90) return both(`${minutes} min`, `${minutes} min`);
  const hours = Math.round(minutes / 60);
  return both(`${hours} h`, `${hours} h`);
}

export const DEVICE_NAME = both('Weishaupt heat pump', 'Pompe à chaleur Weishaupt');

export const FEATURE_NAMES = {
  [F.SYSTEM_MODE]: both('System operating mode', 'Mode de fonctionnement du système'),
  [F.OPERATING_STATE]: both('System state', 'État du système'),
  [F.HEAT_PUMP_STATE]: both('Heat pump state', 'État de la pompe à chaleur'),
  [F.FAULT]: both('Fault', 'Défaut'),
  [F.ERROR_CODE]: both('Error code', 'Code d’erreur'),
  [F.WARNING_CODE]: both('Warning code', 'Code d’avertissement'),
  [F.POWER_DEMAND]: both('Power demand (%)', 'Demande de puissance (%)'),
  [F.TEMP_OUTDOOR]: both('Outdoor temperature', 'Température extérieure'),
  [F.TEMP_OUTDOOR_2]: both('Outdoor temperature 2', 'Température extérieure 2'),
  [F.TEMP_FLOW]: both('Heat pump flow temperature', 'Température de départ de la PAC'),
  [F.TEMP_RETURN]: both('Heat pump return temperature', 'Température de retour de la PAC'),
  [F.TEMP_HYDRAULIC_SWITCH]: both(
    'Hydraulic switch temperature',
    'Température de la bouteille de découplage',
  ),
  [F.TEMP_REGENERATIVE]: both('Regenerative temperature', 'Température régénérative'),
  [F.TEMP_BUFFER]: both('Buffer tank temperature', 'Température du ballon tampon'),
  [F.TEMP_TOTAL_FLOW]: both('Total flow temperature (B7)', 'Température de départ commune (B7)'),
  [F.TEMP_DHW]: both('Hot water temperature', 'Température de l’eau chaude'),
  [F.TEMP_DHW_TARGET]: both('Hot water target in force', 'Consigne d’eau chaude en cours'),
  [F.DHW_SETPOINT]: both('Hot water setpoint (normal)', 'Consigne d’eau chaude (normale)'),
  [F.DHW_SETBACK]: both('Hot water setpoint (setback)', 'Consigne d’eau chaude (réduite)'),
  [F.DHW_PUSH]: both('Hot water push', 'Charge d’eau chaude forcée'),
  [F.SECOND_GENERATOR]: both('Second heat generator on', 'Second générateur en marche'),
  [F.E1]: both('Electric heater 1 on', 'Résistance électrique 1 en marche'),
  [F.E2]: both('Electric heater 2 on', 'Résistance électrique 2 en marche'),
};

export const CIRCUIT_FEATURE_NAMES = {
  [CF.MODE]: both('mode', 'mode'),
  [CF.PARTY_PAUSE]: both('party / pause', 'fête / pause'),
  [CF.SETPOINT_COMFORT]: both('room setpoint (comfort)', 'consigne ambiante (confort)'),
  [CF.SETPOINT_NORMAL]: both('room setpoint (normal)', 'consigne ambiante (normale)'),
  [CF.SETPOINT_SETBACK]: both('room setpoint (setback)', 'consigne ambiante (réduite)'),
  [CF.TEMP_ROOM]: both('room temperature', 'température ambiante'),
  [CF.TEMP_ROOM_TARGET]: both('room target in force', 'consigne ambiante en cours'),
  [CF.HUMIDITY]: both('room humidity', 'humidité ambiante'),
  [CF.TEMP_FLOW]: both('flow temperature', 'température de départ'),
  [CF.TEMP_FLOW_TARGET]: both('flow target temperature', 'température de départ visée'),
};

/** "Heating circuit 1: mode". */
export const circuitFeatureName = (circuit, suffix) =>
  both(
    `Heating circuit ${circuit}: ${CIRCUIT_FEATURE_NAMES[suffix].en}`,
    `Circuit de chauffage ${circuit} : ${CIRCUIT_FEATURE_NAMES[suffix].fr}`,
  );

const SYSTEM_MODE_TEXTS = {
  automatic: both('Automatic', 'Automatique'),
  heating: both('Heating', 'Chauffage'),
  cooling: both('Cooling', 'Rafraîchissement'),
  summer: both('Summer (hot water only)', 'Été (eau chaude seulement)'),
  standby: both('Standby (stopped)', 'Veille (arrêt)'),
  'second-generator': both('Second heat generator', 'Second générateur'),
};

/** The name of a system mode (register 40001). */
export const SYSTEM_MODE_NAMES = (key) => SYSTEM_MODE_TEXTS[key];

const CIRCUIT_MODE_TEXTS = {
  automatic: both('Automatic (time program)', 'Automatique (programme horaire)'),
  comfort: both('Comfort', 'Confort'),
  normal: both('Normal', 'Normal'),
  setback: both('Setback', 'Réduit'),
  standby: both('Standby (stopped)', 'Veille (arrêt)'),
};

/** The name of a heating circuit mode (registers 41x03). */
export const CIRCUIT_MODE_NAMES = (key) => CIRCUIT_MODE_TEXTS[key];

/** The name of a hot water push choice (register 42102): "Off", "30 min". */
export const DHW_PUSH_NAMES = (key) =>
  key === 'off' ? both('Off', 'Arrêt') : both(key.replace('-', ' '), key.replace('-', ' '));

/** The integration status and the answers of the button. */
export const T = {
  noHost: both(
    'Enter the IP address of your Weishaupt heat pump (built-in Modbus TCP), then save.',
    'Saisissez l’adresse IP de votre pompe à chaleur Weishaupt (Modbus TCP intégré), puis enregistrez.',
  ),
  invalid: (length) =>
    both(
      `Invalid address (${length} characters): an IPv4 address or a host name, optionally with a port.`,
      `Adresse invalide (${length} caractères) : une adresse IPv4 ou un nom d’hôte, avec un port si besoin.`,
    ),
  badUnitId: both(
    'Invalid Modbus unit id: a whole number from 1 to 247 (1 on a Weishaupt heat pump). Nothing is read.',
    'Identifiant d’unité Modbus invalide : un nombre entier de 1 à 247 (1 sur une pompe à chaleur Weishaupt). Rien n’est lu.',
  ),
  badCircuits: both(
    'Heating circuits: only the numbers 1 to 5 are read (for example "1, 2"); the rest was ignored.',
    'Circuits de chauffage : seuls les numéros 1 à 5 sont lus (par exemple « 1, 2 ») ; le reste a été ignoré.',
  ),
  configUnreadable: both(
    'The configuration could not be read from Gladys: tried again every 30 s. A stop (standby, circuit standby, push off) still goes to the last heat pump read.',
    'La configuration n’a pas pu être lue depuis Gladys : nouvel essai toutes les 30 s. Un arrêt (veille, circuit en veille, charge forcée arrêtée) part quand même vers la dernière pompe à chaleur lue.',
  ),
  connecting: both('Reading the heat pump…', 'Lecture de la pompe à chaleur…'),
  waiting: (wait) =>
    both(
      `Next read of the heat pump in ${wait.en} (never sooner than the refresh interval).`,
      `Prochaine lecture de la pompe à chaleur dans ${wait.fr} (jamais avant l’intervalle de rafraîchissement).`,
    ),
  lastRead: (ago) => both(`Last read ${ago.en} ago.`, `Dernière lecture il y a ${ago.fr}.`),
  connected: (summary) => both(`Connected. ${summary.en}`, `Connecté. ${summary.fr}`),
  unreachable: (address, wait) =>
    both(
      `No answer from ${address} (next try in ${wait.en}). Check the address, that "Modbus TCP" is on (User > Settings > Modbus TCP) with the address of Gladys in its allowed network, and the Modbus unit id.`,
      `Pas de réponse de ${address} (nouvel essai dans ${wait.fr}). Vérifiez l’adresse, que « Modbus TCP » est activé (Utilisateur > Réglages > Modbus TCP) avec l’adresse de Gladys dans le réseau autorisé, et l’identifiant d’unité Modbus.`,
    ),
  failing: (reason, wait) =>
    both(
      `The heat pump answered badly (${reason}); next try in ${wait.en}.`,
      `La pompe à chaleur a mal répondu (${reason}) ; nouvel essai dans ${wait.fr}.`,
    ),
  missingBlocks: (names) => both(`Not read this time: ${names}.`, `Non lus cette fois : ${names}.`),
  summary: (values) => {
    const mode = values.systemMode
      ? SYSTEM_MODE_NAMES(values.systemMode)
      : both('unknown mode', 'mode inconnu');
    const fault = values.fault === 1 ? both(', FAULT', ', DÉFAUT') : both('', '');
    return both(
      `Weishaupt: ${mode.en.toLowerCase()}${fault.en}.`,
      `Weishaupt : ${mode.fr.toLowerCase()}${fault.fr}.`,
    );
  },
};

/** The errors a command answers to Gladys. */
export const ERRORS = {
  readOnly: both('This feature is read only.', 'Cette fonctionnalité est en lecture seule.'),
  badValue: both('Unknown value: not sent.', 'Valeur inconnue : non envoyée.'),
  notWritable: both(
    'This mode is shown only, Gladys never sets it: not sent.',
    'Ce mode est seulement affiché, Gladys ne le règle jamais : non envoyé.',
  ),
  stopHeld: both(
    'A stop sent to the heat pump is not confirmed yet: only a stop or a new choice on the stopped setting is sent meanwhile. Not sent.',
    'Un arrêt envoyé à la pompe à chaleur n’est pas encore confirmé : seul un arrêt ou un nouveau choix sur le réglage arrêté part en attendant. Non envoyée.',
  ),
  order: both(
    'The setpoints must keep their order (comfort ≥ normal ≥ setback, hot water normal ≥ setback): not sent.',
    'Les consignes doivent garder leur ordre (confort ≥ normale ≥ réduite, eau chaude normale ≥ réduite) : non envoyée.',
  ),
  badNumber: both('Not a number: not sent.', 'Ce n’est pas un nombre : non envoyé.'),
  badStep: (step) =>
    both(`Steps of ${step} °C only: not sent.`, `Par pas de ${step} °C seulement : non envoyé.`),
  outOfRange: (min, max) =>
    both(
      `Out of range (${min} to ${max} °C): not sent.`,
      `Hors limites (${min} à ${max} °C) : non envoyé.`,
    ),
  dhwCap: (cap) =>
    both(
      `Above the hot water ceiling of the configuration (${cap} °C, 65 °C at most): not sent.`,
      `Au-dessus du plafond d’eau chaude de la configuration (${cap} °C, 65 °C au plus) : non envoyé.`,
    ),
  disabled: both(
    'Commands are disabled: turn on "Allow the commands" in the configuration of the integration.',
    'Les commandes sont désactivées : activez « Autoriser les commandes » dans la configuration de l’intégration.',
  ),
  noHost: both(
    'No valid address or Modbus unit id in the configuration: not sent.',
    'Aucune adresse ou identifiant d’unité Modbus valide dans la configuration : non envoyée.',
  ),
  noCircuit: both(
    'This heating circuit is not in the configuration any more: not sent.',
    'Ce circuit de chauffage n’est plus dans la configuration : non envoyée.',
  ),
  quota: (count) =>
    both(
      `Already ${count} changes of this setting in the last hour: the heat pump keeps it in a memory with limited write cycles. Not sent; try again later.`,
      `Déjà ${count} changements de ce réglage dans la dernière heure : la pompe à chaleur le garde dans une mémoire à nombre d’écritures limité. Non envoyée ; réessayez plus tard.`,
    ),
  quotaDay: (count) =>
    both(
      `Already ${count} changes of this setting in the last 24 hours: the heat pump keeps it in a memory with limited write cycles (100,000 in its life). Not sent; try again tomorrow.`,
      `Déjà ${count} changements de ce réglage dans les dernières 24 heures : la pompe à chaleur le garde dans une mémoire à nombre d’écritures limité (100 000 sur sa vie). Non envoyée ; réessayez demain.`,
    ),
  stopNotSent: (reason) =>
    both(
      `The heat pump could not be reached (${reason}): stop not sent yet, it is tried again at every check until the heat pump answers.`,
      `La pompe à chaleur n’a pas pu être jointe (${reason}) : arrêt pas encore envoyé, il est retenté à chaque vérification jusqu’à ce que la pompe réponde.`,
    ),
  unknownValue: both(
    'The current value could not be read just before: command not sent.',
    'La valeur actuelle n’a pas pu être relue juste avant : commande non envoyée.',
  ),
  stopPending: both(
    'Stop not sent yet, still trying to reach the heat pump: check its state in a few seconds.',
    'Arrêt pas encore envoyé, la pompe à chaleur est encore en cours de connexion : vérifiez son état dans quelques secondes.',
  ),
  configChanged: both(
    'The configuration changed meanwhile: not sent.',
    'La configuration a changé entre-temps : non envoyée.',
  ),
  busy: both(
    '16 commands to the heat pump are already waiting: not sent.',
    '16 commandes vers la pompe à chaleur attendent déjà : non envoyée.',
  ),
  protectMeanwhile: both(
    'A stop was sent meanwhile: not sent.',
    'Un arrêt a été envoyé entre-temps : non envoyée.',
  ),
  tooSlow: both(
    'The heat pump answered too slowly to send the command in time: not sent.',
    'La pompe à chaleur a répondu trop lentement pour envoyer la commande à temps : non envoyée.',
  ),
  unknownState: (reason) =>
    both(
      `The current value could not be read just before (${reason}): command not sent.`,
      `La valeur actuelle n’a pas pu être relue juste avant (${reason}) : commande non envoyée.`,
    ),
  refused: (reason) =>
    both(
      `The heat pump refused the command (${reason}): not applied.`,
      `La pompe à chaleur a refusé la commande (${reason}) : non appliquée.`,
    ),
  notSent: (reason) =>
    both(
      `The heat pump could not be reached (${reason}): command not sent.`,
      `La pompe à chaleur n’a pas pu être jointe (${reason}) : commande non envoyée.`,
    ),
  sentUnconfirmed: (reason) =>
    both(
      `Command sent, without confirmation (${reason}): check the state of the heat pump in a minute.`,
      `Commande envoyée, sans confirmation (${reason}) : vérifiez l’état de la pompe à chaleur dans une minute.`,
    ),
  queued: both(
    'Command waiting its turn behind other commands (a scene): it is sent within 15 s of the click, or not at all; check the state of the heat pump in a few seconds.',
    'Commande en attente derrière d’autres commandes (une scène) : elle part dans les 15 s qui suivent le clic, ou pas du tout ; vérifiez l’état de la pompe à chaleur dans quelques secondes.',
  ),
  noAnswerYet: both('no answer yet', 'pas encore de réponse'),
  readBackDiffers: both(
    'the value read back is not the one asked',
    'la valeur relue n’est pas celle demandée',
  ),
};
