/* Flotte de robotaxis (Cybercab) : véhicule libre le plus proche, courses partagées, trajets à vide, recharge. */
(function () {
  const TQ = typeof window !== 'undefined' ? window.TQ : globalThis.TQ;
  const IDLE = 0, TO_PICKUP = 1, LOADED = 2, CHARGING = 3, REPOSITION = 4;
  const MAXS = 4; // arrêts à venir par véhicule : au plus deux prises en charge et deux déposes
  const FAR = 65535; // temps de parcours saturé = point injoignable

  class CabFleet {
    /**
     * net : TQ.Network ; mask : Uint8Array par point de demande (1 = desservi) ;
     * fleetReal : nombre de véhicules réels ; opts.pool : courses partagées.
     * Les temps de parcours viennent de net.cdist : ceux des Cybercab, voie réservée comprise.
     */
    constructor(net, mask, fleetReal, pointInfo, rnd, winter, opts) {
      const P = TQ.PARAMS, C = P.cab;
      opts = opts || {};
      this.net = net; this.mask = mask; this.rnd = rnd; this.info = pointInfo;
      this.w = P.scale / C.occupancy; // véhicules réels par agent
      this.n = Math.max(1, Math.round(fleetReal / this.w));
      this.fleetReal = fleetReal;
      this.kwhKm = C.kwhKm * (winter ? P.winterEnergy : 1);
      this.rangeKm = (C.batteryKwh * (1 - C.reserve)) / this.kwhKm;
      // Partage : un Cybercab a 2 places et transporte déjà 1,4 personne en moyenne. Pour que l'occupation moyenne
      // ne dépasse jamais 2, au plus 30 % des demandes (1 - 1,4 / 2) peuvent se joindre à une course en cours.
      this.pool = !!opts.pool;
      this.poolSeat = Math.max(0, Math.min(1, 1 - C.occupancy / C.seats));
      const n = this.n;
      this.state = new Uint8Array(n); this.point = new Int32Array(n);
      this.tFree = new Float64Array(n); this.dest = new Int32Array(n); // dest : cible d'un repositionnement
      // odomètre réel de chaque véhicule (km parcourus sur le réseau, plus les rues locales), relevé à la recharge
      this.odo = new Float32Array(n); this.odoCharge = new Float32Array(n);
      // arrêts à venir : point et nature (bit 0 : dépose ; bit 1 : seconde demande à bord)
      this.sp = new Int32Array(n * MAXS); this.sk = new Uint8Array(n * MAXS); this.ns = new Uint8Array(n);
      this.aboard = new Uint8Array(n); this.shared = new Uint8Array(n);
      // deux demandes au plus par véhicule : heure de commande, prix annoncé, odomètre à la prise en charge, zone
      this.reqT = new Float64Array(2 * n); this.fare = new Float32Array(2 * n);
      this.odoPickup = new Float32Array(2 * n); this.zoneOf = new Int32Array(2 * n);
      net.cabKm = this.odo;
      net.cabIdx = this.idx = new Int32Array(n).fill(-1); // véhicule du réseau qui porte chaque agent en route
      // dispersion initiale selon les domiciles de la zone desservie
      const idx = [], cum = [];
      let acc = 0;
      for (let p = 0; p < mask.length; p++) if (mask[p]) { acc += pointInfo[p].home + 0.2 * pointInfo[p].act / 10; idx.push(p); cum.push(acc); }
      this.served = idx;
      for (let i = 0; i < n; i++) { this.point[i] = idx[TQ.pick(cum, rnd())]; this.odoCharge[i] = -rnd() * this.rangeKm * 0.5; }
      const Z = 12;
      this.waitEma = new Float32Array(Z).fill(4);
      this.rejectEma = new Float32Array(Z);
      this.recent = new Int32Array(256).fill(-1); this.recentN = 0;
      this.lastRebalance = 0;
      this.stats = { requests: 0, served: 0, rejected: 0, waitSum: 0, waitN: 0, ridesPersons: 0, charges: 0, repositions: 0, revenue: 0, rideKm: 0, ridesDone: 0, pooled: 0, localEmpty: 0, localLoaded: 0 };
    }

    /** Attente perçue (min) pour une demande partant de la zone z. */
    perceivedWait(z) { return this.waitEma[z] * (1 + 2.5 * this.rejectEma[z]) + 0.5; }

    /** Demande de course du point o au point d, au prix annoncé `fare`. Retourne true si un véhicule est affecté. */
    request(o, d, t, zone, fare) {
      const net = this.net, C = TQ.PARAMS.cab, st = this.stats;
      st.requests += 1;
      this.recent[this.recentN++ & 255] = o;
      // course partagée : se joindre à un véhicule déjà en route, s'il a un siège libre et que le détour reste court
      if (this.pool && this.rnd() < this.poolSeat && this.share(o, d, t, zone, fare)) return true;
      const dist = net.cdist[o], dn = net.dnode;
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
      const i = best, b = i * MAXS, j = 2 * i;
      this.reqT[j] = t; this.fare[j] = fare || 0; this.zoneOf[j] = zone;
      this.sp[b] = o; this.sk[b] = 0; this.sp[b + 1] = d; this.sk[b + 1] = 1; this.ns[i] = 2;
      this.aboard[i] = 0; this.shared[i] = 0;
      this.odo[i] += C.localKmEmpty; st.localEmpty += C.localKmEmpty * this.w;
      state[i] = TO_PICKUP;
      this.start(i, t, dn[point[i]]);
      return true;
    }

    /**
     * Cherche un véhicule en route qui peut prendre la demande (o, d) sans dépasser les détours permis,
     * et l'y ajoute. Retourne true si la demande est jumelée.
     */
    share(o, d, t, zone, fare) {
      const net = this.net, C = TQ.PARAMS.cab, T = net.cdist, dn = net.dnode;
      const maxWait = Math.min(C.poolMaxWaitMin, C.maxEtaMin) * 60, maxDet = C.poolMaxDetourMin * 60;
      const no = dn[o], nd = dn[d], direct = T[d][no];
      if (direct >= FAR || no === nd) return false;
      let best = -1, bestCost = Infinity, bestSeq = 0;
      for (let i = 0; i < this.n; i++) {
        const s = this.state[i];
        if ((s !== LOADED && s !== TO_PICKUP) || this.shared[i]) continue;
        const vi = this.idx[i];
        if (vi < 0) continue;
        // temps pour finir l'arête en cours, puis temps depuis son extrémité
        const node = net.eb[net.vEdge[vi]], rem = (1 - net.vProg[vi]) * net.vTT[vi], toO = T[o][node];
        if (toO + rem > maxWait) continue;
        const b = i * MAXS;
        let pB, T0, dA;
        if (s === LOADED && this.ns[i] === 1) { dA = this.sp[b]; pB = toO; T0 = T[dA][node]; }
        else if (s === TO_PICKUP && this.ns[i] === 2) {
          // le premier client est pris d'abord, puis le second
          const oA = this.sp[b]; dA = this.sp[b + 1];
          const toA = T[oA][node];
          pB = toA + T[o][dn[oA]]; T0 = toA + T[dA][dn[oA]];
        } else continue;
        if (pB + rem > maxWait || T0 >= FAR) continue;
        const ndA = dn[dA];
        // ordre 1 : dépose du premier client, puis du second ; ordre 2 : l'inverse
        const tA1 = pB + T[dA][no], tB1 = tA1 + T[d][ndA];
        const tB2 = pB + direct, tA2 = tB2 + T[dA][nd];
        const c1 = tA1 - T0 <= maxDet && tB1 - pB - direct <= maxDet ? tB1 : Infinity;
        const c2 = tA2 - T0 <= maxDet ? tA2 : Infinity;
        const c = Math.min(c1, c2);
        if (c < bestCost) { bestCost = c; best = i; bestSeq = c1 <= c2 ? 1 : 2; }
      }
      if (best < 0) return false;
      const i = best, b = i * MAXS, j = 2 * i + 1, st = this.stats;
      const loaded = this.state[i] === LOADED;
      const k = loaded ? 0 : 1; // en approche, la prise en charge du premier client reste le premier arrêt
      const dA = this.sp[b + k];
      this.sp[b + k] = o; this.sk[b + k] = 2;
      if (bestSeq === 1) { this.sp[b + k + 1] = dA; this.sk[b + k + 1] = 1; this.sp[b + k + 2] = d; this.sk[b + k + 2] = 3; }
      else { this.sp[b + k + 1] = d; this.sk[b + k + 1] = 3; this.sp[b + k + 2] = dA; this.sk[b + k + 2] = 1; }
      this.ns[i] = k + 3;
      this.shared[i] = 1;
      this.reqT[j] = t; this.fare[j] = fare || 0; this.zoneOf[j] = zone;
      this.rejectEma[zone] *= 0.95;
      st.served += 1;
      if (loaded) net.vDest[this.idx[i]] = o; // le véhicule se déroute vers le second client
      return true;
    }

    /** Fait partir le véhicule i, immobile au nœud `node`, vers son prochain arrêt. */
    start(i, t, node) {
      const next = this.nextStop(i, t, node);
      if (next < 0) return;
      if (!this.net.addVehicle(this.aboard[i] > 0 ? 2 : 1, node, next, this.w, i, this.rnd)) {
        // arrêt injoignable : la course se termine sur place
        while (this.ns[i] > 0) this.serve(i, t);
        this.finish(i, t);
      }
    }

    /** Sert les arrêts situés au nœud courant. Retourne le prochain point à rejoindre, ou -1 si la tournée est finie. */
    nextStop(i, t, node) {
      const dn = this.net.dnode;
      while (this.ns[i] > 0) {
        const p = this.sp[i * MAXS];
        if (dn[p] !== node) return p;
        this.serve(i, t);
      }
      this.finish(i, t);
      return -1;
    }

    /** Sert le premier arrêt du véhicule i : prise en charge ou dépose. */
    serve(i, t) {
      const C = TQ.PARAMS.cab, st = this.stats, b = i * MAXS;
      const p = this.sp[b], kind = this.sk[b], j = 2 * i + (kind >> 1);
      for (let q = 1; q < this.ns[i]; q++) { this.sp[b + q - 1] = this.sp[b + q]; this.sk[b + q - 1] = this.sk[b + q]; }
      this.ns[i]--;
      this.point[i] = p;
      if (!(kind & 1)) {
        const w = (t - this.reqT[j]) / 60, z = this.zoneOf[j];
        st.waitSum += w; st.waitN += 1;
        this.waitEma[z] += (w - this.waitEma[z]) * 0.05;
        // détour par les rues locales pour un second client, avec le premier à bord
        if (kind >> 1) { this.odo[i] += C.localKmEmpty; st.localLoaded += C.localKmEmpty * this.w; }
        this.odoPickup[j] = this.odo[i];
        this.aboard[i]++;
        this.state[i] = LOADED;
      } else {
        // la course terminée est payée au prix annoncé à la commande ; les kilomètres viennent de l'odomètre
        this.odo[i] += C.localKmLoaded; st.localLoaded += C.localKmLoaded * this.w;
        st.rideKm += (this.odo[i] - this.odoPickup[j]) * this.w; st.revenue += this.fare[j] * this.w;
        st.ridesPersons += TQ.PARAMS.scale; st.ridesDone += this.w;
        if (this.shared[i]) st.pooled += TQ.PARAMS.scale; // les deux clients d'une course partagée
        this.aboard[i]--;
      }
    }

    /** Fin de tournée : le véhicule redevient libre, ou part se recharger. */
    finish(i, t) {
      const C = TQ.PARAMS.cab;
      this.aboard[i] = 0; this.shared[i] = 0; this.ns[i] = 0;
      if (this.odo[i] - this.odoCharge[i] > this.rangeKm) {
        this.state[i] = CHARGING; this.tFree[i] = t + C.chargeMin * 60; this.odoCharge[i] = this.odo[i]; this.stats.charges++;
      } else { this.state[i] = IDLE; this.tFree[i] = t; }
    }

    /** Rappel du réseau quand un véhicule de la flotte atteint sa destination. Retourne le prochain point, ou -1. */
    onArrive(type, i, t) {
      const s = this.state[i];
      if (s === REPOSITION) { this.point[i] = this.dest[i]; this.state[i] = IDLE; this.tFree[i] = t; return -1; }
      if ((s === TO_PICKUP || s === LOADED) && this.ns[i] > 0) {
        const next = this.nextStop(i, t, this.net.dnode[this.sp[i * MAXS]]);
        this.net.arrType = this.aboard[i] > 0 ? 2 : 1;
        return next;
      }
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
          // repositionnement vers une origine de demande récente,
          // seulement vers un secteur où l'attente ou les refus récents sont élevés
          const target = this.recent[Math.floor(this.rnd() * have)];
          const from = this.point[i];
          const tz = target >= 0 ? Math.max(0, this.info[target].zone) : 0;
          const needed = this.waitEma[tz] > 5 || this.rejectEma[tz] > 0.05;
          this.tFree[i] = t;
          if (needed && target >= 0 && this.net.cdist[target][this.net.dnode[from]] > 300) {
            this.dest[i] = target;
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
