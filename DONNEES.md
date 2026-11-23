# Données, bibliothèques et licences

Le code du projet est sous licence MIT (voir `LICENSE`). Ce qui suit a sa propre licence.

## Données

Les fichiers `data/network.json` et `web/data/network.js` sont produits par `scripts/build_data.py`
à partir des sources ci-dessous.

| Source | Ce qui en est tiré | Licence |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | Réseau routier, interdictions de virage et tracé du tramway (relation 16197598) | ODbL 1.0, © contributeurs OpenStreetMap |
| Wikipédia en français, articles sur le tramway de Québec | Coordonnées approximatives des stations | CC BY-SA 4.0 |
| [Carte officielle TramCité](https://tramcite.info) | Noms et ordre des stations | © CDPQ Infra, information factuelle citée |
| [Ville de Québec, Données Québec](https://www.donneesquebec.ca/recherche/dataset/5ddf584d-b73d-4cd7-b203-28c3b5364d66) | Limites des arrondissements | CC BY 4.0 |
| [Enquête Origine-Destination 2023 Québec-Lévis](https://www.quebec.ca/transports/recherches-statistiques/planification/enquetes-origine-destination/quebec/2023) | Matrices de déplacements par grands secteurs | © Gouvernement du Québec. Conditions de réutilisation à confirmer auprès du ministère des Transports et de la Mobilité durable ; la source doit être citée. |
| [Débits de circulation (DJMA)](https://www.donneesquebec.ca/recherche/dataset/debit-de-circulation) | 112 sections de comptage, pour le calage | CC BY 4.0, ministère des Transports et de la Mobilité durable |
| Orthophotos du gouvernement du Québec (service de tuiles `geoegl.msp.gouv.qc.ca`) | Rien n'est copié. Des tronçons douteux y ont été contrôlés à l'œil, le 21 novembre 2026. | © Gouvernement du Québec. Images consultées seulement ; aucune n'est redistribuée. |

Les parties de ces deux fichiers qui dérivent d'OpenStreetMap (`nodes`, `segs`, `edges`, `peaks`, `turns_off`,
`names`, `line`, `points`, `gates`, `outlines`) sont distribuées sous
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) : vous pouvez les réutiliser à condition
de citer les contributeurs OpenStreetMap et de partager vos versions modifiées sous la même licence.

Les matrices de déplacements (`od`) et les pôles d'activité (`poles`) viennent de l'Enquête
Origine-Destination 2023. Ils restent © Gouvernement du Québec et partenaires de l'enquête et ne
sont pas couverts par l'ODbL. Aucune licence de réutilisation n'est publiée avec ces matrices :
avant de les redistribuer, demandez l'accord du ministère des Transports et de la Mobilité durable,
ou reconstruisez-les vous-même avec `scripts/fetch_raw.py`.

Réseau routier : le nombre de voies et les sens de circulation viennent des balises d'OpenStreetMap.
Les voies réservées (bus, taxi, covoiturage) sont retirées des voies pour autos, en permanence ou
seulement aux heures de pointe selon la balise. La voie centrale du pont de Québec change de sens
matin et soir ; son horaire est une hypothèse. Les sens ont été comparés au Référentiel québécois du
réseau routier : ils concordent à 99,6 %. Le nombre de voies n'a pas pu être vérifié sur tout le
réseau, faute de source officielle pour la ville de Québec.

Pris en compte depuis novembre 2026 :

- Interdictions de virage : 405 des 851 relations d'OpenStreetMap sont appliquées, à 356 carrefours.
  Chaque carrefour concerné est découpé en entrées et en sorties, reliées seulement par les mouvements
  permis. La liste des mouvements interdits est dans `turns_off`.
- Voies de virage : une voie qui ne sert qu'à tourner compte pour une demi-voie de capacité.
- Rues à double sens de 3 ou 5 voies sans détail : 1,5 ou 2,5 voies de capacité par sens.
- Bretelles : 56 rues de raccord relient au réseau des bretelles qui débouchent sur des rues locales.
  Aucun domicile ni lieu d'activité n'y est rattaché.
- Vitesse : un tronçon sans limite indiquée prend celle du tronçon voisin de même nom et de même classe.
- Photos aériennes : les tronçons les plus douteux ont été contrôlés sur les orthophotos du gouvernement
  du Québec (0,20 m par pixel, consultées le 21 novembre 2026, date de prise de vue non publiée). Six ont
  été corrigés et un sens unique a été confirmé. Les cas peu nets sur l'image sont laissés tels quels.
  La liste est dans `WAY_FIXES`, dans `scripts/build_data.py`.

Restent simplifiés : les interdictions de virage qui passent par un tronçon intermédiaire (244) ou qui
ne valent qu'à certaines heures (33) ne sont pas appliquées ; les demi-tours restent permis ; onze
interdictions sont écartées parce que, sans les rues locales, elles coupaient le réseau ; dix bretelles
restent hors du réseau.

Le fond de carte est servi par [OpenFreeMap](https://openfreemap.org) (© OpenMapTiles, données
OpenStreetMap). Il n'est pas copié dans ce dépôt.

## Bibliothèques et polices incluses

| Fichier | Projet | Licence |
|---|---|---|
| `web/vendor/maplibre-gl.js`, `maplibre-gl.css` | MapLibre GL JS 5.24.1 | BSD 3 clauses, `web/vendor/LICENSE-maplibre-gl.txt` |
| `web/vendor/deck.gl.min.js` | deck.gl 9.4.1, avec long.js et Closure Library dans le même fichier | MIT, `web/vendor/LICENSE-deck.gl.txt` ; Apache 2.0 pour les deux composants inclus, `web/vendor/LICENSE-apache-2.0.txt` |
| `web/fonts/*.woff2` | Barlow Condensed et Barlow Semi Condensed | SIL Open Font License 1.1, `web/fonts/OFL.txt` |

## Marques

TramCité, RTC, CDPQ Infra, Tesla et Cybercab sont des marques de leurs propriétaires. Elles sont
citées pour décrire les scénarios simulés. Ce projet n'est affilié à aucun de ces organismes.
