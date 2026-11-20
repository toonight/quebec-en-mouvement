// Rentabilité comparée : une journée complète par scénario, projetée sur l'année.
// Usage : node tests/econ_report.js
const { TQ, data } = require('./load');
const SCENARIOS = [
  ['tram', 'off', 0], ['bus', 'off', 0],
  ['none', 'corridor', 1000], ['none', 'wide', 1500], ['none', 'wide', 3000], ['none', 'wide', 6000],
  ['tram', 'wide', 3000], ['bus', 'wide', 3000],
];
const M = (v) => (v / 1e6).toFixed(1).padStart(8);
console.log('scénario'.padEnd(46), 'invest.M$', 'recettes', '  exploit.', ' capital', ' rés.expl', '  rés.net', ' $/pass', ' passagers/j');
for (const [line, cab, fleet] of SCENARIOS) {
  const sim = new TQ.Simulation(data, { scenario: { line, cab, fleet: fleet || 3000 } });
  while (!sim.history.length) sim.step(10);
  const s = sim.history[0], e = TQ.economics(s), a = e.annual;
  console.log(s.label.padEnd(46), M(e.capex), M(a.revenue), M(a.opex), M(a.capital), M(a.operating), M(a.net), e.netPerRider.toFixed(2).padStart(7), String(Math.round(e.riders)).padStart(9),
    s.cab ? ` | cab: ${Math.round(s.cab.rides)} pass., ${(s.cab.emptyShare * 100).toFixed(0)} % à vide, ${Math.round((s.cab.vkmEmpty + s.cab.vkmLoaded) / s.cab.fleet)} km/véh` : '',
    s.line ? ` | ligne: ${Math.round(s.line.vehKm)} véh-km` : '');
}
