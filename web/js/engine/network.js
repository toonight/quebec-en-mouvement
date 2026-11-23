/* Réseau routier : graphe, temps de parcours débit-vitesse (BPR), arbres de plus courts chemins, véhicules. */
(function () {
  const TQ = typeof window !== 'undefined' ? window.TQ : globalThis.TQ;

  class Network {
    constructor(data, opts) {
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
      this.ecap0 = Float32Array.from(data.edges.cap); // capacité de base à l'heure courante (véh/h)
      // voies réservées permanentes (bus, taxi, covoiturage), déjà retirées de elanes
      this.ebus = data.edges.bus ? Uint8Array.from(data.edges.bus) : new Uint8Array(E);
      // capacités propres aux heures de pointe : [arête, véh/h, minute de début, minute de fin[
      this.ecapPerm = Float32Array.from(data.edges.cap); // capacité permanente (véh/h)
      this.peaks = data.peaks || [];
      this.peakEdges = Array.from(new Set(this.peaks.map((p) => p[0])));
      this.peakBounds = Array.from(new Set(this.peaks.flatMap((p) => [p[2], p[3]]))).sort((a, b) => a - b);
      this.peakNext = Infinity; // prochaine borne de plage (s) ; posée par setTime
      this.ecap = new Float32Array(E);
      this.elin = Float32Array.from(this.ecls, (c) => (c === 0 || c === 1 || c === 5 ? P.linearDelay.motorway : P.linearDelay.street));
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
      // voie réservée aux Cybercab le long du tracé : temps, débits et itinéraires propres à la flotte
      this.cabLane = false;
      this.elane0 = new Float32Array(E); // temps libre sur la voie réservée (s)
      this.ecabT = new Float32Array(E); // temps courant d'un Cybercab (s) : voie réservée sur le tracé, sinon celui des autos
      this.ecntC = new Float32Array(E); this.eflowC = new Float32Array(E);
      this.tnextC = new Array(this.D); this.tdistC = new Array(this.D);
      this.setConditions({ laneDrop: false, winter: false });
      // Simulation.reset() recalcule tous les arbres juste après : inutile de les calculer deux fois
      if (!opts || opts.trees !== false) for (let d = 0; d < this.D; d++) this.computeTree(d);
      this.cabKm = null; // odomètres de la flotte (posés par CabFleet)
      this.cabIdx = null; // véhicule qui porte chaque agent de la flotte (posé par CabFleet)
      this.initVehicles();
      this.flowClock = 0;
      this.P = P;
    }

    /** Temps de parcours des Cybercab : ceux de la voie réservée si elle existe, sinon ceux des autos. */
    get cdist() { return this.cabLane ? this.tdistC : this.tdist; }

    /** Applique le retrait d'une voie le long du tracé (site propre), la voie réservée aux Cybercab, l'hiver et le parc autonome. */
    setConditions(c) {
      this.cond = c;
      this.cabLane = !!c.cabLane;
      for (let e = 0; e < this.E; e++) this.applyEdge(e);
    }

    /** Capacité, temps libre et temps courant de l'arête e, selon les conditions et la capacité de base du moment. */
    applyEdge(e) {
      const P = TQ.PARAMS, c = this.cond;
      const vLane = (P.cabLane.speed / 3.6) * (c.winter ? P.winterSpeed : 1);
      let cap = this.ecap0[e], v = this.efree0[e];
      // là où une voie est déjà réservée en permanence, le site propre prend sa place : pas de second retrait
      if (c.laneDrop && this.ecor[e] && !this.ebus[e]) {
        const l = this.elanes[e];
        cap *= l >= 2 ? (l - 1) / l : 0.85;
      }
      const cl = this.ecls[e], fast = cl === 0 || cl === 1 || cl === 5;
      if (c.auto) { cap *= fast ? P.auto.motorwayCap : P.auto.streetCap; if (!fast) v *= P.auto.streetSpeed; }
      this.elin[e] = (c.auto ? P.auto.linearDelay : P.linearDelay)[fast ? 'motorway' : 'street'];
      if (c.winter) { cap *= P.winterCap; v *= P.winterSpeed; }
      this.ecap[e] = cap;
      this.et0[e] = this.elen[e] / v;
      this.ett[e] = this.travelTime(e, this.eflow[e]);
      this.elane0[e] = this.elen[e] / vLane;
      this.ecabT[e] = this.cabTime(e);
    }

    /**
     * Cale les capacités de pointe sur l'heure t (secondes ; minuit = multiples de 86 400) et note la prochaine borne.
     * À appeler à chaque remise à zéro, puis quand t atteint peakNext ; seules les arêtes de data.peaks sont recalculées.
     */
    setTime(t) {
      const B = this.peakBounds;
      if (!B.length) return;
      const day = Math.floor(t / 86400), m = (t - day * 86400) / 60;
      let i = 0;
      while (i < B.length && B[i] <= m) i++;
      this.peakNext = i < B.length ? day * 86400 + B[i] * 60 : (day + 1) * 86400 + B[0] * 60;
      for (const e of this.peakEdges) this.ecap0[e] = this.ecapPerm[e];
      for (const p of this.peaks) if (m >= p[2] && m < p[3]) this.ecap0[p[0]] = p[1];
      for (const e of this.peakEdges) this.applyEdge(e);
    }

    /** Temps d'un Cybercab sur l'arête e. En voie réservée, les convois coordonnés ne subissent ni feux ni autos. */
    cabTime(e) {
      if (!this.cabLane || !this.ecor[e]) return this.ett[e];
      const P = TQ.PARAMS;
      let r = this.eflowC[e] / P.cabLane.capacity;
      if (r > P.bprMaxRatio) r = P.bprMaxRatio;
      const r2 = r * r;
      return this.elane0[e] * (1 + P.bprAlpha * r2 * r2);
    }

    travelTime(e, flow) {
      const P = TQ.PARAMS;
      let r = flow / this.ecap[e];
      this.eratio[e] = r;
      if (r > P.bprMaxRatio) r = P.bprMaxRatio;
      const r2 = r * r;
      return this.et0[e] * (1 + P.bprAlpha * r2 * r2 + this.elin[e] * r);
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
        if (this.cabLane) { this.eday[e] += this.ecntC[e]; this.eflowC[e] += ((this.ecntC[e] * 3600) / dt - this.eflowC[e]) * k; this.ecntC[e] = 0; }
        this.ecabT[e] = this.cabTime(e);
      }
    }

    /** Arbre des plus courts chemins vers le point de demande d (Dijkstra inverse sur les temps courants). */
    computeTree(d, cab) {
      const N = this.N, dist = this.wdist, hKey = this.hKey, hNode = this.hNode;
      const tn = cab ? this.tnextC : this.tnext, td = cab ? this.tdistC : this.tdist;
      let next = tn[d];
      if (!next) { next = tn[d] = new Int16Array(N); td[d] = new Uint16Array(N); }
      next.fill(-1);
      dist.fill(Infinity);
      const src = this.dnode[d];
      dist[src] = 0;
      let size = 0;
      hKey[0] = 0; hNode[0] = src; size = 1;
      const inStart = this.inStart, inEdge = this.inEdge, ea = this.ea, ett = cab ? this.ecabT : this.ett;
      while (size > 0) {
        const key = hKey[0], node = hNode[0];
        size--;
        if (size > 0) {
          const lk = hKey[size], ln = hNode[size];
          hKey[size] = Infinity; // sentinelle juste après le tas : le plus petit enfant se choisit sans branchement
          let i = 0;
          for (;;) {
            let c = 2 * i + 1;
            if (c >= size) break;
            c += +(hKey[c + 1] < hKey[c]);
            const ck = hKey[c];
            if (ck >= lk) break;
            hKey[i] = ck; hNode[i] = hNode[c]; i = c;
          }
          hKey[i] = lk; hNode[i] = ln;
        }
        if (key > dist[node]) continue;
        for (let k = inStart[node], kEnd = inStart[node + 1]; k < kEnd; k++) {
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
      const out = td[d];
      // (v + 0.5) | 0 vaut Math.round(v) ici : v est positif et inférieur à 65 000
      for (let n = 0; n < N; n++) { const v = dist[n]; out[n] = v > 65000 ? 65535 : (v + 0.5) | 0; }
    }

    /** Recalcule n arbres à tour de rôle. */
    refreshTrees(n) {
      for (let i = 0; i < n; i++) {
        this.computeTree(this.refreshCursor);
        if (this.cabLane) this.computeTree(this.refreshCursor, true);
        this.refreshCursor = (this.refreshCursor + 1) % this.D;
      }
    }

    /** Temps de parcours auto (s) du point de demande o au point de demande d. */
    carTime(o, d) { return this.tdist[d][this.dnode[o]]; }

    /**
     * Longueur (m) de l'itinéraire qu'une auto prendrait maintenant du point de demande o au point de demande d :
     * la somme des tronçons de l'arbre des plus courts chemins, celui que suivent les autos qui roulent.
     * Retourne -1 si la destination n'est pas joignable.
     */
    routeLen(o, d) {
      const tn = this.tnext[d], goal = this.dnode[d], eb = this.eb, elen = this.elen;
      let node = this.dnode[o], len = 0;
      for (let guard = this.N; node !== goal; guard--) {
        const e = tn[node];
        if (e < 0 || guard <= 0) return -1;
        len += elen[e]; node = eb[e];
      }
      return len;
    }

    // ------------------------------------------------------------------ véhicules
    initVehicles() {
      const cap = 4096;
      this.vcap = cap; this.vn = 0;
      this.vEdge = new Int32Array(cap); this.vProg = new Float32Array(cap); this.vTT = new Float32Array(cap);
      this.vDest = new Int16Array(cap); this.vType = new Uint8Array(cap); this.vW = new Float32Array(cap);
      this.vPay = new Int32Array(cap); this.vVar = new Float32Array(cap);
      // pour l'affichage seulement : numéro propre à chaque véhicule et les derniers tronçons quittés, du plus récent au plus ancien (-1 au départ)
      this.vId = new Int32Array(cap); this.vPrev = new Int32Array(cap); this.vPrev2 = new Int32Array(cap); this.vPrev3 = new Int32Array(cap); this.vPrev4 = new Int32Array(cap); this.vSeq = 0;
      this.stats = [0, 1, 2, 3].map(() => ({ vkm: 0, vh: 0, vhFree: 0 }));
      this.cabLaneVkm = 0; // véh-km de Cybercab parcourus sur les arêtes de la voie réservée (0 sans voie)
      this.win = { len: 0, time: 0, free: 0 }; // fenêtre glissante pour la vitesse moyenne
    }

    grow() {
      const cap = this.vcap * 2;
      for (const k of ['vEdge', 'vProg', 'vTT', 'vDest', 'vType', 'vW', 'vPay', 'vVar', 'vId', 'vPrev', 'vPrev2', 'vPrev3', 'vPrev4']) {
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
      const cab = type > 0;
      const e = (cab && this.cabLane ? this.tnextC : this.tnext)[dest][node];
      if (e < 0) return false;
      if (this.vn === this.vcap) this.grow();
      const i = this.vn++;
      this.vEdge[i] = e; this.vProg[i] = 0; this.vDest[i] = dest; this.vType[i] = type; this.vW[i] = w; this.vPay[i] = payload;
      this.vVar[i] = 0.93 + 0.14 * rnd();
      this.vId[i] = this.vSeq++; this.vPrev[i] = -1; this.vPrev2[i] = -1; this.vPrev3[i] = -1; this.vPrev4[i] = -1;
      this.vTT[i] = (cab ? this.ecabT[e] : this.ett[e]) * this.vVar[i];
      if (cab && this.cabLane && this.ecor[e]) this.ecntC[e] += w; else this.ecnt[e] += w;
      if (cab && this.cabIdx) this.cabIdx[payload] = i;
      return true;
    }

    /**
     * Fait avancer tous les véhicules de dt secondes.
     * onArrive(type, payload, node) retourne le prochain point de demande (>= 0) pour poursuivre, ou -1 pour retirer.
     * Peut aussi modifier this.arrType pour changer le type du véhicule qui poursuit.
     */
    stepVehicles(dt, onArrive) {
      const { vEdge, vProg, vTT, vDest, vType, vW, vPay, vVar, vId, vPrev, vPrev2, vPrev3, vPrev4, eb, ett, ecabT, et0, elen, dnode, ecnt, ecntC, ecor, cabIdx } = this;
      const lane = this.cabLane, tnCar = this.tnext, tnCab = lane ? this.tnextC : this.tnext;
      for (let i = this.vn - 1; i >= 0; i--) {
        let p = vProg[i] + dt / vTT[i];
        let guard = 0;
        while (p >= 1 && guard++ < 50) {
          const e = vEdge[i], w = vW[i], st = this.stats[vType[i]];
          const km = (w * elen[e]) / 1000;
          st.vkm += km; st.vh += (w * vTT[i]) / 3600; st.vhFree += (w * et0[e]) / 3600;
          if (vType[i] > 0 && this.cabKm) this.cabKm[vPay[i]] += elen[e] / 1000; // odomètre du Cybercab
          if (lane && vType[i] > 0 && ecor[e]) this.cabLaneVkm += km; // kilomètres faits dans la voie réservée
          // la vitesse et le temps perdu affichés sont ceux des autos
          if (vType[i] === 0) { this.win.len += w * elen[e]; this.win.time += w * vTT[i]; this.win.free += w * et0[e]; }
          const node = eb[e];
          let dest = vDest[i];
          if (node === dnode[dest]) {
            this.arrType = vType[i];
            dest = onArrive(vType[i], vPay[i], node);
            if (dest < 0 || node === dnode[dest] || (this.arrType > 0 ? tnCab : tnCar)[dest][node] < 0) {
              // retrait par permutation avec le dernier
              if (vType[i] > 0 && cabIdx) cabIdx[vPay[i]] = -1;
              const last = --this.vn;
              if (i !== last) {
                vEdge[i] = vEdge[last]; vProg[i] = vProg[last]; vTT[i] = vTT[last]; vDest[i] = vDest[last];
                vType[i] = vType[last]; vW[i] = vW[last]; vPay[i] = vPay[last]; vVar[i] = vVar[last];
                vId[i] = vId[last]; vPrev[i] = vPrev[last]; vPrev2[i] = vPrev2[last]; vPrev3[i] = vPrev3[last]; vPrev4[i] = vPrev4[last];
                if (vType[i] > 0 && cabIdx) cabIdx[vPay[i]] = i;
              }
              p = -1;
              break;
            }
            vDest[i] = dest; vType[i] = this.arrType;
          }
          const isCab = vType[i] > 0;
          const ne = (isCab ? tnCab : tnCar)[dest][node];
          const left = (p - 1) * vTT[i];
          vPrev4[i] = vPrev3[i]; vPrev3[i] = vPrev2[i]; vPrev2[i] = vPrev[i]; vPrev[i] = e; vEdge[i] = ne;
          vTT[i] = (isCab ? ecabT[ne] : ett[ne]) * vVar[i];
          if (isCab && lane && ecor[ne]) ecntC[ne] += w; else ecnt[ne] += w;
          p = left / vTT[i];
        }
        if (p >= 0) vProg[i] = p > 1 ? 1 : p;
      }
    }

    /**
     * Pour l'affichage seulement : où sera le véhicule i dans `ahead` secondes (moins d'un pas), sans rien changer
     * à l'état du moteur. Même calcul que stepVehicles : il finit son tronçon, puis prend le suivant de son trajet.
     * Écrit dans o : e (tronçon), p (fraction parcourue), tt (temps de parcours de ce tronçon, s),
     * hops (tronçons franchis). Un véhicule qui atteint sa destination attend au bout de son tronçon :
     * ce qu'il fait ensuite (s'effacer, repartir vers un client) ne se décide qu'au pas suivant.
     */
    aheadOf(i, ahead, o) {
      let e = this.vEdge[i], tt = this.vTT[i], p = this.vProg[i] + ahead / tt, hops = 0;
      if (p >= 1) {
        const cab = this.vType[i] > 0, dest = this.vDest[i], goal = this.dnode[dest];
        const tn = (cab && this.cabLane ? this.tnextC : this.tnext)[dest], et = cab ? this.ecabT : this.ett, vr = this.vVar[i];
        while (p >= 1 && hops < 8) {
          const node = this.eb[e], ne = node === goal ? -1 : tn[node];
          if (ne < 0) { p = 1; break; }
          const left = (p - 1) * tt;
          e = ne; tt = et[ne] * vr; p = left / tt; hops++;
        }
        if (p > 1) p = 1;
      }
      o.e = e; o.p = p; o.tt = tt; o.hops = hops;
      return o;
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

    /**
     * Position et cap d'un véhicule à `dist` mètres du début de l'arête e, décalé de `lateral` mètres à droite
     * de l'axe du tronçon. Écrit lon, lat et le cap (degrés, sens trigonométrique depuis l'est) dans out[k..k+2].
     */
    edgePosLane(e, dist, lateral, out, k) {
      const s = this.eseg[e], o = this.segOff[s], n = this.segOff[s + 1] - o, rev = this.erev[e];
      const total = this.segCum[o + n - 1];
      const target = rev ? total - dist : dist;
      let lo = 0, hi = n - 1;
      while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (this.segCum[o + mid] <= target) lo = mid; else hi = mid; }
      const c0 = this.segCum[o + lo], c1 = this.segCum[o + hi];
      const t = c1 > c0 ? Math.min(1, Math.max(0, (target - c0) / (c1 - c0))) : 0;
      const x0 = this.segXY[(o + lo) * 2], y0 = this.segXY[(o + lo) * 2 + 1], x1 = this.segXY[(o + hi) * 2], y1 = this.segXY[(o + hi) * 2 + 1];
      let dx = (x1 - x0) * TQ.geo.KX, dy = (y1 - y0) * TQ.geo.KY;
      const l = Math.hypot(dx, dy) || 1;
      if (rev) { dx = -dx; dy = -dy; }
      out[k] = x0 + (x1 - x0) * t + ((dy / l) * lateral) / TQ.geo.KX;
      out[k + 1] = y0 + (y1 - y0) * t - ((dx / l) * lateral) / TQ.geo.KY;
      out[k + 2] = (Math.atan2(dy, dx) * 180) / Math.PI;
    }

    resetTraffic() {
      this.vn = 0; this.vSeq = 0; this.refreshCursor = 0; // même point de départ à chaque journée : résultats reproductibles
      this.eflow.fill(0); this.ecnt.fill(0); this.eday.fill(0); this.eratio.fill(0);
      this.ecntC.fill(0); this.eflowC.fill(0);
      for (let e = 0; e < this.E; e++) { this.ett[e] = this.et0[e]; this.ecabT[e] = this.cabTime(e); }
      this.stats.forEach((s) => { s.vkm = 0; s.vh = 0; s.vhFree = 0; });
      this.cabLaneVkm = 0;
      this.win = { len: 0, time: 0, free: 0 };
    }
  }

  TQ.Network = Network;
})();
