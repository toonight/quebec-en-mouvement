/* Flotte de robotaxis (Cybercab) : répartition au véhicule libre le plus proche, trajets à vide, recharge. */
(function () {
  const TQ = typeof window !== 'undefined' ? window.TQ : globalThis.TQ;
  const IDLE = 0, TO_PICKUP = 1, LOADED = 2, CHARGING = 3, REPOSITION = 4;

  class CabFleet {
    /**
     * net : TQ.Network ; mask : Uint8Array par point de demande (1 = desservi) ;
     * fleetReal : nombre de véhicules réels ; seeds : points de départ pondérés.
     */
    constructor(net, mask, fleetReal, pointInfo, rnd, winter) {
      const P = TQ.PARAMS, C = P.cab;
      this.net = net; this.mask = mask; this.rnd = rnd; this.info = pointInfo;
      this.w = P.scale / C.occupancy; // véhicules réels par agent
      this.n = Math.max(1, Math.round(fleetReal / this.w));
      this.fleetReal = fleetReal;
      this.kwhKm = C.kwhKm * (winter ? P.winterEnergy : 1);
      this.rangeKm = (C.batteryKwh * (1 - C.reserve)) / this.kwhKm;
      const n = this.n;
      this.state = new Uint8Array(n); this.point = new Int32Array(n); this.km = new Float32Array(n);
      this.tFree = new Float64Array(n); this.reqT = new Float64Array(n); this.dest = new Int32Array(n); this.orig = new Int32Array(n);
      // dispersion initiale selon les domiciles de la zone desservie
      const idx = [], cum = [];
      let acc = 0;
      for (let p = 0; p < mask.length; p++) if (mask[p]) { acc += pointInfo[p].home + 0.2 * pointInfo[p].act / 10; idx.push(p); cum.push(acc); }
      this.served = idx;
      for (let i = 0; i < n; i++) { this.point[i] = idx[TQ.pick(cum, rnd())]; this.km[i] = rnd() * this.rangeKm * 0.5; }
      const Z = 12;
      this.waitEma = new Float32Array(Z).fill(4);
      this.rejectEma = new Float32Array(Z);
      this.recent = new Int32Array(256).fill(-1); this.recentN = 0;
      this.lastRebalance = 0;
      this.stats = { requests: 0, served: 0, rejected: 0, waitSum: 0, waitN: 0, ridesPersons: 0, charges: 0, repositions: 0 };
    }

    /** Attente perçue (min) pour une demande partant de la zone z. */
    perceivedWait(z) { return this.waitEma[z] * (1 + 2.5 * this.rejectEma[z]) + 0.5; }

    crowKm(a, b) {
      const A = this.info[a], B = this.info[b];
      return (TQ.geo.dist(A.lon, A.lat, B.lon, B.lat) * 1.3) / 1000;
    }

    /** Demande de course du point o au point d. Retourne true si un véhicule est affecté. */
    request(o, d, t, zone) {
      const net = this.net, C = TQ.PARAMS.cab, st = this.stats;
      st.requests += 1;
      this.recent[this.recentN++ & 255] = o;
      const dist = net.tdist[o], dn = net.dnode;
      let best = -1, bestEta = C.maxEtaMin * 60;
      const state = this.state, point = this.point;
      for (let i = 0; i < this.n; i++) {
        if (state[i] !== IDLE) continue;
        const eta = dist[dn[point[i]]];
        if (eta < bestEta) { bestEta = eta; best = i; if (eta < 45) break; }
      }
      if (best < 0) {
        st.rejected += 1;
        this.rejectEma[zone] += (1 - this.rejectEma[zone]) * 0.05;
        return false;
      }
      this.rejectEma[zone] *= 0.95;
      st.served += 1;
      this.reqT[best] = t; this.dest[best] = d; this.orig[best] = o;
      this.zoneOf = this.zoneOf || new Int32Array(this.n);
      this.zoneOf[best] = zone;
      const from = point[best];
      this.km[best] += this.crowKm(from, o) + this.crowKm(o, d);
      state[best] = TO_PICKUP;
      if (!net.addVehicle(1, dn[from], o, this.w, best, this.rnd)) this.pickup(best, t + 60, true);
      return true;
    }

    pickup(i, t, spawn) {
      const w = (t - this.reqT[i]) / 60, z = this.zoneOf[i];
      this.stats.waitSum += w; this.stats.waitN += 1;
      this.waitEma[z] += (w - this.waitEma[z]) * 0.05;
      this.state[i] = LOADED;
      this.stats.ridesPersons += TQ.PARAMS.scale;
      if (spawn) {
        if (!this.net.addVehicle(2, this.net.dnode[this.orig[i]], this.dest[i], this.w, i, this.rnd)) this.dropoff(i, t);
      }
    }

    dropoff(i, t) {
      this.point[i] = this.dest[i];
      if (this.km[i] > this.rangeKm) {
        this.state[i] = CHARGING; this.tFree[i] = t + TQ.PARAMS.cab.chargeMin * 60; this.km[i] = 0; this.stats.charges++;
      } else { this.state[i] = IDLE; this.tFree[i] = t; }
    }

    /** Rappel du réseau quand un véhicule de la flotte atteint sa destination. */
    onArrive(type, i, t) {
      const s = this.state[i];
      if (s === TO_PICKUP) {
        this.pickup(i, t, false);
        const d = this.dest[i];
        if (this.net.dnode[d] === this.net.dnode[this.orig[i]]) { this.dropoff(i, t); return -1; }
        this.net.arrType = 2;
        return d;
      }
      if (s === LOADED) { this.dropoff(i, t); return -1; }
      if (s === REPOSITION) { this.point[i] = this.dest[i]; this.state[i] = IDLE; this.tFree[i] = t; return -1; }
      return -1;
    }

    step(t) {
      const C = TQ.PARAMS.cab;
      if (t - this.lastRebalance < 300) return;
      this.lastRebalance = t;
      // quand des véhicules sont libres, le souvenir des refus et des longues attentes s'estompe
      let idle = 0;
      for (let i = 0; i < this.n; i++) if (this.state[i] === IDLE) idle++;
      if (idle > 0) {
        const share = idle / this.n;
        for (let z = 0; z < this.rejectEma.length; z++) {
          this.rejectEma[z] *= 0.9;
          if (share > 0.3) this.waitEma[z] += (4 - this.waitEma[z]) * 0.1;
        }
      }
      let moves = Math.ceil(this.n * 0.03);
      const have = Math.min(this.recentN, 256);
      for (let i = 0; i < this.n; i++) {
        if (this.state[i] === CHARGING && t >= this.tFree[i]) { this.state[i] = IDLE; this.tFree[i] = t; }
        else if (this.state[i] === IDLE && moves > 0 && have > 20 && t - this.tFree[i] > C.rebalanceIdleMin * 60) {
          // repositionnement vers une origine de demande récente
          // seulement vers un secteur où l'attente ou les refus récents sont élevés
          const target = this.recent[Math.floor(this.rnd() * have)];
          const from = this.point[i];
          const tz = target >= 0 ? Math.max(0, this.info[target].zone) : 0;
          const needed = this.waitEma[tz] > 5 || this.rejectEma[tz] > 0.05;
          this.tFree[i] = t;
          if (needed && target >= 0 && this.net.tdist[target][this.net.dnode[from]] > 300) {
            this.dest[i] = target; this.km[i] += this.crowKm(from, target);
            if (this.net.addVehicle(1, this.net.dnode[from], target, this.w, i, this.rnd)) { this.state[i] = REPOSITION; this.stats.repositions++; moves--; }
          }
        }
      }
    }

    counts() {
      const c = [0, 0, 0, 0, 0];
      for (let i = 0; i < this.n; i++) c[this.state[i]]++;
      return { idle: c[0] * this.w, toPickup: c[1] * this.w, loaded: c[2] * this.w, charging: c[3] * this.w, reposition: c[4] * this.w };
    }
  }

  CabFleet.IDLE = IDLE;
  TQ.CabFleet = CabFleet;
})();
