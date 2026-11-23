/* Rentabilité d'un scénario : résultat financier de l'exploitant, puis bilan pour la société.
   Montants en dollars canadiens. Les sources sont dans web/js/assumptions.js. */
(function () {
  const TQ = (globalThis.TQ = globalThis.TQ || {});

  TQ.ECON = {
    daysPerYear: 300, // une journée de semaine simulée pèse 1/300 de l'année (fins de semaine moins chargées)
    discount: 0.04, // taux réel pour étaler l'investissement
    transitFare: 2.53, // recette moyenne par déplacement, budget 2026 du RTC
    line: {
      tram: { capex: 7.6e9, life: 40, opexKm: 16, fixedYear: 12e6 },
      bus: { capex: 1.4e9, life: 30, opexKm: 10.5, fixedYear: 3e6 },
    },
    // Cybercab : chaque poste a sa valeur, sa durée de vie et sa source dans web/js/assumptions.js (STORY-024).
    // Conversions des dollars américains (hypothèses, taux non vérifiés auprès de la Banque du Canada) :
    // 1,33 pour 2019, 1,30 pour 2022, 1,40 pour 2026.
    cab: {
      vehicle: 42000, life: 5, // véhicule : 29 990 $ US (Electrek, 17 nov. 2026) × 1,40 ; durée de vie : hypothèse
      // exploitation hors nettoyage et supervision, désormais comptés à part (0,25 $ avant STORY-024) : hypothèse
      opexKm: 0.15,
      fixedYearPerVeh: 4000, // immatriculation, logiciels et frais généraux, par véhicule et par an : hypothèse
      // bornes de 150 kW (hypothèse) : 75 000 $ US de matériel + 18 577 $ US d'installation sur un site de 6 à 20 bornes
      // (ICCT 2019, tableaux 2 et 4) × 1,33, arrondi, non indexé ; durée de vie et entretien : hypothèses
      charger: { cost: 125000, kw: 150, life: 10, maintYear: 2500 },
      vehPerCharger: 13, // repli pour un ancien résumé sans nombre de bornes : 1 borne pour 13 taxis (NYC TLC, 2013)
      grid: { perKw: 300, life: 40 }, // raccordement par kW de bornes : hypothèse ; 40 ans (réseau électrique, Terrebonne 2019)
      depotMaxKw: 5000, // kW de bornes par dépôt : reste au tarif M (moins de 5 000 kW) et sous 5 MW (autorisation) : hypothèse
      // dépôts : stationnement de surface et bâtiment (lavage, entretien), terrain compris
      depot: {
        parkM2: 30, // m² par véhicule, allées comprises (VTPI : 25 à 35 m² par place)
        buildM2: 5, // m² de bâtiment par véhicule : hypothèse
        landM2: 175, // $/m² : terrains municipaux des parcs industriels de Québec, 140 à 215 $/m² pour la plupart (oct. 2025)
        paveM2: 200, // $/m² : stationnement de surface, 12 à 25 $/pi² (Altus 2026, Montréal)
        buildCostM2: 2000, // $/m² : haut de la plage des entrepôts, 120 à 185 $/pi² (Altus 2026, Montréal)
        indirect: 0.35, // coûts indirects : 30 à 40 % (VTPI)
        paveLife: 20, buildLife: 40, // politique d'amortissement de Terrebonne (2019)
        parkOpexPerVeh: 650, // entretien et déneigement : 500 $ US par place et par an (VTPI 2022) × 1,30
        propertyTax: 0.030642, // Ville de Québec 2026, non résidentiel, appliqué au coût du dépôt (évaluation = coût : hypothèse)
        surfaceTaxM2: 0.71, // Ville de Québec 2026, stationnement extérieur au-delà de 1 000 m², secteur urbain (secteur supposé)
      },
      // électricité : tarif M d'Hydro-Québec au 1er avril 2026, un abonnement par dépôt
      power: { demandKwMonth: 18.242, energy1: 0.06292, energy1Kwh: 210000, energy2: 0.04666 },
      // supervision à distance : 1 agent pour 40 véhicules en circulation (WeRide, mars 2026) ; salaire : hypothèse
      supervision: { vehPerAgent: 40, wageH: 32 },
      // nettoyage : 15 min par véhicule et par jour (hypothèse), laveur à 21,71 $/h (Guichet-Emplois, Capitale-Nationale)
      cleaning: { minPerVehDay: 15, wageH: 21.71 },
      payrollLoad: 0.25, // charges sociales et avantages ajoutés aux salaires : hypothèse
    },
    // bilan pour la société
    vot: 22, // valeur d'une heure de déplacement ($)
    carbon: 275, // coût social d'une tonne de CO2 ($), Environnement et Changement climatique Canada
    carOccupancy: 1.21,
    cabOccupancy: 1.4, // passagers par course de Cybercab, comme dans le moteur
  };
  TQ.ECON_DEFAULTS = JSON.parse(JSON.stringify(TQ.ECON));

  // annuité constante : part d'un investissement à payer chaque année pendant n ans
  TQ.annuity = (rate, years) => (rate > 0 ? rate / (1 - Math.pow(1 + rate, -years)) : 1 / years);

  /** Coûts de la flotte de Cybercab, poste par poste, pour le résumé s (s.cab requis).
   *  capex : investissement par poste ($) ; capitalYear : investissement étalé par an, chaque poste sur sa durée de vie
   *  (le terrain ne s'use pas : seul son coût d'opportunité, au taux réel, est compté) ;
   *  opex : km, fixed, supervision et cleaning pour la période simulée ; energy, demand, chargers, depot et tax par an.
   *  Un ancien résumé sans nombre de bornes (s.cab.chargers) prend le ratio de repli vehPerCharger.
   *  sizing (facultatif) : { chargers, chargePeakKw } à prendre à la place de ceux du résumé, pour dimensionner les
   *  bornes de plusieurs journées enchaînées sur la plus forte pointe (TQ.economicsTotal). */
  TQ.cabCosts = function (s, E, sizing) {
    E = E || TQ.ECON;
    const p = E.cab, d = p.depot, k = s.cab, fleet = k.fleet, z = sizing || k;
    const frac = Math.max(0, s.elapsedH) / 24;
    const fromRatio = !Number.isFinite(z.chargers) || z.chargers < 0;
    const chargers = fromRatio ? Math.ceil(fleet / p.vehPerCharger) : z.chargers;
    const kwInstalled = chargers * p.charger.kw;
    // pointe appelée : mesurée ; sinon, les bornes sans la marge, chacune à la puissance moyenne d'une recharge
    // (batteryKwh × (1 − réserve) en chargeMin minutes), comme la pointe mesurée
    const C = (TQ.PARAMS && TQ.PARAMS.cab) || {}, margin = C.chargerMargin || 0;
    const kwCharge = C.batteryKwh > 0 && C.chargeMin > 0 ? (C.batteryKwh * (1 - (C.reserve || 0))) / (C.chargeMin / 60) : p.charger.kw;
    const peakKw = Number.isFinite(z.chargePeakKw) && z.chargePeakKw >= 0 ? z.chargePeakKw : (chargers / (1 + margin)) * kwCharge;
    const depots = Math.max(1, Math.ceil(kwInstalled / p.depotMaxKw - 1e-9));
    const parkM2 = fleet * d.parkM2, buildM2 = fleet * d.buildM2;
    const capex = {
      vehicles: fleet * p.vehicle,
      chargers: chargers * p.charger.cost,
      grid: kwInstalled * p.grid.perKw,
      land: (parkM2 + buildM2) * d.landM2,
      pave: parkM2 * d.paveM2 * (1 + d.indirect),
      build: buildM2 * d.buildCostM2 * (1 + d.indirect),
    };
    const capexTotal = capex.vehicles + capex.chargers + capex.grid + capex.land + capex.pave + capex.build;
    const ann = (v, life) => v * TQ.annuity(E.discount, life);
    const capitalYear = ann(capex.vehicles, p.life) + ann(capex.chargers, p.charger.life) + ann(capex.grid, p.grid.life)
      + capex.land * E.discount + ann(capex.pave, d.paveLife) + ann(capex.build, d.buildLife);
    // électricité, tarif M, un abonnement par dépôt : énergie en deux tranches chaque mois, prime sur la pointe chaque
    // mois. La pointe de la journée simulée est supposée atteinte chaque mois (le plancher de 65 % de l'hiver est couvert).
    const W = p.power, yearKwh = frac > 0 ? (k.kwh * E.daysPerYear) / frac : 0, monthKwh = yearKwh / 12 / depots;
    const energy = 12 * depots * (Math.min(monthKwh, W.energy1Kwh) * W.energy1 + Math.max(0, monthKwh - W.energy1Kwh) * W.energy2);
    const demand = 12 * W.demandKwMonth * peakKw;
    const load = 1 + p.payrollLoad;
    // supervision : heures de circulation (kilomètres à la vitesse moyenne de la flotte) divisées par vehPerAgent
    const vh = k.speed > 0 ? (k.vkmEmpty + k.vkmLoaded) / k.speed : 0;
    const opex = {
      km: (k.vkmEmpty + k.vkmLoaded) * p.opexKm,
      fixed: ((fleet * p.fixedYearPerVeh) / E.daysPerYear) * frac,
      supervision: (vh / p.supervision.vehPerAgent) * p.supervision.wageH * load,
      cleaning: fleet * (p.cleaning.minPerVehDay / 60) * p.cleaning.wageH * load * frac,
      energy, demand,
      chargers: chargers * p.charger.maintYear,
      depot: fleet * d.parkOpexPerVeh,
      tax: (capex.land + capex.pave + capex.build) * d.propertyTax + depots * Math.max(0, parkM2 / depots - 1000) * d.surfaceTaxM2,
    };
    return { chargers, fromRatio, kwInstalled, peakKw, depots, parkM2, buildM2, vh, capex, capexTotal, capitalYear, opex };
  };

  /** s : résultat de Simulation.summary(). Les montants couvrent la période simulée (s.elapsedH). */
  TQ.economics = function (s, E, cabSizing) {
    E = E || TQ.ECON;
    const frac = Math.max(0, s.elapsedH) / 24; // part de journée écoulée
    const perDay = (yearly) => (yearly / E.daysPerYear) * frac;
    const parts = [];
    if (s.line) {
      const p = E.line[s.line.kind];
      parts.push({
        key: 'line', kind: s.line.kind, capex: p.capex, riders: s.line.boardings,
        revenue: s.line.boardings * E.transitFare,
        opex: s.line.vehKm * p.opexKm + perDay(p.fixedYear),
        capital: perDay(p.capex * TQ.annuity(E.discount, p.life)),
      });
    }
    if (s.cab) {
      const c = TQ.cabCosts(s, E, cabSizing), cap = c.capex, op = c.opex;
      parts.push({
        key: 'cab', kind: 'cab', capex: c.capexTotal, riders: s.cab.rides,
        revenue: s.cab.revenue || 0,
        opex: op.km + op.fixed + op.supervision + op.cleaning + perDay(op.energy + op.demand + op.chargers + op.depot + op.tax),
        capital: perDay(c.capitalYear),
        // détail de l'investissement par poste, avec le nombre de bornes et de dépôts (panneau et tableau annuel)
        items: { vehicles: cap.vehicles, chargers: cap.chargers, grid: cap.grid, depots: cap.land + cap.pave + cap.build, nChargers: c.chargers, nDepots: c.depots, chargersFromRatio: c.fromRatio },
      });
    }
    const out = { parts, capex: 0, riders: 0, revenue: 0, opex: 0, capital: 0 };
    for (const p of parts) {
      p.operating = p.revenue - p.opex; p.net = p.operating - p.capital;
      for (const k of ['capex', 'riders', 'revenue', 'opex', 'capital']) out[k] += p[k];
    }
    out.operating = out.revenue - out.opex;
    out.net = out.operating - out.capital;
    out.netPerRider = out.riders > 0 ? out.net / out.riders : 0;
    out.costCoverage = out.opex + out.capital > 0 ? out.revenue / (out.opex + out.capital) : 0;

    // --- bilan pour la société : les tarifs payés ne sont qu'un transfert entre voyageurs et exploitants
    const soc = (out.society = { riders: 0, carFree: null, drivers: null, co2: 0, rtcLoss: 0 });
    if (parts.length || (s.scenario && s.scenario.auto)) {
      // voyageurs qui changent de mode : temps et argent gagnés (tarif compris)
      soc.riders = ((s.riderGainH || 0) * E.vot);
      // une course partagée coûte à chacun moins que le plein tarif sur lequel il a choisi : l'écart revient aux voyageurs
      if (s.cab) soc.riders += (s.cab.revenue || 0) * (E.cabOccupancy - 1);
      // déplacements faits sans auto (abandon de l'auto) : écart net de coût généralisé avec l'auto, compté en entier.
      // Poste à part : ces voyageurs n'ont pas choisi leur nouveau mode. null quand l'option est inactive.
      if (s.scenario && s.scenario.carFree > 0 && s.cab) {
        soc.carFree = (s.carFreeGapH || 0) * E.vot;
        // Leur écart est compté au plein tarif du Cybercab, alors qu'une course de 1,4 personne ne rapporte qu'un tarif :
        // la part du rabais d'occupation qui vient de leurs courses va dans leur poste, pas dans le gain de ceux qui ont choisi.
        const rebate = Math.min(((s.carFreeCabFare || 0) * (E.cabOccupancy - 1)) / E.cabOccupancy, (s.cab.revenue || 0) * (E.cabOccupancy - 1));
        soc.riders -= rebate; soc.carFree += rebate;
      }
      // recettes que perd le réseau d'autobus actuel quand ses usagers passent à la ligne ou au Cybercab
      const fromRtc = s.fromRtc != null ? s.fromRtc : ((s.lineFrom && s.lineFrom.rtc) || 0) + ((s.cabFrom && s.cabFrom.rtc) || 0);
      // (moins ceux qui y reviennent parce qu'ils n'ont plus d'auto)
      soc.rtcLoss = -(fromRtc - (s.toRtc || 0)) * E.transitFare;
      soc.co2 = (s.co2Avoided || 0) * E.carbon;
      // automobilistes restants : écart de temps perdu par kilomètre avec la journée de référence
      const ref = TQ.REFERENCE && TQ.REFERENCE[s.scenario && s.scenario.winter ? 'winter' : 'normal'];
      if (ref && s.carVkm > 0) soc.drivers = (ref.delayPerVkm - s.carDelayH / s.carVkm) * s.carVkm * E.carOccupancy * E.vot;
      // parc autonome : la vitesse libre change aussi (plus d'arrêts aux feux), on compare donc le temps total par kilomètre
      if (ref && ref.vhPerVkm && s.carVkm > 0 && s.carVh > 0 && s.scenario && s.scenario.auto) soc.drivers = (ref.vhPerVkm - s.carVh / s.carVkm) * s.carVkm * E.carOccupancy * E.vot;
    }
    soc.net = out.net + soc.riders + (soc.carFree || 0) + soc.rtcLoss + soc.co2 + (soc.drivers || 0);

    // projection annuelle : n'a de sens que pour une journée complète
    const k = frac > 0 ? E.daysPerYear / frac : 0;
    out.annual = {
      revenue: out.revenue * k, opex: out.opex * k, capital: out.capital * k, operating: out.operating * k, net: out.net * k,
      society: { riders: soc.riders * k, carFree: soc.carFree == null ? null : soc.carFree * k, drivers: soc.drivers == null ? null : soc.drivers * k, co2: soc.co2 * k, rtcLoss: soc.rtcLoss * k, net: soc.net * k },
    };
    return out;
  };

  /** Rentabilité cumulée de l'exploitant sur plusieurs journées enchaînées du même scénario (Simulation.runSummaries()).
   *  Additionne recettes, exploitation, investissement étalé, résultats et voyageurs de chaque journée, au total et par
   *  partie ; l'investissement (capex) et les parties sont ceux du scénario (dernière journée). days : journées entamées.
   *  Cybercab : les bornes de toutes les journées sont dimensionnées sur la plus forte pointe de la liste, pour que la
   *  journée qui commence ne compte pas 0 borne ; items.peakSoFar est vrai tant qu'aucune journée complète n'est finie. */
  TQ.economicsTotal = function (list, E) {
    const keys = ['riders', 'revenue', 'opex', 'capital', 'operating', 'net'];
    const out = { parts: [], capex: 0, days: 0, riders: 0, revenue: 0, opex: 0, capital: 0, operating: 0, net: 0 };
    if (!list || !list.length) return out;
    const sized = list.filter((s) => s.cab && Number.isFinite(s.cab.chargers) && s.cab.chargers >= 0);
    const sizing = sized.length ? {
      chargers: Math.max(...sized.map((s) => s.cab.chargers)),
      chargePeakKw: Math.max(...sized.map((s) => (Number.isFinite(s.cab.chargePeakKw) ? s.cab.chargePeakKw : 0))),
    } : null;
    const all = list.map((s) => TQ.economics(s, E, sizing)), last = all[all.length - 1];
    const peakSoFar = !list.some((s) => s.cab && s.elapsedH >= 24 - 1e-6);
    out.capex = last.capex;
    out.parts = last.parts.map((p) => {
      const q = { key: p.key, kind: p.kind, capex: p.capex };
      if (p.items) q.items = Object.assign({}, p.items, { peakSoFar });
      for (const k of keys) q[k] = 0;
      return q;
    });
    list.forEach((s, i) => {
      if (s.elapsedH > 0) out.days++;
      for (const k of keys) out[k] += all[i][k];
      for (const p of all[i].parts) { const q = out.parts.find((x) => x.key === p.key); if (q) for (const k of keys) q[k] += p[k]; }
    });
    return out;
  };
})();
