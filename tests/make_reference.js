// Simule la journée de référence (aucune ligne, aucune flotte), en conditions normales et en hiver, puis à la date
// représentative de chaque journée type du bilan sur un an (TQ.yearPlan(2027) ; les représentants de 2026 ont les
// mêmes facteurs, voies et grille : une seule référence par type sert aux deux années), et écrit
// web/js/engine/reference.js. À relancer après tout changement du moteur ou des données.
// Le type d'automne n'a pas de clé : sa journée est celle de « normal » (repli de TQ.referenceFor).
// Usage : node tests/make_reference.js  (environ 3 min : 13 journées)
const fs = require('fs');
const path = require('path');
const { TQ, data } = require('./load');
const out = {};
const runs = [['normal', { winter: false }], ['winter', { winter: true }]];
for (const g of TQ.yearPlan(2027).groups) if (g.key !== 'ouv-automne') runs.push([g.key, { date: g.date }]);
for (const [key, extra] of runs) {
  const sim = new TQ.Simulation(data, { scenario: Object.assign({ line: 'none', cab: 'off' }, extra) });
  while (!sim.history.length) sim.step(10);
  const s = sim.history[0];
  out[key] = { carVkm: Math.round(s.carVkm), carDelayH: Math.round(s.carDelayH), delayPerVkm: +(s.carDelayH / s.carVkm).toFixed(9), vhPerVkm: +(s.carVh / s.carVkm).toFixed(9) };
  if (extra.date) out[key].date = extra.date;
  console.log(key, out[key]);
}
const js = `/* Journée de référence (situation actuelle), produite par tests/make_reference.js. Ne pas modifier à la main. */
(function () {
  const TQ = (globalThis.TQ = globalThis.TQ || {});
  TQ.REFERENCE = ${JSON.stringify(out)};
})();
`;
fs.writeFileSync(path.join(__dirname, '..', 'web', 'js', 'engine', 'reference.js'), js);
