// Profil de congestion sur la journée (référence) : node tests/profile.js
const { TQ, data } = require('./load');
const sim = new TQ.Simulation(data, { scenario: { line: process.argv[2] || 'none', cab: 'off' } });
for (let i = 0; i < 24 * 360 - 1; i++) sim.step(10);
const s = sim.series, byH = {};
s.t.forEach((t, i) => { const h = Math.floor((t - 1) / 3600) % 24; (byH[h] = byH[h] || []).push(s.congestion[i]); });
console.log(Object.keys(byH).map(Number).sort((a, b) => ((a + 19) % 24) - ((b + 19) % 24)).map((h) => `${h}h:${Math.round((byH[h].reduce((a, b) => a + b, 0) / byH[h].length) * 100)}`).join(' '));
const sum = sim.summary();
console.log('moyenne journée', (sum.congestion * 100).toFixed(0) + ' %', 'vitesse', sum.avgSpeed.toFixed(1));
