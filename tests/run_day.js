// Exécute une journée complète hors navigateur et affiche le bilan.
// Usage : node tests/run_day.js [none|tram|bus] [off|corridor|wide] [flotte] [heures]
const { TQ, data } = require('./load');
const [line = 'none', cab = 'off', fleet = '3000', hours = '24'] = process.argv.slice(2);
let t0 = Date.now();
const sim = new TQ.Simulation(data, { scenario: { line, cab, fleet: +fleet } });
console.log('init ms', Date.now() - t0, 'D', sim.net.D);
t0 = Date.now();
const H = +hours;
let maxV = 0;
for (let h = 0; h < H; h++) {
  for (let k = 0; k < 360; k++) { sim.step(10); if (sim.net.vn > maxV) maxV = sim.net.vn; }
  const s = h === 23 ? sim.history[sim.history.length - 1] : sim.summary();
  if (h === 23 || process.env.VERBOSE || h === 3 || h === 11) console.log(`${TQ.formatClock(sim.t)} agents=${sim.net.vn} v=${sim.cur.speed.toFixed(1)}km/h cong=${(sim.cur.congestion * 100).toFixed(0)}%`, sim.line ? `ligne à bord=${sim.line.onboardNow()} attente=${sim.line.waitingNow()} véh=${sim.line.inService()}` : '');
}
console.log('durée ms', Date.now() - t0, 'max agents', maxV);
const s = sim.history.length ? sim.history[sim.history.length - 1] : sim.summary();
console.log(JSON.stringify(s, (k, v) => (typeof v === 'number' ? Math.round(v * 100) / 100 : v), 1));
if (process.env.COUNTS) {
  // calage : débits journaliers simulés vs DJMA
  const rows = data.counts.map((c) => ({ name: c.name, djma: c.djma, sim: ((sim.lastDayFlows||sim.net.eday)[c.edges[0]] + (sim.lastDayFlows||sim.net.eday)[c.edges[1]]) * TQ.PARAMS.truckFactor }));
  const ratios = rows.map((r) => r.sim / r.djma).sort((a, b) => a - b);
  console.log('DJMA n=', rows.length, 'ratio médian', ratios[ratios.length >> 1].toFixed(2), 'p25', ratios[ratios.length >> 2].toFixed(2), 'p75', ratios[(ratios.length * 3) >> 2].toFixed(2));
  rows.sort((a, b) => b.djma - a.djma).slice(0, 14).forEach((r) => console.log(String(r.djma).padStart(7), String(Math.round(r.sim)).padStart(7), r.name));
}
