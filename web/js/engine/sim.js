/* Simulation : génération de la demande (EOD 2023), choix modal, orchestration, indicateurs. */
(function () {
  const TQ = typeof window !== 'undefined' ? window.TQ : globalThis.TQ;
  const PERIOD_OF_HOUR = [];
  for (let h = 0; h < 24; h++) PERIOD_OF_HOUR.push(h >= 6 && h < 9 ? 'A' : h >= 9 && h < 15 ? 'H' : h >= 15 && h < 18 ? 'P' : 'N');
  const MODES = ['auto', 'rtc', 'actif', 'autre', 'line', 'cab'];

  class Simulation {
    constructor(data, opts) {
      opts = opts || {};
      this.data = data;
      this.P = TQ.PARAMS;
      this.seed = opts.seed || 20261119;
      this.net = new TQ.Network(data);
      // line : none | tram | bus | cablane (voie réservée aux Cybercab : un seul type de véhicule par voie) ;
      // pool : courses partagées ; carFree : part des résidents de la zone desservie qui renoncent à leur auto
      this.scenario = Object.assign({ line: 'none', cab: 'off', fleet: 3000, farePerKm: this.P.cab.farePerKm, winter: false, pool: false, carFree: 0, auto: false }, opts.scenario || {});
      this.history = [];
      this.day = 1;
      this.prepareDemand();
      this.preparePoints();
      this.reset(opts.start != null ? opts.start : this.P.dayStart);
    }

    // ------------------------------------------------------------------ préparation
    prepareDemand() {
      const od = this.data.od, Z = 12, P = this.P;
      const night = od.JTO.map((row, i) => row.map((v, j) => Math.max(0, v - od.ATO[i][j] - od.HTO[i][j] - od.PTO[i][j])));
      const mats = { A: od.ATO, H: od.HTO, P: od.PTO, N: night };
      this.cdf = {}; this.periodTotal = {};
      for (const k of 'AHPN') {
        const cum = new Float64Array(Z * Z); let acc = 0;
        for (let i = 0; i < Z; i++) for (let j = 0; j < Z; j++) {
          if (!(i >= 9 && j >= 9)) acc += mats[k][i][j]; // les échanges entre zones externes ne sont pas modélisés
          cum[i * Z + j] = acc;
        }
        this.cdf[k] = cum; this.periodTotal[k] = acc;
      }
      const share = { A: 0, H: 0, P: 0, N: 0 };
      for (let h = 0; h < 24; h++) share[PERIOD_OF_HOUR[h]] += P.hourly[h];
      this.hourRate = new Float64Array(24); // déplacements par heure
      for (let h = 0; h < 24; h++) { const k = PERIOD_OF_HOUR[h]; this.hourRate[h] = (this.periodTotal[k] * P.hourly[h]) / share[k]; }
      // parts modales de référence par paire OD et par période (repli sur les parts 24 h quand la cellule est trop mince)
      const cell = (k, m, i, j) => (k === 'N' ? Math.max(0, od['J' + m][i][j] - od['A' + m][i][j] - od['H' + m][i][j] - od['P' + m][i][j]) : od[k + m][i][j]);
      this.baseShare = {};
      for (const k of 'JAHPN') {
        const sh = (this.baseShare[k] = new Float32Array(Z * Z * 4));
        for (let i = 0; i < Z; i++) for (let j = 0; j < Z; j++) {
          const o = (i * Z + j) * 4;
          const au = cell(k, 'AU', i, j), tc = cell(k, 'TC', i, j), nm = cell(k, 'NM', i, j), to = cell(k, 'TO', i, j);
          if (k !== 'J' && Math.max(to, au + tc + nm) < 400) { for (let q = 0; q < 4; q++) sh[o + q] = this.baseShare.J[o + q]; continue; }
          const tot = Math.max(to, au + tc + nm, 1);
          sh[o] = au / tot; sh[o + 1] = tc / tot; sh[o + 2] = nm / tot; sh[o + 3] = Math.max(0, 1 - (au + tc + nm) / tot);
        }
      }
    }

    preparePoints() {
      const d = this.data, G = TQ.geo, P = this.P, L = d.line;
      // informations par point de demande (points puis portes)
      this.info = d.points.map((p) => ({ lon: p.lon, lat: p.lat, zone: p.zone, home: p.home, act: p.act, label: p.label }));
      for (const g of d.gates) this.info.push({ lon: g.lon, lat: g.lat, zone: -1, home: 0, act: 0, label: g.name, gate: true });
      // échantillonneurs par zone : domicile et activité
      const Z = 12;
      this.sampler = [];
      for (let z = 0; z < Z; z++) {
        const s = { home: { idx: [], cum: [] }, act: { idx: [], cum: [] } };
        let ah = 0, aa = 0;
        d.points.forEach((p, i) => { if (p.zone === z) { ah += p.home; aa += p.act; s.home.idx.push(i); s.home.cum.push(ah); s.act.idx.push(i); s.act.cum.push(aa); } });
        // portes : moitié des déplacements de la ceinture nord, totalité des zones 10 et 11
        const gw = z === 9 ? 1 : z >= 10 ? 1e9 : 0;
        if (gw) d.gates.forEach((g, gi) => {
          const w = g.zones[z];
          if (!w) return;
          const hw = z === 9 ? w * ah : w, awt = z === 9 ? w * aa : w;
          s.home.idx.push(this.net.gateOffset + gi); s.act.idx.push(this.net.gateOffset + gi);
          s.home.cum.push((s.home.cum.length ? s.home.cum[s.home.cum.length - 1] : 0) + hw);
          s.act.cum.push((s.act.cum.length ? s.act.cum[s.act.cum.length - 1] : 0) + awt);
        });
        this.sampler.push(s);
      }
      // accès à la ligne : stations candidates par point
      const st = L.stations, stLL = st.map((s) => { const o = [0, 0]; this.lineLL(s.s, o); return o; });
      this.stationLL = stLL;
      this.cand = this.info.map((p) => {
        if (p.gate) return [];
        const ds = stLL.map((ll, i) => ({ i, m: G.dist(p.lon, p.lat, ll[0], ll[1]) })).sort((a, b) => a.m - b.m);
        const out = [];
        for (const c of ds.slice(0, 2)) if (c.m <= P.walkMax) { const t = (c.m * 1.3) / P.walkSpeed; out.push({ st: c.i, t, gen: P.walkWeight * t, feeder: false }); }
        if (!out.length && ds[0].m <= 3000) { const t = (ds[0].m * 1.35) / P.feederSpeed + 7; out.push({ st: ds[0].i, t, gen: 1.3 * t + 5, feeder: true }); }
        const hub = ds.find((c) => st[c.i].hub);
        if (hub && hub.m > P.walkMax && hub.m <= 7000 && !out.some((c) => c.st === hub.i)) { const t = (hub.m * 1.35) / P.feederSpeed + 6; out.push({ st: hub.i, t, gen: 1.3 * t + 4, feeder: true }); }
        return out;
      });
      // distance au tracé (zone de service « corridor » des Cybercab)
      this.lineDist = this.info.map((p) => {
        let best = 1e9;
        for (let i = 0; i < L.coords.length; i += 2) { const m = G.dist(p.lon, p.lat, L.coords[i][0], L.coords[i][1]); if (m < best) best = m; }
        return best;
      });
      // stationnement à destination (minutes de recherche et de marche, coût par déplacement)
      const centre = [[-71.2165, 46.809], [-71.223, 46.815]], mid = [[-71.275, 46.781], [-71.286, 46.768]];
      this.park = this.info.map((p) => {
        if (centre.some((c) => G.dist(p.lon, p.lat, c[0], c[1]) < 1300)) return { min: 7, cost: 4.5 };
        if (mid.some((c) => G.dist(p.lon, p.lat, c[0], c[1]) < 1000)) return { min: 4, cost: 1.5 };
        return { min: 1, cost: 0 };
      });
    }

    lineLL(s, out) {
      const L = this.data.line, cum = L.cum;
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
      const t = cum[hi] > cum[lo] ? (s - cum[lo]) / (cum[hi] - cum[lo]) : 0;
      out[0] = L.coords[lo][0] + (L.coords[hi][0] - L.coords[lo][0]) * t;
      out[1] = L.coords[lo][1] + (L.coords[hi][1] - L.coords[lo][1]) * t;
    }

    // ------------------------------------------------------------------ état
    reset(start) {
      this.resets = (this.resets || 0) + 1; // l'affichage s'en sert pour oublier les véhicules de la journée précédente
      const sc = this.scenario, P = this.P;
      // flux aléatoires indépendants : la demande tirée ne dépend pas du scénario
      // et chaque journée rejoue le même tirage : les journées comparées, et la référence, ont la même demande
      this.rndDemand = TQ.rng(this.seed + 7919);
      this.rnd = TQ.rng((this.seed ^ 0x9e3779b9) + 104729);
      const rndLine = TQ.rng((this.seed ^ 0xc2b2ae35) + 1), rndCab = TQ.rng((this.seed ^ 0x27d4eb2f) + 1);
      this.t = start; this.tDayStart = start;
      this.tDayEnd = P.dayStart + 86400 * (Math.floor((start - P.dayStart) / 86400) + 1); // prochaine frontière de 5 h
      // la voie du tracé sert aux Cybercab quand elle leur est réservée
      this.cabLane = sc.cab !== 'off' && sc.line === 'cablane';
      // sans flotte, la voie réservée aux Cybercab n'existe pas : les autos gardent leurs voies
      this.net.setConditions({ laneDrop: sc.line === 'tram' || sc.line === 'bus' || this.cabLane, winter: sc.winter, cabLane: this.cabLane, auto: !!sc.auto });
      this.net.resetTraffic();
      for (let d = 0; d < this.net.D; d++) { this.net.computeTree(d); if (this.cabLane) this.net.computeTree(d, true); }
      this.line = sc.line === 'none' || sc.line === 'cablane' ? null : new TQ.TransitLine(this.data.line, sc.line, rndLine, sc.winter);
      this.fleet = null; this.net.cabKm = null; this.net.cabIdx = null;
      if (sc.cab !== 'off') {
        const mask = new Uint8Array(this.info.length);
        for (let p = 0; p < this.info.length; p++) {
          const i = this.info[p];
          mask[p] = i.gate ? 0 : sc.cab === 'corridor' ? (this.lineDist[p] <= P.cab.corridorRadius ? 1 : 0) : i.zone <= 5 ? 1 : 0;
        }
        this.cabMask = mask;
        this.fleet = new TQ.CabFleet(this.net, mask, sc.fleet, this.info, rndCab, sc.winter, { pool: sc.pool });
      }
      this.pending = []; for (let i = 0; i < 64; i++) this.pending.push([]);
      this.pendingMin = Math.floor(start / 60);
      this.flowAcc = 0; this.treeAcc = 0; this.seriesAcc = 0;
      this.m = {
        trips: 0, modes: { auto: 0, rtc: 0, actif: 0, autre: 0, line: 0, cab: 0 },
        lineFrom: { auto: 0, rtc: 0, actif: 0 }, cabFrom: { auto: 0, rtc: 0, actif: 0, line: 0 },
        carsRemoved: 0, divertedCarKm: 0, local: 0, cabUnserved: 0, crowKm: 0, gainMin: 0, fromRtc: 0, toRtc: 0, carFree: 0,
      };
      this.series = { t: [], speed: [], congestion: [], lineLoad: [], lineBoard: [], cabWait: [], cars: [] };
      this.lastBoard = 0;
      this.cur = { speed: 0, congestion: 0 };
      this.onArrive = (type, payload) => (type === 0 ? -1 : this.fleet ? this.fleet.onArrive(type, payload, this.t) : -1);
    }

    setScenario(cfg) {
      Object.assign(this.scenario, cfg);
      this.reset(this.t);
    }

    scenarioLabel() {
      const s = this.scenario, parts = [];
      if (s.line === 'tram') parts.push('Tramway'); else if (s.line === 'bus') parts.push('Bus voies réservées'); else if (s.line === 'cablane' && s.cab !== 'off') parts.push('Voie réservée aux Cybercab');
      const extra = [];
      if (s.farePerKm !== this.P.cab.farePerKm) extra.push(`${s.farePerKm.toFixed(2).replace('.', ',')} $/km`);
      if (s.pool) extra.push('courses partagées');
      if (s.carFree > 0) extra.push(`${Math.round(s.carFree * 100)} % sans auto`);
      if (s.cab !== 'off') parts.push(`Cybercab ${s.cab === 'corridor' ? 'corridor' : 'réseau élargi'} (${[s.fleet.toLocaleString('fr-CA'), ...extra].join(', ')})`);
      if (!parts.length) parts.push('Référence (situation actuelle)');
      if (s.auto) { if (parts[0] === 'Référence (situation actuelle)') parts[0] = 'Autos autonomes, sans feux'; else parts.push('autos autonomes'); }
      if (s.winter) parts.push('hiver');
      return parts.join(' + ');
    }

    // ------------------------------------------------------------------ boucle
    /** Avance la simulation de dt secondes (découpées en pas de 2 s au plus). */
    step(dt) {
      while (dt > 1e-9) {
        const h = Math.min(2, dt);
        this.tick(h);
        dt -= h;
      }
    }

    tick(dt) {
      const net = this.net, P = this.P;
      this.t += dt;
      const t = this.t;
      this.generate(dt);
      // voyageurs arrivant aux stations après leur trajet d'accès
      const minute = Math.floor(t / 60);
      while (this.pendingMin < minute) {
        const b = this.pending[this.pendingMin & 63];
        if (b.length) { if (this.line) for (const p of b) this.line.addPassenger(p.i, p.j, t); b.length = 0; }
        this.pendingMin++;
      }
      if (this.line) this.line.step(t, dt);
      if (this.fleet) this.fleet.step(t);
      net.stepVehicles(dt, this.onArrive);
      this.flowAcc += dt;
      if (this.flowAcc >= 60) { net.updateFlows(this.flowAcc); this.flowAcc = 0; }
      // hors congestion, les itinéraires changent peu : recalcul quatre fois moins fréquent
      this.treeAcc += (net.D * dt) / (this.cur.congestion < P.calmCongestion ? P.treeRefresh * 4 : P.treeRefresh);
      if (this.treeAcc >= 1) { const n = Math.floor(this.treeAcc); net.refreshTrees(n); this.treeAcc -= n; }
      this.seriesAcc += dt;
      if (this.seriesAcc >= 600) { this.sample(); this.seriesAcc = 0; }
      if (t >= this.tDayEnd) this.endDay();
    }

    sample() {
      const w = this.net.win, s = this.series;
      const speed = w.time > 0 ? (w.len / w.time) * 3.6 : 0;
      const cong = w.free > 0 ? w.time / w.free - 1 : 0;
      this.cur.speed = speed; this.cur.congestion = cong;
      w.len = 0; w.time = 0; w.free = 0;
      s.t.push(this.t); s.speed.push(speed); s.congestion.push(cong);
      let cars = 0; const vW = this.net.vW, vT = this.net.vType;
      for (let i = 0; i < this.net.vn; i++) if (vT[i] === 0) cars += vW[i];
      s.cars.push(cars);
      if (this.line) { this.line.updatePeak(); s.lineLoad.push(this.line.curPeak || 0); s.lineBoard.push((this.line.stats.boardings - this.lastBoard) * 6); this.lastBoard = this.line.stats.boardings; } else { s.lineLoad.push(0); s.lineBoard.push(0); }
      s.cabWait.push(this.fleet && this.fleet.stats.waitN ? this.fleet.stats.waitSum / this.fleet.stats.waitN : 0);
    }

    endDay() {
      // seules les journées complètes (5 h à 5 h) entrent dans la comparaison
      if (this.tDayStart <= this.P.dayStart + 1) { this.history.push(this.summary()); this.lastDayFlows = this.net.eday.slice(); }
      this.day++;
      this.reset(this.P.dayStart + 0);
    }

    // ------------------------------------------------------------------ demande et choix modal
    generate(dt) {
      const P = this.P, rnd = this.rndDemand;
      const hf = (((this.t % 86400) + 86400) % 86400) / 3600;
      const h = Math.floor(hf) % 24;
      // interpolation entre centres d'heures
      const c = hf - 0.5, h0 = ((Math.floor(c) % 24) + 24) % 24, h1 = (h0 + 1) % 24, f = c - Math.floor(c);
      const rate = this.hourRate[h0] * (1 - f) + this.hourRate[h1] * f;
      const n = TQ.poisson((rate * dt) / 3600 / P.scale, rnd);
      // chaque déplacement appartient à l'heure dont il provient (les totaux par période de l'EOD sont conservés)
      const w0 = rate > 0 ? (this.hourRate[h0] * (1 - f)) / rate : 1;
      for (let i = 0; i < n; i++) {
        const k = PERIOD_OF_HOUR[rnd() < w0 ? h0 : h1], cum = this.cdf[k], pHome = P.homeOrigin[k];
        const pair = TQ.pick(cum, rnd());
        const zo = (pair / 12) | 0, zd = pair % 12;
        const homeO = rnd() < pHome;
        const so = this.sampler[zo][homeO ? 'home' : 'act'], sd = this.sampler[zd][homeO ? 'act' : 'home'];
        if (!so.idx.length || !sd.idx.length) continue;
        const o = so.idx[TQ.pick(so.cum, rnd())];
        // tirage de la destination avec dissuasion par la distance (effet gravitaire à l'intérieur des secteurs)
        let d = sd.idx[TQ.pick(sd.cum, rnd())];
        const A = this.info[o];
        // (les portes du territoire gardent leur poids : la dissuasion ne s'applique qu'entre points internes)
        for (let r = 0; r < P.gravityTries && !this.info[d].gate && !A.gate; r++) {
          const B = this.info[d];
          if (this.net.dnode[d] !== this.net.dnode[o] && rnd() < Math.exp(-TQ.geo.dist(A.lon, A.lat, B.lon, B.lat) / P.gravityLambda)) break;
          let nd = sd.idx[TQ.pick(sd.cum, rnd())];
          for (let q = 0; q < 8 && this.info[nd].gate; q++) nd = sd.idx[TQ.pick(sd.cum, rnd())];
          if (!this.info[nd].gate) d = nd;
        }
        this.m.crowKm += (TQ.geo.dist(A.lon, A.lat, this.info[d].lon, this.info[d].lat) / 1000) * P.scale;
        this.m.trips += P.scale;
        if (this.net.dnode[d] === this.net.dnode[o]) { this.m.local += P.scale; this.m.modes.actif += P.scale; continue; }
        this.trip(o, d, zo, zd, k, rnd(), homeO ? o : d);
      }
    }

    /** home : point de demande du domicile du voyageur (origine ou destination du déplacement). */
    trip(o, d, zo, zd, k, r, home) {
      const P = this.P, rnd = this.rnd, net = this.net, m = this.m, sc = P.scale;
      const b = (zo * 12 + zd) * 4, bs = this.baseShare[k];
      let base = r < bs[b] ? 0 : r < bs[b] + bs[b + 1] ? 1 : r < bs[b] + bs[b + 1] + bs[b + 2] ? 2 : 3;
      const A = this.info[o], B = this.info[d];
      const km = (TQ.geo.dist(A.lon, A.lat, B.lon, B.lat) * 1.3) / 1000;
      const tCar = net.carTime(o, d) / 60;
      const park = this.park[d];
      const gtCar = tCar + park.min + ((P.carCostKm * km + park.cost) / P.vot) * 60;
      const fareMin = (P.transitFare / P.vot) * 60;
      const gtRtc = P.walkWeight * 8 + P.waitWeight * 6 + (km / P.rtcSpeedKmh) * 60 + (km > 7 ? 6 : 0) + fareMin;
      const gtAct = (km / (km < 1.5 ? 4.8 : 13)) * 60;
      let mode = base; // 0 auto, 1 rtc, 2 actif, 3 autre, 4 ligne, 5 cab
      // gain du voyageur qui change de mode : moitié de l'écart de coût généralisé (minutes) avec son mode d'origine
      const gtBase = base === 0 ? gtCar : base === 1 ? gtRtc : gtAct;
      let gain = 0;
      // ménage qui a renoncé à son auto parce que la flotte dessert son quartier : ce déplacement se fait sans auto
      const noCar = base === 0 && this.fleet && this.scenario.carFree > 0 && home != null && this.cabMask[home] === 1 && rnd() < this.scenario.carFree;
      let lineChoice = null, gtLine = Infinity;
      // --- report vers la ligne structurante
      if (this.line && base !== 3 && this.line.isOpen(this.t)) {
        const co = this.cand[o], cd = this.cand[d], L = this.line, lp = L.p;
        for (let x = 0; x < co.length; x++) for (let y = 0; y < cd.length; y++) {
          const i = co[x].st, j = cd[y].st;
          if (Math.abs(L.st[i].s - L.st[j].s) < 700) continue;
          const dir = j > i ? 0 : 1;
          let gt = fareMin + co[x].gen + cd[y].gen + P.waitWeight * L.waitEst(dir, i, this.t) + (lp.ivtWeight * L.timeBetween(i, j)) / 60;
          if (co[x].feeder && cd[y].feeder) gt += 8;
          if (gt < gtLine) { gtLine = gt; lineChoice = { i, j, access: co[x].t }; }
        }
        if (lineChoice && !noCar) {
          let p = 0;
          if (base === 1) p = TQ.sigmoid(P.theta * (gtRtc - gtLine + lp.bonus));
          else if (base === 0) p = TQ.sigmoid(P.theta * (gtCar - gtLine + lp.bonus - P.carCaptivity));
          else if (base === 2 && km > 1.5) p = 0.5 * TQ.sigmoid(P.theta * (gtAct - gtLine - 5));
          if (rnd() < p) { mode = 4; gain = 0.5 * Math.max(0, gtBase - gtLine); }
        }
      }
      // --- report vers le Cybercab
      const cabOk = this.fleet && base !== 3 && this.cabMask[o] && this.cabMask[d];
      let cabFare = 0, cabZone = 0, gtCabNoCar = Infinity;
      if (cabOk) {
        const C = P.cab, zone = A.zone < 0 ? 0 : A.zone, pool = this.scenario.pool;
        // course partagée : rabais sur le prix, contre un détour possible
        const fare = (C.fareBase + this.scenario.farePerKm * km) * (pool ? 1 - C.poolDiscount : 1);
        const vot = mode === 4 || base === 1 ? P.votTransit : P.vot;
        // temps à bord : celui des Cybercab, plus court que celui des autos quand ils ont leur voie
        const tCab = (this.cabLane ? net.cdist[d][net.dnode[o]] / 60 : tCar) + (pool ? C.poolPerceivedMin : 0);
        const waitCab = P.waitWeight * this.fleet.perceivedWait(zone);
        const gtCab = waitCab + tCab + (fare / vot) * 60;
        // pour le bilan, le tarif est compté à sa valeur faciale, à la même valeur du temps que le mode d'origine
        const gtCabGain = waitCab + tCab + (fare / P.vot) * 60;
        cabFare = fare; cabZone = zone; gtCabNoCar = gtCabGain;
        let p;
        if (noCar) p = 0; else
        if (mode === 4) p = TQ.sigmoid(P.theta * (gtLine - gtCab - 2));
        else if (base === 0) p = TQ.sigmoid(P.theta * (gtCar - gtCab - C.captivity));
        else if (base === 1) p = TQ.sigmoid(P.theta * (gtRtc - gtCab - 2));
        else p = km > 1.2 ? 0.3 * TQ.sigmoid(P.theta * (gtAct - gtCab - 4)) : 0;
        if (rnd() < p) {
          if (this.fleet.request(o, d, this.t, zone, fare)) {
            m.cabFrom[mode === 4 ? 'line' : MODES[base]] += sc; mode = 5;
            gain = Math.max(gain, 0.5 * Math.max(0, gtBase - gtCabGain));
          }
          else m.cabUnserved += sc;
        }
      }
      // sans auto : le voyageur prend la moins coûteuse des solutions qui lui restent
      if (noCar) {
        const opts = [[gtRtc, 1], [gtAct, 2]];
        if (lineChoice) opts.push([gtLine, 4]);
        if (cabOk) opts.push([gtCabNoCar, 5]);
        opts.sort((x, y) => x[0] - y[0]);
        for (const [, md] of opts) {
          if (md === 5) {
            if (!this.fleet.request(o, d, this.t, cabZone, cabFare)) { m.cabUnserved += sc; continue; }
            m.cabFrom.auto += sc;
          }
          mode = md; break;
        }
        m.carFree += sc;
        if (mode === 1) m.toRtc += sc;
      }
      m.modes[MODES[mode]] += sc;
      if (mode >= 4) { m.gainMin += gain * sc; if (base === 1) m.fromRtc += sc; }
      if (mode === 4) {
        m.lineFrom[MODES[base]] += sc;
        const at = Math.floor((this.t + lineChoice.access * 60) / 60);
        this.pending[Math.min(at, this.pendingMin + 62) & 63].push(lineChoice);
      }
      if (base === 0 && mode !== 0) { m.carsRemoved += sc / P.carOccupancy; m.divertedCarKm += (sc / P.carOccupancy) * km; }
      if (mode === 0) net.addVehicle(0, net.dnode[o], d, sc / P.carOccupancy, 0, rnd);
    }

    // ------------------------------------------------------------------ indicateurs
    summary() {
      const P = this.P, m = this.m, ns = this.net.stats, L = this.line, F = this.fleet;
      const out = {
        label: this.scenarioLabel(), scenario: Object.assign({}, this.scenario), day: this.day, t: this.t, elapsedH: (this.t - this.tDayStart) / 3600,
        trips: m.trips, avgCrowKm: m.trips ? m.crowKm / m.trips : 0, modes: Object.assign({}, m.modes), carsRemoved: m.carsRemoved,
        carVkm: ns[0].vkm, carVh: ns[0].vh, carDelayH: ns[0].vh - ns[0].vhFree,
        avgSpeed: ns[0].vh > 0 ? ns[0].vkm / ns[0].vh : 0, congestion: ns[0].vhFree > 0 ? ns[0].vh / ns[0].vhFree - 1 : 0,
        lineFrom: Object.assign({}, m.lineFrom), cabFrom: Object.assign({}, m.cabFrom), riderGainH: m.gainMin / 60, fromRtc: m.fromRtc, toRtc: m.toRtc, carFree: m.carFree, cabLane: !!this.cabLane,
      };
      let co2Added = 0;
      if (L) {
        const s = L.stats;
        out.line = {
          kind: L.kind, boardings: s.boardings, avgWait: s.waitN ? s.waitSum / s.waitN : 0, denied: s.denied, peakLoad: s.peakLoad,
          peakSeg: s.peakSeg >= 0 ? `${L.st[s.peakDir === 0 ? s.peakSeg : s.peakSeg + 1].name} → ${L.st[s.peakDir === 0 ? s.peakSeg + 1 : s.peakSeg].name}` : '',
          capacity: (60 / L.p.headway.peak) * L.p.capacity, speed: L.commercialSpeed(), fleet: s.maxFleet, vehKm: s.vehKm, paxKm: s.paxKm, cv: L.headwayCv(),
        };
        co2Added += s.vehKm * L.p.co2Km + s.vehKm * L.p.kwhKm * P.gridCO2;
      }
      if (F) {
        const s = F.stats, empty = ns[1].vkm + s.localEmpty, loaded = ns[2].vkm + s.localLoaded;
        out.cab = {
          fleet: F.fleetReal, rides: s.ridesPersons, revenue: s.revenue, rideKm: s.rideKm, ridesDone: s.ridesDone, pooled: s.pooled, speed: ns[1].vh + ns[2].vh > 0 ? (ns[1].vkm + ns[2].vkm) / (ns[1].vh + ns[2].vh) : 0, requests: s.requests * P.scale, unserved: m.cabUnserved, avgWait: s.waitN ? s.waitSum / s.waitN : 0,
          vkmEmpty: empty, vkmLoaded: loaded, emptyShare: empty + loaded > 0 ? empty / (empty + loaded) : 0,
          kwh: (empty + loaded) * F.kwhKm, ridesPerVeh: s.ridesPersons / P.cab.occupancy / F.fleetReal, charges: s.charges * F.w,
        };
        co2Added += out.cab.kwh * P.gridCO2;
      }
      // parc autonome : toutes les autos sont électriques, celles qui roulent encore n'émettent presque plus
      const auto = !!this.scenario.auto, carCO2 = auto ? P.auto.kwhKm * P.gridCO2 : P.carCO2;
      // (un kilomètre d'auto supprimé reste compté au facteur du parc actuel, à essence : même base pour les deux termes)
      out.co2Avoided = (m.divertedCarKm * P.carCO2 - co2Added + (auto ? ns[0].vkm * (P.carCO2 - carCO2) : 0)) / 1000; // tonnes
      out.roadVkm = ns[0].vkm + ns[1].vkm + ns[2].vkm;
      return out;
    }
  }

  Simulation.MODES = MODES;
  TQ.Simulation = Simulation;
})();
