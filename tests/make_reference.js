// Simule la journée de référence (aucune ligne, aucune flotte), en conditions normales et en hiver,
// et écrit web/js/engine/reference.js. À relancer après tout changement du moteur ou des données.
// Usage : node tests/make_reference.js
const fs = require('fs');
const path = require('path');
const { TQ, data } = require('./load');
const out = {};
for (const [key, winter] of [['normal', false], ['winter', true]]) {
  const sim = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off', winter } });
  while (!sim.history.length) sim.step(10);
  const s = sim.history[0];
  out[key] = { carVkm: Math.round(s.carVkm), carDelayH: Math.round(s.carDelayH), delayPerVkm: +(s.carDelayH / s.carVkm).toFixed(9), vhPerVkm: +(s.carVh / s.carVkm).toFixed(9) };
  console.log(key, out[key]);
}
const js = `/* Journée de référence (situation actuelle), produite par tests/make_reference.js. Ne pas modifier à la main. */
(function () {
  const TQ = (globalThis.TQ = globalThis.TQ || {});
  TQ.REFERENCE = ${JSON.stringify(out)};
})();
`;
fs.writeFileSync(path.join(__dirname, '..', 'web', 'js', 'engine', 'reference.js'), js);
