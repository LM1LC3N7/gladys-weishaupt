# Pompe à chaleur Weishaupt (Modbus TCP intégré)

Cette intégration affiche votre pompe à chaleur Weishaupt dans Gladys par son interface **Modbus TCP
intégrée**, sur votre réseau local, sans cloud. Si vous l’autorisez, elle peut aussi changer les modes
et les consignes et lancer une charge d’eau chaude forcée.

> **Jamais testé avec un vrai appareil.** L’intégration suit la liste de registres que Weishaupt a
> transmise aux utilisateurs de l’intégration Home Assistant `weishaupt_modbus` (telle que ce projet
> la conserve), et n’a été testée que contre une pompe simulée. Sans lien avec Weishaupt.

## Ce qu’il faut

- Une pompe à chaleur Weishaupt dont la régulation intègre **Modbus TCP** (WBB et autres modèles
  récents, selon le logiciel de la régulation). Les pompes qui n’offrent que le **module Modbus séparé
  de Weishaupt** ne sont **pas prises en charge** (autre produit, autre table de registres). Le portail
  Weishaupt WEM (cloud) n’est pas utilisé.
- **Modbus TCP activé** sur la pompe : « Utilisateur » → « Réglages » → « Modbus TCP », « Paramètre :
  Marche », et dans « Réseau » / « Masque » une plage qui contient l’adresse de Gladys (le plus sûr :
  n’autoriser que l’adresse IP de Gladys).
- Une adresse IP fixe pour la pompe (réservez-la dans votre box).
- Le Modbus TCP n’a **pas de mot de passe** : tout appareil autorisé peut lire et écrire les réglages
  de la pompe. Gardez-la sur un **réseau de confiance**, jamais exposée à Internet.

## Configuration

| Champ                          | Rôle                                                                                           |
| ------------------------------ | ---------------------------------------------------------------------------------------------- |
| Adresse IP de la pompe         | IPv4 ou nom d’hôte, port 502 sauf si vous en ajoutez un (`192.168.1.60:502`).                  |
| Identifiant d’unité Modbus     | 1.                                                                                             |
| Circuits de chauffage          | Les numéros de vos circuits, de 1 à 5, séparés par des virgules (`1` par défaut).              |
| Autoriser les commandes        | Désactivé par défaut (voir plus bas).                                                          |
| Plafond d’eau chaude (°C)      | La consigne d’eau chaude la plus haute que Gladys peut envoyer : 65 °C par défaut, 30 à 65 °C. |
| Intervalle de rafraîchissement | 60 s par défaut, de 30 s à 1 h.                                                                |
| Langue                         | Langue des noms de l’appareil, du statut et des messages.                                      |

Enregistrez, puis ajoutez la pompe depuis l’onglet **Découverte**. Le bouton « Tester la connexion »
relit la pompe, jamais plus souvent que l’intervalle.

## Ce que vous voyez

- Mode de fonctionnement du système (automatique, chauffage, rafraîchissement, été, veille, second
  générateur), état du système et état de la pompe (chauffage, eau chaude, dégivrage, veille, coupure
  du distributeur, hors-gel…, en textes stables comme `heating`, `hot-water`, `defrost`).
- Défaut (0/1), code d’erreur et code d’avertissement (`none`, ou le numéro du code en texte : à
  chercher dans la notice de la pompe).
- Demande de puissance (%), températures : extérieure, aspiration de l’air, départ et retour de la
  pompe, évaporation, gaz aspirés du compresseur, bouteille de découplage, eau chaude et consigne
  d’eau chaude en cours.
- Consignes d’eau chaude (normale, réduite) et charge d’eau chaude forcée (arrêt, ou 5 à 235 minutes).
- Second générateur et résistances électriques 1 et 2 (marche/arrêt), quand la pompe les donne.
- Pour chaque circuit configuré : mode, fête/pause (`automatic`, `pause-90-min`, `party-60-min`…),
  consignes ambiantes (confort, normale, réduite), température et humidité ambiantes, consigne
  ambiante en cours, températures de départ et de départ visée.

Une fonctionnalité apparaît dès qu’une valeur en a été lue. Les valeurs spéciales ne sont jamais
publiées comme des mesures : « pas de sonde » (0x8000) et « sonde défectueuse » (0x8001) sur une
température, 0xFFFF sur un pourcentage, un état hors de sa liste, une valeur hors plage. Un texte
(état, code) n’est jamais publié comme un nombre.

Non affichés : les statistiques d’énergie de la pompe (kWh du jour, du mois, de l’année : elles
repartent à zéro à chaque période, ce n’est pas un index de compteur), la puissance calorifique que
`weishaupt_modbus` calcule d’après la courbe d’un seul modèle, les entrées/sorties et les réglages
installateur.

## Les commandes

Désactivées par défaut. Avec « Autoriser les commandes », Gladys peut changer :

- le mode de fonctionnement du système (automatique, chauffage, rafraîchissement, été, second
  générateur) ;
- le mode d’un circuit configuré (automatique, confort, normal, réduit) ;
- les consignes ambiantes d’un circuit (confort, normale, réduite), de 16 à 28 °C par pas de 0,5 °C,
  en gardant confort ≥ normale ≥ réduite d’après la pompe relue juste avant ;
- les consignes d’eau chaude (normale, réduite), de 5,5 °C jusqu’au plus bas de 60 °C (la pompe), du
  plafond de la configuration et de 65 °C, par pas de 0,5 °C, en gardant normale ≥ réduite. **Rien
  au-dessus de 65 °C n’est jamais envoyé**, quoi qu’il soit saisi ;
- la charge d’eau chaude forcée (5 à 235 minutes).

Chaque commande relit d’abord les valeurs actuelles sur la pompe, n’écrit rien si c’est déjà bon,
puis relit la valeur écrite : elle ne réussit que si la relecture montre la valeur demandée. Sinon
Gladys répond « envoyée, sans confirmation » et relit la pompe 5 s, 25 s et 60 s après.

Une commande est refusée, rien n’est envoyé, quand : l’option est désactivée (vérifiée aussi juste
avant l’écriture), la valeur est hors limites, au-dessus du plafond ou casse l’ordre des consignes, le
circuit n’est pas dans la configuration, les valeurs actuelles n’ont pas pu être relues, la
configuration a changé entre-temps, un arrêt est parti après son arrivée, un arrêt envoyé à cette pompe
n’est pas encore confirmé (seul un nouveau choix sur ce même réglage part alors), 16 commandes
attendent déjà, ou ce réglage a déjà été changé 6 fois dans la dernière heure. Cette dernière limite
protège la mémoire de la pompe, qui garde ces réglages avec un nombre d’écritures limité ; elle ne
s’applique jamais à une baisse de consigne ni à un arrêt.

Les commandes partent une à une, dans l’ordre d’arrivée, sur une seule connexion. Une scène qui règle
plusieurs valeurs les règle toutes : une commande qui attend encore son tour après 3,5 s reçoit la
réponse « en attente » et part dans les 15 s qui suivent le clic, ou pas du tout.

## Les arrêts

Mettre le mode du système sur **Veille**, un circuit sur **Veille** ou la charge forcée sur **Arrêt**
ne dépend pas de l’option des commandes, des bornes, d’une lecture en cours ou en échec, d’une pompe
pas encore lue, ni d’une commande en attente. Un arrêt passe avant tout ; toute commande arrivée avant
lui et pas encore partie est abandonnée. Une connexion refusée est retentée toutes les 250 ms pendant
3 s ; Gladys reçoit sa réponse en 3,5 s au plus.

Un arrêt non confirmé est **tenu** dans `/data` (avec la valeur d’avant) jusqu’à ce qu’une lecture le
montre : il n’est pas abandonné au bout d’un temps. L’intégration vérifie la pompe toutes les 15 s
pendant 3 minutes, puis toutes les minutes, quel que soit l’intervalle : un arrêt qui n’a pas pu partir
est retenté à chaque vérification ; un arrêt écrit mais pas encore visible est renvoyé tant que la pompe
montre la valeur d’avant (au moins 20 s après la dernière écriture ; trois fois, puis une fois toutes
les 10 minutes au plus, chacune étant une écriture dans la mémoire de la pompe). Une vérification
n’interrompt jamais une commande ; un nouveau clic sur un arrêt interrompt une vérification et est
écrit puis relu comme tout clic. Après un redémarrage, la vérification part tout de suite, avant même la
lecture de la configuration. Les arrêts ne sont jamais limités par le quota horaire des commandes.

Tant qu’un arrêt est tenu, les autres commandes vers la même pompe sont refusées.

Un arrêt peut échouer ou ne plus être tenu dans ces cas :

- aucune adresse valide dans la configuration (ou, avant la lecture de la configuration, aucune pompe
  lue auparavant) : refusé, rien n’est envoyé ;
- la pompe reste injoignable pendant 3 s : « non envoyée », puis retenté à chaque vérification jusqu’à
  ce qu’il puisse partir ;
- la pompe répond une exception Modbus : « refusée » ou « envoyée, sans confirmation » selon le code ;
- la relecture ne montre pas encore l’arrêt : « envoyée, sans confirmation », puis tenu ;
- il n’est plus tenu dès qu’une lecture le montre, dès qu’une commande Gladys plus récente sur le même
  réglage est partie (un clic avec l’option activée), dès que deux lectures de suite montrent une autre
  valeur que celle d’avant l’arrêt (réglée sur la pompe ; pour un arrêt cliqué avant toute lecture, la
  première valeur lue après lui est la valeur d’avant), ou dès que la configuration désigne une autre
  pompe (adresse, port ou identifiant d’unité) ;
- un arrêt de `/data` daté dans le futur (horloge reculée) : invalide, il n’est pas rejoué.

Gladys ne relance jamais la pompe d’elle-même.

## Limites connues

- Pas de numéro de série en Modbus : l’appareil est lié à l’intégration, pas à l’adresse IP (changer
  l’adresse garde l’appareil et son historique), et un autre appareil Modbus à la même adresse ne
  serait pas détecté.
- La liste de registres vient de `weishaupt_modbus` ; la copie partagée de Weishaupt n’est plus
  publique et n’a donc pas pu être relue pour le logiciel actuel. Le délai d’application d’une valeur
  écrite n’est pas documenté (l’intégration attend 20 s avant de renvoyer un arrêt).
- Deux clients Modbus à la fois (Home Assistant et Gladys) peuvent ne pas être acceptés par la pompe.
