/* Réseau routier : graphe, temps de parcours débit-vitesse (BPR), arbres de plus courts chemins, véhicules. */
(function () {
  const TQ = typeof window !== 'undefined' ? window.TQ : globalThis.TQ;

  class Network {
    constructor(data) {
      const P = TQ.PARAMS;
      this.data = data;
      const E = data.edges.a.length, N = data.nodes.length;
      this.N = N; this.E = E;
      this.ea = Int32Array.from(data.edges.a);
      this.eb = Int32Array.from(data.edges.b);
      this.elen = Float32Array.from(data.edges.len);
      this.ecls = Uint8Array.from(data.edges.cls);
      this.ecor = Uint8Array.from(data.edges.cor);
      this.elanes = Uint8Array.from(data.edges.lanes);
      this.eseg = Int32Array.from(data.edges.seg);
      this.erev = Uint8Array.from(data.edges.rev);
      this.efree0 = Float32Array.from(data.edges.speed, (v) => v / 3.6);
      this.ecap0 = Float32Array.from(data.edges.cap);
      this.ecap = new Float32Array(E);
      this.et0 = new Float32Array(E); // temps libre (s)
      this.ett = new Float32Array(E); // temps courant (s)
      this.eflow = new Float32Array(E); // débit lissé (véh/h)
      this.ecnt = new Float32Array(E); // véhicules entrés depuis la dernière mise à jour
      this.eday = new Float32Array(E); // cumul journalier (véhicules)
      this.eratio = new Float32Array(E); // débit / capacité
      // CSR des arêtes entrantes
      this.inStart = new Int32Array(N + 1);
      for (let e = 0; e < E; e++) this.inStart[this.eb[e] + 1]++;
      for (let n = 0; n < N; n++) this.inStart[n + 1] += this.inStart[n];
      this.inEdge = new Int32Array(E);
      const fill = this.inStart.slice(0, N);
      for (let e = 0; e < E; e++) this.inEdge[fill[this.eb[e]]++] = e;
      // géométrie des segments
      const S = data.segs.length;
      this.segOff = new Int32Array(S + 1);
      let np = 0;
      for (let s = 0; s < S; s++) { this.segOff[s] = np; np += data.segs[s].length; }
      this.segOff[S] = np;
      this.segXY = new Float32Array(np * 2);
      this.segCum = new Float32Array(np);
      for (let s = 0; s < S; s++) {
        const c = data.segs[s]; let cum = 0; const o = this.segOff[s];
        for (let i = 0; i < c.length; i++) {
          if (i > 0) cum += TQ.geo.dist(c[i - 1][0], c[i - 1][1], c[i][0], c[i][1]);
          this.segXY[(o + i) * 2] = c[i][0]; this.segXY[(o + i) * 2 + 1] = c[i][1]; this.segCum[o + i] = cum;
        }
      }
      // arêtes à double sens (décalage visuel à droite)
      const segUse = new Uint8Array(S);
      for (let e = 0; e < E; e++) segUse[this.eseg[e]]++;
      this.etwo = Uint8Array.from(this.eseg, (s) => (segUse[s] > 1 ? 1 : 0));
      // points de demande (destinations possibles) : points + portes
      this.dnode = [];
      for (const p of data.points) this.dnode.push(p.node);
      this.gateOffset = this.dnode.length;
      for (const g of data.gates) this.dnode.push(g.node);
      this.D = this.dnode.length;
      this.tnext = new Array(this.D);
      this.tdist = new Array(this.D);
      // file de priorité (réutilisée)
      this.hKey = new Float32Array(E + N + 16);
      this.hNode = new Int32Array(E + N + 16);
      this.wdist = new Float32Array(N);
      this.refreshCursor = 0;
      this.setConditions({ laneDrop: false, winter: false });
      for (let d = 0; d < this.D; d++) this.computeTree(d);
      this.initVehicles();
      this.flowClock = 0;
      this.P = P;
    }

    /** Applique le retrait d'une voie le long du tracé (site propre) et les conditions hivernales. */
    setConditions(c) {
      const P = TQ.PARAMS;
      this.cond = c;
      for (let e = 0; e < this.E; e++) {
        let cap = this.ecap0[e], v = this.efree0[e];
        if (c.laneDrop && this.ecor[e]) {
          const l = this.elanes[e];
          cap *= l >= 2 ? (l - 1) / l : 0.85;
        }
        if (c.winter) { cap *= P.winterCap; v *= P.winterSpeed; }
        this.ecap[e] = cap;
        this.et0[e] = this.elen[e] / v;
        this.ett[e] = this.travelTime(e, this.eflow[e]);
      }
    }

    travelTime(e, flow) {
      const P = TQ.PARAMS;
      let r = flow / this.ecap[e];
      this.eratio[e] = r;
      if (r > P.bprMaxRatio) r = P.bprMaxRatio;
      const r2 = r * r;
      return this.et0[e] * (1 + P.bprAlpha * r2 * r2);
    }

    /** Mise à jour des débits lissés et des temps de parcours (appelée toutes les 60 s simulées). */
    updateFlows(dt) {
      const k = Math.min(1, dt / TQ.PARAMS.flowTau), f = (3600 / dt) * TQ.PARAMS.truckFactor;
      for (let e = 0; e < this.E; e++) {
        const rate = this.ecnt[e] * f;
        this.eday[e] += this.ecnt[e];
        this.ecnt[e] = 0;
        const fl = this.eflow[e] + (rate - this.eflow[e]) * k;
        this.eflow[e] = fl;
        this.ett[e] = this.travelTime(e, fl);
      }
    }

    /** Arbre des plus courts chemins vers le point de demande d (Dijkstra inverse sur les temps courants). */
    computeTree(d) {
      const N = this.N, dist = this.wdist, hKey = this.hKey, hNode = this.hNode;
      let next = this.tnext[d];
      if (!next) { next = this.tnext[d] = new Int16Array(N); this.tdist[d] = new Uint16Array(N); }
      next.fill(-1);
      dist.fill(Infinity);
      const src = this.dnode[d];
      dist[src] = 0;
      let size = 0;
      hKey[0] = 0; hNode[0] = src; size = 1;
      const inStart = this.inStart, inEdge = this.inEdge, ea = this.ea, ett = this.ett;
      while (size > 0) {
        const key = hKey[0], node = hNode[0];
        size--;
        if (size > 0) {
          const lk = hKey[size], ln = hNode[size];
          let i = 0;
          for (;;) {
            let c = 2 * i + 1;
            if (c >= size) break;
            if (c + 1 < size && hKey[c + 1] < hKey[c]) c++;
            if (hKey[c] >= lk) break;
            hKey[i] = hKey[c]; hNode[i] = hNode[c]; i = c;
          }
          hKey[i] = lk; hNode[i] = ln;
        }
        if (key > dist[node]) continue;
        for (let k = inStart[node]; k < inStart[node + 1]; k++) {
          const e = inEdge[k], a = ea[e], nd = key + ett[e];
          if (nd < dist[a]) {
            dist[a] = nd; next[a] = e;
            let i = size++;
            while (i > 0) {
              const p = (i - 1) >> 1;
              if (hKey[p] <= nd) break;
              hKey[i] = hKey[p]; hNode[i] = hNode[p]; i = p;
            }
            hKey[i] = nd; hNode[i] = a;
          }
        }
      }
      const out = this.tdist[d];
      for (let n = 0; n < N; n++) out[n] = dist[n] > 65000 ? 65535 : Math.round(dist[n]);
    }

    /** Recalcule n arbres à tour de rôle. */
    refreshTrees(n) {
      for (let i = 0; i < n; i++) {
        this.computeTree(this.refreshCursor);
        this.refreshCursor = (this.refreshCursor + 1) % this.D;
      }
    }

    /** Temps de parcours auto (s) du point de demande o au point de demande d. */
    carTime(o, d) { return this.tdist[d][this.dnode[o]]; }

    // ------------------------------------------------------------------ véhicules
    initVehicles() {
      const cap = 4096;
      this.vcap = cap; this.vn = 0;
      this.vEdge = new Int32Array(cap); this.vProg = new Float32Array(cap); this.vTT = new Float32Array(cap);
      this.vDest = new Int16Array(cap); this.vType = new Uint8Array(cap); this.vW = new Float32Array(cap);
      this.vPay = new Int32Array(cap); this.vVar = new Float32Array(cap);
      this.stats = [0, 1, 2, 3].map(() => ({ vkm: 0, vh: 0, vhFree: 0 }));
      this.win = { len: 0, time: 0, free: 0 }; // fenêtre glissante pour la vitesse moyenne
    }

    grow() {
      const cap = this.vcap * 2;
      for (const k of ['vEdge', 'vProg', 'vTT', 'vDest', 'vType', 'vW', 'vPay', 'vVar']) {
        const a = new this[k].constructor(cap); a.set(this[k]); this[k] = a;
      }
      this.vcap = cap;
    }

    /**
     * Ajoute un véhicule au noeud `node` à destination du point de demande `dest`.
     * type : 0 auto, 1 Cybercab à vide, 2 Cybercab chargé. w : véhicules réels représentés.
     * Retourne false si le véhicule est déjà à destination.
     */
    addVehicle(type, node, dest, w, payload, rnd) {
      if (node === this.dnode[dest]) return false;
      const e = this.tnext[dest][node];
      if (e < 0) return false;
      if (this.vn === this.vcap) this.grow();
      const i = this.vn++;
      this.vEdge[i] = e; this.vProg[i] = 0; this.vDest[i] = dest; this.vType[i] = type; this.vW[i] = w; this.vPay[i] = payload;
      this.vVar[i] = 0.93 + 0.14 * rnd();
      this.vTT[i] = this.ett[e] * this.vVar[i];
      this.ecnt[e] += w;
      return true;
    }

    /**
     * Fait avancer tous les véhicules de dt secondes.
     * onArrive(type, payload, node) retourne le prochain point de demande (>= 0) pour poursuivre, ou -1 pour retirer.
     * Peut aussi modifier this.arrType pour changer le type du véhicule qui poursuit.
     */
    stepVehicles(dt, onArrive) {
      const { vEdge, vProg, vTT, vDest, vType, vW, vPay, vVar, eb, ett, et0, elen, tnext, dnode, ecnt } = this;
      for (let i = this.vn - 1; i >= 0; i--) {
        let p = vProg[i] + dt / vTT[i];
        let guard = 0;
        while (p >= 1 && guard++ < 50) {
          const e = vEdge[i], w = vW[i], st = this.stats[vType[i]];
          const km = (w * elen[e]) / 1000;
          st.vkm += km; st.vh += (w * vTT[i]) / 3600; st.vhFree += (w * et0[e]) / 3600;
          this.win.len += w * elen[e]; this.win.time += w * vTT[i]; this.win.free += w * et0[e];
          const node = eb[e];
          let dest = vDest[i];
          if (node === dnode[dest]) {
            this.arrType = vType[i];
            dest = onArrive(vType[i], vPay[i], node);
            if (dest < 0 || node === dnode[dest] || tnext[dest][node] < 0) {
              // retrait par permutation avec le dernier
              const last = --this.vn;
              if (i !== last) {
                vEdge[i] = vEdge[last]; vProg[i] = vProg[last]; vTT[i] = vTT[last]; vDest[i] = vDest[last];
                vType[i] = vType[last]; vW[i] = vW[last]; vPay[i] = vPay[last]; vVar[i] = vVar[last];
              }
              p = -1;
              break;
            }
            vDest[i] = dest; vType[i] = this.arrType;
          }
          const ne = tnext[dest][node];
          const left = (p - 1) * vTT[i];
          vEdge[i] = ne;
          vTT[i] = ett[ne] * vVar[i];
          ecnt[ne] += w;
          p = left / vTT[i];
        }
        if (p >= 0) vProg[i] = p > 1 ? 1 : p;
      }
    }

    /** Position (lon, lat) à la fraction f de l'arête e, décalée à droite pour les rues à double sens. */
    edgePos(e, f, out, k) {
      const s = this.eseg[e], o = this.segOff[s], n = this.segOff[s + 1] - o, rev = this.erev[e];
      const total = this.segCum[o + n - 1];
      const target = (rev ? 1 - f : f) * total;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.segCum[o + mid] <= target) lo = mid; else hi = mid; }
      const c0 = this.segCum[o + lo], c1 = this.segCum[o + hi];
      const t = c1 > c0 ? (target - c0) / (c1 - c0) : 0;
      const x0 = this.segXY[(o + lo) * 2], y0 = this.segXY[(o + lo) * 2 + 1], x1 = this.segXY[(o + hi) * 2], y1 = this.segXY[(o + hi) * 2 + 1];
      let lon = x0 + (x1 - x0) * t, lat = y0 + (y1 - y0) * t;
      if (this.etwo[e]) {
        let dx = (x1 - x0) * TQ.geo.KX, dy = (y1 - y0) * TQ.geo.KY;
        const l = Math.hypot(dx, dy) || 1;
        if (rev) { dx = -dx; dy = -dy; }
        const off = 3.2 + 1.6 * (this.elanes[e] - 1);
        lon += ((dy / l) * off) / TQ.geo.KX; lat -= ((dx / l) * off) / TQ.geo.KY;
      }
      out[k] = lon; out[k + 1] = lat;
    }

    resetTraffic() {
      this.vn = 0;
      this.eflow.fill(0); this.ecnt.fill(0); this.eday.fill(0); this.eratio.fill(0);
      for (let e = 0; e < this.E; e++) this.ett[e] = this.et0[e];
      this.stats.forEach((s) => { s.vkm = 0; s.vh = 0; s.vhFree = 0; });
      this.win = { len: 0, time: 0, free: 0 };
    }
  }

  TQ.Network = Network;
})();
