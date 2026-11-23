/* Ligne structurante (tramway ou bus en voies réservées) : véhicules, stations, passagers. */
(function () {
  const TQ = typeof window !== 'undefined' ? window.TQ : globalThis.TQ;

  class TransitLine {
    /** kind : 'tram' | 'bus' */
    constructor(lineData, kind, rnd, winter) {
      this.kind = kind;
      this.p = TQ.PARAMS.line[kind];
      this.rnd = rnd;
      this.winter = !!winter;
      this.scale = TQ.PARAMS.scale;
      this.coords = lineData.coords; this.cum = lineData.cum; this.length = lineData.length; this.tunnel = lineData.tunnel;
      this.st = lineData.stations;
      const n = (this.n = this.st.length);
      this.capPackets = Math.max(1, Math.round(this.p.capacity / this.scale));
      this.wait = [[], []]; // files d'attente par sens et station
      this.waitEma = [new Float32Array(n), new Float32Array(n)];
      this.segTime = [new Float32Array(n - 1), new Float32Array(n - 1)]; // temps inter-stations lissé (s), arrêt compris
      for (let d = 0; d < 2; d++) for (let i = 0; i < n; i++) this.wait[d].push([]);
      for (let i = 0; i < n - 1; i++) {
        const t = this.runTime(i, i + 1, false) + this.p.dwellBase + 6;
        this.segTime[0][i] = t; this.segTime[1][i] = t;
      }
      this.vehicles = [];
      this.pool = [[], []];
      this.nextDepart = [0, 0];
      this.started = false;
      this.buckets = 12; // 12 tranches de 5 min = 1 h glissante
      this.segFlow = [new Float32Array((n - 1) * this.buckets), new Float32Array((n - 1) * this.buckets)];
      this.bucketIdx = 0; this.bucketT = 0;
      this.capFlow = [new Float32Array(this.buckets), new Float32Array(this.buckets)]; // places offertes sur la même heure glissante
      this.depHist = [[], []]; // heures de passage à une station témoin (régularité)
      this.witness = Math.floor(n / 2);
      this.stats = { boardings: 0, paxKm: 0, waitSum: 0, waitN: 0, denied: 0, vehKm: 0, tripTimeSum: 0, trips: 0, maxFleet: 0, peakLoad: 0, peakSeg: -1, peakDir: 0 };
      this.stationBoard = new Float32Array(n);
    }

    headway(t) {
      const per = TQ.servicePeriod(t);
      return per === 'closed' ? 0 : this.p.headway[per] * 60;
    }

    isOpen(t) { return TQ.servicePeriod(t) !== 'closed'; }

    /** Temps de marche entre deux stations adjacentes (s), hors arrêt. */
    runTime(i, j, random) {
      const p = this.p, a = Math.min(this.st[i].s, this.st[j].s), b = Math.max(this.st[i].s, this.st[j].s);
      const tun = Math.max(0, Math.min(b, this.tunnel[1]) - Math.max(a, this.tunnel[0]));
      const surf = b - a - tun;
      let t = surf / (p.cruise / 3.6) + tun / (p.cruiseTunnel / 3.6) + p.stopLoss;
      // carrefours : le tramway en tunnel n'en croise aucun ; le bus reste en surface
      const junctionLen = this.kind === 'tram' ? surf : b - a;
      const nj = junctionLen / p.junctionEvery;
      const whole = Math.floor(nj);
      if (random) {
        // tramway : priorité aux feux, retard faible et borné ; bus : priorité partielle, retards plus dispersés
        const draw = this.kind === 'tram' ? () => this.rnd() * p.junctionDelay : () => -Math.log(1 - this.rnd()) * p.junctionDelay * 0.5;
        for (let k = 0; k < whole; k++) t += draw();
        t += (nj - whole) * draw();
      } else t += nj * p.junctionDelay * 0.5;
      if (this.winter) t *= 1.06;
      return t;
    }

    /** Temps estimé (s) de la station i à la station j, d'après les marches observées. */
    timeBetween(i, j) {
      const d = j > i ? 0 : 1, a = Math.min(i, j), b = Math.max(i, j);
      let t = 0;
      for (let k = a; k < b; k++) t += this.segTime[d][k];
      return t;
    }

    /** Attente estimée (min) à la station i dans le sens d. */
    waitEst(d, i, t) {
      const h = this.headway(t) / 60;
      return Math.max(h / 2, this.waitEma[d][i]);
    }

    addPassenger(i, j, t) {
      const d = j > i ? 0 : 1;
      this.wait[d][i].push({ dest: j, t });
    }

    waitingAt(i) { return (this.wait[0][i].length + this.wait[1][i].length) * this.scale; }

    spawn(d, t) {
      let v = this.pool[d].pop();
      if (!v) {
        v = { id: this.vehicles.length, onboard: new Int16Array(this.n) };
        this.vehicles.push(v);
      }
      v.dir = d; v.load = 0; v.onboard.fill(0); v.active = true; v.tStart = t;
      v.at = d === 0 ? 0 : this.n - 1;
      v.s = this.st[v.at].s;
      this.arrive(v, t, true);
      const inService = this.vehicles.filter((x) => x.active).length;
      if (inService > this.stats.maxFleet) this.stats.maxFleet = inService;
    }

    /** Arrivée en station : descentes, montées, durée d'arrêt. */
    arrive(v, t, first) {
      const i = v.at, d = v.dir, sc = this.scale;
      const alight = v.onboard[i];
      v.load -= alight; v.onboard[i] = 0;
      const q = this.wait[d][i];
      let board = 0, k = 0;
      while (k < q.length && v.load < this.capPackets) {
        const pax = q[k++];
        v.onboard[pax.dest]++; v.load++; board++;
        const w = (t - pax.t) / 60;
        this.stats.waitSum += w * sc; this.stats.waitN += sc;
        this.waitEma[d][i] += (w - this.waitEma[d][i]) * 0.08;
        this.stats.paxKm += (Math.abs(this.st[pax.dest].s - this.st[i].s) / 1000) * sc;
      }
      if (k > 0) q.splice(0, k);
      if (q.length > 0 && v.load >= this.capPackets) {
        this.stats.denied += q.length * sc;
        // les voyageurs laissés à quai allongent l'attente perçue
        this.waitEma[d][i] += (this.headway(t) / 60) * 0.25;
      }
      this.stats.boardings += board * sc;
      this.stationBoard[i] += board * sc;
      let dwell = this.p.dwellBase + this.p.dwellPerPax * (alight + board) * sc;
      if (this.kind === 'bus') dwell *= 0.75 + 1.5 * this.rnd() * this.rnd(); // rampe, paiement à bord, portes : arrêts plus variables
      if (dwell > this.p.dwellMax) dwell = this.p.dwellMax;
      if (this.winter) dwell *= 1.1;
      if (first) dwell = Math.max(dwell, 30);
      v.state = 'dwell'; v.tEnd = t + dwell; v.tArr = t; v.dwell = dwell;
    }

    depart(v, t) {
      const i = v.at, d = v.dir, j = d === 0 ? i + 1 : i - 1;
      if (j < 0 || j >= this.n) {
        // terminus : fin de course, mise en réserve après battement
        this.stats.tripTimeSum += t - v.tStart; this.stats.trips++;
        v.state = 'layover'; v.tEnd = t + 180; v.active = false;
        return;
      }
      const seg = Math.min(i, j);
      this.segFlow[d][seg * this.buckets + this.bucketIdx] += v.load * this.scale;
      if (i === this.witness) { const h = this.depHist[d]; h.push(t); if (h.length > 24) h.shift(); }
      v.state = 'run'; v.from = i; v.to = j; v.t0 = t; v.t1 = t + this.runTime(i, j, true);
      v.depT = t;
    }

    step(t, dt) {
      if (!this.started) { this.started = true; this.nextDepart[0] = t; this.nextDepart[1] = t + 30; this.bucketT = t; }
      // rotation de la fenêtre glissante
      while (t - this.bucketT >= 300) {
        this.bucketT += 300;
        this.updatePeak();
        this.bucketIdx = (this.bucketIdx + 1) % this.buckets;
        for (let d = 0; d < 2; d++) { this.capFlow[d][this.bucketIdx] = 0; for (let s = 0; s < this.n - 1; s++) this.segFlow[d][s * this.buckets + this.bucketIdx] = 0; }
      }
      // fermeture : les voyageurs encore à quai après le dernier passage renoncent (pas d'attente jusqu'au matin)
      if (!this.isOpen(t) && this.inService() === 0) {
        for (let d = 0; d < 2; d++) for (const q of this.wait[d]) if (q.length) { this.stats.denied += q.length * this.scale; q.length = 0; }
      }
      // départs des terminus
      for (let d = 0; d < 2; d++) {
        if (t >= this.nextDepart[d]) {
          const h = this.headway(t);
          if (h > 0) { this.spawn(d, t); this.capFlow[d][this.bucketIdx] += this.p.capacity; this.nextDepart[d] = Math.max(this.nextDepart[d] + h, t - h); } else this.nextDepart[d] = t + 60;
        }
      }
      for (const v of this.vehicles) {
        if (v.state === 'layover') {
          if (t >= v.tEnd) { v.state = 'pool'; this.pool[v.dir === 0 ? 1 : 0].push(v); }
          continue;
        }
        if (v.state === 'pool' || !v.active) continue;
        if (v.state === 'dwell') {
          if (t >= v.tEnd) this.depart(v, t);
        } else if (v.state === 'run') {
          if (t >= v.t1) {
            // quai occupé par un véhicule du même sens : attente en amont (formation de trains de bus)
            if (this.platformBusy(v.to, v.dir, v)) { v.s = this.st[v.to].s - (v.dir === 0 ? 1 : -1) * (this.p.length + 6); continue; }
            const seg = Math.min(v.from, v.to);
            v.at = v.to; v.s = this.st[v.at].s;
            this.stats.vehKm += Math.abs(this.st[v.to].s - this.st[v.from].s) / 1000;
            this.arrive(v, t, false);
            const obs = t - v.depT + v.dwell;
            this.segTime[v.dir][seg] += (obs - this.segTime[v.dir][seg]) * 0.15;
          } else {
            const u = (t - v.t0) / (v.t1 - v.t0), e = u * u * (3 - 2 * u);
            v.s = this.st[v.from].s + (this.st[v.to].s - this.st[v.from].s) * e;
          }
        }
      }
    }

    /**
     * Pour l'affichage seulement : point kilométrique du véhicule v `ahead` secondes (moins d'un pas) après le
     * dernier pas calculé à l'instant t, sans rien changer à l'état. Même courbe que step() entre deux stations ;
     * à l'arrêt, en réserve ou retenu derrière un quai occupé, le véhicule reste où le moteur l'a mis.
     */
    drawS(v, t, ahead) {
      if (v.state !== 'run' || t >= v.t1 || !(ahead > 0)) return v.s;
      if (t + ahead >= v.t1) return this.platformBusy(v.to, v.dir, v) ? this.st[v.to].s - (v.dir === 0 ? 1 : -1) * (this.p.length + 6) : this.st[v.to].s;
      const u = (t + ahead - v.t0) / (v.t1 - v.t0), e = u * u * (3 - 2 * u);
      return this.st[v.from].s + (this.st[v.to].s - this.st[v.from].s) * e;
    }

    platformBusy(i, d, self) {
      for (const o of this.vehicles) if (o !== self && o.active && o.dir === d && o.state === 'dwell' && o.at === i) return true;
      return false;
    }

    updatePeak() {
      let best = 0, bs = -1, bd = 0;
      for (let d = 0; d < 2; d++) for (let s = 0; s < this.n - 1; s++) {
        let sum = 0;
        for (let b = 0; b < this.buckets; b++) sum += this.segFlow[d][s * this.buckets + b];
        if (sum > best) { best = sum; bs = s; bd = d; }
      }
      this.curPeak = best; this.curPeakSeg = bs; this.curPeakDir = bd;
      let cap = 0; for (let b = 0; b < this.buckets; b++) cap += this.capFlow[bd][b];
      this.curCap = cap;
      if (best > this.stats.peakLoad) { this.stats.peakLoad = best; this.stats.peakSeg = bs; this.stats.peakDir = bd; }
    }

    /** Capacité offerte (passagers/h/sens) à l'instant t. */
    capacityPerHour(t) { const h = this.headway(t); return h > 0 ? (3600 / h) * this.p.capacity : 0; }

    /** Irrégularité des intervalles à la station témoin (coefficient de variation). */
    headwayCv() {
      let n = 0, sum = 0, sq = 0;
      for (const h of this.depHist) for (let i = Math.max(1, h.length - 10); i < h.length; i++) { const x = h[i] - h[i - 1]; n++; sum += x; sq += x * x; }
      if (n < 4) return 0;
      const m = sum / n;
      return Math.sqrt(Math.max(0, sq / n - m * m)) / m;
    }

    inService() { let c = 0; for (const v of this.vehicles) if (v.active) c++; return c; }
    onboardNow() { let c = 0; for (const v of this.vehicles) if (v.active) c += v.load; return c * this.scale; }
    waitingNow() { let c = 0; for (let d = 0; d < 2; d++) for (const q of this.wait[d]) c += q.length; return c * this.scale; }
    commercialSpeed() { return this.stats.trips ? this.length / 1000 / (this.stats.tripTimeSum / this.stats.trips / 3600) : 0; }

    /** Position (lon, lat) et cap au point kilométrique s. */
    posAt(s, out, k) {
      const cum = this.cum;
      if (s < 0) s = 0; else if (s > this.length) s = this.length;
      let lo = 0, hi = cum.length - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (cum[mid] <= s) lo = mid; else hi = mid; }
      const t = cum[hi] > cum[lo] ? (s - cum[lo]) / (cum[hi] - cum[lo]) : 0;
      out[k] = this.coords[lo][0] + (this.coords[hi][0] - this.coords[lo][0]) * t;
      out[k + 1] = this.coords[lo][1] + (this.coords[hi][1] - this.coords[lo][1]) * t;
    }
  }

  TQ.TransitLine = TransitLine;
})();
