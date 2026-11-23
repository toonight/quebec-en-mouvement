/* Noyau : espace de noms, paramètres du modèle, utilitaires. Fonctionne dans le navigateur et sous Node. */
(function () {
  const TQ = typeof window !== 'undefined' ? (window.TQ = window.TQ || {}) : (globalThis.TQ = globalThis.TQ || {});

  /** Paramètres du modèle. Les valeurs sourcées sont décrites dans le panneau « Hypothèses » de l'interface. */
  TQ.PARAMS = {
    scale: 5, // 1 agent simulé = 5 personnes
    dayStart: 5 * 3600, // la journée simulée va de 5 h à 5 h
    carOccupancy: 1.21, // EOD 2023
    truckFactor: 1.12, // camions et trafic de transit absents de l'EOD
    bprAlpha: 0.45,
    bprBeta: 4,
    bprMaxRatio: 1.9,
    // retard proportionnel à la charge (feux, entrecroisements), sensible dès les débits moyens
    linearDelay: { street: 0.6, motorway: 0.2 },
    flowTau: 600, // constante de temps (s) du lissage des débits
    treeRefresh: 1200, // recalcul des itinéraires (s simulées)
    calmCongestion: 0.22, // sous ce temps perdu, les itinéraires sont recalculés quatre fois moins souvent
    // Profil horaire (part des déplacements quotidiens par heure, 0 h à 23 h). Calé sur les 4 périodes de l'EOD 2023
    // (pointe AM 23,6 %, jour 28,0 %, pointe PM 31,9 %, soir et nuit 16,5 %) ; heures de pointe 7 h et 16 h.
    hourly: [0.3, 0.15, 0.1, 0.1, 0.25, 0.6, 5.0, 11.7, 6.9, 4.3, 4.2, 4.6, 5.0, 4.7, 5.2, 9.7, 13.2, 9.0, 5.0, 3.6, 2.6, 1.9, 1.2, 0.7],
    gravityLambda: 3900, // m — dissuasion par la distance dans le tirage des destinations (portée moyenne EOD : 6,1 km)
    gravityTries: 6,
    homeOrigin: { A: 0.9, H: 0.5, P: 0.15, N: 0.3 }, // probabilité que l'origine soit le domicile
    // Choix modal (minutes généralisées)
    theta: 0.12,
    vot: 22, // valeur du temps, $/h
    votTransit: 14, // valeur du temps des usagers du transport collectif face au tarif d'un robotaxi
    carCostKm: 0.22,
    transitFare: 2.53, // $ par déplacement (recette moyenne au budget 2026 du RTC)
    carCaptivity: -1, // constante de captivité automobile vis-à-vis de la ligne (min) — calée sur la prévision d'achalandage
    walkSpeed: 80, // m/min (4,8 km/h, hypothèse)
    walkWeight: 1.8,
    waitWeight: 1.5,
    walkMax: 1100,
    feederSpeed: 333, // m/min (20 km/h)
    rtcSpeedKmh: 17, // vitesse porte-à-porte des parcours actuels
    // Abandon de l'auto : modes de repli d'un déplacement fait sans auto. La marche (walkSpeed) est toujours possible.
    // Vélo : part des déplacements pour lesquels il est disponible (53 % des adultes de Québec ont fait du vélo en 2020,
    // Vélo Québec ; l'appliquer à chaque déplacement est une hypothèse), facteur d'hiver (190 000 personnes ont roulé
    // de décembre 2019 à mars 2020 selon l'observatoire de Vélo Québec, sur 3,4 millions de cyclistes adultes au Québec), vitesse porte-à-porte (hypothèse du modèle).
    noCar: { bikeShare: 0.53, bikeWinterFactor: 0.056, bikeSpeedKmh: 13 },
    // Parc entièrement autonome et connecté (hypothèse) : les autos se coordonnent, les carrefours n'ont plus de feux.
    // Rues : débit par voie proche d'une circulation ininterrompue, vitesse libre sans arrêts aux feux.
    // Autoroutes : pelotons à intervalles courts. Parc électrique.
    auto: { streetCap: 1.8, motorwayCap: 1.4, streetSpeed: 1.25, linearDelay: { street: 0.1, motorway: 0.05 }, kwhKm: 0.17 },
    // Conditions hivernales
    winterCap: 0.9,
    winterSpeed: 0.92,
    winterEnergy: 1.35,
    // Émissions
    carCO2: 0.21, // kg CO2 / véh-km (parc léger à essence)
    busCO2: 0.9, // kg CO2 / bus-km (articulé hybride)
    gridCO2: 0.002, // kg CO2 / kWh (Hydro-Québec)
    line: {
      tram: {
        label: 'Tramway', capacity: 240, length: 40, width: 2.65,
        headway: { peak: 4, shoulder: 5, day: 8, evening: 12 },
        cruise: 42, cruiseTunnel: 60, stopLoss: 20, junctionDelay: 5, junctionEvery: 450,
        dwellBase: 18, dwellPerPax: 0.035, dwellMax: 60, bonus: 4, ivtWeight: 0.9, kwhKm: 3.2, co2Km: 0,
      },
      bus: {
        label: 'Bus articulé en voies réservées', capacity: 105, length: 18.9, width: 2.6,
        headway: { peak: 2.5, shoulder: 3, day: 6, evening: 10 },
        cruise: 38, cruiseTunnel: 26, stopLoss: 22, junctionDelay: 14, junctionEvery: 400,
        dwellBase: 12, dwellPerPax: 0.09, dwellMax: 110, bonus: 1, ivtWeight: 1.0, kwhKm: 0, co2Km: 0.9,
      },
    },
    // voie réservée aux Cybercab sur le tracé : vitesse des convois (km/h) et capacité d'une voie (véh/h)
    cabLane: { speed: 45, capacity: 2400 },
    cab: {
      seats: 2, occupancy: 1.4, batteryKwh: 47.6, kwhKm: 0.11, maxEtaMin: 12, chargeMin: 25, reserve: 0.15,
      fareBase: 3.5, farePerKm: 1.2, captivity: 9, corridorRadius: 1200, rebalanceIdleMin: 20,
      localKmLoaded: 0.6, localKmEmpty: 0.3, // rues locales non modélisées, aux deux bouts d'une course
      // courses partagées : rabais, détour ressenti (min), attente et détour maximaux pour jumeler deux demandes (min)
      poolDiscount: 0.2, poolPerceivedMin: 2, poolMaxWaitMin: 6, poolMaxDetourMin: 5,
    },
  };

  /** Générateur pseudo-aléatoire déterministe (mulberry32). */
  TQ.rng = function (seed) {
    let a = seed >>> 0;
    return function () {
      a = (a + 0x6d2b79f5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  };

  TQ.poisson = function (lambda, rnd) {
    if (lambda <= 0) return 0;
    if (lambda > 30) {
      const u = Math.sqrt(-2 * Math.log(1 - rnd())) * Math.cos(2 * Math.PI * rnd());
      return Math.max(0, Math.round(lambda + Math.sqrt(lambda) * u));
    }
    const L = Math.exp(-lambda);
    let k = 0, p = 1;
    do { k++; p *= rnd(); } while (p > L);
    return k - 1;
  };

  const LAT0 = 46.8, LON0 = -71.28;
  const KX = 111320 * Math.cos((LAT0 * Math.PI) / 180), KY = 110574;
  TQ.geo = {
    KX, KY,
    x: (lon) => (lon - LON0) * KX,
    y: (lat) => (lat - LAT0) * KY,
    dist: (lon1, lat1, lon2, lat2) => Math.hypot((lon1 - lon2) * KX, (lat1 - lat2) * KY),
  };

  TQ.sigmoid = (x) => 1 / (1 + Math.exp(-x));

  /** Recherche dans une distribution cumulée. */
  TQ.pick = function (cum, r) {
    let lo = 0, hi = cum.length - 1;
    const target = r * cum[hi];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cum[mid] > target) hi = mid; else lo = mid + 1;
    }
    return lo;
  };

  /**
   * Pour l'affichage : découpe un tracé (coords, avec cum : distance cumulée en mètres) en portions couvertes par
   * au moins un des intervalles `spans` ([début, fin] en mètres le long du tracé) et en portions non couvertes.
   * Deux intervalles séparés de moins de `tol` mètres sont joints, et un bout de moins de `tol` mètres en début ou
   * en fin de tracé est rattaché à la portion voisine. Retourne { on, off } : listes de { s0, s1, path }.
   */
  TQ.lineCover = function (coords, cum, spans, tol) {
    const total = cum[cum.length - 1], merged = [];
    const sorted = spans.map((x) => [Math.max(0, Math.min(x[0], x[1])), Math.min(total, Math.max(x[0], x[1]))]).filter((x) => x[1] > x[0]).sort((a, b) => a[0] - b[0]);
    for (const x of sorted) {
      const l = merged[merged.length - 1];
      if (l && x[0] <= l[1] + tol) { if (x[1] > l[1]) l[1] = x[1]; } else merged.push(x);
    }
    if (merged.length) {
      if (merged[0][0] <= tol) merged[0][0] = 0;
      if (merged[merged.length - 1][1] >= total - tol) merged[merged.length - 1][1] = total;
    }
    const at = (s) => {
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
      const t = cum[hi] > cum[lo] ? (s - cum[lo]) / (cum[hi] - cum[lo]) : 0;
      return [coords[lo][0] + (coords[hi][0] - coords[lo][0]) * t, coords[lo][1] + (coords[hi][1] - coords[lo][1]) * t];
    };
    const piece = (s0, s1) => {
      const path = [at(s0)];
      for (let i = 0; i < cum.length; i++) if (cum[i] > s0 && cum[i] < s1) path.push(coords[i]);
      path.push(at(s1));
      return { s0, s1, path };
    };
    const on = merged.map((x) => piece(x[0], x[1])), off = [];
    let s = 0;
    for (const x of merged) { if (x[0] > s) off.push(piece(s, x[0])); s = x[1]; }
    if (s < total) off.push(piece(s, total));
    return { on, off };
  };

  TQ.formatClock = function (t) {
    const s = ((t % 86400) + 86400) % 86400;
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60);
    return (h < 10 ? '0' : '') + h + ' h ' + (m < 10 ? '0' : '') + m;
  };

  /** Type de période de service pour une heure donnée. */
  TQ.servicePeriod = function (t) {
    const h = ((t % 86400) / 3600);
    if (h >= 1 && h < 5) return 'closed';
    if ((h >= 6.5 && h < 9) || (h >= 15 && h < 18)) return 'peak';
    if ((h >= 6 && h < 6.5) || (h >= 9 && h < 9.5) || (h >= 14.5 && h < 15) || (h >= 18 && h < 18.5)) return 'shoulder';
    if (h >= 9.5 && h < 14.5) return 'day';
    if (h >= 18.5 && h < 20) return 'day';
    return 'evening';
  };
})();
