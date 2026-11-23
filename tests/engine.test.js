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
  // Cybercab : postes séparés (STORY-024) ; ce résumé n'a pas de nombre de bornes, le ratio de repli s'applique
  const k = TQ.cabCosts(s), o = k.opex;
  assert.ok(k.fromRatio && k.chargers === Math.ceil(1000 / E.cab.vehPerCharger));
  assert.ok(Math.abs(o.km - 100000 * E.cab.opexKm) < 1e-9 && Math.abs(o.fixed - (1000 * E.cab.fixedYearPerVeh) / 300) < 1e-9);
  assert.ok(Math.abs(c.opex - (o.km + o.fixed + o.supervision + o.cleaning + (o.energy + o.demand + o.chargers + o.depot + o.tax) / 300)) < 1e-6);
  assert.strictEqual(c.capex, k.capexTotal);
  assert.ok(Math.abs(c.capital * 300 - k.capitalYear) < 1e-6);
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

test('les usagers venus du RTC sont comptés pour le mode qui les prend, ligne ou Cybercab', () => {
  // un seul mode à la fois : le compteur des usagers venus du RTC est celui de la ligne, ou celui de la flotte
  const tram = run({ line: 'tram', cab: 'off' }, 3, 6 * 3600).summary();
  assert.ok(tram.lineFrom.rtc > 0);
  assert.strictEqual(tram.fromRtc, tram.lineFrom.rtc);
  assert.strictEqual(tram.cabFrom.rtc + tram.cabFrom.line, 0);
  const cab = run({ line: 'none', cab: 'wide', fleet: 1500 }, 3, 6 * 3600).summary();
  assert.ok(cab.cabFrom.rtc > 0);
  assert.strictEqual(cab.fromRtc, cab.cabFrom.rtc);
  assert.strictEqual(cab.lineFrom.rtc, 0);
  assert.strictEqual(cab.cabFrom.line, 0, 'plus aucun voyageur ne passe de la ligne au Cybercab');
});

test('un seul mode : le moteur refuse une ligne avec une flotte, au constructeur, à reset et à setScenario', () => {
  const mixed = /Scénario refusé : une ligne .* et une flotte de Cybercab/;
  for (const line of ['tram', 'bus']) for (const cab of ['corridor', 'wide']) {
    assert.throws(() => new TQ.Simulation(data, { scenario: { line, cab, fleet: 500 } }), mixed, `${line} + ${cab}`);
  }
  const sim = new TQ.Simulation(data, { scenario: { line: 'tram', cab: 'off' }, start: 7 * 3600 });
  sim.step(600);
  const before = JSON.stringify(sim.summary()), scenario = JSON.stringify(sim.scenario), resets = sim.resets;
  // setScenario vérifie le scénario fusionné avant de le poser : un refus laisse tout en place
  assert.throws(() => sim.setScenario({ cab: 'wide' }), mixed);
  assert.strictEqual(JSON.stringify(sim.scenario), scenario, 'scénario inchangé après le refus');
  assert.strictEqual(JSON.stringify(sim.summary()), before, 'simulation inchangée après le refus');
  assert.strictEqual(sim.resets, resets);
  sim.step(600);
  assert.strictEqual(sim.t, 7 * 3600 + 1200, 'la simulation continue');
  // un scénario mêlé posé à la main est refusé par reset, sans remise à zéro
  sim.scenario.cab = 'corridor';
  const t = sim.t;
  assert.throws(() => sim.reset(7 * 3600), mixed);
  assert.strictEqual(sim.t, t);
  assert.strictEqual(sim.resets, resets);
  // ... et par la fin de journée, avant de toucher à history, day ou run (sinon chaque pas suivant la rejouerait)
  const day = sim.day, nHist = sim.history.length, nRun = sim.run.length;
  assert.throws(() => sim.endDay(), mixed);
  assert.deepStrictEqual([sim.day, sim.history.length, sim.run.length, sim.t], [day, nHist, nRun, t]);
  sim.scenario.cab = 'off';
  // passer d'un mode à l'autre en une fois reste permis
  sim.setScenario({ line: 'none', cab: 'corridor', fleet: 500 });
  assert.ok(sim.fleet && !sim.line);
  assert.throws(() => sim.setScenario({ line: 'bus' }), mixed);
  assert.strictEqual(sim.scenario.line, 'none');
  sim.setScenario({ line: 'bus', cab: 'off' });
  assert.ok(sim.line && !sim.fleet);
  // l'ancienne voie « cablane » devient line none avant la vérification : elle reste acceptée avec une flotte
  const old = new TQ.Simulation(data, { scenario: { line: 'cablane', cab: 'wide', fleet: 500 } });
  assert.strictEqual(old.scenario.line, 'none');
  assert.ok(old.fleet && !old.line);
  sim.setScenario({ line: 'cablane', cab: 'corridor' });
  assert.strictEqual(sim.scenario.line, 'none');
  assert.ok(sim.fleet && !sim.line);
});

test('rentabilité cumulée : les journées enchaînées s\'additionnent, une remise à zéro repart de rien', () => {
  const sim = new TQ.Simulation(data, { scenario: { line: 'tram', cab: 'off' } });
  assert.strictEqual(sim.run.length, 0);
  assert.strictEqual(sim.runSummaries().length, 1);
  while (!sim.history.length) sim.step(10);
  // la fin de journée ne vide pas la liste : elle y ajoute la journée qui finit
  assert.strictEqual(sim.run.length, 1);
  assert.strictEqual(sim.run[0], sim.history[0]);
  for (let i = 0; i < 2 * 360; i++) sim.step(10);
  const list = sim.runSummaries();
  assert.strictEqual(list.length, 2);
  // seuls des résumés sont gardés, pas l'état du moteur
  for (const s of sim.run) assert.ok(!(s instanceof TQ.Simulation) && s.elapsedH > 0 && JSON.parse(JSON.stringify(s)).trips === s.trips);
  const d1 = TQ.economics(sim.history[0]), cur = TQ.economics(sim.summary()), tot = TQ.economicsTotal(list);
  assert.ok(Math.abs(list[1].elapsedH - 2) < 1e-9);
  for (const k of ['revenue', 'opex', 'capital', 'operating', 'net', 'riders']) {
    assert.ok(Math.abs(tot[k] - (d1[k] + cur[k])) < 1e-6 * Math.max(1, Math.abs(tot[k])), k + ' : ' + tot[k] + ' contre ' + (d1[k] + cur[k]));
    assert.ok(Math.abs(tot.parts[0][k] - (d1.parts[0][k] + cur.parts[0][k])) < 1e-6 * Math.max(1, Math.abs(tot[k])), 'partie ' + k);
  }
  assert.ok(cur.revenue > 0 && tot.revenue > d1.revenue);
  assert.strictEqual(tot.capex, d1.capex);
  assert.strictEqual(tot.days, 2);
  assert.deepStrictEqual(tot.parts.map((p) => p.kind), ['tram']);
  // d'autres hypothèses de coût : le cumul se recalcule à partir des mêmes résumés
  const E = JSON.parse(JSON.stringify(TQ.ECON)); E.line.tram.opexKm *= 2;
  const dear = TQ.economicsTotal(list, E);
  assert.ok(Math.abs(dear.opex - (TQ.economics(list[0], E).opex + TQ.economics(list[1], E).opex)) < 1e-6 && dear.opex > tot.opex);
  // changement de scénario, saut dans le temps ou remise à zéro : la liste repart de rien
  sim.setScenario({ winter: true });
  assert.strictEqual(sim.run.length, 0);
  sim.step(600);
  sim.reset(TQ.PARAMS.dayStart);
  assert.strictEqual(sim.run.length, 0);
  // une journée partielle (partie de 3 h) compte dans le cumul, sans entrer dans la comparaison
  const part = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'corridor', fleet: 500 }, start: TQ.PARAMS.dayStart + 86400 - 3600 });
  part.step(3600 + 600);
  assert.strictEqual(part.history.length, 0);
  assert.strictEqual(part.run.length, 1);
  assert.ok(Math.abs(part.run[0].elapsedH - 1) < 1e-9);
  assert.strictEqual(TQ.economicsTotal(part.runSummaries()).days, 2);
  // liste vide : rien
  assert.strictEqual(TQ.economicsTotal([]).net, 0);
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

test('ancien scénario « cablane » : traité comme line none, sans voie, même résumé que la même flotte', () => {
  const old = run({ line: 'cablane', cab: 'corridor', fleet: 500 }, 1.5, 7 * 3600);
  const none = run({ line: 'none', cab: 'corridor', fleet: 500 }, 1.5, 7 * 3600);
  assert.strictEqual(old.scenario.line, 'none');
  assert.ok(!old.line && !old.net.cond.laneDrop);
  assert.ok(none.summary().cab.rides > 0);
  assert.deepStrictEqual(old.summary(), none.summary());
  // même chose quand le scénario change en cours de route
  const sw = new TQ.Simulation(data, { scenario: { line: 'tram', cab: 'off' }, start: 7 * 3600 });
  sw.setScenario({ line: 'cablane', cab: 'corridor', fleet: 500 });
  for (let i = 0; i < 1.5 * 360; i++) sw.step(10);
  assert.deepStrictEqual(sw.summary(), none.summary());
  // le bilan ne compte plus que la flotte
  assert.deepStrictEqual(TQ.economics(old.summary()).parts.map((p) => p.key), ['cab']);
  // « cablane » sans flotte : la référence (Rien), sans retrait de voie et avec un bilan vide
  const off = new TQ.Simulation(data, { scenario: { line: 'cablane', cab: 'off' } });
  assert.strictEqual(off.scenario.line, 'none');
  assert.ok(!off.line && !off.net.cond.laneDrop);
  assert.ok(!TQ.economics(off.summary()).parts.length);
  // une remise à zéro après un bout de simulation redonne le résultat d'une simulation neuve, avec une flotte
  const again = run({ line: 'none', cab: 'corridor', fleet: 500 }, 0.5, 7 * 3600); again.reset(7 * 3600); again.step(1800);
  const fresh = run({ line: 'none', cab: 'corridor', fleet: 500 }, 0.5, 7 * 3600);
  assert.deepStrictEqual(again.summary(), fresh.summary());
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
});

test('calendrier : jours fériés 2026 et 2027, Pâques, vacances de la construction, Noël, fin de semaine', () => {
  const D = TQ.dayInfo;
  const ferie = (d, key) => { const i = D(d); assert.strictEqual(i.holiday, key, d); assert.strictEqual(i.type, 'ferie', d); };
  for (const [d, k] of [['2026-01-01', 'jour-de-l-an'], ['2026-04-06', 'lundi-de-paques'], ['2026-05-18', 'patriotes'], ['2026-06-24', 'fete-nationale'], ['2026-07-01', 'fete-du-canada'], ['2026-09-07', 'fete-du-travail'], ['2026-10-12', 'action-de-grace'], ['2026-12-25', 'noel'],
    ['2027-01-01', 'jour-de-l-an'], ['2027-03-29', 'lundi-de-paques'], ['2027-05-24', 'patriotes'], ['2027-06-24', 'fete-nationale'], ['2027-07-01', 'fete-du-canada'], ['2027-09-06', 'fete-du-travail'], ['2027-10-11', 'action-de-grace'], ['2027-12-25', 'noel']]) ferie(d, k);
  // Vendredi saint : jour férié repéré, mais journée presque normale (jour ouvrable)
  for (const d of ['2026-04-03', '2027-03-26']) { const i = D(d); assert.strictEqual(i.holiday, 'vendredi-saint'); assert.strictEqual(i.type, 'ouvrable'); assert.strictEqual(i.weekday, 5); }
  // ... férié selon la loi : voies réservées de pointe libres (règlement « à l'exception des jours fériés »), grille de semaine
  for (const d of ['2026-04-03', '2027-03-26']) { assert.strictEqual(D(d).peakLanes, false, d); assert.strictEqual(D(d).service, 'semaine', d); }
  assert.strictEqual(D('2026-04-02').peakLanes, true);
  // 2 janvier : chômé dans la fonction publique, comme les 24, 26 et 31 décembre (vendredi en 2026, samedi en 2027)
  for (const d of ['2026-01-02', '2027-01-02']) {
    const i = D(d); assert.strictEqual(i.holiday, 'lendemain-du-jour-de-l-an', d); assert.strictEqual(i.type, 'ferie', d);
    assert.strictEqual(i.total, 0.72, d); assert.strictEqual(i.peakLanes, false, d); assert.strictEqual(i.service, 'fin-de-semaine', d);
  }
  assert.strictEqual(D('2026-01-05').type, 'ouvrable'); assert.strictEqual(D('2026-01-05').total, 0.85);
  // dimanche de Pâques : un dimanche ordinaire du calendrier
  assert.strictEqual(D('2026-04-05').type, 'dimanche'); assert.strictEqual(D('2026-04-05').holiday, null);
  // Noël 2026 : vendredi ; Noël 2027 : samedi, toujours férié
  assert.strictEqual(D('2026-12-25').weekday, 5); assert.strictEqual(D('2027-12-25').weekday, 6);
  assert.strictEqual(D('2026-12-25').label, 'Noël'); assert.strictEqual(D('2026-12-25').special, 'fetes');
  // bornes de la CCQ : du dimanche 19 juillet au samedi 1er août 2026, du 25 juillet au 7 août 2027
  for (const [d, inside] of [['2026-07-18', false], ['2026-07-19', true], ['2026-08-01', true], ['2026-08-02', false], ['2027-07-24', false], ['2027-07-25', true], ['2027-08-07', true], ['2027-08-08', false]]) {
    assert.strictEqual(D(d).special === 'construction', inside, d);
  }
  assert.strictEqual(D('2026-07-22').label, 'vacances de la construction');
  assert.strictEqual(D('2026-08-31').special, 'rentree');
  assert.strictEqual(D('2027-03-03').special, 'relache');
  assert.strictEqual(D('2027-01-04').special, 'retour-des-fetes');
  // vendredi -> samedi, en calcul de date UTC (sans fuseau, y compris au changement d'heure)
  assert.strictEqual(D('2026-07-24').type, 'ouvrable');
  assert.strictEqual(TQ.addDays('2026-07-24', 1), '2026-07-25');
  assert.strictEqual(D('2026-07-25').type, 'samedi'); assert.strictEqual(D('2026-07-26').type, 'dimanche');
  assert.strictEqual(TQ.addDays('2026-03-07', 1), '2026-03-08'); assert.strictEqual(TQ.addDays('2026-03-08', 1), '2026-03-09');
  assert.strictEqual(TQ.addDays('2026-10-31', 1), '2026-11-01'); assert.strictEqual(TQ.addDays('2026-12-31', 1), '2027-01-01');
  assert.strictEqual(TQ.addDays('2027-03-01', -1), '2027-02-28');
  assert.strictEqual(TQ.formatDate('2026-08-01'), 'samedi 1er août 2026');
  // saisons et hiver (décembre à mars)
  assert.strictEqual(D('2026-07-08').season, 'été'); assert.strictEqual(D('2027-01-20').season, 'hiver');
  assert.ok(D('2027-01-20').winter && D('2027-03-31').winter && !D('2027-04-01').winter && D('2026-12-01').winter && !D('2026-11-30').winter);
  // jour neutre : jour type d'automne, tous les facteurs valent 1 ; de même un jour ouvrable de septembre à novembre
  const n = D(null);
  assert.strictEqual(n.type, 'ouvrable-automne'); assert.strictEqual(n.date, null); assert.strictEqual(n.profile, null);
  assert.strictEqual(n.label, 'Jour type d\'automne'); assert.strictEqual(n.winter, false);
  for (const d of [null, '2026-09-16', '2026-10-14', '2026-11-25', '2027-10-20']) { assert.deepStrictEqual(D(d).f, { A: 1, H: 1, P: 1, N: 1 }, d); assert.strictEqual(D(d).profile, null); assert.strictEqual(D(d).total, 1); }
  // facteurs datés : construction, Fêtes, hiver (janvier), samedi, Noël
  assert.deepStrictEqual(D('2026-07-22').f, { A: 0.73, H: 1.08, P: 0.93, N: 1.27 });
  assert.deepStrictEqual(D('2026-12-29').f, { A: 0.41, H: 0.97, P: 0.76, N: 0.97 });
  assert.deepStrictEqual(D('2027-01-20').f, { A: 0.89, H: 0.89, P: 0.89, N: 0.89 });
  assert.strictEqual(D('2026-07-25').f, null); assert.ok(D('2026-07-25').profile); assert.ok(Math.abs(D('2026-07-25').total - 0.98 * 0.88) < 1e-12);
  assert.strictEqual(D('2026-12-25').total, 0.56);
  // férié une fin de semaine : le plus bas des deux facteurs (26 décembre 2026, un samedi des Fêtes : 0,77 × 0,88 < 0,72)
  assert.ok(Math.abs(D('2026-12-26').total - 0.77 * 0.88) < 1e-12);
  // ... et dans l'autre sens : Noël 2027, un samedi (0,56 < 0,77 × 0,88), puis le 26, un dimanche (0,77 × 0,79 < 0,72)
  assert.strictEqual(D('2027-12-25').total, 0.56);
  assert.ok(Math.abs(D('2027-12-26').total - 0.77 * 0.79) < 1e-12);
  // les dates proposées par la page tombent bien le jour annoncé
  for (const [d, w] of [['2026-07-08', 3], ['2026-07-22', 3], ['2026-08-31', 1], ['2026-12-16', 3], ['2026-12-29', 2], ['2027-01-20', 3]]) assert.strictEqual(D(d).weekday, w, d);
});

test('calendrier : une date hors de 2026-2027 ou mal formée est refusée, sans toucher à la simulation', () => {
  for (const d of ['2025-12-31', '2028-01-01', '2026-02-30', '2026-13-01', '22 juillet', '']) assert.throws(() => TQ.dayInfo(d), /Date refusée/, d);
  assert.throws(() => new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off', date: '2028-01-01' } }), /Date refusée/);
  const sim = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off', date: '2026-07-22' } });
  sim.step(600);
  const t = sim.t;
  assert.throws(() => sim.setScenario({ date: '2025-06-01' }), /Date refusée/);
  assert.strictEqual(sim.scenario.date, '2026-07-22'); assert.strictEqual(sim.date, '2026-07-22'); assert.strictEqual(sim.t, t);
});

test('date neutre : un mercredi d\'octobre 2026 donne le même résumé que le jour type, tant que les facteurs valent 1', () => {
  const go = (sc) => { const sim = new TQ.Simulation(data, { scenario: sc }); for (let i = 0; i < 3 * 360; i++) sim.step(10); return sim.summary(); };
  for (const sc of [{ line: 'tram', cab: 'off' }, { line: 'none', cab: 'corridor', fleet: 500 }]) {
    const a = go(sc), b = go(Object.assign({ date: '2026-10-14' }, sc));
    // sans date, le résumé n'a pas de champ date (même forme qu'avant le calendrier)
    assert.ok(!('date' in a.scenario));
    assert.strictEqual(b.scenario.date, '2026-10-14');
    delete b.scenario.date;
    assert.deepStrictEqual(b, a);
    // une date posée à null se comporte comme l'absence de date
    assert.deepStrictEqual(go(Object.assign({ date: null }, sc)), a);
  }
});

test('journées enchaînées : avec une date, la fin de journée passe au lendemain ; sans date, rien ne change', () => {
  const start = TQ.PARAMS.dayStart + 86400 - 1800; // 4 h 30
  const sim = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off', date: '2026-07-24' }, start });
  assert.strictEqual(sim.dayInfo.type, 'ouvrable');
  sim.step(3600);
  assert.strictEqual(sim.date, '2026-07-25'); assert.strictEqual(sim.scenario.date, '2026-07-25');
  assert.strictEqual(sim.dayInfo.type, 'samedi'); assert.strictEqual(sim.day, 2);
  // chaque résumé porte la date de sa journée
  assert.strictEqual(sim.run[0].scenario.date, '2026-07-24'); assert.strictEqual(sim.summary().scenario.date, '2026-07-25');
  // journée complète : elle entre dans la comparaison avec sa date
  while (!sim.history.length) sim.step(10);
  assert.strictEqual(sim.history[0].scenario.date, '2026-07-25'); assert.strictEqual(sim.date, '2026-07-26');
  // sans date : le jour type se rejoue
  const neutral = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off' }, start });
  neutral.step(3600);
  assert.strictEqual(neutral.date, null); assert.ok(!('date' in neutral.scenario)); assert.strictEqual(neutral.dayInfo.type, 'ouvrable-automne');
  // à la fin du calendrier, la dernière date se rejoue
  const last = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off', date: '2027-12-31' }, start });
  last.step(3600);
  assert.strictEqual(last.date, '2027-12-31');
});

test('compteurs cumulés : déplacements, répartition, CO2, montées par station et Cybercab s\'additionnent sur les journées', () => {
  const start = TQ.PARAMS.dayStart + 86400 - 6 * 3600; // 23 h, la journée finit à 5 h (la ligne ferme de 1 h à 5 h)
  const sum = (list, f) => list.reduce((a, s) => a + f(s), 0);
  const close = (a, b, k) => assert.ok(Math.abs(a - b) <= 1e-6 * Math.max(1, Math.abs(b)), `${k} : ${a} contre ${b}`);
  const sim = new TQ.Simulation(data, { scenario: { line: 'tram', cab: 'off', date: '2026-10-14' }, start });
  for (let i = 0; i < 8 * 360; i++) sim.step(10); // jusqu'à 7 h : 6 h la veille, 2 h le jour même
  const list = sim.runSummaries(), aux = sim.runAuxiliary(), R = TQ.runTotals(list, aux);
  assert.strictEqual(list.length, 2); assert.strictEqual(aux.length, 2); assert.strictEqual(R.days, 2);
  close(R.hours, 8, 'heures');
  close(R.trips, sum(list, (s) => s.trips), 'déplacements');
  for (const k of TQ.Simulation.MODES) close(R.modes[k], sum(list, (s) => s.modes[k]), k);
  close(R.co2Avoided, sum(list, (s) => s.co2Avoided), 'CO2');
  close(R.line.boardings, sum(list, (s) => s.line.boardings), 'montées');
  assert.ok(R.line.boardings > list[1].line.boardings && list[0].line.boardings > 0);
  // les montées par station de la veille et du jour s'additionnent, et leur somme redonne les montées
  close(R.stationBoard.reduce((a, b) => a + b, 0), R.line.boardings, 'montées par station');
  for (let j = 0; j < R.stationBoard.length; j++) close(R.stationBoard[j], aux[0].stationBoard[j] + sim.line.stationBoard[j], 'station ' + j);
  // le résumé garde sa forme : les montées par station n'y sont pas
  assert.ok(!('stationBoard' in list[1]) && !('stationBoard' in list[1].line));
  // un changement de scénario remet tout à 0
  sim.setScenario({ line: 'bus' });
  assert.strictEqual(sim.run.length, 0); assert.strictEqual(sim.runAux.length, 0);
  assert.strictEqual(TQ.runTotals(sim.runSummaries(), sim.runAuxiliary()).trips, 0);
  // Cybercab : passagers, demandes et kilomètres s'additionnent ; les moyennes sont refaites sur les sommes
  const cab = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'corridor', fleet: 500 }, start });
  for (let i = 0; i < 8 * 360; i++) cab.step(10);
  const cl = cab.runSummaries(), C = TQ.runTotals(cl, cab.runAuxiliary()).cab;
  for (const k of ['rides', 'unserved', 'pooled', 'vkmEmpty', 'vkmLoaded']) close(C[k], sum(cl, (s) => s.cab[k]), k);
  assert.ok(C.rides > cl[1].cab.rides && cl[0].cab.rides > 0);
  close(C.emptyShare, C.vkmEmpty / (C.vkmEmpty + C.vkmLoaded), 'km à vide');
  const lo = Math.min(...cl.map((s) => s.cab.avgWait)), hi = Math.max(...cl.map((s) => s.cab.avgWait));
  assert.ok(C.avgWait >= lo - 1e-9 && C.avgWait <= hi + 1e-9);
  assert.ok(C.speed > 0);
  // une seule journée : le cumul est la journée elle-même
  const one = TQ.runTotals([cl[1]]);
  assert.strictEqual(one.trips, cl[1].trips); assert.strictEqual(one.cab.rides, cl[1].cab.rides);
  assert.strictEqual(TQ.runTotals([]).trips, 0);
});

// ---------------------------------------------------------------- calendrier : facteurs, voies réservées, grille horaire
const ratesOf = (date) => { const sim = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off', date } }); return { rate: Array.from(sim.hourRate), sim }; };
const sumH = (r, a, b) => { let x = 0; for (let h = a; h < b; h++) x += r[h]; return x; };

test('calendrier : un jour neutre garde la demande du jour type, sans aucun calcul', () => {
  const n = ratesOf(null);
  assert.strictEqual(n.sim.hourRate, n.sim.baseRate);
  for (const d of ['2026-10-14', '2026-09-16', '2026-11-25']) {
    const s = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off', date: d } });
    assert.strictEqual(s.hourRate, s.baseRate, d); assert.ok(!s.net.peaksOff && !s.winter, d);
  }
  // revenir à la date neutre redonne la demande du jour type
  n.sim.setScenario({ date: '2026-07-22' }); assert.notStrictEqual(n.sim.hourRate, n.sim.baseRate);
  n.sim.setScenario({ date: null }); assert.strictEqual(n.sim.hourRate, n.sim.baseRate);
});

test('calendrier : volumes de la journée (25 décembre plus bas, juillet plus haut, construction en pointe du matin)', () => {
  const oct = ratesOf('2026-10-14').rate, base = sumH(oct, 0, 24);
  const noel = ratesOf('2026-12-25').rate, dec = ratesOf('2026-12-16').rate, jul = ratesOf('2026-07-08').rate, ccq = ratesOf('2026-07-22').rate;
  assert.ok(sumH(noel, 0, 24) < sumH(dec, 0, 24) && sumH(noel, 0, 24) < base);
  assert.ok(Math.abs(sumH(noel, 0, 24) / base - 0.56) < 1e-9);
  assert.ok(sumH(jul, 0, 24) > base, 'juillet hors construction : total du jour au-dessus d\'octobre');
  assert.ok(Math.abs(sumH(ccq, 6, 9) / sumH(oct, 6, 9) - 0.73) < 1e-9);
});

test('calendrier : pointe du matin simulée, un samedi sous 40 % et la construction à 0,73 d\'un jour d\'octobre', () => {
  const am = (date) => run({ line: 'none', cab: 'off', date }, 3, 6 * 3600).summary().trips; // 6 h à 9 h
  const oct = am('2026-10-14'), sat = am('2026-10-17'), ccq = am('2026-07-22');
  // samedi : le modèle donne 0,345 (profil de l'A-40 appliqué à la demande de l'enquête O-D), sous les 0,41 mesurés
  // sur l'A-40 en 2024 : écart déclaré dans les limites du README. Le seuil serré protège la valeur du modèle.
  assert.ok(sat < 0.4 * oct, 'samedi ' + sat + ' contre ' + oct);
  assert.ok(Math.abs(sat / oct - 0.345) < 0.02, 'samedi ' + sat / oct);
  assert.ok(Math.abs(ccq / oct - 0.73) <= 0.02, 'construction ' + ccq / oct);
});

test('calendrier : voies réservées de pointe et grille horaire de fin de semaine', () => {
  const [e0, cap0, a0] = data.peaks[0];
  const peakEdges = [...new Set(data.peaks.map((p) => p[0]))];
  const t = (a0 + 10) * 60; // en pleine plage de pointe
  const mk = (date) => new TQ.Simulation(data, { scenario: { line: 'tram', cab: 'off', date }, start: t });
  const wd = mk('2026-10-14'), sat = mk('2026-10-17'), hol = mk('2026-10-12'); // Action de grâce : un lundi
  assert.strictEqual(wd.net.ecap0[e0], cap0); assert.ok(!wd.net.peaksOff);
  for (const s of [sat, hol]) {
    assert.ok(s.net.peaksOff); assert.strictEqual(s.net.peakNext, Infinity);
    for (const e of peakEdges) assert.strictEqual(s.net.ecap0[e], data.edges.cap[e]);
    s.step(3600);
    for (const e of peakEdges) assert.strictEqual(s.net.ecap0[e], data.edges.cap[e]);
  }
  // grille : pointe aux 4 minutes en semaine ; la fin de semaine, intervalle de jour (8 min) de 6 h à 20 h, puis de soir
  const h = (s, hr) => s.line.headway(hr * 3600) / 60;
  assert.strictEqual(h(wd, 7.5), 4); assert.strictEqual(h(wd, 16), 4);
  for (const hr of [6.2, 7.5, 12, 16, 19.5]) assert.strictEqual(h(sat, hr), 8, 'samedi ' + hr);
  for (const hr of [5.5, 21, 0.5]) assert.strictEqual(h(sat, hr), 12, 'samedi ' + hr);
  assert.strictEqual(h(sat, 3), 0); assert.ok(!sat.line.isOpen(3 * 3600));
  assert.strictEqual(hol.line.service, 'fin-de-semaine'); assert.strictEqual(wd.line.service, 'semaine');
  // sans grille donnée, servicePeriod est inchangé
  for (let m = 0; m < 1440; m += 15) assert.strictEqual(TQ.servicePeriod(m * 60), TQ.servicePeriod(m * 60, 'semaine'));
  // 28 au 30 décembre : jour ouvrable (voies en vigueur), mais service du RTC au niveau du samedi
  const d = TQ.dayInfo('2026-12-29'); assert.ok(d.peakLanes); assert.strictEqual(d.service, 'fin-de-semaine');
  assert.strictEqual(TQ.dayInfo('2026-12-22').service, 'semaine');
  // journées enchaînées : du dimanche 18 au lundi 19 octobre 2026, les voies et la grille de semaine reviennent,
  // comme dans une simulation partie directement le lundi
  const ch = new TQ.Simulation(data, { scenario: { line: 'tram', cab: 'off', date: '2026-10-18' }, start: TQ.PARAMS.dayStart + 86400 - 1800 });
  assert.ok(ch.net.peaksOff); assert.strictEqual(ch.line.service, 'fin-de-semaine');
  ch.step(3600);
  assert.strictEqual(ch.date, '2026-10-19'); assert.ok(!ch.net.peaksOff); assert.strictEqual(ch.line.service, 'semaine');
  ch.step(Math.floor(ch.t / 86400) * 86400 + (a0 + 10) * 60 - ch.t); // en pleine plage de pointe du lundi
  const fresh = mk('2026-10-19');
  assert.strictEqual(ch.net.ecap0[e0], cap0); assert.strictEqual(ch.net.ecap0[e0], fresh.net.ecap0[e0]);
  assert.strictEqual(h(ch, (ch.t % 86400) / 3600), h(fresh, (fresh.t % 86400) / 3600));
});

test('calendrier : l\'hiver vient de la date, la case « Journée d\'hiver » reste prioritaire', () => {
  const jan = new TQ.Simulation(data, { scenario: { line: 'tram', cab: 'off', date: '2027-01-20' } });
  assert.ok(jan.winter && !jan.scenario.winter && jan.line.winter && jan.net.cond.winter);
  assert.strictEqual(jan.summary().scenario.winter, true); assert.ok(/hiver/.test(jan.summary().label));
  const jul = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off', date: '2026-07-22' } });
  assert.ok(!jul.winter && !jul.net.cond.winter && jul.summary().scenario.winter === false);
  jul.setScenario({ winter: true }); assert.ok(jul.winter && jul.net.cond.winter);
  // sans date, seule la case compte
  const n = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'off' } });
  assert.strictEqual(n.winter, false); assert.ok(!('date' in n.summary().scenario));
});

// --- STORY-024 : bornes, dépôts et raccordement des Cybercab

test('Cybercab : le nombre de bornes suit la pointe de véhicules en recharge, sans changer la journée', () => {
  const C = TQ.PARAMS.cab, battery = C.batteryKwh;
  C.batteryKwh = 8; // petite batterie : des recharges dès les premières heures
  try {
    const sim = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'corridor', fleet: 400 }, start: 7 * 3600 });
    const F = sim.fleet, starts = [], count = F.countCharging.bind(F);
    // chaque début de recharge est noté, pour recalculer la pointe à part
    F.countCharging = (t) => { starts.push(t); count(t); };
    let seen = 0;
    for (let i = 0; i < 3 * 360; i++) {
      sim.step(10);
      let c = 0;
      for (let k = 0; k < F.n; k++) if (F.state[k] === 3 && F.tFree[k] > sim.t) c++;
      seen = Math.max(seen, c * F.w);
    }
    const s = sim.summary().cab, kw = (C.batteryKwh * (1 - C.reserve)) / (C.chargeMin / 60);
    assert.ok(s.charges > 0 && s.chargePeak > 0, 'des recharges ont lieu');
    // pointe mesurée à chaque début de recharge : au moins celle vue à chaque pas, au plus le nombre de recharges
    assert.ok(s.chargePeak >= seen - 1e-9 && s.chargePeak <= s.charges + 1e-9, `pointe ${s.chargePeak}, vue ${seen}`);
    // recalcul indépendant : plus grand chevauchement des recharges [début, début + chargeMin)
    const len = C.chargeMin * 60;
    let overlap = 0;
    for (const t of starts) overlap = Math.max(overlap, starts.filter((u) => u <= t && u + len > t).length);
    assert.strictEqual(starts.length * F.w, s.charges);
    assert.ok(Math.abs(s.chargePeak - overlap * F.w) < 1e-9, `pointe ${s.chargePeak}, chevauchement ${overlap * F.w}`);
    assert.ok(Math.abs(s.chargePeak / F.w - Math.round(s.chargePeak / F.w)) < 1e-9, 'pointe en véhicules réels');
    assert.strictEqual(s.chargers, Math.max(0, Math.ceil(s.chargePeak * (1 + C.chargerMargin) - 1e-9)));
    assert.ok(s.chargers >= s.chargePeak && s.chargers <= s.chargePeak * (1 + C.chargerMargin) + 1);
    assert.ok(Math.abs(s.chargePeakKw - s.chargePeak * kw) < 1e-6);
    assert.ok(s.chargePeakH >= 7 && s.chargePeakH <= 10);
    assert.strictEqual(TQ.economics(sim.summary()).parts[0].items.nChargers, s.chargers);
    // la mesure ne change pas la journée : sans elle, les champs existants du résumé sont identiques
    const bare = new TQ.Simulation(data, { scenario: { line: 'none', cab: 'corridor', fleet: 400 }, start: 7 * 3600 });
    bare.fleet.countCharging = () => {};
    for (let i = 0; i < 3 * 360; i++) bare.step(10);
    const strip = (x) => { const y = JSON.parse(JSON.stringify(x)); for (const k of ['chargePeak', 'chargePeakH', 'chargePeakKw', 'chargers']) delete y.cab[k]; return JSON.stringify(y); };
    assert.strictEqual(strip(bare.summary()), strip(sim.summary()));
  } finally { C.batteryKwh = battery; }
  // sans recharge : aucune borne, aucune heure de pointe
  const quiet = run({ line: 'none', cab: 'corridor', fleet: 300 }, 0.2, 7 * 3600).summary().cab;
  assert.ok(quiet.chargePeak >= 0 && quiet.chargers >= 0);
  if (quiet.chargePeak === 0) assert.ok(Object.is(quiet.chargers, 0) && quiet.chargePeakH === null);
});

test('Cybercab : investissement égal à la somme des postes, chacun sur sa durée de vie', () => {
  const E = JSON.parse(JSON.stringify(TQ.ECON)), p = E.cab, d = p.depot;
  const s = { elapsedH: 24, cab: { fleet: 1000, rides: 14000, revenue: 90000, vkmEmpty: 20000, vkmLoaded: 80000, kwh: 11000, speed: 25, chargePeak: 50, chargePeakKw: 4850, chargers: 60 } };
  const k = TQ.cabCosts(s, E), c = k.capex;
  assert.ok(!k.fromRatio && k.chargers === 60 && k.kwInstalled === 60 * p.charger.kw);
  assert.strictEqual(k.depots, Math.ceil((60 * p.charger.kw) / p.depotMaxKw));
  assert.strictEqual(c.vehicles, 1000 * p.vehicle);
  assert.strictEqual(c.chargers, 60 * p.charger.cost);
  assert.strictEqual(c.grid, 60 * p.charger.kw * p.grid.perKw);
  assert.ok(Math.abs(c.land - 1000 * (d.parkM2 + d.buildM2) * d.landM2) < 1e-6);
  assert.ok(Math.abs(c.pave - 1000 * d.parkM2 * d.paveM2 * (1 + d.indirect)) < 1e-6);
  assert.ok(Math.abs(c.build - 1000 * d.buildM2 * d.buildCostM2 * (1 + d.indirect)) < 1e-6);
  const sum = c.vehicles + c.chargers + c.grid + c.land + c.pave + c.build;
  assert.ok(Math.abs(k.capexTotal - sum) < 1e-6);
  const e = TQ.economics(s, E), part = e.parts[0], it = part.items;
  assert.ok(Math.abs(e.capex - sum) < 1e-6 && Math.abs(it.vehicles + it.chargers + it.grid + it.depots - sum) < 1e-6);
  assert.ok(it.nChargers === 60 && it.nDepots === k.depots && it.chargersFromRatio === false);
  // durées de vie : chaque poste sur la sienne, le terrain au seul coût d'opportunité
  const A = (v, n) => v * TQ.annuity(E.discount, n);
  const expect = A(c.vehicles, p.life) + A(c.chargers, p.charger.life) + A(c.grid, p.grid.life) + c.land * E.discount + A(c.pave, d.paveLife) + A(c.build, d.buildLife);
  assert.ok(Math.abs(k.capitalYear - expect) < 1e-6 && Math.abs(part.capital * 300 - expect) < 1e-6);
  const E2 = JSON.parse(JSON.stringify(E)); E2.cab.charger.life = 20;
  const k2 = TQ.cabCosts(s, E2);
  assert.ok(Math.abs(k.capitalYear - k2.capitalYear - (A(c.chargers, 10) - A(c.chargers, 20))) < 1e-6, 'seule la part des bornes change');
  assert.strictEqual(k2.capexTotal, k.capexTotal);
  // électricité au tarif M : prime sur la pointe mesurée, énergie en deux tranches par dépôt et par mois
  const W = p.power, month = (11000 * 300) / 12 / k.depots;
  assert.ok(Math.abs(k.opex.demand - 12 * W.demandKwMonth * 4850) < 1e-6);
  assert.ok(Math.abs(k.opex.energy - 12 * k.depots * (Math.min(month, W.energy1Kwh) * W.energy1 + Math.max(0, month - W.energy1Kwh) * W.energy2)) < 1e-6);
  // supervision : heures de circulation / véhicules par agent ; nettoyage : minutes par véhicule et par jour
  assert.ok(Math.abs(k.opex.supervision - (100000 / 25 / p.supervision.vehPerAgent) * p.supervision.wageH * (1 + p.payrollLoad)) < 1e-6);
  assert.ok(Math.abs(k.opex.cleaning - 1000 * (p.cleaning.minPerVehDay / 60) * p.cleaning.wageH * (1 + p.payrollLoad)) < 1e-6);
  // une demi-journée : la moitié de l'investissement étalé, même investissement
  const half = TQ.economics(Object.assign({}, s, { elapsedH: 12 }), E).parts[0];
  assert.ok(Math.abs(half.capital - part.capital / 2) < 1e-6 && half.capex === part.capex);
});

test('Cybercab : un ancien résumé sans nombre de bornes reste calculable', () => {
  const old = { elapsedH: 24, cab: { fleet: 500, rides: 26000, revenue: 124000, vkmEmpty: 24000, vkmLoaded: 70000, kwh: 10400, speed: 28 } };
  const e = TQ.economics(old), it = e.parts[0].items;
  assert.ok(it.chargersFromRatio && it.nChargers === Math.ceil(500 / TQ.ECON.cab.vehPerCharger));
  for (const v of [e.capex, e.opex, e.capital, e.net, e.annual.net]) assert.ok(Number.isFinite(v));
  const tot = TQ.economicsTotal([old, old]);
  assert.ok(Number.isFinite(tot.net) && tot.parts[0].items.nChargers === it.nChargers);
  // repli : pointe appelée = bornes sans la marge, à la puissance moyenne d'une recharge (pas à 150 kW)
  const C = TQ.PARAMS.cab, kwCharge = (C.batteryKwh * (1 - C.reserve)) / (C.chargeMin / 60);
  assert.ok(Math.abs(TQ.cabCosts(old).peakKw - (it.nChargers / (1 + C.chargerMargin)) * kwCharge) < 1e-6);
  // un résumé passé par JSON avec NaN (devenu null) prend aussi le repli, pas 0 borne
  const nul = JSON.parse(JSON.stringify(Object.assign({}, old, { cab: Object.assign({}, old.cab, { chargers: NaN, chargePeakKw: NaN }) })));
  const kn = TQ.cabCosts(nul);
  assert.ok(nul.cab.chargers === null && kn.fromRatio && kn.chargers === it.nChargers && kn.peakKw > 0);
  // même sans vitesse ni énergie (très ancien résumé)
  assert.ok(Number.isFinite(TQ.economics({ elapsedH: 24, cab: { fleet: 100, rides: 0, revenue: 0, vkmEmpty: 0, vkmLoaded: 0, kwh: 0 } }).net));
});

test('Cybercab : le cumul de plusieurs journées garde les bornes de la plus forte pointe', () => {
  const base = { fleet: 500, rides: 26000, revenue: 124000, vkmEmpty: 24000, vkmLoaded: 70000, kwh: 10400, speed: 28 };
  const d1 = { elapsedH: 24, cab: Object.assign({}, base, { chargePeak: 14.3, chargePeakKw: 1387.2, chargers: 18 }) };
  // la journée suivante vient de commencer : encore aucune recharge
  const d2 = { elapsedH: 0.2, cab: Object.assign({}, base, { rides: 200, revenue: 950, vkmEmpty: 180, vkmLoaded: 520, kwh: 77, chargePeak: 0, chargePeakKw: 0, chargers: 0 }) };
  const one = TQ.economics(d1), tot = TQ.economicsTotal([d1, d2]), it = tot.parts[0].items;
  assert.ok(it.nChargers === 18 && it.peakSoFar === false && !it.chargersFromRatio);
  assert.strictEqual(tot.capex, one.capex);
  assert.strictEqual(it.chargers, one.parts[0].items.chargers);
  // la journée entamée compte son investissement étalé avec les mêmes bornes
  const d2sized = TQ.economics(d2, undefined, { chargers: 18, chargePeakKw: 1387.2 });
  assert.ok(Math.abs(tot.capital - (one.capital + d2sized.capital)) < 1e-6);
  assert.ok(Math.abs(d2sized.capital - (one.capital * 0.2) / 24) < 1e-6);
  // une seule journée en cours : la pointe est celle atteinte jusqu'ici, et c'est dit
  const solo = TQ.economicsTotal([Object.assign({}, d1, { elapsedH: 3 })]).parts[0].items;
  assert.ok(solo.peakSoFar === true && solo.nChargers === 18);
});

test('Cybercab : le tramway, le bus et la référence ne portent ni bornes ni postes de dépôt', () => {
  const E = TQ.ECON;
  for (const kind of ['tram', 'bus']) {
    const s = { elapsedH: 24, line: { kind, boardings: 50000, vehKm: 7000 } }, p = E.line[kind], l = TQ.economics(s).parts[0];
    assert.deepStrictEqual(Object.keys(l), ['key', 'kind', 'capex', 'riders', 'revenue', 'opex', 'capital', 'operating', 'net']);
    assert.ok(Math.abs(l.opex - (7000 * p.opexKm + p.fixedYear / 300)) < 1e-6 && l.capex === p.capex);
    assert.ok(Math.abs(l.capital * 300 - p.capex * TQ.annuity(E.discount, p.life)) < 1e-3);
  }
  const ref = run({ line: 'none', cab: 'off' }, 0.1).summary();
  assert.ok(!ref.cab && !TQ.economics(ref).parts.length);
});
