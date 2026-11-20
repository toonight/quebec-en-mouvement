/* Hypothèses et sources affichées dans l'interface. */
(function () {
  const TQ = window.TQ;
  const a = (href, text) => `<a href="${href}" target="_blank" rel="noopener">${text}</a>`;
  TQ.ASSUMPTIONS = [
    { title: 'Demande de déplacements', items: [
      `Matrices origine-destination de l'${a('https://www.quebec.ca/transports/recherches-statistiques/planification/enquetes-origine-destination/quebec/2023', 'Enquête Origine-Destination 2023 Québec-Lévis')} par grands secteurs : 2,0 millions de déplacements par jour de semaine, répartis en quatre périodes.`,
      'Profil horaire reconstruit à partir des quatre périodes de l\'enquête, avec les heures de pointe à 7 h et 16 h.',
      'À l\'intérieur de chaque secteur, les domiciles suivent la densité des rues résidentielles d\'OpenStreetMap et les destinations suivent les pôles d\'activité de l\'enquête (Lebourgneuf, colline Parlementaire, plateau de Sainte-Foy, Université Laval, etc.), placés à la main.',
      'Chaque agent simulé représente 5 personnes. Un point automobile représente environ 4 véhicules (1,21 personne par auto).',
      'Les déplacements entre zones extérieures au territoire ne sont pas simulés. Les zones extérieures entrent par sept portes autoroutières.',
    ] },
    { title: 'Réseau routier et congestion', items: [
      `Réseau ${a('https://www.openstreetmap.org/copyright', 'OpenStreetMap')} des autoroutes aux collectrices (environ 7 000 nœuds). Les rues locales ne sont pas modélisées.`,
      'Temps de parcours par tronçon selon une loi débit-vitesse de type BPR ; les itinéraires sont recalculés à tour de rôle : toutes les 20 minutes simulées en période de congestion, toutes les 80 minutes sinon.',
      'Les débits sont majorés de 12 % pour les camions et le transit, absents de l\'enquête.',
      `Calage : sur 109 sections de comptage du ${a('https://www.donneesquebec.ca/recherche/dataset/debit-de-circulation', 'ministère des Transports')}, le débit journalier simulé vaut en médiane 1,1 fois le débit mesuré.`,
      'Quand la ligne structurante existe, une voie par sens est retirée aux autos sur les rues qui longent le tracé en surface.',
    ] },
    { title: 'Tramway TramCité', items: [
      `Tracé de 19 km et 29 stations (Le Gendre à Charlesbourg), tunnel de 1,7 km sous la colline Parlementaire, d'après ${a('https://tramcite.info/fr/tramcite-en-bref', 'tramcite.info')} et la relation OpenStreetMap 16197598 (tracé de l'avis au marché de décembre 2024, sujet à modification).`,
      'Rames d\'environ 240 passagers, passage aux 4 minutes en pointe (valeurs officielles 2026). Hors pointe : 8 à 12 minutes, hypothèse reprise de l\'ancien projet.',
      'Priorité aux feux, vitesse de croisière de 42 km/h en surface et 60 km/h en tunnel. La vitesse commerciale simulée, environ 24 km/h, correspond aux études de 2019.',
      'Report modal calé pour approcher la prévision de CDPQ Infra (73 000 déplacements par jour à l\'horizon 2041).',
    ] },
    { title: 'Bus en voies réservées', items: [
      'Même tracé et mêmes stations que le tramway. Le bus ne peut pas emprunter le tunnel : il traverse la colline en surface, plus lentement.',
      'Bus articulés de 105 passagers aux 2,5 minutes en pointe, priorité partielle aux feux, arrêts plus longs et plus variables. Moteurs hybrides (0,9 kg de CO₂ par km).',
    ] },
    { title: 'Flotte de Cybercab', items: [
      'Scénario prospectif. Le Cybercab (2 places, batterie de 48 kWh) ne roule commercialement qu\'au Texas en novembre 2026, et les véhicules sans conducteur sont interdits au Québec hors projet pilote.',
      'Chaque demande reçoit le véhicule libre le plus proche, s\'il peut arriver en moins de 12 minutes. Sinon le voyageur garde son mode habituel.',
      'Tarif par défaut inspiré du tarif réel d\'Austin : 3,50 $ plus 1,20 $ par kilomètre, 1,4 passager par course.',
      'Les trajets à vide (approche, repositionnement) s\'ajoutent à la circulation. Recharge de 25 minutes quand la batterie atteint sa réserve.',
      '« Le long du tracé » dessert les lieux à moins de 1,2 km de la ligne ; « réseau élargi » dessert les six arrondissements de la Ville de Québec.',
    ] },
    { title: 'Rentabilité', items: [
      `Calcul financier du point de vue de l'exploitant : recettes des passagers, moins les coûts d'exploitation, moins l'investissement étalé sur sa durée de vie (taux réel de 4 %). Les subventions et les bénéfices pour la société (temps gagné, CO₂, accidents) ne sont pas comptés.`,
      `Une journée de semaine simulée compte pour 1/300 de l'année. Recette par déplacement en transport collectif : 2,53 $, soit 82,3 M$ pour 32,5 millions de déplacements au ${a('https://cdn.rtcquebec.ca/sites/default/files/2025-12/Budget_2026.pdf', 'budget 2026 du RTC')}. Les montées de la ligne venant des autobus actuels sont comptées comme recettes de la ligne, même si elles ne sont pas nouvelles pour le RTC.`,
      `Tramway : investissement de 7,6 G$ (${a('https://www.lesaffaires.com/secteurs/aeronautique-et-transport/le-cout-du-tramway-de-quebec-est-evalue-a-76g-mise-en-service-en-2033/', 'montant annoncé par le gouvernement')}) étalé sur 40 ans. Exploitation : 16 $ par kilomètre de rame et 12 M$ par an pour l'infrastructure (hypothèses, faute de chiffre officiel pour TramCité).`,
      `Bus en voies réservées : investissement de 1,4 G$, soit 19 km au coût moyen du ${a('https://www.cbc.ca/1.7232400', 'plan CITÉ de CDPQ Infra')} (4,5 G$ pour 60 km de voies réservées), étalé sur 30 ans. Exploitation : 10,50 $ par kilomètre, d'après le budget 2026 du RTC (290 M$ pour 28,8 millions de kilomètres), et 3 M$ par an pour l'infrastructure (hypothèse).`,
      `Cybercab : 42 000 $ par véhicule (${a('https://insideevs.com/news/736936/tesla-robotaxi-cybercab-price/', 'moins de 30 000 $ US selon Tesla')}) et 8 000 $ de recharge et de dépôt, étalés sur 5 ans. Exploitation : 0,25 $ par kilomètre (entretien, nettoyage, supervision, assurance), électricité à 0,12 $ le kilowattheure et 4 000 $ par véhicule par an. Ces coûts suivent les cibles de Tesla, qui ne sont pas encore démontrées en exploitation.`,
    ] },
    { title: 'Limites du modèle', items: [
      'Le réseau d\'autobus actuel du RTC n\'est pas animé : ses usagers apparaissent seulement dans la répartition des déplacements.',
      'Pas de feux de circulation ni de files d\'attente physiques : la congestion est estimée par tronçon, et elle est sous-estimée en dehors des heures de pointe.',
      'La demande totale est fixe : pas de déplacements induits par un nouveau service.',
      'Le CO₂ évité compte les kilomètres d\'auto remplacés, moins les émissions du nouveau service. Il ignore la fabrication des véhicules et des infrastructures.',
      'Journée d\'hiver : capacité des rues réduite de 10 %, vitesses de 8 %, consommation des Cybercab majorée de 35 % (hypothèses).',
    ] },
  ];
})();
