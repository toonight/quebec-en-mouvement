/* Rentabilité financière d'un scénario : recettes, exploitation, coût annualisé de l'investissement.
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
  };

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
    // projection annuelle : n'a de sens que pour une journée complète
    const k = frac > 0 ? E.daysPerYear / frac : 0;
    out.annual = { revenue: out.revenue * k, opex: out.opex * k, capital: out.capital * k, operating: out.operating * k, net: out.net * k };
    return out;
  };
})();
