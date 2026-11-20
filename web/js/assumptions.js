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
      `Temps de parcours par tronçon : une loi débit-vitesse de type BPR pour la saturation, plus un retard proportionnel à la charge qui représente les feux et les entrecroisements. Les itinéraires sont recalculés à tour de rôle : toutes les 20 minutes simulées en période de congestion, toutes les 80 minutes sinon.`,
      'Les débits sont majorés de 12 % pour les camions et le transit, absents de l\'enquête.',
      `Calage des débits : sur 109 sections de comptage du ${a('https://www.donneesquebec.ca/recherche/dataset/debit-de-circulation', 'ministère des Transports')}, le débit journalier simulé vaut en médiane 1,1 fois le débit mesuré.`,
      `Calage de la congestion : le temps perdu simulé est de 39 % sur la journée, 58 % à la pointe du matin et 71 % à celle du soir. L'${a('https://www.tomtom.com/traffic-index/', 'indice TomTom')} mesure 41 %, 55 % et 77 % à Québec.`,
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
      `Tarif par défaut inspiré du tarif réel d'Austin : 3,50 $ plus 1,20 $ par kilomètre, 1,4 passager par course. Le prix est annoncé à la commande, d'après la distance estimée, et payé à l'arrivée.`,
      `Les trajets à vide (approche, repositionnement) s'ajoutent à la circulation. Chaque véhicule a un odomètre : la course est facturée et la batterie se vide selon les kilomètres réellement parcourus sur le réseau, plus 0,6 km de rues locales par course et 0,3 km par approche (hypothèse). Recharge de 25 minutes quand la batterie atteint sa réserve.`,
      '« Le long du tracé » dessert les lieux à moins de 1,2 km de la ligne ; « réseau élargi » dessert les six arrondissements de la Ville de Québec.',
    ] },
    { title: 'Voie réservée aux Cybercab, courses partagées, abandon de l\'auto', items: [
      `Voie réservée aux Cybercab : si le tramway est abandonné, sa voie est donnée à la flotte, et à elle seule. Les Cybercab y roulent en convois coordonnés à 45 km/h, sans feux ni autos, jusqu'à 2 400 véhicules par heure et par sens (hypothèses : une voie ordinaire en ville en écoule environ 900). Ailleurs, ils partagent les rues avec les autos. Les autos perdent une voie le long du tracé, comme avec le tramway ou le bus.`,
      `La coordination de l'essaim se limite à ce que le modèle sait représenter : répartition centrale des courses, itinéraires propres à la flotte, convois dans la voie réservée. Les arrêts pour prendre ou déposer un passager se font hors de la voie et ne la ralentissent pas (hypothèse favorable).`,
      `Courses partagées : le Cybercab a 2 places et transporte déjà 1,4 personne en moyenne. Pour que l'occupation moyenne ne dépasse jamais 2, au plus 30 % des demandes peuvent se joindre à une course en cours. Il faut aussi que le véhicule arrive en moins de 6 minutes et que le détour ne dépasse pas 5 minutes pour chacun. En échange : 20 % de rabais pour tous, et 2 minutes de détour ressenti.`,
      `Abandon de l'auto : aucune donnée ne dit combien de ménages renonceraient à leur voiture avec des robotaxis. Le curseur fixe la part des résidents de la zone desservie qui n'ont plus d'auto ; leurs déplacements se font alors par la moins coûteuse des solutions restantes (Cybercab, ligne, autobus actuels, marche ou vélo). Les économies de ces ménages (achat, assurance, stationnement) ne sont pas comptées dans le bilan.`,
      `Investissement de la voie réservée aux Cybercab : 1,4 G$, comme les voies réservées aux bus sur la même emprise (hypothèse), plus la flotte.`,
    ] },
    { title: 'Rentabilité', items: [
      `Résultat de l'exploitant : recettes des passagers, moins les coûts d'exploitation, moins l'investissement étalé sur sa durée de vie (taux réel de 4 %). Les subventions ne sont pas comptées. Les curseurs « Hypothèses de coûts » changent ces valeurs.`,
      `Une journée de semaine simulée compte pour 1/300 de l'année. Recette par déplacement en transport collectif : 2,53 $, soit 82,3 M$ pour 32,5 millions de déplacements au ${a('https://cdn.rtcquebec.ca/sites/default/files/2025-12/Budget_2026.pdf', 'budget 2026 du RTC')}. Les montées de la ligne venant des autobus actuels sont comptées comme recettes de la ligne, même si elles ne sont pas nouvelles pour le RTC.`,
      `Tramway : investissement de 7,6 G$ (${a('https://www.lesaffaires.com/secteurs/aeronautique-et-transport/le-cout-du-tramway-de-quebec-est-evalue-a-76g-mise-en-service-en-2033/', 'montant annoncé par le gouvernement')}) étalé sur 40 ans. Exploitation : 16 $ par kilomètre de rame et 12 M$ par an pour l'infrastructure (hypothèses, faute de chiffre officiel pour TramCité).`,
      `Bus en voies réservées : investissement de 1,4 G$, soit 19 km au coût moyen du ${a('https://www.cbc.ca/1.7232400', 'plan CITÉ de CDPQ Infra')} (4,5 G$ pour 60 km de voies réservées), étalé sur 30 ans. Exploitation : 10,50 $ par kilomètre, soit les 10 $ du budget 2026 du RTC (290 M$ pour 28,8 millions de kilomètres) arrondis à la hausse pour des autobus articulés (hypothèse), et 3 M$ par an pour l'infrastructure (hypothèse).`,
      `Cybercab : 42 000 $ par véhicule (${a('https://insideevs.com/news/736936/tesla-robotaxi-cybercab-price/', 'moins de 30 000 $ US selon Tesla')}) et 8 000 $ de recharge et de dépôt, étalés sur 5 ans. Exploitation : 0,25 $ par kilomètre (entretien, nettoyage, supervision, assurance), électricité à 0,12 $ le kilowattheure et 4 000 $ par véhicule par an. Ces coûts suivent les cibles de Tesla, qui ne sont pas encore démontrées en exploitation.`,
    ] },
    { title: 'Bilan pour la société', items: [
      `Le bilan pour la société part du résultat de l'exploitant et y ajoute ce que gagnent ou perdent les autres. Les tarifs payés sont un simple transfert entre voyageurs et exploitants : ils ne créent ni ne détruisent de valeur.`,
      `Gain des voyageurs : pour chaque personne qui change de mode, la moitié de l'écart de coût généralisé (temps, attente, marche, tarif, stationnement) entre son ancien mode et le nouveau, à 22 $ l'heure. C'est une estimation prudente : le confort et la fiabilité ne sont pas comptés. Pour les Cybercab s'ajoute le partage de la course : chacun choisit comme s'il payait le plein tarif, alors qu'une course transporte 1,4 personne en moyenne.`,
      `Temps des automobilistes : écart de temps perdu par kilomètre avec la journée de référence sans ligne ni flotte, pour 1,21 personne par auto, à 22 $ l'heure. La voie retirée aux autos et les Cybercab à vide y pèsent en négatif. Chaque journée rejoue le même tirage de déplacements que la référence ; il reste un écart de quelques millions de dollars par an dû au hasard des itinéraires.`,
      `CO₂ : 275 $ la tonne évitée, selon le ${a('https://www.canada.ca/fr/environnement-changement-climatique/services/changements-climatiques/recherche-donnees/cout-social-ges.html', 'coût social du carbone d\'Environnement et Changement climatique Canada')} (256 $ en 2022, 294 $ en 2030).`,
      `Recettes perdues par les autobus actuels : 2,53 $ par usager du RTC qui passe à la ligne ou au Cybercab. Le modèle ne réduit pas le service d'autobus en parallèle : les économies que le RTC en tirerait ne sont pas comptées.`,
      `Non comptés : accidents, bruit, pollution locale, valeur foncière et développement urbain autour des stations, emplois, déplacements induits, recettes de stationnement et taxes sur les carburants perdues quand un automobiliste change de mode. Un bilan officiel en tiendrait compte.`,
    ] },
    { title: 'Limites du modèle', items: [
      'Le réseau d\'autobus actuel du RTC n\'est pas animé : ses usagers apparaissent seulement dans la répartition des déplacements.',
      `Pas de feux de circulation ni de files d'attente physiques : la congestion est estimée par tronçon. Les bouchons qui remontent d'une rue à l'autre ne sont pas reproduits.`,
      'La demande totale est fixe : pas de déplacements induits par un nouveau service.',
      'Le CO₂ évité compte les kilomètres d\'auto remplacés, moins les émissions du nouveau service. Il ignore la fabrication des véhicules et des infrastructures.',
      'Journée d\'hiver : capacité des rues réduite de 10 %, vitesses de 8 %, consommation des Cybercab majorée de 35 % (hypothèses).',
      'Autos toutes autonomes et connectées (supposition, aucune ville ne fonctionne ainsi) : sans feux, chaque voie de rue écoule 80 % de véhicules de plus et la vitesse libre monte de 25 % ; sur autoroute, les pelotons ajoutent 40 % de capacité. Le retard qui grandit avec la charge (feux, entrecroisements) est presque supprimé. Le parc est électrique : le CO₂ évité compte alors toutes les autos qui ne brûlent plus d\'essence. Ne sont pas comptés : le coût de remplacement de toutes les autos, les piétons et cyclistes aux carrefours, les déplacements à vide et les nouveaux déplacements que cette facilité susciterait.',
    ] },
  ];
})();
