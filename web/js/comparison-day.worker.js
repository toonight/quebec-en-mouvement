// The packed dataset installs itself on window in the static site.
self.window = self;
importScripts('../data/network.js', 'engine/core.js', 'engine/network.js', 'engine/line.js', 'engine/cabs.js', 'engine/sim.js');

self.onmessage = ({ data: { scenario, seed } }) => {
  const baseline = new TQ.Simulation(self.TQ_DATA, { seed, scenario });
  while (!baseline.history.length) baseline.step(10);
  self.postMessage(baseline.history[0]);
  self.close();
};
