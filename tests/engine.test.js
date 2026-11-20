// Tests du moteur : node --test tests/engine.test.js
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
  const perRide = s.cab.revenue / s.cab.ridesDone;
  assert.ok(perRide > TQ.PARAMS.cab.fareBase && perRide < 40, 'recette par course ' + perRide);
});

test('Cybercab : recettes et batterie suivent les kilomètres réellement parcourus', () => {
  const sim = run({ line: 'none', cab: 'wide', fleet: 1500 }, 5, 6 * 3600), F = sim.fleet, C = TQ.PARAMS.cab;
  const s = sim.summary();
  // les recettes, les kilomètres et le nombre de courses portent sur les mêmes courses terminées
  assert.ok(s.cab.ridesDone > 500, 'courses terminées ' + s.cab.ridesDone);
  assert.ok(Math.abs(s.cab.rides - s.cab.ridesDone * C.occupancy) < 1e-6);
  const perRide = s.cab.revenue / s.cab.ridesDone, kmPerRide = s.cab.rideKm / s.cab.ridesDone;
  assert.ok(perRide > C.fareBase + C.farePerKm && perRide < 40, 'recette par course ' + perRide);
  assert.ok(kmPerRide > 1.5 && kmPerRide < 15, 'km par course ' + kmPerRide);
  // les odomètres couvrent tous les kilomètres comptés par le réseau et les rues locales
  let odo = 0;
  for (let i = 0; i < F.n; i++) { odo += F.odo[i]; assert.ok(F.odo[i] - F.odoCharge[i] <= F.rangeKm + 60); }
  assert.ok(Math.abs(odo * F.w - (s.cab.vkmEmpty + s.cab.vkmLoaded)) / (odo * F.w) < 0.02, 'odomètres ' + odo * F.w + ' vs ' + (s.cab.vkmEmpty + s.cab.vkmLoaded));
});

test('autos autonomes et connectées : sans feux, la congestion fond ; sans l\'option, rien ne change', () => {
  const base = run({ line: 'none', cab: 'off' }, 2.2, 6 * 3600), auto = run({ line: 'none', cab: 'off', auto: true }, 2.2, 6 * 3600);
  const b = base.summary(), a = auto.summary();
  assert.ok(a.congestion < b.congestion * 0.5, `temps perdu ${a.congestion} contre ${b.congestion}`);
  assert.ok(a.avgSpeed > b.avgSpeed * 1.15);
  assert.deepStrictEqual(a.modes, b.modes); // la demande ne dépend pas de l'option quand rien d'autre ne change
  assert.ok(a.co2Avoided > 0 && b.co2Avoided === 0);
  assert.strictEqual(base.net.cond.auto, false);
  assert.ok(a.label.startsWith('Autos autonomes'));
  // retirer des autos de la route ne peut pas faire baisser le CO2 évité
  const tram = run({ line: 'tram', cab: 'off', auto: true }, 2.2, 6 * 3600).summary();
  assert.ok(tram.co2Avoided > a.co2Avoided - 1, `tram + auto ${tram.co2Avoided} t contre ${a.co2Avoided} t`);
  // gain des automobilistes : temps total par kilomètre comparé à la journée de référence
  const y = TQ.economics(Object.assign({}, a, { elapsedH: 24 })).society, ref = TQ.REFERENCE.normal;
  assert.ok(Math.abs(y.drivers - (ref.vhPerVkm - a.carVh / a.carVkm) * a.carVkm * TQ.ECON.carOccupancy * TQ.ECON.vot) < 1e-3);
});

test('bilan pour la société : somme des composantes et rôle de la référence', () => {
  const s = { elapsedH: 24, scenario: { winter: false }, carVkm: 14e6, carDelayH: 90000, riderGainH: 3000, co2Avoided: 20,
    lineFrom: { rtc: 40000, auto: 20000, actif: 5000 }, line: { kind: 'tram', boardings: 70000, vehKm: 7000 } };
  const e = TQ.economics(s), y = e.society, E = TQ.ECON, ref = TQ.REFERENCE.normal;
  assert.strictEqual(y.riders, 3000 * E.vot);
  assert.strictEqual(y.co2, 20 * E.carbon);
  assert.ok(Math.abs(y.rtcLoss + 40000 * E.transitFare) < 1e-6);
  assert.ok(Math.abs(y.drivers - (ref.delayPerVkm - 90000 / 14e6) * 14e6 * E.carOccupancy * E.vot) < 1e-3);
  assert.ok(Math.abs(y.net - (e.net + y.riders + y.rtcLoss + y.co2 + y.drivers)) < 1e-6);
  // le compteur d'usagers venus du RTC, quand il existe, prime sur la somme des provenances
  assert.ok(Math.abs(TQ.economics(Object.assign({}, s, { fromRtc: 50000 })).society.rtcLoss + 50000 * E.transitFare) < 1e-6);
  // course partagée : chacun paie moins que le plein tarif sur lequel il a choisi
  const shared = TQ.economics({ elapsedH: 24, cab: { fleet: 100, rides: 1400, revenue: 9000, vkmEmpty: 0, vkmLoaded: 0, kwh: 0 } });
  assert.ok(Math.abs(shared.society.riders - 9000 * (E.cabOccupancy - 1)) < 1e-6);
  assert.ok(Math.abs(e.annual.society.net - y.net * 300) < 1e-2);
  // sans ligne ni flotte, rien à compter
  assert.strictEqual(TQ.economics({ elapsedH: 24, carVkm: 14e6, carDelayH: 90000 }).society.net, 0);
});

test('un voyageur qui change de mode y gagne, selon le modèle', () => {
  const s = run({ line: 'tram', cab: 'off' }, 3, 6 * 3600).summary();
  assert.ok(s.riderGainH > 0);
  // moins de la moitié de vingt minutes par voyageur de la ligne, en moyenne
  assert.ok((s.riderGainH * 60) / s.modes.line < 10, 'minutes par voyageur ' + (s.riderGainH * 60) / s.modes.line);
});

test('les usagers venus du RTC sont comptés même quand ils passent par la ligne puis par le Cybercab', () => {
  const s = run({ line: 'tram', cab: 'wide', fleet: 1500 }, 3, 6 * 3600).summary();
  assert.ok(s.fromRtc >= s.lineFrom.rtc + s.cabFrom.rtc);
  assert.ok(s.fromRtc <= s.lineFrom.rtc + s.cabFrom.rtc + s.cabFrom.line);
});

test('deux journées de suite rejouent la même demande', () => {
  const sim = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off' }, start: 4.9 * 3600 + 86400 });
  sim.step(600);
  const day2 = sim.day, trips = [];
  for (let k = 0; k < 2; k++) { sim.reset(TQ.PARAMS.dayStart); sim.day = day2 + k; sim.step(1800); trips.push(sim.summary().trips); }
  assert.strictEqual(trips[0], trips[1]);
});

test('courses partagées : des demandes se joignent à des courses en cours, sans perdre de voyageurs', () => {
  const sim = run({ line: 'none', cab: 'wide', fleet: 1500, pool: true }, 5, 6 * 3600), F = sim.fleet, s = sim.summary();
  assert.ok(s.cab.pooled > 500, 'voyageurs jumelés ' + s.cab.pooled);
  assert.ok(s.cab.pooled < 2 * s.cab.requests * F.poolSeat + 1, 'pas plus de jumelages que de sièges libres');

  // l'occupation moyenne ne dépasse pas les deux places du véhicule
  assert.ok(F.poolSeat <= 1 - TQ.PARAMS.cab.occupancy / TQ.PARAMS.cab.seats + 1e-12);
  // chaque demande acceptée finit déposée ou est encore en route
  let pending = 0;
  for (let i = 0; i < F.n; i++) {
    for (let q = 0; q < F.ns[i]; q++) if (F.sk[i * 4 + q] & 1) pending++;
    assert.ok(F.ns[i] <= 4 && F.aboard[i] <= 2);
    if (F.state[i] === 0 || F.state[i] === 3) assert.strictEqual(F.ns[i], 0);
  }
  assert.strictEqual(F.stats.served, Math.round(F.stats.ridesPersons / TQ.PARAMS.scale) + pending);
  // les véhicules en route correspondent toujours aux agents occupés
  let onRoad = 0, busy = 0;
  for (let i = 0; i < sim.net.vn; i++) if (sim.net.vType[i] > 0) { onRoad++; assert.strictEqual(F.idx[sim.net.vPay[i]], i); }
  for (let i = 0; i < F.n; i++) if ([1, 2, 4].includes(F.state[i])) busy++;
  assert.strictEqual(onRoad, busy);
});

test('voie réservée aux Cybercab : plus rapide que les rues le long du tracé, et fermée sans flotte', () => {
  const sim = run({ line: 'cablane', cab: 'corridor', fleet: 1500 }, 2.5, 6 * 3600), net = sim.net;
  assert.ok(sim.cabLane && net.cabLane && !sim.line);
  let lane = 0, faster = 0, flow = 0;
  for (let e = 0; e < net.E; e++) if (net.ecor[e]) { lane++; flow += net.eflowC[e]; if (net.ecabT[e] < net.ett[e]) faster++; }
  assert.ok(lane > 100 && faster / lane > 0.8, 'arêtes plus rapides ' + faster + ' sur ' + lane);
  assert.ok(flow > 0, 'des Cybercab empruntent la voie');
  for (let e = 0; e < net.E; e++) if (!net.ecor[e]) assert.strictEqual(net.ecabT[e], net.ett[e]);
  // deux départs identiques donnent le même résultat, même après un bout de simulation
  const again = run({ line: 'cablane', cab: 'corridor', fleet: 1500 }, 0.5, 6 * 3600); again.reset(6 * 3600); again.step(1800);
  const fresh = run({ line: 'cablane', cab: 'corridor', fleet: 1500 }, 0.5, 6 * 3600);
  assert.deepStrictEqual(again.summary().modes, fresh.summary().modes);
  const eco = TQ.economics(sim.summary());
  assert.ok(eco.parts.some((p) => p.key === 'lane' && p.capex === TQ.ECON.line.cablane.capex));
  // sans flotte, la voie n'existe pas pour les Cybercab
  const off = new TQ.Simulation(data, { scenario: { line: 'cablane', cab: 'off' } });
  assert.strictEqual(off.cabLane, false);
  assert.strictEqual(off.net.cond.laneDrop, false);
  assert.ok(!TQ.economics(off.summary()).parts.length);
});

test('abandon de l\'auto : les résidents sans auto ne roulent plus en auto', () => {
  const a = run({ line: 'none', cab: 'wide', fleet: 1500 }, 2, 6 * 3600).summary();
  const b = run({ line: 'none', cab: 'wide', fleet: 1500, carFree: 0.2 }, 2, 6 * 3600).summary();
  assert.strictEqual(a.carFree, 0);
  assert.ok(b.carFree > 0 && b.modes.auto < a.modes.auto - 0.5 * b.carFree, 'auto ' + a.modes.auto + ' -> ' + b.modes.auto);
  assert.strictEqual(a.trips, b.trips); // même demande
  assert.ok(b.toRtc > 0 && b.toRtc <= b.carFree);
});
