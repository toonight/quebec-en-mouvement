// Étude des Cybercab : combien d'autos une flotte retire-t-elle, et à partir de quel tarif la congestion baisse ?
// Usage : node tests/cab_study.js <flotte> <tarif au km> [forfait] [none|tram|bus] [off|corridor|wide]
//   HOURLY=1 ajoute le détail heure par heure. POOL=1 : courses partagées. CARFREE=0.1 : 10 % des déplacements auto de la zone desservie faits sans auto.
//   Le Cybercab seul sur le tracé se choisit avec la ligne « none ».
const { TQ, data } = require('./load');
const [fleet = '1500', perKm = '1.2', base = '3.5', line = 'none', cab = 'wide'] = process.argv.slice(2);
TQ.PARAMS.cab.fareBase = +base;
const sim = new TQ.Simulation(data, { scenario: { line, cab, fleet: +fleet, farePerKm: +perKm, pool: !!process.env.POOL, carFree: +(process.env.CARFREE || 0) } });
const hours = [];
let prev = { removed: 0, req: 0, unserved: 0, rides: 0 }, series = null;
for (let h = 0; h < 24; h++) {
  for (let k = 0; k < 360 && !sim.history.length; k++) { series = sim.series; sim.step(10); }
  if (sim.history.length) break;
  const m = sim.m, f = sim.fleet ? sim.fleet.stats : { requests: 0, ridesPersons: 0 };
  const cur = { removed: m.carsRemoved, req: f.requests * TQ.PARAMS.scale, unserved: m.cabUnserved, rides: f.ridesPersons };
  const c = sim.fleet ? sim.fleet.counts() : null;
  hours.push({ h: (5 + h) % 24, removed: cur.removed - prev.removed, req: cur.req - prev.req, unserved: cur.unserved - prev.unserved, idle: c ? c.idle / sim.fleet.fleetReal : 0, cong: sim.cur.congestion });
  prev = cur;
}
while (!sim.history.length) { series = sim.series; sim.step(10); }
const s = sim.history[0], e = TQ.economics(s), a = e.annual;
const mean = (h0, h1) => { let x = 0, n = 0; series.t.forEach((t, i) => { const h = t / 3600; if (h > h0 && h <= h1) { x += series.congestion[i]; n++; } }); return n ? Math.round((x / n) * 100) : 0; };
const cabSpeed = s.cab ? +s.cab.speed.toFixed(1) : 0;
const M = (v) => (v == null ? '–' : (v / 1e6).toFixed(0));
console.log(JSON.stringify({
  scenario: s.label, tarif: `${base} $ + ${perKm} $/km`,
  passagers: Math.round(s.cab ? s.cab.rides : 0), sansVehicule: Math.round(s.cab ? s.cab.unserved : 0), aVide: s.cab ? Math.round(s.cab.emptyShare * 100) + ' %' : '–',
  autosRetirees: Math.round(s.carsRemoved), deAuto: Math.round(s.cabFrom.auto), deRtc: Math.round(s.cabFrom.rtc), deActif: Math.round(s.cabFrom.actif), deLigne: Math.round(s.cabFrom.line),
  vkmAuto: Math.round(s.carVkm / 1000), vkmCab: Math.round(s.cab ? (s.cab.vkmEmpty + s.cab.vkmLoaded) / 1000 : 0), vkmRoute: Math.round(s.roadVkm / 1000),
  partages: Math.round(s.cab ? s.cab.pooled : 0), sansAuto: Math.round(s.carFree || 0), vitesseCab: cabSpeed, montees: Math.round(s.line ? s.line.boardings : 0),
  congJour: Math.round(s.congestion * 100), congMatin: mean(7, 9), congSoir: mean(16, 18), vitesse: +s.avgSpeed.toFixed(1),
  exploitantM$: M(a.net), societeM$: M(a.society.net),
}));
if (process.env.HOURLY) {
  console.log('heure | autos retirées | demandes | sans véhicule | flotte libre | temps perdu');
  for (const r of hours) console.log(`${String(r.h).padStart(2)} h | ${String(Math.round(r.removed)).padStart(6)} | ${String(Math.round(r.req)).padStart(6)} | ${String(Math.round(r.unserved)).padStart(6)} (${r.req ? Math.round((r.unserved / r.req) * 100) : 0} %) | ${Math.round(r.idle * 100)} % | +${Math.round(r.cong * 100)} %`);
}
