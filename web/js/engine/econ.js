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
    cab: { vehicle: 42000, infraPerVeh: 8000, life: 5, opexKm: 0.25, kwhPrice: 0.12, fixedYearPerVeh: 4000 },
    // bilan pour la société
    vot: 22, // valeur d'une heure de déplacement ($)
    carbon: 275, // coût social d'une tonne de CO2 ($), Environnement et Changement climatique Canada
    carOccupancy: 1.21,
    cabOccupancy: 1.4, // passagers par course de Cybercab, comme dans le moteur
  };
  TQ.ECON_DEFAULTS = JSON.parse(JSON.stringify(TQ.ECON));

  // annuité constante : part d'un investissement à payer chaque année pendant n ans
  TQ.annuity = (rate, years) => (rate > 0 ? rate / (1 - Math.pow(1 + rate, -years)) : 1 / years);

  /** s : résultat de Simulation.summary(). Les montants couvrent la période simulée (s.elapsedH). */
  TQ.economics = function (s, E) {
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
      const p = E.cab, capex = s.cab.fleet * (p.vehicle + p.infraPerVeh);
      parts.push({
        key: 'cab', kind: 'cab', capex, riders: s.cab.rides,
        revenue: s.cab.revenue || 0,
        opex: (s.cab.vkmEmpty + s.cab.vkmLoaded) * p.opexKm + s.cab.kwh * p.kwhPrice + perDay(s.cab.fleet * p.fixedYearPerVeh),
        capital: perDay(capex * TQ.annuity(E.discount, p.life)),
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
})();
