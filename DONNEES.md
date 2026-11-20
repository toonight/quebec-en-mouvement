# Données, bibliothèques et licences

Le code du projet est sous licence MIT (voir `LICENSE`). Ce qui suit a sa propre licence.

## Données

Les fichiers `data/network.json` et `web/data/network.js` sont produits par `scripts/build_data.py`
à partir des sources ci-dessous.

| Source | Ce qui en est tiré | Licence |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) | Réseau routier et tracé du tramway (relation 16197598) | ODbL 1.0, © contributeurs OpenStreetMap |
| Wikipédia en français, articles sur le tramway de Québec | Coordonnées approximatives des stations | CC BY-SA 4.0 |
| [Carte officielle TramCité](https://tramcite.info) | Noms et ordre des stations | © CDPQ Infra, information factuelle citée |
| [Ville de Québec, Données Québec](https://www.donneesquebec.ca/recherche/dataset/5ddf584d-b73d-4cd7-b203-28c3b5364d66) | Limites des arrondissements | CC BY 4.0 |
| [Enquête Origine-Destination 2023 Québec-Lévis](https://www.quebec.ca/transports/recherches-statistiques/planification/enquetes-origine-destination/quebec/2023) | Matrices de déplacements par grands secteurs | © Gouvernement du Québec. Conditions de réutilisation à confirmer auprès du ministère des Transports et de la Mobilité durable ; la source doit être citée. |
| [Débits de circulation (DJMA)](https://www.donneesquebec.ca/recherche/dataset/debit-de-circulation) | 109 sections de comptage, pour le calage | CC BY 4.0, ministère des Transports et de la Mobilité durable |

Les parties de ces deux fichiers qui dérivent d'OpenStreetMap (`nodes`, `segs`, `edges`, `names`,
`line`, `points`, `gates`, `outlines`) sont distribuées sous
[ODbL 1.0](https://opendatacommons.org/licenses/odbl/1-0/) : vous pouvez les réutiliser à condition
de citer les contributeurs OpenStreetMap et de partager vos versions modifiées sous la même licence.

Les matrices de déplacements (`od`) et les pôles d'activité (`poles`) viennent de l'Enquête
Origine-Destination 2023. Ils restent © Gouvernement du Québec et partenaires de l'enquête et ne
sont pas couverts par l'ODbL. Aucune licence de réutilisation n'est publiée avec ces matrices :
avant de les redistribuer, demandez l'accord du ministère des Transports et de la Mobilité durable,
ou reconstruisez-les vous-même avec `scripts/fetch_raw.py`.

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
