# Québec en mouvement

Simulateur interactif du réseau de transport de la ville de Québec : une journée de semaine
rejouée sur le réseau routier réel, avec au choix le tramway TramCité, un bus en voies réservées
sur le même tracé, et une flotte de Cybercab (le long du tracé ou sur toute la ville).

## Lancer

```powershell
node scripts/serve.js
```

Puis ouvrir http://localhost:5173. Une connexion Internet est nécessaire pour le fond de carte
(OpenFreeMap) et les bibliothèques (MapLibre GL JS 5.24.1, deck.gl 9.4.1).

## Reconstruire les données

```powershell
python scripts/fetch_raw.py
python scripts/build_data.py
```

`fetch_raw.py` télécharge une fois les données ouvertes dans `data/raw/` ; `build_data.py`
produit `web/data/network.js` (et `data/network.json` pour les tests).

## Tester

```powershell
node --test tests/
node tests/run_day.js tram off 0 24
node tests/econ_report.js   # rentabilité annuelle de huit scénarios (environ 3 minutes)
```

`run_day.js <none|tram|bus> <off|corridor|wide> <flotte> <heures>` exécute une journée hors
navigateur et affiche le bilan. Avec `COUNTS=1`, il compare les débits simulés aux comptages
DJMA du ministère des Transports.

## Modèle

- Demande : matrices de l'Enquête Origine-Destination 2023 Québec-Lévis (12 grands secteurs,
  4 périodes), 1 agent = 5 personnes.
- Circulation : graphe OpenStreetMap (autoroutes à collectrices), temps par tronçon selon une
  loi débit-vitesse (BPR), itinéraires recalculés selon la congestion.
- Ligne structurante : véhicules, arrêts, capacité et files d'attente simulés un par un.
- Cybercab : répartition au véhicule libre le plus proche, trajets à vide, recharge.
- Choix modal : report par logit binaire depuis le mode de référence de l'enquête.

Les hypothèses détaillées et leurs sources sont dans l'interface (« Hypothèses et sources »)
et dans `web/js/assumptions.js`. Ce modèle compare des ordres de grandeur ; ce n'est pas une
étude d'achalandage officielle.

## Sources et licences des données

- Réseau routier et tracé du tramway : © contributeurs OpenStreetMap (ODbL).
- Limites des arrondissements : Ville de Québec, Données Québec (CC-BY 4.0).
- Enquête Origine-Destination 2023 et débits DJMA : ministère des Transports et de la Mobilité
  durable du Québec.
- Fond de carte : OpenFreeMap © OpenMapTiles, données OpenStreetMap.
