// Rentabilité comparée : une journée complète par scénario, projetée sur l'année (M$ par an).
// Usage : node tests/econ_report.js  (--modes : tableau des trois modes publié dans le README)
const { TQ, data } = require('./load');
const transitReport = process.argv.includes('--modes') || process.argv.includes('--bus-cab');
const SCENARIOS = [
  ['tram', 'off', 0], ['bus', 'off', 0],
  ['none', 'corridor', 500], ['none', 'wide', 1500], ['none', 'wide', 3000], ['none', 'wide', 6000],
];
const M = (v) => (v == null ? '–' : (v / 1e6).toFixed(1)).padStart(8);
// trois choix exclusifs sur le tracé : tramway seul, autobus seuls, ou Cybercab sans ligne (dans la circulation)
// avec la flotte le long du tracé ou sur le réseau élargi (jamais une ligne et une flotte ensemble)
const transitScenarios = SCENARIOS.concat([
  ['none', 'corridor', 500, true], ['none', 'wide', 1500, true], ['none', 'wide', 3000, true],
]);
if (transitReport) console.log('Scénario | prix perçu | montées sur la ligne/j | passagers cab/j | exploitant M$/an | société M$/an | CO₂ évité t/j');
else console.log('scénario'.padEnd(52), ' invest.', 'recettes', ' exploit.', ' capital', 'rés.expl', ' rés.net', '| voyag.', 'sans auto', ' automob.', '    CO2', 'perte RTC', ' SOCIÉTÉ', '| pass./j');
for (const [line, cab, fleet, farePerOccupant = false] of transitReport ? transitScenarios : SCENARIOS) {
  const sim = new TQ.Simulation(data, { scenario: { line, cab, fleet: fleet || 3000, farePerOccupant } });
  while (!sim.history.length) sim.step(10);
  const s = sim.history[0], e = TQ.economics(s), a = e.annual, y = a.society;
  if (transitReport) {
    console.log([s.label, !s.cab ? '-' : farePerOccupant ? 'par occupant' : 'course entière',
      s.line?.boardings ?? 0, s.cab?.rides ?? 0, M(a.net).trim(), M(y.net).trim(), s.co2Avoided.toFixed(1)].join(' | '));
    continue;
  }
  console.log(s.label.padEnd(52), M(e.capex), M(a.revenue), M(a.opex), M(a.capital), M(a.operating), M(a.net), '|', M(y.riders), M(y.carFree), M(y.drivers), M(y.co2), M(y.rtcLoss), M(y.net), '|', String(Math.round(e.riders)).padStart(7),
    s.cab ? ` | cab: ${(s.cab.emptyShare * 100).toFixed(0)} % à vide, ${Math.round((s.cab.vkmEmpty + s.cab.vkmLoaded) / s.cab.fleet)} km/véh, course ${(s.cab.rideKm / (s.cab.rides / TQ.PARAMS.cab.occupancy)).toFixed(1)} km` : '',
    s.line ? ` | ligne: ${Math.round(s.line.vehKm)} véh-km` : '');
}
