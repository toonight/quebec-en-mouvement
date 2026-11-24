// The packed dataset installs itself on window in the static site.
self.window = self;
importScripts('../data/network.js', 'engine/core.js', 'engine/network.js', 'engine/line.js', 'engine/cabs.js', 'engine/calendar.js', 'engine/sim.js');

// Deux messages :
// - { scenario, seed } : une journée complète, renvoyée telle quelle (résumé), puis le worker se ferme ;
// - { kind: 'year', scenario, seed, days: [{ key, date }] } : bilan sur un an, les journées types reçues simulées l'une
//   après l'autre. Renvoie { kind: 'progress', key, done, hour } pendant chaque journée (toutes les heures simulées),
//   { kind: 'day', key, summary } à la fin de chacune, puis { kind: 'done' } et se ferme. L'annulation se fait de la
//   page, en arrêtant le worker (terminate).
self.onmessage = ({ data }) => {
  if (data && data.kind === 'year') {
    data.days.forEach(({ key, date }, i) => {
      const sim = new TQ.Simulation(self.TQ_DATA, { seed: data.seed, scenario: Object.assign({}, data.scenario, { date }) });
      let lastH = -1;
      while (!sim.history.length) {
        sim.step(10);
        const h = Math.floor((sim.t - sim.tDayStart) / 3600);
        if (h !== lastH) { lastH = h; self.postMessage({ kind: 'progress', key, done: i, hour: h }); }
      }
      self.postMessage({ kind: 'day', key, summary: sim.history[0] });
    });
    self.postMessage({ kind: 'done' });
    self.close();
    return;
  }
  const { scenario, seed } = data;
  const baseline = new TQ.Simulation(self.TQ_DATA, { seed, scenario });
  while (!baseline.history.length) baseline.step(10);
  self.postMessage(baseline.history[0]);
  self.close();
};
