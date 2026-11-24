# Québec en mouvement

<p align="center">
  <img src="docs/images/banniere.svg" alt="Québec en mouvement : une journée de transport rejouée sur les vraies rues de Québec" width="100%">
</p>

<p align="center">
  <a href="https://toonight.github.io/quebec-en-mouvement/"><img alt="Ouvrir le simulateur" src="https://img.shields.io/badge/Ouvrir_le_simulateur-ffc83d?style=for-the-badge"></a>
</p>

<p align="center">
  <a href="https://github.com/toonight/quebec-en-mouvement/actions/workflows/pages.yml"><img alt="Tests et publication" src="https://github.com/toonight/quebec-en-mouvement/actions/workflows/pages.yml/badge.svg"></a>
  <img alt="Licence MIT" src="https://img.shields.io/badge/licence-MIT-3ecf8e?labelColor=14202f">
  <img alt="Site statique, aucune installation" src="https://img.shields.io/badge/site_statique-aucune_installation-52b6ff?labelColor=14202f">
  <img alt="Carte : MapLibre et deck.gl" src="https://img.shields.io/badge/carte-MapLibre_%2B_deck.gl-ff5c93?labelColor=14202f">
  <img alt="Données publiques" src="https://img.shields.io/badge/donn%C3%A9es-publiques-cdd8e6?labelColor=14202f">
</p>

Simulateur citoyen du transport à Québec. Une journée de semaine est rejouée sur le réseau
routier réel, et vous choisissez ce qui roule sur le tracé du tramway. Le simulateur montre
la circulation, l'achalandage, la rentabilité pour l'exploitant et le bilan pour la société.

> [!IMPORTANT]
> **Ce n'est pas une étude officielle.** C'est un projet citoyen indépendant, sans lien avec
> la Ville de Québec, CDPQ Infra, le RTC ou Tesla. Le modèle est calé sur des données
> publiques et sert à comparer des ordres de grandeur. Toutes les hypothèses sont affichées
> dans l'application (« Hypothèses et sources ») et se modifient dans
> `web/js/engine/core.js` et `web/js/engine/econ.js`.

## 🚋 Quatre choix pour le même tracé

Un seul mode à la fois. Le tramway et les autobus roulent seuls sur leur voie réservée ;
les Cybercab n'ont pas de voie et roulent avec les autos. Chaque mode garde sa couleur partout
dans l'application.

| | Sur le tracé | Ce qui est simulé |
|---|---|---|
| ![Tramway](https://img.shields.io/badge/Tramway-ffc83d?style=flat-square) | Tramway TramCité | Rames de 240 places aux 4 minutes en pointe, tunnel sous la colline Parlementaire |
| ![Bus](https://img.shields.io/badge/Bus-52b6ff?style=flat-square) | Bus en voies réservées | Bus articulés de 105 places aux 2 min 30 en pointe, en surface sur tout le trajet |
| ![Cybercab](https://img.shields.io/badge/Cybercab-ff5c93?style=flat-square) | Cybercab (sans ligne) | Robotaxis à deux places dans la circulation générale, sans voie réservée : les autos gardent toutes leurs voies |
| ![Rien](https://img.shields.io/badge/Rien-cdd8e6?style=flat-square) | Rien (aujourd'hui) | La situation de référence, calée sur les comptages |

Les Cybercab desservent le corridor du tracé ou toute la ville, avec des courses partagées et une
part des déplacements automobiles faits sans auto. Les trois modes ne se combinent pas.

## Résultats simulés des trois modes

Un seul mode à la fois : le tramway, les autobus en voies réservées ou les Cybercab (sans ligne).
Ils ne se combinent pas. Les Cybercab n'ont pas de voie réservée : ils roulent dans la circulation
générale, soit le long du tracé (corridor), soit dans toute la ville (réseau élargi).

Chaque scénario rejoue la même demande de déplacements, de 5 h à 5 h (graine `20261119`), avec les
coûts par défaut, hors hiver, sans déplacements imposés sans auto et sans courses partagées.

| Scénario | Passagers par jour | Résultat de l’exploitant (M$/an) | Bilan pour la société (M$/an) | CO₂ évité (t/j) |
|---|---:|---:|---:|---:|
| Tramway | 75 570 | −372,6 | −367,9 | 30,8 |
| Autobus en voies réservées | 56 740 | −73,6 | −79,2 | 10,4 |
| Cybercab, corridor, 500 véhicules | 26 030 | +21,9 | +28,8 | 5,3 |
| Cybercab, réseau élargi, 1 500 véhicules | 52 035 | +46,4 | +70,7 | 14,0 |
| Cybercab, réseau élargi, 3 000 véhicules | 58 895 | +31,2 | +58,9 | 16,6 |
| Cybercab, réseau élargi, 6 000 véhicules | 64 040 | −14,5 | +20,4 | 18,7 |

Les passagers sont les montées sur la ligne pour le tramway et les autobus, et les passagers
transportés pour les Cybercab. Les montants sont en millions de dollars canadiens par an, sur
300 journées équivalentes. Le résultat de l’exploitant déduit des recettes l’exploitation et
l’investissement étalé sur sa durée de vie. Le bilan pour la société ajoute les effets sur les
voyageurs, les automobilistes, les recettes du RTC et le CO₂.

Le tramway et les autobus perdent de l’argent pour l’exploitant, à cause de l’investissement.
Avant l’investissement, leur exploitation est légèrement positive.
- Tramway : 7,6 G$ étalés sur 40 ans font 384 M$ par an, pour 57 M$ de recettes et 46 M$
  d’exploitation (+11 M$ par an avant l’investissement).
- Autobus : 1,4 G$ étalés sur 30 ans font 81 M$ par an, pour 43 M$ de recettes et 36 M$
  d’exploitation (+7 M$ par an avant l’investissement).

Les Cybercab, au prix annoncé par Tesla et aux coûts de dépôt et de recharge estimés, sont rentables pour l’exploitant jusqu’à 3 000 véhicules.
Sans voie à construire, l’investissement porte sur quatre postes, chacun étalé sur sa durée de vie :
les véhicules (42 000 $ chacun, 5 ans), les bornes (125 000 $ chacune, 10 ans), le raccordement
électrique (300 $ par kW de bornes, 40 ans) et les dépôts (terrain, stationnement sur 20 ans et
bâtiment sur 40 ans). Le nombre de bornes vient de la simulation : la pointe de véhicules en
recharge au même moment, plus 20 %.

| Scénario Cybercab | Véhicules | Bornes | Raccordement | Dépôts | Investissement total |
|---|---:|---:|---:|---:|---:|
| Corridor, 500 véhicules | 21,0 M$ | 18 bornes, 2,3 M$ | 0,8 M$ | 1 dépôt, 13,9 M$ | 37,9 M$ |
| Réseau élargi, 3 000 véhicules | 126,0 M$ | 30 bornes, 3,8 M$ | 1,4 M$ | 1 dépôt, 83,2 M$ | 214,3 M$ |

Le nombre de bornes est probablement sous-estimé : 1 borne pour 100 véhicules à 3 000 véhicules,
alors que l’étude des taxis de New York de 2013 en recommandait 1 pour 13 (voir les limites).

Les dépôts pèsent lourd à l’achat (environ 27 700 $ par véhicule), mais s’étalent sur 20 à 40 ans.
L’investissement étalé reste donc proche de l’ancien forfait : environ 11 100 $ par véhicule et
par an à 3 000 véhicules. L’exploitation compte à part l’électricité au tarif M d’Hydro-Québec
(avec la prime de puissance), l’entretien des bornes, la supervision à distance, le nettoyage et les
taxes foncières du dépôt. La supervision à distance (1 agent pour 40 véhicules) est comptée sur les
seules heures de roulage, une hypothèse : comptée sur toute la flotte en service, elle coûterait
environ 16 M$ par an au lieu de 2,4 M$ à 3 000 véhicules. Les sources et les hypothèses de chaque poste sont dans l’application,
sous « Hypothèses et sources ».
- Corridor, 500 véhicules : 37 M$ de recettes, 10 M$ d’exploitation et 6 M$ d’investissement par an.
- Réseau élargi, 1 500 véhicules : 90 M$ de recettes, 26 M$ d’exploitation et 17 M$ d’investissement,
  le meilleur résultat des quatre.
- Au-delà, les passagers augmentent peu (+13 % de 1 500 à 3 000 véhicules, +9 % de 3 000 à 6 000)
  alors que l’investissement double à chaque fois : 33 M$ par an à 3 000 véhicules, 66 M$ à 6 000,
  et l’exploitation passe de 38 à 61 M$ par an.

Pour la société, les Cybercab font perdre du temps aux automobilistes (de 8 à 13 M$ par an) :
ils roulent dans les mêmes rues, et une partie de leurs kilomètres se fait à vide. Le tramway et
les autobus leur en font gagner (16 et 8 M$ par an). Les Cybercab prennent aussi des usagers
au réseau d’autobus actuel, ce qui lui coûte de 9 à 23 M$ de recettes par an.

### Effet du prix perçu au moment du choix

Le tarif des Cybercab est de 3,50 $ par course plus 1,20 $/km. Par défaut, le voyageur choisit son
mode sur le prix entier de la course. La variante le fait choisir sur le prix divisé par 1,4,
l’occupation moyenne supposée : pour un trajet estimé à 10 km, 11,07 $ au lieu de 15,50 $.
Dans les deux cas, la course rapporte 15,50 $ à l’exploitant.

| Scénario Cybercab | Passagers par jour, prix entier | Passagers par jour, prix par occupant | Exploitant, prix entier (M$/an) | Exploitant, prix par occupant (M$/an) |
|---|---:|---:|---:|---:|
| Corridor, 500 véhicules | 26 030 | 37 720 | +21,9 | +41,7 |
| Réseau élargi, 1 500 véhicules | 52 035 | 86 430 | +46,4 | +126,3 |
| Réseau élargi, 3 000 véhicules | 58 895 | 110 285 | +31,2 | +149,1 |

Choisi au prix par occupant, le Cybercab attire de 45 à 87 % de passagers en plus et son résultat
pour l’exploitant est de 1,9 à 4,8 fois plus élevé. Avec ce choix, 3 000 véhicules font mieux
que 1 500 (+149,1 contre +126,3 M$ par an) : la demande, plus forte, occupe la flotte plus grande.
Cette sensibilité au prix perçu s’ajoute à l’incertitude sur les coûts d’exploitation des Cybercab,
qui suivent les cibles de Tesla.

Les tableaux se reproduisent avec cette commande depuis la racine du dépôt.

```powershell
node tests/econ_report.js --modes
```

Dans l’application, ouvrir **Comparer les journées simulées**, simuler une journée avec des Cybercab,
puis sélectionner **Comparer le prix de la course entière et le prix par occupant**.

## 📆 Bilan sur un an

Les montants ci-dessus multiplient le jour type d’automne par 300. Le bouton **Bilan sur un an**
(dans **Comparer les journées simulées**) fait un vrai bilan de l’année 2026 ou 2027 pour le scénario
en cours. Chaque jour de l’année est rangé dans une des 12 journées types. Chaque type est simulé
une fois, à une date représentative, puis compté autant de fois qu’il a de jours.

| Journée type | Date simulée en 2027 | Jours en 2026 | Jours en 2027 | Facteur de la journée |
|---|---|---:|---:|---:|
| Jour ouvrable d’automne (septembre à novembre) | 18 octobre | 63 | 63 | 1,00 |
| Jour ouvrable d’hiver (janvier et février) | 1er février | 39 | 38 | 0,91 |
| Jour ouvrable d’hiver chargé (mars, 1er au 20 décembre) | 9 décembre | 36 | 36 | 0,95 |
| Jour ouvrable de printemps (avril à juin) | 14 mai | 62 | 63 | 1,04 |
| Jour ouvrable d’été (juillet et août, rentrée comprise) | 23 août | 33 | 33 | 1,03 |
| Vacances de la construction | 30 juillet | 10 | 10 | 0,98 |
| Jour ouvrable des Fêtes (21 au 31 décembre, 2 au 5 janvier) | 23 décembre | 7 | 9 | 0,77 |
| Samedi d’hiver (décembre à mars) | 27 février | 16 | 15 | 0,80 |
| Samedi d’avril à novembre | 14 août | 35 | 35 | 0,90 |
| Dimanche d’hiver (décembre à mars) | 21 février | 17 | 16 | 0,72 |
| Dimanche d’avril à novembre | 8 août | 35 | 35 | 0,80 |
| Jour férié ou chômé | 31 décembre | 12 | 12 | 0,71 |
| **Total** | | **365** | **365** | |

La date représentative est celle dont le facteur est le plus proche de la moyenne du type. Le jour
ouvrable d’hiver chargé fait exception : il prend un jour de décembre à 0,95, la journée la plus
chargée de son type (ce qui sous-représente un peu les jours de mars : environ −0,7 % sur le bilan
pour la société dans le corridor avec 500 Cybercab, estimé sur un seul jour de mars). Les dates de 2026 ont les mêmes facteurs, voies réservées et horaires que
celles de 2027 : les 12 journées simulées sont les mêmes, seuls les poids changent.

Comment l’année est comptée :

- Les recettes, l’exploitation au kilomètre, la supervision, le nettoyage et les effets sur les
  voyageurs, les automobilistes, le CO₂ et le RTC s’additionnent journée par journée.
- L’investissement étalé, les coûts fixes, l’entretien des dépôts et des bornes, les taxes et la
  prime de puissance ne sont comptés qu’une fois par an.
- Cybercab : les bornes et la prime de puissance sont dimensionnées sur la plus forte pointe de
  recharge des 12 journées, un jour d’hiver (le 9 décembre à 3 000 véhicules sur le réseau élargi,
  le 1er février à 500 véhicules dans le corridor). L’électricité suit les tranches du tarif M sur les kWh
  de l’année.
- Le temps des automobilistes de chaque journée type est comparé à la situation actuelle du même
  jour (aucune ligne, aucune flotte), simulée à la même date.
- La case « Journée d’hiver » n’y sert pas : la saison vient de la date de chaque journée type.

Résultats en 2027, en M$ par an, avec la même demande et les coûts par défaut :

| Scénario | Exploitant, jour type × 300 | Exploitant, bilan sur un an | Société, jour type × 300 | Société, bilan sur un an | Bornes, jour type / un an |
|---|---:|---:|---:|---:|---:|
| Tramway | −372,6 | −372,8 | −367,9 | −367,4 | – |
| Autobus en voies réservées | −73,6 | −73,5 | −79,2 | −78,7 | – |
| Cybercab, corridor, 500 véhicules | +21,9 | +25,9 | +28,8 | +37,8 | 18 / 35 |
| Cybercab, réseau élargi, 3 000 véhicules | +31,2 | +40,0 | +58,9 | +77,8 | 30 / 52 |

En 2026, les résultats diffèrent de ceux de 2027 de moins de 0,1 M$ par an.

Pour le tramway et les autobus, le × 300 tombait presque juste. Pour les Cybercab, le bilan sur un
an dépasse le × 300 de 18 à 28 % pour l’exploitant et d’environ 31 % pour la société (écart rapporté
au × 300, comme dans la page). Le × 300 compte
300 jours ouvrables d’automne ; l’année en compte 365, dont des fins de semaine qui rapportent
aussi aux Cybercab, et un printemps et un été plus chargés. Les bornes, elles, augmentent : la pointe
de recharge d’hiver en demande de 70 à 95 % de plus que celle de l’automne.

Précision mesurée : en 2027, les 365 jours ont été simulés un par un pour le tramway et pour
3 000 Cybercab sur le réseau élargi. L’écart des 12 journées types avec cette somme est de
−0,04 % pour l’exploitant et +0,1 % pour la société avec le tramway, de −0,5 % et +1,4 % avec les
Cybercab. Pour les autres scénarios, l’écart n’est pas mesuré : environ 2 %, en ordre de grandeur,
et jusqu’à environ 5 % pour le bilan pour la société des Cybercab (voir les limites).

Limites :

- Une seule journée par type, avec la même graine : selon la date retenue dans chaque type, le
  bilan pour la société des Cybercab varierait d’environ 5 %.
- Le jour de l’An (0,48) et Noël (0,56) sont représentés par le 31 décembre (0,71). L’effet sur
  l’année reste sous 0,1 M$.
- Du 28 au 30 décembre, la ligne roule à l’horaire du samedi, mais leur journée type (le 23 décembre)
  a l’horaire de semaine. Le Vendredi saint n’a pas de voies réservées, son type en a.
- La pointe des bornes ne tient qu’à quelques véhicules simulés : de 39 à 48 bornes pour des jours
  d’hiver de même facteur à 3 000 véhicules sur le réseau élargi, de 26 à 35 à 500 véhicules dans le
  corridor, selon la date. La « plus forte pointe de l’année » est celle des 12 journées simulées :
  elle égale le maximum des 365 jours à 3 000 véhicules sur le réseau élargi, et aucun des 12 jours
  de plus simulés dans le corridor ne la dépasse, mais un autre jour pourrait la dépasser ailleurs.
- La prime de puissance compte la pointe de l’année chaque mois, ce qui est prudent.
- Le calcul demande environ 25 secondes sur un ordinateur de 20 cœurs, 40 secondes sur 8 cœurs et
  1 minute 15 sur 4 cœurs (mesuré en limitant le nombre de workers, sur une machine rapide ; une
  machine plus lente prend plus longtemps).

## 🗺️ Aperçu

| Vue en plan : la pointe du matin avec le tramway | Vue 3D : Saint-Roch, tramway et Cybercab |
|---|---|
| ![Carte de Québec sur fond sombre, rues colorées selon la congestion, tracé du tramway en jaune et tableaux de bord](docs/images/vue-en-plan.png) | ![Quartier Saint-Roch en volume à 8 h, avec les autos et le tramway (scénario tramway seul)](docs/images/vue-3d.png) |

## 🚀 Lancer

Il faut [Node.js](https://nodejs.org) 20 ou plus récent.

```powershell
node scripts/serve.js
```

Puis ouvrir http://localhost:5173. Les bibliothèques et les polices sont dans le dépôt ;
seul le fond de carte (OpenFreeMap) demande une connexion Internet.

Le dossier `web/` est un site statique : il se publie tel quel, par exemple sur GitHub Pages
(le flux `.github/workflows/pages.yml` le fait à chaque envoi sur `main`).

## 🎛️ Utiliser

- **Scénario** : mode sur le tracé (un seul à la fois), zone et taille de la
  flotte de Cybercab, tarif, courses partagées, part des déplacements automobiles faits sans auto, journée d'hiver,
  parc d'autos entièrement autonome et connecté (plus de feux aux carrefours).
- **Autos autonomes et connectées** : supposition extrême où tout le parc est remplacé par des
  autos électriques qui se coordonnent. Le coût de ce remplacement n'est pas compté.
- **Vue 3D** : la ville en volume, rues avec trottoirs, marquages, passages piétons, rails du
  tramway et arbres des parcs, avec chaque véhicule dessiné sur sa voie. Chaque auto se suit du départ à
  l'arrivée : elle garde sa couleur et sa voie et tourne aux carrefours. La vue 3D ramène la vitesse au temps réel.
  Un véhicule du moteur représente environ quatre autos réelles ; en vue 3D, elles sont toutes dessinées.
- **Bâtiments réels** (facultatif) : en vue 3D, la ville photographiée en 3D par Google remplace les volumes
  dessinés. Il faut une clé d'API Google Maps Platform personnelle (« Map Tiles API », facturation à votre
  nom) ; elle reste dans le navigateur, n'est envoyée qu'à Google et n'est jamais écrite dans ce dépôt.
- **Temps** : pause, vitesse (du temps réel au maximum), reprise à 5 h, 7 h, midi ou 16 h.
  Le moteur avance toujours par pas de 2 secondes, quelle que soit la vitesse : une journée animée donne
  le même bilan qu'une journée calculée d'un coup. Entre deux pas, l'affichage prolonge le mouvement.
- **Comparer les journées simulées** : chaque journée complète s'ajoute à deux tableaux,
  déplacements et rentabilité. Deux boutons simulent d'un coup la journée du scénario, ou quatre scénarios types.
  Pour chaque journée avec des déplacements faits sans auto, la comparaison affiche aussi le bilan annuel
  du même scénario à 0 % et l’écart entre les deux. La journée à 0 % est réutilisée ou calculée en arrière-plan.
- **Bilan sur un an** : dans la comparaison, choisir 2026 ou 2027 et lancer le calcul. Les 12 journées
  types du scénario en cours sont simulées en arrière-plan, avec la progression et un bouton « Annuler ».
  Le tableau donne le bilan de l'année à côté du jour type × 300, et le détail par journée type.
- **Déplacements faits sans auto** : le bilan pour la société a un poste à part pour ces voyageurs, qui n'ont
  pas choisi leur nouveau mode (autobus, marche, vélo ou Cybercab). Il compte ce qu'ils gagnent ou
  perdent en temps et en argent par rapport à l'auto. Le gain des voyageurs ne compte que ceux qui ont choisi de changer.
- **Cybercab (sans ligne)** : choisir ce mode, ou une zone de flotte, retire la ligne. La flotte roule
  dans la circulation générale, avec les autos, le long du tracé ou sur le réseau élargi.
- **Hypothèses de coûts** : cinq curseurs recalculent la rentabilité sans relancer la journée.
- **Copier le lien de ce scénario** : l'adresse contient le scénario et les coûts choisis.
- **Démarrer à** : le jour type d'automne (par défaut, chiffres ci-dessus), une saison ou une date de 2026-2027.
  Avec une date, les journées s'enchaînent, et les compteurs s'additionnent depuis le départ.

## 📅 Calendrier

Sans date, la journée simulée est le jour type d'automne : un jour de semaine de l'enquête Origine-Destination 2023.
Avec une date, trois choses changent.

- **Le nombre de déplacements**, heure par heure, par rapport à ce jour type :
  - le mois (janvier 0,89 ; juillet 1,09 ; septembre à novembre 1,00) ;
  - les vacances de la construction : pointe du matin 0,73, pointe du soir 0,93, journée 0,98 ;
  - août avant la rentrée et la semaine de la rentrée : pointe du matin 0,88 puis 0,95 ;
  - les Fêtes (jours de semaine du 21 au 31 décembre, mesurés du 22 au 31) : pointe du matin 0,41, journée 0,77 ;
    du 2 au 5 janvier : 0,85 (hypothèse) ;
  - les fériés (par exemple Noël 0,56, jour de l'An 0,48 ; le 2 janvier, chômé dans la fonction publique : 0,72,
    hypothèse) ;
  - le samedi (0,88) et le dimanche (0,79), avec leur propre profil horaire, sans pointe du matin.
- **Les voies réservées de pointe** : elles ne s'appliquent que du lundi au vendredi, selon OpenStreetMap.
  Les fins de semaine et les fériés (Vendredi saint compris), les autos ont toutes leurs voies.
- **L'horaire de la ligne** : les fins de semaine et les fériés, pas de pointe. Le passage reste celui du jour
  (8 minutes pour le tramway) jusqu'à 20 h, puis celui du soir. C'est ce que font les Métrobus du RTC.

De décembre à mars, la journée est aussi une journée d'hiver (la case « Journée d'hiver » l'impose toute l'année).

D'où viennent les chiffres : les comptages du ministère des Transports (2024 et 2025) sur l'A-540, l'A-73 et l'A-40,
les dates de la CCQ et du calendrier scolaire, et les horaires du RTC. Le détail et le statut de chaque facteur
(sourcé, analogue ou hypothèse) sont dans le panneau « Hypothèses ».

Tramway seul, mesuré sur une journée complète :

| Journée | Déplacements | dont 7 h à 8 h | Montées du tramway |
|---|---|---|---|
| Jour type d'automne, ou mercredi 14 octobre 2026 | 1 863 835 | 190 180 | 75 570 |
| Samedi 17 octobre 2026 | 1 646 855 | 45 645 | 52 245 |
| Mercredi 22 juillet 2026 (construction) | 1 838 215 | 139 835 | 71 470 |
| Vendredi 25 décembre 2026 (Noël, hiver) | 1 044 260 | 23 555 | 31 845 |
| Mercredi 20 janvier 2027 (hiver) | 1 663 885 | 169 805 | 67 020 |

Limites :

- L'enquête O-D ne couvre pas les fins de semaine. Un samedi garde les trajets d'un jour de semaine (d'où à où,
  et part de chaque mode) : seuls leur nombre et leur heure changent. Les sorties de magasinage et de loisirs ne
  sont pas déplacées vers les commerces.
- Les facteurs viennent d'autoroutes, souvent d'un seul site et d'une seule année. Aucun comptage public des
  artères de la Ville n'existe. On applique un débit de véhicules à des déplacements : c'est une approximation.
- Le profil de fin de semaine est celui de l'A-40. Le jour de semaine, lui, suit l'enquête O-D, plus marquée aux
  pointes : de 15 h à 18 h, un samedi simulé fait 0,60 d'un jour de semaine, contre 0,89 mesuré sur l'A-40.
- Aucune hausse du débit n'est mesurée avant Noël : décembre est un peu plus bas que l'automne. La congestion de
  décembre (neige, commerces) n'est pas reproduite.
- La part du transport collectif ne change pas selon la saison.
- La rentabilité d'une journée datée est ramenée à l'année comme un jour type (300 fois la journée). Son temps des
  automobilistes est comparé à la situation actuelle de sa journée type, simulée à sa date représentative. Un jour
  moins ou plus chargé que ce représentant (jour de l'An, 24 juin, retour des Fêtes, début juillet) y paraît encore
  gagner ou perdre du temps : jusqu'à environ 150 M$ par an sur ce poste (environ 20 M$ en moyenne sur les jours de
  2027). Pour l'année, voir le bilan sur un an, qui n'a pas ce biais.

## 📊 Ce que le modèle reproduit

| Mesure | Simulé | Observé ou officiel |
|---|---|---|
| Débit journalier sur 112 sections de comptage | 1,1 fois le débit mesuré (médiane) | Comptages DJMA du ministère des Transports |
| Temps perdu en congestion, journée | +38 % | +41 % (TomTom) |
| Temps perdu, pointe du matin et du soir | +54 % et +68 % | +55 % et +77 % (TomTom) |
| Tramway, déplacements par jour | environ 75 600 | 73 000 (prévision de CDPQ Infra, horizon 2041) |
| Tramway, charge du tronçon le plus chargé | environ 3 400 passagers par heure | 3 200 à 3 500 (étude de 2022) |

## ⚠️ Limites

- La demande totale est fixe : un nouveau service n'induit pas de déplacements.
- Pas de feux simulés un à un ni de files d'attente physiques : la congestion est estimée par tronçon.
- Le réseau d'autobus actuel du RTC n'est pas animé et son service ne s'ajuste pas.
- Les coûts des Cybercab suivent les cibles de Tesla, qui ne sont pas démontrées en
  exploitation. Aucun robotaxi n'est autorisé au Québec hors projet pilote.
- Plusieurs coûts des dépôts et de la recharge des Cybercab sont des hypothèses : raccordement
  électrique, durée de vie des bornes, surface bâtie, temps de nettoyage, salaire des agents de
  supervision. Le coût des bornes vient d'études américaines (2013 et 2019). La journée simulée
  part de batteries chargées de 50 à 100 % : elle compte moins de recharges qu'en régime établi,
  et le nombre de bornes est probablement sous-estimé. La pointe de recharge ne tient qu'à
  quelques véhicules simulés (chacun en représente environ 3,6). Dans les tableaux du jour type,
  les bornes et la prime de puissance viennent d'une journée d'automne : un jour d'hiver en demande
  davantage dans le corridor avec 500 véhicules : 26 bornes au lieu de 18 avec la case « Journée
  d'hiver », 35 le 1er février 2027. Le bilan sur un an les
  dimensionne sur la plus forte pointe de l'année.
- Les coûts d'exploitation du tramway et l'investissement du bus en voies réservées sont des
  hypothèses, faute de chiffres officiels pour ce tracé.
- Les limites de Lévis et de la ceinture nord sont approximées.

## 🛠️ Développer

```powershell
node --test tests/engine.test.js
node tests/run_day.js tram off 0 24
node tests/calib.js tram
node tests/econ_report.js
node tests/make_reference.js
```

- `run_day.js <none|tram|bus> <off|corridor|wide> <flotte> <heures>` : une journée hors
  navigateur, avec le bilan complet.
- `calib.js` : congestion par période, débits DJMA et achalandage, pour vérifier le calage.
- `econ_report.js` : rentabilité annuelle détaillée de six scénarios, un seul mode à la fois (environ 3 minutes).
  `--modes` : les tableaux de la section « Résultats simulés des trois modes ».
- `cab_study.js <flotte> <tarif au km> [forfait] [none|tram|bus] [off|corridor|wide]` :
  autos retirées, provenance des passagers et congestion. `HOURLY=1` ajoute le détail par
  heure, `POOL=1` les courses partagées, `CARFREE=0.1` dix pour cent des déplacements automobiles de la zone desservie faits sans auto.
  Un seul mode à la fois : une ligne (`tram`, `bus`) va avec `off`, une flotte avec `none`.
- `make_reference.js` : régénère `web/js/engine/reference.js`, les journées de référence qui
  servent au calcul du temps des automobilistes : le jour type (`normal`, `winter`) et une par
  journée type du bilan sur un an (environ 3 minutes). À relancer après tout changement du moteur.

Pour reconstruire les données à partir des sources (Python 3) :

```powershell
python scripts/fetch_raw.py
python scripts/build_data.py
```

`fetch_raw.py` télécharge une fois les données publiques dans `data/raw/` ; `build_data.py`
produit `data/network.json` (lisible) et `web/data/network.js` (la même chose sous forme compacte,
décodée au chargement). `python scripts/build_data.py --web` refait seulement le second à partir du premier.

### Organisation

- `web/js/engine/` : le moteur, sans dépendance, utilisable sous Node.
  `core.js` (paramètres), `network.js` (rues, congestion, itinéraires), `line.js` (tramway ou
  bus), `cabs.js` (flotte), `sim.js` (demande et choix modal), `econ.js` (rentabilité).
- `web/js/app.js` : la carte et l'interface. `web/js/assumptions.js` : hypothèses affichées.
- `scripts/` : construction des données et serveur local. `tests/` : tests et outils de calage.

### Modèle en bref

- Demande : matrices de l'Enquête Origine-Destination 2023 Québec-Lévis (12 grands secteurs,
  4 périodes), 1 agent pour 5 personnes.
- Circulation : graphe OpenStreetMap des autoroutes aux collectrices, temps par tronçon selon
  la charge, itinéraires recalculés selon la congestion.
- Ligne structurante : véhicules, arrêts, capacité et files d'attente simulés un par un.
- Cybercab : véhicule libre le plus proche, courses partagées, trajets à vide, odomètre,
  recharge ; dans la circulation générale, aux mêmes temps de parcours que les autos.
- Choix modal : report par logit binaire depuis le mode de référence de l'enquête.

## 📄 Licences

Code sous licence MIT (`LICENSE`). Données, bibliothèques et polices : voir `DONNEES.md`.
Réseau routier © contributeurs OpenStreetMap (ODbL).
