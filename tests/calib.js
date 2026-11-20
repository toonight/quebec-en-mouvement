// Calage : congestion par période, débits DJMA et achalandage de la ligne pour une journée complète.
// Usage : node tests/calib.js [none|tram|bus] [off|corridor|wide] [flotte]
const { TQ, data } = require('./load');
const [line = 'none', cab = 'off', fleet = '3000'] = process.argv.slice(2);
const sim = new TQ.Simulation(data, { scenario: { line, cab, fleet: +fleet } });
let series = null;
while (!sim.history.length) { series = sim.series; sim.step(10); }
const s = sim.history[0];
const mean = (h0, h1) => {
  let a = 0, n = 0;
  series.t.forEach((t, i) => { const h = t / 3600; if (h > h0 && h <= h1) { a += series.congestion[i]; n++; } });
  return n ? ((a / n) * 100).toFixed(0) : '–';
};
const flows = sim.lastDayFlows;
const ratios = data.counts.map((c) => ((flows[c.edges[0]] + flows[c.edges[1]]) * TQ.PARAMS.truckFactor) / c.djma).sort((a, b) => a - b);
console.log(`${s.label} | congestion jour +${(s.congestion * 100).toFixed(0)} % | matin 7-9 h +${mean(7, 9)} % | midi 10-15 h +${mean(10, 15)} % | soir 16-18 h +${mean(16, 18)} % | soirée 19-22 h +${mean(19, 22)} %`);
console.log(`  vitesse auto ${s.avgSpeed.toFixed(1)} km/h | DJMA médian ${ratios[ratios.length >> 1].toFixed(2)} (p25 ${ratios[ratios.length >> 2].toFixed(2)}, p75 ${ratios[(ratios.length * 3) >> 2].toFixed(2)})`
  + (s.line ? ` | ligne ${Math.round(s.line.boardings)} montées, charge max ${Math.round(s.line.peakLoad)}, ${s.line.speed.toFixed(1)} km/h` : '')
  + (s.cab ? ` | cab ${Math.round(s.cab.rides)} pass., ${(s.cab.emptyShare * 100).toFixed(0)} % à vide` : ''));
