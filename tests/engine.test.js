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

test('les données servies à la page (network.js) sont identiques à network.json', () => {
  const vm = require('node:vm'), fs = require('node:fs'), path = require('node:path');
  const ctx = { window: {} };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '..', 'web', 'data', 'network.js'), 'utf8'), ctx);
  assert.strictEqual(JSON.stringify(ctx.window.TQ_DATA), JSON.stringify(data));
});

test('tout point de demande est joignable depuis tout noeud', () => {
  const net = new TQ.Network(data);
  for (let d = 0; d < net.D; d += 37) for (let n = 0; n < net.N; n += 11) assert.ok(net.tdist[d][n] < 65535);
});

test('référence : la pointe du matin reproduit les ordres de grandeur de l\'EOD', () => {
  const sim = run({ line: 'none', cab: 'off' }, 4, 5 * 3600); // 5 h à 9 h
  const s = sim.summary();
  assert.ok(s.trips > 400000 && s.trips < 520000, 'déplacements 5 h-9 h : ' + s.trips);
  // Part de l'auto : la cible est celle de l'EOD en pointe du matin (matrices AAU / ATO, hors échanges entre zones
  // externes, que le moteur ne simule pas), comparée à la moyenne de 5 graines. Mesuré sur 12 graines : moyenne
  // 0,7188, écart type 0,0014 par graine, donc 0,0006 pour une moyenne de 5 ; l'écart systématique à la cible est
  // de +0,004 (de 5 h à 6 h la simulation suit les parts de la nuit, et les cellules trop minces celles de la
  // journée). Les 5 graines du test donnent 0,7192, soit +0,0044 : sous la tolérance de 0,008, il reste 0,0036,
  // environ 5 erreurs types.
  let eodAuto = 0, eodAll = 0;
  for (let i = 0; i < 12; i++) for (let j = 0; j < 12; j++) if (!(i >= 9 && j >= 9)) { eodAuto += data.od.AAU[i][j]; eodAll += data.od.ATO[i][j]; }
  const target = eodAuto / eodAll;
  assert.ok(target > 0.70 && target < 0.73, 'part auto de l\'EOD en pointe du matin ' + target);
  const shares = [s.modes.auto / s.trips];
  for (const seed of [1, 2, 3, 4]) {
    const other = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off' }, start: 5 * 3600, seed });
    for (let i = 0; i < 4 * 360; i++) other.step(10);
    const o = other.summary();
    shares.push(o.modes.auto / o.trips);
  }
  const auto = shares.reduce((a, b) => a + b, 0) / shares.length;
  assert.ok(Math.abs(auto - target) < 0.008, 'part auto moyenne ' + auto + ' (par graine : ' + shares.map((v) => v.toFixed(4)).join(', ') + ') contre ' + target + ' dans l\'EOD');
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

// Trois façons de demander la même durée au moteur : par tranches de 10 s (les scripts et « journée complète »),
// par intervalles irréguliers de 0,01 à 3 s (une animation, d'une image à l'autre), ou d'un seul appel.
function cadences(scenario, start, seconds) {
  const make = () => new TQ.Simulation(data, { scenario, start });
  const regular = make();
  for (let i = 0; i < seconds / 10; i++) regular.step(10);
  const irregular = make();
  // suite fixe (générateur congruentiel), en centièmes de seconde pour que le total tombe juste
  let x = 12345, left = Math.round(seconds * 100), calls = 0;
  while (left > 0) {
    x = (Math.imul(x, 1103515245) + 12345) >>> 0;
    const cs = Math.min(left, 1 + ((x >>> 8) % 300));
    irregular.step(cs / 100); left -= cs; calls++;
  }
  const single = make();
  single.step(seconds);
  return { regular, irregular, single, calls };
}

test('pas fixe de 2 s : le résultat ne dépend pas de la cadence des appels', () => {
  assert.strictEqual(TQ.Simulation.STEP, 2);
  // deux heures dont la pointe du matin (6 h 30 à 8 h 30), durée multiple du pas : aucun reste en attente à la fin
  for (const scenario of [{ line: 'tram', cab: 'off' }, { line: 'none', cab: 'wide', fleet: 1500 }]) {
    const start = 6.5 * 3600, c = cadences(scenario, start, 7200);
    assert.ok(c.calls > 3000, 'la cadence irrégulière fait bien des milliers d\'appels');
    const ref = JSON.stringify(c.regular.summary()), refSeries = JSON.stringify(c.regular.series);
    for (const k of ['irregular', 'single']) {
      assert.strictEqual(c[k].t, start + 7200, `${k} : heure atteinte`);
      assert.ok(c[k].stepRest < 1e-6, `${k} : aucun reste`);
      assert.strictEqual(JSON.stringify(c[k].summary()), ref, `${k} : même résumé que par tranches de 10 s (${scenario.line}, ${scenario.cab})`);
      assert.strictEqual(JSON.stringify(c[k].series), refSeries, `${k} : mêmes relevés de 10 minutes`);
    }
    assert.ok(c.regular.summary().trips > 100000, 'la période simulée contient bien de la demande');
  }
  // passage de 5 h : la fin de journée remet l'état à zéro au milieu d'un appel, sans perdre le temps restant
  const d = cadences({ line: 'tram', cab: 'off' }, TQ.PARAMS.dayStart - 600, 1200);
  assert.strictEqual(d.regular.day, 2);
  for (const k of ['irregular', 'single']) {
    assert.strictEqual(d[k].t, TQ.PARAMS.dayStart + 600, `${k} : heure atteinte après 5 h`);
    assert.strictEqual(JSON.stringify(d[k].summary()), JSON.stringify(d.regular.summary()), `${k} : même résumé après le passage de 5 h`);
  }
});

test('pas fixe de 2 s : le temps qui ne remplit pas un pas attend, sans être simulé ni compté', () => {
  const sim = new TQ.Simulation(data, { scenario: { line: 'tram', cab: 'off' }, start: 7 * 3600 });
  sim.step(600);
  const t = sim.t, before = JSON.stringify(sim.summary());
  sim.step(1.5);
  assert.strictEqual(sim.t, t, 'l\'heure du moteur ne bouge pas');
  assert.strictEqual(sim.stepRest, 1.5);
  assert.strictEqual(sim.stepFraction, 0.75);
  assert.strictEqual(JSON.stringify(sim.summary()), before, 'le résumé ignore le reste en attente');
  sim.step(0.5);
  assert.strictEqual(sim.t, t + 2, 'le pas est fait dès qu\'il est rempli');
  assert.strictEqual(sim.stepRest, 0);
  sim.step(-5); sim.step(NaN);
  assert.strictEqual(sim.t, t + 2);
  sim.step(1); sim.reset(7 * 3600);
  assert.strictEqual(sim.stepRest, 0, 'reset() efface le reste');
  // les aides d'affichage ne changent pas l'état du moteur
  sim.step(601);
  const net = sim.net, o = {}, snap = () => JSON.stringify([Array.from(net.vEdge.subarray(0, net.vn)), Array.from(net.vProg.subarray(0, net.vn)), sim.line.vehicles.map((v) => [v.s, v.state, v.at])]);
  const s0 = snap();
  let moved = 0, hopped = 0;
  for (let i = 0; i < net.vn; i++) {
    net.aheadOf(i, 0, o);
    assert.strictEqual(o.e, net.vEdge[i]); assert.strictEqual(o.p, net.vProg[i]); assert.strictEqual(o.hops, 0);
    net.aheadOf(i, sim.stepRest, o);
    assert.ok(o.p >= 0 && o.p <= 1 && o.e >= 0 && o.e < net.E);
    if (o.hops > 0) hopped++; else if (o.p > net.vProg[i]) moved++;
  }
  assert.ok(moved > 100, 'les véhicules sont dessinés plus loin que leur position au dernier pas');
  for (const v of sim.line.vehicles) {
    assert.strictEqual(sim.line.drawS(v, sim.t, 0), v.s);
    const s1 = sim.line.drawS(v, sim.t, 1), s2 = sim.line.drawS(v, sim.t, 1.99);
    if (v.active && v.state === 'run' && sim.t + 2 < v.t1) assert.ok(v.dir === 0 ? s1 > v.s && s2 > s1 : s1 < v.s && s2 < s1, 'une rame en marche avance dans son sens');
    if (v.state === 'dwell') assert.strictEqual(s2, v.s);
  }
  assert.strictEqual(snap(), s0, 'état inchangé');
  // la position dessinée à la fin du pas est celle que le moteur calcule au pas suivant (sauf arrivée à destination)
  const pred = [];
  for (let i = 0; i < net.vn; i++) { net.aheadOf(i, 2, o); pred.push([net.vId[i], o.e, o.p, net.eb[o.e] === net.dnode[net.vDest[i]] && o.p === 1]); }
  const predLine = sim.line.vehicles.map((v) => (v.active && v.state === 'run' && sim.t + 2 < v.t1 ? sim.line.drawS(v, sim.t, 2) : null));
  sim.step(1);
  assert.strictEqual(sim.t, 7 * 3600 + 602);
  const at = new Map();
  for (let i = 0; i < net.vn; i++) at.set(net.vId[i], i);
  let same = 0, n = 0;
  for (const [id, e, p, arriving] of pred) {
    if (arriving || !at.has(id)) continue;
    const i = at.get(id); n++;
    if (net.vEdge[i] === e && Math.abs(net.vProg[i] - p) < 1e-4) same++;
  }
  assert.ok(n > 100 && same / n > 0.99, `prévision d'affichage confirmée pour ${same} véhicules sur ${n}`);
  sim.line.vehicles.forEach((v, k) => { if (predLine[k] != null) assert.ok(Math.abs(v.s - predLine[k]) < 1e-6, 'rame : position prévue égale à la position calculée'); });
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

test('le prix perçu modifie le choix du Cybercab et préserve le montant facturé par course', () => {
  const scenario = { line: 'none', cab: 'wide', fleet: 3000, carFree: 0.2, farePerKm: 0 };
  const full = run(scenario, 2, 6 * 3600).summary();
  const split = run({ ...scenario, farePerOccupant: true }, 2, 6 * 3600).summary();
  assert.strictEqual(split.trips, full.trips);
  assert.ok(split.cab.rides > full.cab.rides);
  assert.ok(split.carFreeModes.cab > full.carFreeModes.cab);
  for (const day of [full, split]) {
    assert.ok(Math.abs(day.cab.revenue / day.cab.ridesDone - TQ.PARAMS.cab.fareBase) < 1e-8);
  }
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
  // retirer des autos de la route ne peut pas faire baisser le CO2 évité. Depuis que les kilomètres évités sont ceux
  // de l'itinéraire sur le réseau (même base que les autos qui roulent), le tramway ajoute de 0,16 à 0,45 t au CO2
  // évité à 8 h 12 selon la graine (8 graines, réseau de novembre 2026 ; +0,38 t ici). Avec l'ancien compte à vol
  // d'oiseau × 1,3, il en retirait 0,5 à 1,0 t en apparence : la tolérance, alors de 1 t, est ramenée à 0,5 t.
  const tram = run({ line: 'tram', cab: 'off', auto: true }, 2.2, 6 * 3600).summary();
  assert.ok(tram.co2Avoided > a.co2Avoided - 0.5, `tram + auto ${tram.co2Avoided} t contre ${a.co2Avoided} t`);
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
  // la voie ne couvre que les rues du tracé : une part des kilomètres de la flotte s'y fait, jamais la totalité
  const cab = sim.summary().cab;
  assert.ok(cab.laneVkm > 0 && cab.laneShare > 0 && cab.laneShare < 1, 'part des kilomètres en voie réservée ' + cab.laneShare);
  assert.ok(Math.abs(cab.laneShare - cab.laneVkm / (cab.vkmEmpty + cab.vkmLoaded)) < 1e-12);
  assert.ok(cab.laneVkm < net.stats[1].vkm + net.stats[2].vkm, 'moins que les kilomètres faits sur le réseau');
  // sans voie réservée, la même flotte n'y fait aucun kilomètre
  const plain = run({ line: 'none', cab: 'corridor', fleet: 1500 }, 0.5, 6 * 3600).summary().cab;
  assert.ok(plain.vkmLoaded > 0);
  assert.strictEqual(plain.laneVkm, 0);
  assert.strictEqual(plain.laneShare, 0);
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

test('carte de la voie réservée aux Cybercab : seules les rues du tracé sont couvertes', () => {
  // cas d'école : tracé droit de 1 000 m, deux intervalles voisins (joints) et un troisième plus loin
  const coords = [[0, 0], [4, 0], [10, 0]], cum = [0, 400, 1000];
  const c = TQ.lineCover(coords, cum, [[300, 100], [120, 350], [370, 700], [800, 990]], 30);
  assert.deepStrictEqual(c.on.map((p) => [p.s0, p.s1]), [[100, 700], [800, 1000]]); // le bout de 10 m en fin de tracé est rattaché
  assert.deepStrictEqual(c.off.map((p) => [p.s0, p.s1]), [[0, 100], [700, 800]]);
  assert.deepStrictEqual(c.on[0].path, [[1, 0], [4, 0], [7, 0]]); // extrémités interpolées, sommet de 400 m gardé
  assert.deepStrictEqual(TQ.lineCover(coords, cum, [], 30), { on: [], off: [{ s0: 0, s1: 1000, path: coords }] });
  // données réelles : les arêtes réservées (edges.cor) projetées sur le tracé, comme le fait la page
  const net = new TQ.Network(data, { trees: false }), L = data.line, KX = TQ.geo.KX, KY = TQ.geo.KY;
  const along = (lon, lat) => {
    let best = Infinity, s = 0;
    for (let i = 0; i < L.coords.length - 1; i++) {
      const ax = (L.coords[i][0] - lon) * KX, ay = (L.coords[i][1] - lat) * KY, dx = (L.coords[i + 1][0] - L.coords[i][0]) * KX, dy = (L.coords[i + 1][1] - L.coords[i][1]) * KY;
      const l2 = dx * dx + dy * dy, t = l2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / l2)) : 0, d = Math.hypot(ax + dx * t, ay + dy * t);
      if (d < best) { best = d; s = L.cum[i] + (L.cum[i + 1] - L.cum[i]) * t; }
    }
    return s;
  };
  const spans = [], o = [0, 0, 0];
  let perDir = 0;
  for (let e = 0; e < net.E; e++) if (net.ecor[e]) {
    net.edgePosLane(e, 0, 0, o, 0); const s0 = along(o[0], o[1]);
    net.edgePosLane(e, net.elen[e], 0, o, 0); const s1 = along(o[0], o[1]);
    spans.push([s0, s1]); perDir += net.elen[e] / 2;
  }
  const cover = TQ.lineCover(L.coords, L.cum, spans, 40), len = (list) => list.reduce((a, p) => a + p.s1 - p.s0, 0);
  const on = len(cover.on), off = len(cover.off);
  assert.ok(Math.abs(on + off - L.length) < 1, 'portions allumées et éteintes : ' + (on + off) + ' m pour un tracé de ' + L.length);
  // environ 11 km par sens sur 19 (c'est ce que disent les textes de la page) : ni tout le tracé, ni presque rien
  assert.ok(perDir > 10500 && perDir < 12000, 'voie réservée par sens ' + perDir + ' m');
  assert.ok(on > 10500 && on < 12500 && on / L.length < 0.7, 'tracé allumé ' + on + ' m');
  // le tunnel n'est jamais allumé (à 50 m près aux trémies), et les portions s'enchaînent sans se chevaucher
  for (const p of cover.on) assert.ok(p.s1 <= L.tunnel[0] + 50 || p.s0 >= L.tunnel[1] - 50, 'portion allumée dans le tunnel : ' + p.s0 + ' à ' + p.s1);
  const all = cover.on.concat(cover.off).sort((a, b) => a.s0 - b.s0);
  for (let i = 1; i < all.length; i++) assert.ok(Math.abs(all[i].s0 - all[i - 1].s1) < 1e-6);
  assert.ok(cover.on.length >= 3 && cover.on.length <= 12 && cover.off.length >= 3, cover.on.length + ' portions allumées');
});

test('CO2 : les kilomètres d\'auto évités sont ceux de l\'itinéraire du réseau et recoupent l\'écart global de véh-km', () => {
  // longueur d'itinéraire : somme des tronçons de l'arbre des plus courts chemins, jamais plus courte que le vol d'oiseau
  const net = new TQ.Network(data), info = data.points;
  let n = 0;
  for (let o = 0; o < info.length; o += 17) for (let d = 7; d < info.length; d += 23) {
    const len = net.routeLen(o, d);
    if (net.dnode[o] === net.dnode[d]) { assert.strictEqual(len, 0); continue; }
    let node = net.dnode[o], sum = 0, hops = 0;
    while (node !== net.dnode[d]) { const e = net.tnext[d][node]; sum += net.elen[e]; node = net.eb[e]; hops++; }
    assert.strictEqual(len, sum);
    const A = data.nodes[net.dnode[o]], B = data.nodes[net.dnode[d]];
    assert.ok(hops > 0 && len >= TQ.geo.dist(A[0], A[1], B[0], B[1]) - 5, 'itinéraire plus court que le vol d\'oiseau : ' + o + ' -> ' + d);
    n++;
  }
  assert.ok(n > 500, 'paires vérifiées : ' + n);
  // Journée complète du tramway. Contrôle indépendant : les autos qui roulent encore, comparées à la journée de
  // référence (TQ.REFERENCE, même graine), ont perdu à peu près les kilomètres comptés comme évités.
  const sim = new TQ.Simulation(data, { scenario: { line: 'tram', cab: 'off' } });
  let avoidedKm = 0;
  const endDay = sim.endDay.bind(sim);
  sim.endDay = () => { avoidedKm = sim.m.divertedCarKm; endDay(); };
  while (!sim.history.length) sim.step(10);
  const s = sim.history[0], P = TQ.PARAMS, lp = P.line.tram;
  const added = (s.line.vehKm * (lp.co2Km + lp.kwhKm * P.gridCO2)) / 1000;
  assert.ok(Math.abs(s.co2Avoided - ((avoidedKm * P.carCO2) / 1000 - added)) < 1e-9, 'CO2 évité = kilomètres évités, moins les émissions de la ligne');
  // détour moyen : l'itinéraire est plus long que le vol d'oiseau × 1,3 de l'ancien compte, sans être démesuré
  const perCar = avoidedKm / s.carsRemoved;
  assert.ok(perCar > 3 && perCar < 12, 'km évités par auto retirée ' + perCar);
  const global = TQ.REFERENCE.normal.carVkm - s.carVkm;
  // Mesuré (novembre 2026) : 147 000 km évités contre 142 000 km d'écart global (30,9 t contre 29,8 t), rapport 1,04.
  // L'écart global dépend du hasard des itinéraires des 14,4 millions de véh-km restants : sur quatre graines, chacune
  // comparée à sa propre référence, il va de 29,8 à 34,7 t pour 30,9 à 31,9 t évitées (rapport de 0,92 à 1,04).
  // Tolérance de 20 % : large devant ce bruit, mais l'ancien compte à vol d'oiseau × 1,3 (105 000 km, rapport 0,74)
  // n'y entrerait pas.
  assert.ok(global > 0 && Math.abs(avoidedKm / global - 1) < 0.2, `km évités ${Math.round(avoidedKm)} contre écart global de véh-km ${Math.round(global)}`);
});

// trois pointes du matin partagées par les deux tests de l'abandon de l'auto : sans l'option, avec, et avec en hiver
let carFreeRuns = null;
function carFreeCases() {
  if (!carFreeRuns) carFreeRuns = {
    a: run({ line: 'none', cab: 'wide', fleet: 1500 }, 2, 6 * 3600).summary(),
    b: run({ line: 'none', cab: 'wide', fleet: 1500, carFree: 0.2 }, 2, 6 * 3600).summary(),
    w: run({ line: 'none', cab: 'wide', fleet: 1500, carFree: 0.2, winter: true }, 2, 6 * 3600).summary(),
  };
  return carFreeRuns;
}

test('abandon de l\'auto : les déplacements faits sans auto ne roulent plus en auto et se replient sur les modes disponibles', () => {
  const { a, b, w } = carFreeCases(), N = TQ.PARAMS.noCar;
  assert.strictEqual(a.carFree, 0);
  assert.ok(b.carFree > 0 && b.modes.auto < a.modes.auto - 0.5 * b.carFree, 'auto ' + a.modes.auto + ' -> ' + b.modes.auto);
  assert.strictEqual(a.trips, b.trips); // même demande
  assert.ok(b.toRtc > 0 && b.toRtc <= b.carFree);
  // chaque déplacement fait sans auto a exactement un mode de repli, et les compteurs se recoupent
  const sum = (o) => Object.values(o).reduce((x, y) => x + y, 0);
  assert.strictEqual(sum(a.carFreeModes), 0);
  for (const s of [b, w]) {
    assert.strictEqual(sum(s.carFreeModes), s.carFree);
    assert.strictEqual(s.carFreeModes.rtc, s.toRtc);
    assert.strictEqual(s.carFreeModes.line, 0); // pas de ligne dans ce scénario
    assert.ok(s.carFreeModes.cab > 0 && s.carFreeModes.cab <= s.cabFrom.auto);
    assert.strictEqual(sum(s.modes), s.trips);
  }
  // la marche sert aux courtes distances, le vélo n'est pas pris plus souvent qu'il n'est disponible
  assert.ok(b.carFreeModes.walk > 0 && b.carFreeModes.bike > 0);
  assert.ok(b.carFreeKm.walk / b.carFreeModes.walk < b.carFreeKm.bike / b.carFreeModes.bike, 'la marche va moins loin que le vélo');
  assert.ok(b.carFreeKm.walk / b.carFreeModes.walk < 3.5, 'km moyens à pied ' + b.carFreeKm.walk / b.carFreeModes.walk);
  assert.ok(b.carFreeModes.bike / b.carFree < N.bikeShare, 'part du vélo ' + b.carFreeModes.bike / b.carFree);
  // plus aucun mode ne prend presque tout (avant la révision du repli : 97,5 % en marche ou vélo)
  for (const k of ['rtc', 'walk', 'bike', 'cab']) assert.ok(b.carFreeModes[k] / b.carFree < 0.6, k + ' ' + b.carFreeModes[k] / b.carFree);
  // en hiver le vélo devient marginal
  assert.ok(w.carFreeModes.bike / w.carFree < N.bikeShare * N.bikeWinterFactor * 2, 'part du vélo en hiver ' + w.carFreeModes.bike / w.carFree);
  assert.ok(w.carFreeModes.bike < 0.2 * b.carFreeModes.bike);
});

test('abandon de l\'auto : l\'écart de coût généralisé est un poste à part du bilan pour la société', () => {
  const { a, b } = carFreeCases(), E = TQ.ECON;
  // sans l'option : rien de cumulé, poste absent
  assert.strictEqual(a.carFreeGapH, 0);
  const ea = TQ.economics(a), eb = TQ.economics(b), ya = ea.society, yb = eb.society;
  assert.strictEqual(ya.carFree, null);
  assert.strictEqual(ea.annual.society.carFree, null);
  assert.ok(Math.abs(ya.net - (ea.net + ya.riders + ya.rtcLoss + ya.co2 + ya.drivers)) < 1e-6);
  // avec l'option : une perte nette, de l'ordre de dix minutes à une heure de coût généralisé par déplacement
  assert.ok(b.carFreeGapH < 0);
  const minPerTrip = (-b.carFreeGapH * 60) / b.carFree;
  assert.ok(minPerTrip > 10 && minPerTrip < 60, 'minutes perdues par déplacement fait sans auto ' + minPerTrip);
  // Leur écart est compté au plein tarif du Cybercab ; le rabais d'occupation de leurs courses (une course de
  // 1,4 personne ne rapporte qu'un tarif) leur revient, dans leur poste et non dans le gain de ceux qui ont choisi.
  const rebate = (b.carFreeCabFare * (E.cabOccupancy - 1)) / E.cabOccupancy;
  assert.strictEqual(a.carFreeCabFare, 0);
  assert.ok(rebate > 0 && rebate < b.cab.revenue * (E.cabOccupancy - 1), 'rabais des courses imposées ' + rebate);
  assert.ok(Math.abs(yb.carFree - (b.carFreeGapH * E.vot + rebate)) < 1e-6);
  assert.ok(Math.abs(yb.riders - (b.riderGainH * E.vot + b.cab.revenue * (E.cabOccupancy - 1) - rebate)) < 1e-6);
  // Imposer l'abandon de l'auto ne fait pas monter le gain de ceux qui ont choisi. Mesuré (pointe du matin, 1 500
  // véhicules) : 29 192 $ sans l'option, 15 620 $ avec ; avant la correction, le rabais des courses imposées s'y
  // ajoutait et donnait 41 432 $.
  assert.ok(yb.riders <= ya.riders, 'gain des voyageurs ' + ya.riders + ' -> ' + yb.riders);
  // le poste n'est pas fondu dans le gain des voyageurs, et le bilan le comprend
  assert.ok(yb.riders > 0);
  assert.ok(Math.abs(yb.net - (eb.net + yb.riders + yb.carFree + yb.rtcLoss + yb.co2 + yb.drivers)) < 1e-6);
  const k = (E.daysPerYear * 24) / b.elapsedH;
  assert.ok(Math.abs(eb.annual.society.carFree - yb.carFree * k) < 1e-3);
  assert.ok(Math.abs(eb.annual.society.net - yb.net * k) < 1e-2);
  // cas d'école : le poste vaut les heures cumulées fois la valeur du temps, et déplace le bilan d'autant
  const cab = { fleet: 100, rides: 1400, revenue: 9000, vkmEmpty: 0, vkmLoaded: 0, kwh: 0 };
  const off = TQ.economics({ elapsedH: 24, scenario: { carFree: 0 }, cab, carFreeGapH: 0 }).society;
  const on = TQ.economics({ elapsedH: 24, scenario: { carFree: 0.2 }, cab, carFreeGapH: -1000 }).society;
  assert.strictEqual(off.carFree, null);
  assert.strictEqual(on.carFree, -1000 * E.vot);
  assert.ok(Math.abs(on.net - off.net + 1000 * E.vot) < 1e-6);
  // 1 400 $ de tarif facial sur des courses imposées : 400 $ de rabais passent du gain des voyageurs au poste, bilan inchangé
  const moved = TQ.economics({ elapsedH: 24, scenario: { carFree: 0.2 }, cab, carFreeGapH: -1000, carFreeCabFare: 1400 }).society;
  assert.ok(Math.abs(moved.carFree - (on.carFree + 400)) < 1e-6 && Math.abs(moved.riders - (on.riders - 400)) < 1e-6);
  assert.ok(Math.abs(moved.net - on.net) < 1e-6);
  // le rabais déplacé ne dépasse jamais le rabais total des recettes de la flotte
  const capped = TQ.economics({ elapsedH: 24, scenario: { carFree: 0.2 }, cab, carFreeGapH: -1000, carFreeCabFare: 1e9 }).society;
  assert.ok(Math.abs(capped.riders) < 1e-6 && Math.abs(capped.net - on.net) < 1e-6);
});

test('réseau : voies, voies réservées et plages de pointe bien formées', () => {
  const e = data.edges, E = e.a.length;
  for (const k of Object.keys(e)) assert.strictEqual(e[k].length, E, 'longueur de edges.' + k);
  for (let i = 0; i < E; i++) {
    assert.ok(Number.isInteger(e.lanes[i]) && e.lanes[i] >= 1 && e.lanes[i] <= 6, 'voies de l\'arête ' + i + ' : ' + e.lanes[i]);
    assert.ok(Number.isInteger(e.bus[i]) && e.bus[i] >= 0 && e.bus[i] <= 9, 'voies réservées de l\'arête ' + i + ' : ' + e.bus[i]);
    assert.ok(e.cap[i] > 0, 'capacité de l\'arête ' + i);
  }
  assert.ok(Array.isArray(data.peaks) && data.peaks.length > 0);
  const byEdge = new Map();
  for (const p of data.peaks) {
    assert.strictEqual(p.length, 4);
    const [i, cap, a, b] = p;
    assert.ok(Number.isInteger(i) && i >= 0 && i < E, 'arête ' + i);
    assert.ok(cap > 0, 'capacité de pointe de l\'arête ' + i);
    assert.ok(Number.isInteger(a) && Number.isInteger(b) && a >= 0 && a < b && b <= 1440, 'plage ' + a + '-' + b + ' de l\'arête ' + i);
    assert.notStrictEqual(cap, e.cap[i], 'la pointe de l\'arête ' + i + ' change la capacité');
    // le retrait d'une voie le long du tracé ne sait pas tenir compte d'une voie déjà retirée en pointe
    assert.strictEqual(e.cor[i], 0, 'plage de pointe sur l\'arête ' + i + ' du tracé du tramway');
    if (!byEdge.has(i)) byEdge.set(i, []);
    byEdge.get(i).push([a, b]);
  }
  for (const [i, spans] of byEdge) {
    spans.sort((x, y) => x[0] - y[0]);
    for (let k = 1; k < spans.length; k++) assert.ok(spans[k - 1][1] <= spans[k][0], 'plages qui se chevauchent sur l\'arête ' + i);
  }
});

test('réseau : cas témoins des voies réservées et des sens uniques', () => {
  const e = data.edges, of = (name) => { const n = data.names.indexOf(name), out = []; assert.ok(n >= 0, name); for (let i = 0; i < e.a.length; i++) if (e.name[i] === n) out.push(i); return out; };
  const qb = of('Chemin des Quatre-Bourgeois'), gc = of('Boulevard Guillaume-Couture');
  assert.ok(qb.length > 50 && gc.length > 50);
  assert.ok(qb.some((i) => e.bus[i] > 0), 'voie réservée sur le chemin des Quatre-Bourgeois');
  assert.ok(gc.every((i) => e.lanes[i] < 5), 'plus de tronçon à 5 voies sur le boulevard Guillaume-Couture');
});

test('réseau : virages interdits impossibles, connexité forte et arêtes de liaison des carrefours éclatés', () => {
  const e = data.edges, E = e.a.length, N = data.nodes.length, off = data.turns_off;
  assert.ok(Array.isArray(off) && off.length > 300, 'virages interdits : ' + (off && off.length));
  assert.ok(E < 32768, 'les arbres du moteur rangent les numéros d\'arête sur 16 bits signés : ' + E);
  const out = Array.from({ length: N }, () => []), inn = Array.from({ length: N }, () => []);
  for (let i = 0; i < E; i++) { out[e.a[i]].push(i); inn[e.b[i]].push(i); }
  // du port d'entrée ne partent que des arêtes de liaison, et aucune ne mène au port de sortie du virage interdit
  const links = new Set(), portsIn = [], portsOut = [];
  for (const [i, o] of off) {
    assert.ok(i >= 0 && i < E && o >= 0 && o < E && e.len[i] > 1 && e.len[o] > 1, 'paire ' + i + ', ' + o);
    assert.notStrictEqual(e.b[i], e.a[o], 'virage interdit resté direct : ' + i + ' -> ' + o);
    assert.ok(out[e.b[i]].length > 0 && inn[e.a[o]].length > 0, 'port sans mouvement permis : ' + i + ' -> ' + o);
    for (const k of out[e.b[i]]) assert.notStrictEqual(e.b[k], e.a[o], 'virage interdit possible : ' + i + ' -> ' + o);
    portsIn.push(e.b[i]); portsOut.push(e.a[o]);
  }
  // toutes les liaisons des carrefours éclatés : celles qui quittent un port d'entrée ou entrent dans un port de sortie
  const seenIn = new Set(), seenOut = new Set();
  while (portsIn.length || portsOut.length) {
    if (portsIn.length) { const p = portsIn.pop(); if (seenIn.has(p)) continue; seenIn.add(p); for (const k of out[p]) { links.add(k); portsOut.push(e.b[k]); } }
    else { const p = portsOut.pop(); if (seenOut.has(p)) continue; seenOut.add(p); for (const k of inn[p]) { links.add(k); portsIn.push(e.a[k]); } }
  }
  // arêtes de liaison : 1 m, sans nom, hors du tracé, sans plage de pointe, trop rapides et trop larges pour freiner quoi que ce soit
  const peak = new Set(data.peaks.map((p) => p[0])), ports = new Set();
  let capMax = 0;
  for (let i = 0; i < E; i++) if (!links.has(i)) capMax = Math.max(capMax, e.cap[i]);
  for (const k of links) {
    assert.strictEqual(e.len[k], 1, 'longueur de la liaison ' + k);
    assert.ok(e.cap[k] >= 2 * capMax && e.speed[k] >= 100, 'liaison ' + k + ' : ' + e.cap[k] + ' véh/h, ' + e.speed[k] + ' km/h');
    assert.ok(data.names[e.name[k]] === '' && e.cor[k] === 0 && e.bus[k] === 0 && e.lanes[k] === 1 && !peak.has(k), 'liaison ' + k);
    assert.strictEqual(data.classes[e.cls[k]], 'link');
    ports.add(e.a[k]); ports.add(e.b[k]);
  }
  // rien ne s'accroche à un port : tous les mouvements n'y sont pas permis
  for (const p of data.points.concat(data.poles, data.gates)) assert.ok(!ports.has(p.node), 'point de demande sur un port : ' + p.node);
  // ni à une rue de raccord ou à une bretelle seule : le noeud touche au moins une arête d'une autre classe que « link »
  const link = data.classes.indexOf('link'), plain = new Uint8Array(N);
  for (let i = 0; i < E; i++) if (e.cls[i] !== link) plain[e.a[i]] = plain[e.b[i]] = 1;
  for (const p of data.points.concat(data.poles, data.gates)) assert.ok(plain[p.node], 'point de demande sur un noeud de raccord : ' + p.node);
  // connexité forte : tout noeud est atteint depuis le noeud 0 et l'atteint
  for (const [adj, end] of [[out, e.b], [inn, e.a]]) {
    const seen = new Uint8Array(N), stack = [0];
    let n = 1;
    seen[0] = 1;
    while (stack.length) for (const k of adj[stack.pop()]) if (!seen[end[k]]) { seen[end[k]] = 1; n++; stack.push(end[k]); }
    assert.strictEqual(n, N, 'noeuds reliés au noeud 0');
  }
});

test('heures de pointe : la capacité suit les plages de data.peaks', () => {
  const P = TQ.PARAMS;
  // capacité attendue de l'arête e à la minute m de la journée
  const capAt = (e, m) => { for (const p of data.peaks) if (p[0] === e && m >= p[2] && m < p[3]) return p[1]; return data.edges.cap[e]; };
  const peakEdges = [...new Set(data.peaks.map((p) => p[0]))];
  const check = (net, t, k, what) => {
    const m = (((t % 86400) + 86400) % 86400) / 60;
    for (const e of peakEdges) assert.strictEqual(net.ecap[e], Math.fround(capAt(e, m) * (k || 1)), what + ' : arête ' + e + ' à la minute ' + m);
  };
  // le réseau seul garde les capacités permanentes tant qu'aucune heure n'est donnée
  const net = new TQ.Network(data, { trees: false });
  for (const e of peakEdges) assert.strictEqual(net.ecap[e], data.edges.cap[e]);
  // toutes les bornes, dans le désordre, y compris le lendemain et la veille de minuit
  const bounds = [...new Set(data.peaks.flatMap((p) => [p[2], p[3]]))];
  for (const b of bounds.concat(bounds.slice().reverse())) for (const d of [-1, 0, 1]) for (const day of [0, 1]) {
    const t = day * 86400 + (b + d) * 60;
    net.setTime(t); check(net, t, 1, 'setTime');
    assert.ok(net.peakNext > t, 'prochaine borne après ' + t);
  }
  net.setTime(23.5 * 3600);
  assert.strictEqual(net.peakNext, 86400 + Math.min(...bounds) * 60); // la prochaine borne est le lendemain
  // les arêtes hors de data.peaks ne bougent pas
  const ref = new TQ.Network(data, { trees: false }), isPeak = new Set(peakEdges);
  for (let e = 0; e < net.E; e++) if (!isPeak.has(e)) assert.strictEqual(net.ecap[e], ref.ecap[e]);

  const [e0, cap0, a0, b0] = data.peaks[0];
  assert.notStrictEqual(cap0, data.edges.cap[e0]);
  // départ en pleine plage, sortie de plage en simulant, puis remise à zéro
  const mid = (b0 - 5) * 60, sim = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off' }, start: mid });
  assert.strictEqual(sim.net.ecap[e0], cap0);
  check(sim.net, mid, 1, 'départ en plage');
  sim.step(240); check(sim.net, mid + 240, 1, 'avant la fin');
  assert.strictEqual(sim.net.ecap[e0], cap0);
  sim.step(60); check(sim.net, mid + 300, 1, 'à la fin');
  assert.strictEqual(sim.net.ecap[e0], capAt(e0, b0));
  sim.step(300); check(sim.net, mid + 600, 1, 'après la fin');
  sim.reset(mid);
  assert.strictEqual(sim.net.ecap[e0], cap0);
  check(sim.net, mid, 1, 'après reset');
  // départ hors plage, entrée en plage en simulant
  sim.reset((a0 - 5) * 60);
  assert.strictEqual(sim.net.ecap[e0], capAt(e0, a0 - 5));
  sim.step(298); assert.strictEqual(sim.net.ecap[e0], capAt(e0, a0 - 1));
  sim.step(2); assert.strictEqual(sim.net.ecap[e0], cap0);
  // les autres facteurs restent appliqués : l'hiver réduit aussi la capacité de pointe
  sim.setScenario({ winter: true });
  check(sim.net, a0 * 60, P.winterCap, 'hiver');
  // sans data.peaks ni edges.bus, le réseau se comporte comme avant
  const edges = Object.assign({}, data.edges); delete edges.bus;
  const plain = Object.assign({}, data, { edges }); delete plain.peaks;
  const old = new TQ.Network(plain, { trees: false });
  old.setTime(a0 * 60);
  assert.strictEqual(old.peakNext, Infinity);
  for (let e = 0; e < old.E; e++) assert.strictEqual(old.ecap[e], data.edges.cap[e]);
});

test('tracé : une voie déjà réservée en permanence n\'est pas retirée une seconde fois', () => {
  const net = new TQ.Network(data, { trees: false }), e = data.edges;
  const busy = [], free = [];
  for (let i = 0; i < net.E; i++) if (e.cor[i]) (e.bus[i] > 0 ? busy : free).push(i);
  assert.ok(busy.length > 0, 'des arêtes du tracé portent une voie réservée permanente');
  assert.ok(free.length > 0);
  net.setConditions({ laneDrop: true, winter: false });
  for (const i of busy) assert.strictEqual(net.ecap[i], net.ecap0[i], 'arête ' + i);
  for (const i of free) assert.ok(net.ecap[i] < net.ecap0[i], 'arête ' + i);
  // même chose dans une simulation du tramway
  const sim = new TQ.Simulation(data, { scenario: { line: 'tram', cab: 'off' }, start: 12 * 3600 });
  assert.ok(sim.net.cond.laneDrop);
  for (const i of busy) assert.strictEqual(sim.net.ecap[i], e.cap[i], 'arête ' + i);
  for (const i of free) assert.ok(sim.net.ecap[i] < e.cap[i], 'arête ' + i);
});

test('Cybercab : une attente déjà courte n\'est pas ramenée vers 4 minutes', () => {
  const F = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'wide', fleet: 1500 } }).fleet;
  F.waitEma[0] = 2; F.waitEma[1] = 6; F.rejectEma[1] = 0.2;
  F.step(F.lastRebalance + 300); // toute la flotte est libre
  assert.strictEqual(F.waitEma[0], 2);
  assert.ok(Math.abs(F.waitEma[1] - 5.8) < 1e-6 && Math.abs(F.rejectEma[1] - 0.18) < 1e-6);
  for (let k = 0; k < 200; k++) F.step(F.lastRebalance + 300);
  assert.ok(F.waitEma[1] >= 4 && F.waitEma[1] < 4.01 && F.waitEma[0] === 2);
  assert.ok(Math.abs(F.perceivedWait(0) - 2.5) < 1e-3);
  // la voie réservée aux Cybercab part du même coût que les voies réservées aux bus (le curseur de la page règle les deux)
  assert.strictEqual(TQ.ECON_DEFAULTS.line.cablane.capex, TQ.ECON_DEFAULTS.line.bus.capex);
});
