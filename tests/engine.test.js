// Tests du moteur : node --test tests/
const test = require('node:test');
const assert = require('node:assert');
const { TQ, data } = require('./load');

function run(scenario, hours, start) {
  const sim = new TQ.Simulation(data, { scenario, start });
  for (let i = 0; i < hours * 360; i++) sim.step(10);
  return sim;
}

test('les données décrivent bien la ligne TramCité', () => {
  assert.strictEqual(data.line.stations.length, 29);
  assert.ok(Math.abs(data.line.length - 19000) < 400, 'longueur proche de 19 km');
  assert.strictEqual(data.line.stations.filter((s) => s.underground).length, 2);
  assert.strictEqual(data.line.stations.filter((s) => s.hub).length, 5);
  for (let i = 1; i < 29; i++) assert.ok(data.line.stations[i].s > data.line.stations[i - 1].s + 300);
});

test('tout point de demande est joignable depuis tout noeud', () => {
  const net = new TQ.Network(data);
  for (let d = 0; d < net.D; d += 37) for (let n = 0; n < net.N; n += 11) assert.ok(net.tdist[d][n] < 65535);
});

test('référence : la pointe du matin reproduit les ordres de grandeur de l\'EOD', () => {
  const sim = run({ line: 'none', cab: 'off' }, 4, 5 * 3600); // 5 h à 9 h
  const s = sim.summary();
  assert.ok(s.trips > 400000 && s.trips < 520000, 'déplacements 5 h-9 h : ' + s.trips);
  const auto = s.modes.auto / s.trips;
  assert.ok(auto > 0.72 && auto < 0.82, 'part auto ' + auto);
  assert.strictEqual(s.modes.line, 0);
  assert.ok(sim.cur.congestion > 0.2 && sim.cur.congestion < 1.2, 'congestion de pointe ' + sim.cur.congestion);
  // conservation : chaque déplacement a exactement un mode
  const sum = Object.values(s.modes).reduce((a, b) => a + b, 0);
  assert.strictEqual(sum, s.trips);
});

test('tramway : vitesse commerciale, capacité et report modal plausibles', () => {
  const sim = run({ line: 'tram', cab: 'off' }, 4, 5 * 3600);
  const s = sim.summary();
  assert.ok(s.line.speed > 21 && s.line.speed < 26, 'vitesse ' + s.line.speed);
  assert.ok(s.line.boardings > 9000 && s.line.boardings < 30000, 'montées ' + s.line.boardings);
  assert.ok(s.line.peakLoad <= s.line.capacity * 1.05, 'charge sous la capacité');
  assert.ok(s.carsRemoved > 0);
  for (const v of sim.line.vehicles) assert.ok(v.load >= 0 && v.load <= sim.line.capPackets);
});

test('bus : plus lent et moins capacitaire que le tramway', () => {
  const tram = run({ line: 'tram', cab: 'off' }, 4, 5 * 3600).summary();
  const bus = run({ line: 'bus', cab: 'off' }, 4, 5 * 3600).summary();
  assert.ok(bus.line.speed < tram.line.speed);
  assert.ok(bus.line.capacity < tram.line.capacity);
  assert.ok(bus.line.fleet > tram.line.fleet);
});

test('Cybercab : comptabilité de la flotte et trajets à vide', () => {
  const sim = run({ line: 'none', cab: 'corridor', fleet: 600 }, 4, 5 * 3600);
  const s = sim.summary(), c = sim.fleet.counts();
  const total = c.idle + c.toPickup + c.loaded + c.charging + c.reposition;
  assert.ok(Math.abs(total - sim.fleet.n * sim.fleet.w) < 1e-6);
  assert.ok(s.cab.rides > 1000, 'courses ' + s.cab.rides);
  assert.ok(s.cab.emptyShare > 0.02 && s.cab.emptyShare < 0.6, 'part à vide ' + s.cab.emptyShare);
  assert.ok(s.cab.avgWait >= 0 && s.cab.avgWait <= TQ.PARAMS.cab.maxEtaMin + 1);
  // les véhicules en route correspondent aux agents non libres
  let onRoad = 0;
  for (let i = 0; i < sim.net.vn; i++) if (sim.net.vType[i] > 0) onRoad++;
  let busy = 0;
  for (let i = 0; i < sim.fleet.n; i++) if ([1, 2, 4].includes(sim.fleet.state[i])) busy++;
  assert.strictEqual(onRoad, busy);
});

test('une flotte trop petite laisse des demandes sans véhicule', () => {
  const s = run({ line: 'none', cab: 'wide', fleet: 300 }, 4, 5 * 3600).summary();
  assert.ok(s.cab.unserved > 0);
});

test('la simulation est déterministe à graine égale', () => {
  const a = run({ line: 'tram', cab: 'off' }, 1, 7 * 3600).summary();
  const b = run({ line: 'tram', cab: 'off' }, 1, 7 * 3600).summary();
  assert.deepStrictEqual(a.modes, b.modes);
});

test('rentabilité : recettes, exploitation et investissement se composent correctement', () => {
  const E = TQ.ECON;
  assert.ok(Math.abs(TQ.annuity(0.04, 40) - 0.050523) < 1e-5);
  const s = { elapsedH: 24, line: { kind: 'tram', boardings: 70000, vehKm: 6000 }, cab: { fleet: 1000, rides: 14000, revenue: 90000, vkmEmpty: 20000, vkmLoaded: 80000, kwh: 11000 } };
  const e = TQ.economics(s);
  const [l, c] = e.parts;
  assert.strictEqual(l.revenue, 70000 * E.transitFare);
  assert.ok(Math.abs(l.opex - (6000 * 16 + 12e6 / 300)) < 1e-6);
  assert.ok(Math.abs(l.capital * 300 - 7.6e9 * TQ.annuity(0.04, 40)) < 1);
  assert.ok(Math.abs(c.opex - (100000 * 0.25 + 11000 * 0.12 + (1000 * 4000) / 300)) < 1e-6);
  assert.strictEqual(c.capex, 1000 * 50000);
  assert.ok(Math.abs(e.net - (l.net + c.net)) < 1e-6);
  assert.ok(Math.abs(e.annual.net - e.net * 300) < 1e-3);
  // une demi-journée porte la moitié des coûts fixes
  const half = TQ.economics(Object.assign({}, s, { elapsedH: 12, cab: undefined }));
  assert.ok(Math.abs(half.capital - l.capital / 2) < 1e-6);
  assert.strictEqual(TQ.economics({ elapsedH: 24 }).net, 0);
});

test('les recettes des Cybercab suivent le tarif', () => {
  const s = run({ line: 'none', cab: 'corridor', fleet: 600 }, 4, 5 * 3600).summary();
  const perRide = s.cab.revenue / (s.cab.rides / TQ.PARAMS.cab.occupancy);
  assert.ok(perRide > TQ.PARAMS.cab.fareBase && perRide < 40, 'recette par course ' + perRide);
});
