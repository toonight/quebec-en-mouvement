/* Interface : carte MapLibre, calques deck.gl, commandes et indicateurs. */
(function () {
  const TQ = window.TQ, $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 0 });
  const fmt1 = new Intl.NumberFormat('fr-CA', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  // montant en dollars : [nombre, unité], par exemple ['−1,2', 'M$']
  const money = (v) => {
    const a = Math.abs(v), sg = v < -0.5 ? '−' : '';
    return a >= 1e9 ? [sg + fmt1.format(a / 1e9), 'G$'] : a >= 1e6 ? [sg + fmt1.format(a / 1e6), 'M$'] : a >= 1e3 ? [sg + fmt.format(a / 1e3), 'k$'] : [sg + fmt.format(a), '$'];
  };
  const moneyText = (v) => money(v).join(' ');
  const COLORS = { tram: [255, 200, 61], bus: [82, 182, 255], cab: [255, 92, 147], car: [205, 216, 230] };
  const MODE_META = [
    ['auto', 'Automobile', '#cdd8e6'], ['rtc', 'Autobus actuels', '#6f86a3'], ['actif', 'Marche et vélo', '#3ecf8e'],
    ['autre', 'Autres', '#46586e'], ['line', 'Ligne', '#ffc83d'], ['cab', 'Cybercab', '#ff5c93'],
  ];
  // les noms de rues et de stations viennent de données externes (OpenStreetMap) : toujours les échapper
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const status = $('status');
  const state = { speed: 120, playing: true, layers: { cars: true, roads: true, zone: true }, colorTick: 0 };
  let sim, map, overlay, roadData, lineParts, stationData;

  function fail(msg) { status.hidden = false; status.textContent = msg; }
  if (!window.TQ_DATA) return fail('Les données du réseau sont introuvables. Lancez « python scripts/build_data.py », puis rechargez la page.');
  if (!TQ || !TQ.Simulation || !TQ.economics || !TQ.ASSUMPTIONS) return fail('Un fichier du simulateur est manquant. Rechargez la page.');
  if (!window.maplibregl || !window.deck) return fail('La carte n\'a pas pu se charger. Vérifiez la connexion Internet, puis rechargez la page.');

  // ------------------------------------------------------------------ initialisation
  setTimeout(() => {
    sim = new TQ.Simulation(window.TQ_DATA, { scenario: { line: 'tram', cab: 'off', fleet: 3000 } });
    window.sim = sim;
    prepareStatic();
    initMap();
    bindUi();
    status.hidden = true;
    requestAnimationFrame(frame);
  }, 30);

  function prepareStatic() {
    const d = window.TQ_DATA, net = sim.net;
    roadData = d.segs.map((path, i) => ({ path, i, cls: 4, name: '' }));
    for (let e = 0; e < net.E; e++) { const r = roadData[net.eseg[e]]; r.cls = Math.min(r.cls, net.ecls[e] === 5 ? 3 : net.ecls[e] === 6 ? 4 : net.ecls[e]); r.name = d.names[d.edges.name[e]]; }
    state.segRatio = new Float32Array(d.segs.length);
    const L = d.line, surfA = [], tun = [], surfB = [];
    L.coords.forEach((c, i) => { const s = L.cum[i]; if (s <= L.tunnel[0]) surfA.push(c); if (s >= L.tunnel[0] && s <= L.tunnel[1]) tun.push(c); if (s >= L.tunnel[1]) surfB.push(c); });
    lineParts = [{ path: surfA, tunnel: false }, { path: tun, tunnel: true }, { path: surfB, tunnel: false }];
    // tracé simplifié (un point aux 900 m) : un trait très large sur un tracé dense se déchire aux jointures
    state.zonePath = []; let lastS = -1e9;
    L.coords.forEach((c, i) => { if (L.cum[i] - lastS >= 900 || i === L.coords.length - 1) { state.zonePath.push(c); lastS = L.cum[i]; } });
    stationData = L.stations.map((s, i) => ({ i, name: s.name, hub: s.hub, underground: s.underground, pos: sim.stationLL[i] }));
    state.posBuf = new Float32Array(2 * 40000); state.colBuf = new Uint8Array(4 * 40000);
  }

  function initMap() {
    map = new maplibregl.Map({
      container: 'map', style: 'https://tiles.openfreemap.org/styles/dark', center: [-71.262, 46.803], zoom: 11.6, minZoom: 9.5, maxZoom: 17,
      attributionControl: false, maxBounds: [[-72.2, 46.4], [-70.4, 47.25]],
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Réseau : © contributeurs OpenStreetMap · Demande : EOD 2023, MTMD · Limites : Ville de Québec' }), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('error', (e) => { if (e && e.error && /style|Failed to fetch/i.test(String(e.error.message))) console.warn('Fond de carte indisponible', e.error.message); });
    map.once('load', () => { const a = document.querySelector('.maplibregl-ctrl-attrib'); if (a) a.classList.remove('maplibregl-compact-show'); });
    overlay = new deck.MapboxOverlay({ interleaved: false, layers: [], getTooltip: tooltip });
    map.addControl(overlay);
    window.tqMap = map;
  }

  function tooltip({ object, layer }) {
    if (!object || !layer) return null;
    if (layer.id === 'stations') {
      const waiting = sim.line ? sim.line.waitingAt(object.i) : 0;
      const kind = object.hub ? 'Pôle d\'échanges' : object.underground && sim.scenario.line !== 'bus' ? 'Station souterraine' : 'Station';
      return { html: `<b>${esc(object.name)}</b><br>${kind}${sim.line ? `<br>${fmt.format(waiting)} personnes en attente<br>${fmt.format(sim.line.stationBoard[object.i])} montées depuis le départ` : ''}` };
    }
    if (layer.id === 'line-veh') {
      const L = sim.line, pct = Math.round((object.v.load * L.scale / L.p.capacity) * 100);
      const to = L.st[object.v.dir === 0 ? L.n - 1 : 0].name;
      return { html: `<b>${L.p.label}</b> vers ${esc(to)}<br>${fmt.format(object.v.load * L.scale)} passagers à bord (${pct} % de la capacité)` };
    }
    if (layer.id === 'roads' && object.name) {
      const r = state.segRatio[object.i];
      return { html: `<b>${esc(object.name)}</b><br>Débit à ${Math.round(r * 100)} % de la capacité` };
    }
    return null;
  }

  // ------------------------------------------------------------------ calques
  function rampColor(r) {
    if (r < 0.55) return [47, 111, 122, 70];
    if (r < 0.8) { const t = (r - 0.55) / 0.25; return [47 + t * 208, 111 + t * 65, 122 - t * 90, 110 + t * 90]; }
    if (r < 1) { const t = (r - 0.8) / 0.2; return [255, 176 - t * 99, 32 + t * 47, 220]; }
    return [255, 77, 79, 240];
  }

  function buildLayers() {
    const net = sim.net, L = sim.line, F = sim.fleet, layers = [];
    const lineColor = L ? COLORS[L.kind] : [130, 146, 166];
    const tun = (d) => d.tunnel && (!L || L.kind === 'tram'); // le bus reste en surface
    if (state.layers.roads) {
      layers.push(new deck.PathLayer({
        id: 'roads', data: roadData, getPath: (d) => d.path, getColor: (d) => rampColor(state.segRatio[d.i]),
        getWidth: (d) => (d.cls === 0 ? 5 : d.cls <= 2 ? 3.4 : 2.2), widthUnits: 'pixels', widthMinPixels: 1, capRounded: true, jointRounded: true,
        pickable: true, updateTriggers: { getColor: state.colorTick }, parameters: { depthTest: false },
      }));
    }
    if (F && state.layers.zone && sim.scenario.cab === 'corridor') {
      layers.push(new deck.PathLayer({ id: 'cab-zone', data: [{ path: state.zonePath }], getPath: (d) => d.path, getColor: [255, 92, 147, 22], getWidth: 2400, widthUnits: 'meters', capRounded: true, jointRounded: true }));
    }
    if (F && state.layers.zone && sim.scenario.cab === 'wide') {
      layers.push(new deck.PathLayer({ id: 'cab-zone-wide', data: window.TQ_DATA.outlines.filter((o) => o.zone <= 5), getPath: (d) => d.ring, getColor: [255, 92, 147, 120], getWidth: 1.5, widthUnits: 'pixels' }));
    }
    layers.push(new deck.PathLayer({
      id: 'line', data: lineParts, getPath: (d) => d.path, getColor: (d) => [...lineColor, L ? (tun(d) ? 90 : 230) : 110],
      getWidth: (d) => (tun(d) ? 3 : 4), widthUnits: 'pixels', capRounded: true, jointRounded: true, updateTriggers: { getColor: [L ? L.kind : 'none'], getWidth: [L ? L.kind : 'none'] },
    }));
    // véhicules routiers
    const n = net.vn, pos = state.posBuf, col = state.colBuf;
    let k = 0;
    for (let i = 0; i < n && k < 40000; i++) {
      const type = net.vType[i];
      if (type === 0 && !state.layers.cars) continue;
      net.edgePos(net.vEdge[i], net.vProg[i], pos, k * 2);
      const o = k * 4;
      if (type === 0) { col[o] = 205; col[o + 1] = 216; col[o + 2] = 230; col[o + 3] = 150; }
      else if (type === 2) { col[o] = 255; col[o + 1] = 92; col[o + 2] = 147; col[o + 3] = 255; }
      else { col[o] = 255; col[o + 1] = 150; col[o + 2] = 185; col[o + 3] = 150; }
      k++;
    }
    if (F) {
      for (let i = 0; i < F.n && k < 40000; i++) {
        if (F.state[i] !== 0 && F.state[i] !== 3) continue;
        const p = sim.info[F.point[i]], j = ((i * 2654435761) >>> 0) / 4294967296;
        pos[k * 2] = p.lon + (j - 0.5) * 0.0016; pos[k * 2 + 1] = p.lat + (((j * 7919) % 1) - 0.5) * 0.0011;
        const o = k * 4; col[o] = 255; col[o + 1] = 92; col[o + 2] = 147; col[o + 3] = F.state[i] === 3 ? 40 : 85;
        k++;
      }
    }
    layers.push(new deck.ScatterplotLayer({
      id: 'vehicles', data: { length: k, attributes: { getPosition: { value: pos, size: 2 }, getFillColor: { value: col, size: 4, normalized: true } } },
      getRadius: 13, radiusUnits: 'meters', radiusMinPixels: 1.25, radiusMaxPixels: 5, parameters: { depthTest: false },
    }));
    layers.push(new deck.ScatterplotLayer({
      id: 'stations', data: stationData, getPosition: (d) => d.pos, pickable: true, stroked: true, filled: true,
      getFillColor: [12, 21, 34, 255], getLineColor: (d) => [...lineColor, L ? 255 : 140], lineWidthUnits: 'pixels', getLineWidth: (d) => (d.hub ? 2.5 : 1.5),
      getRadius: (d) => (d.hub ? 5.5 : 3.6) + (L ? Math.min(7, Math.sqrt(L.waitingAt(d.i)) * 0.35) : 0), radiusUnits: 'pixels',
      updateTriggers: { getRadius: state.colorTick, getLineColor: [L ? L.kind : 'none'] },
    }));
    if (L) {
      const veh = [];
      const half = L.p.length / 2;
      for (const v of L.vehicles) {
        if (!v.active) continue;
        const a = [0, 0], b = [0, 0], c = [0, 0];
        L.posAt(v.s - half, a, 0); L.posAt(v.s, b, 0); L.posAt(v.s + half, c, 0);
        veh.push({ v, path: [a, b, c], tunnel: L.kind === 'tram' && v.s > L.tunnel[0] && v.s < L.tunnel[1] });
      }
      layers.push(new deck.PathLayer({
        id: 'line-veh', data: veh, getPath: (d) => d.path, getColor: (d) => [255, 255, 255, d.tunnel ? 130 : 255], getWidth: 9, widthUnits: 'meters', widthMinPixels: L.kind === 'tram' ? 7 : 5, capRounded: true, pickable: true, parameters: { depthTest: false },
      }));
      layers.push(new deck.PathLayer({
        id: 'line-veh-core', data: veh, getPath: (d) => d.path, getColor: (d) => [...lineColor, d.tunnel ? 150 : 255], getWidth: 5, widthUnits: 'meters', widthMinPixels: L.kind === 'tram' ? 4 : 2.5, capRounded: true, parameters: { depthTest: false },
      }));
    }
    return layers;
  }

  // ------------------------------------------------------------------ boucle d'animation
  let last = performance.now(), uiAcc = 0, colorAcc = 0;
  function frame(now) {
    const dtReal = Math.min(0.1, (now - last) / 1000); last = now;
    if (state.playing && !document.hidden) {
      if (state.speed === 0) { const t0 = performance.now(); while (performance.now() - t0 < 22) sim.step(10); }
      else sim.step(dtReal * state.speed);
    }
    colorAcc += dtReal; uiAcc += dtReal;
    if (colorAcc > 0.7) {
      colorAcc = 0; state.colorTick++;
      const net = sim.net, sr = state.segRatio; sr.fill(0);
      for (let e = 0; e < net.E; e++) { const s = net.eseg[e]; if (net.eratio[e] > sr[s]) sr[s] = net.eratio[e]; }
    }
    overlay.setProps({ layers: buildLayers() });
    if (uiAcc > 0.25) { uiAcc = 0; updateUi(); }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ indicateurs
  function setText(id, v) { const el = $(id); if (el.textContent !== v) el.textContent = v; }
  function kpi(id, value, unit) { const el = $(id); const html = value + (unit ? `<small>${unit}</small>` : ''); if (el.innerHTML !== html) el.innerHTML = html; }

  function updateUi() {
    const s = sim.summary(), L = sim.line, F = sim.fleet;
    setText('clock', TQ.formatClock(sim.t));
    setText('day-label', `Jour ${sim.day}, ${sim.scenarioLabel()}`);
    setText('split-title', `Déplacements depuis ${TQ.formatClock(Math.round(sim.tDayStart / 600) * 600).replace(' h 00', ' h')}`);
    const total = Math.max(1, s.trips);
    const lineName = L ? (L.kind === 'tram' ? 'Tramway' : 'Bus voies réservées') : 'Ligne';
    const lineHex = L && L.kind === 'bus' ? '#52b6ff' : '#ffc83d';
    $('split').innerHTML = MODE_META.map(([k, , c]) => `<span style="flex:0 0 ${(s.modes[k] / total) * 100}%;background:${k === 'line' ? lineHex : c}"></span>`).join('');
    $('split-legend').innerHTML = MODE_META.filter(([k]) => (k !== 'line' || L) && (k !== 'cab' || F)).map(([k, label, c]) =>
      `<li><span><i style="background:${k === 'line' ? lineHex : c}"></i>${k === 'line' ? lineName : label}</span><b>${fmt1.format((s.modes[k] / total) * 100)} %</b></li>`).join('');
    // valeurs en direct : fenêtre en cours tant qu'aucun relevé de 10 minutes n'existe
    const net = sim.net, w = net.win, has = sim.series.t.length > 0;
    const speed = has ? sim.cur.speed : w.time > 0 ? (w.len / w.time) * 3.6 : 0;
    const cong = has ? sim.cur.congestion : w.free > 0 ? w.time / w.free - 1 : 0;
    let cars = 0;
    for (let i = 0; i < net.vn; i++) if (net.vType[i] === 0) cars += net.vW[i];
    kpi('k-speed', speed ? fmt.format(speed) : '–', 'km/h');
    kpi('k-cong', `+${fmt.format(Math.max(0, cong) * 100)}`, '%');
    kpi('k-cars', fmt.format(cars));
    kpi('k-removed', fmt.format(s.carsRemoved));
    $('sec-line').hidden = !L; $('sec-cab').hidden = !F;
    if (L) {
      setText('line-title', L.kind === 'tram' ? 'Tramway' : 'Bus en voies réservées');
      const cap = L.curCap || L.capacityPerHour(sim.t), peak = L.curPeak || 0;
      $('g-load').style.width = Math.min(100, cap ? (peak / cap) * 100 : 0) + '%';
      $('g-load').style.background = lineHex;
      setText('k-peak', fmt.format(peak)); setText('k-cap', fmt.format(cap));
      kpi('k-board', fmt.format(s.line.boardings)); kpi('k-onboard', fmt.format(L.onboardNow()));
      kpi('k-lwait', fmt1.format(s.line.avgWait), 'min'); kpi('k-lspeed', s.line.speed ? fmt1.format(s.line.speed) : '–', 'km/h');
      kpi('k-lveh', fmt.format(L.inService())); kpi('k-denied', fmt.format(s.line.denied));
      $('key-line-swatch').style.background = lineHex;
    }
    setText('key-line', L ? `Charge du tronçon le plus chargé (${L.kind === 'tram' ? 'tramway' : 'bus'})` : 'Aucune ligne sur le tracé');
    if (F) {
      const c = F.counts(), tot = Math.max(1, c.idle + c.toPickup + c.loaded + c.charging + c.reposition);
      const parts = [['En course', c.loaded, '#ff5c93'], ['En approche ou à vide', c.toPickup + c.reposition, '#ff9cbd'], ['Libres', c.idle, '#5a3a4c'], ['En recharge', c.charging, '#2b3d54']];
      $('cab-split').innerHTML = parts.map(([, v, col]) => `<span style="flex:0 0 ${(v / tot) * 100}%;background:${col}"></span>`).join('');
      $('cab-legend').innerHTML = parts.map(([l, v, col]) => `<li><span><i style="background:${col}"></i>${l}</span><b>${fmt.format(v)}</b></li>`).join('');
      kpi('k-rides', fmt.format(s.cab.rides)); kpi('k-cwait', fmt1.format(s.cab.avgWait), 'min');
      kpi('k-empty', fmt.format(s.cab.emptyShare * 100), '%'); kpi('k-unserved', fmt.format(s.cab.unserved));
    }
    $('sec-econ').hidden = !L && !F;
    if (L || F) {
      const e = TQ.economics(s);
      kpi('k-rev', ...money(e.revenue)); kpi('k-opex', ...money(e.opex));
      kpi('k-oper', ...money(e.operating)); kpi('k-net', ...money(e.net));
      $('k-oper').style.color = e.operating < 0 ? 'var(--bad)' : 'var(--ok)';
      $('k-net').style.color = e.net < 0 ? 'var(--bad)' : 'var(--ok)';
      setText('k-capex', `Investissement à amortir : ${e.parts.map((p) => `${moneyText(p.capex)} (${p.kind === 'tram' ? 'tramway' : p.kind === 'bus' ? 'voies réservées et bus' : 'Cybercab et recharge'})`).join(' + ')}.`);
    }
    setText('k-co2', fmt1.format(Math.abs(s.co2Avoided)));
    setText('k-co2-label', s.co2Avoided >= 0 ? 'tonnes de CO₂ évitées depuis le départ' : 'tonnes de CO₂ ajoutées depuis le départ');
    drawChart(lineHex);
    if ($('dlg-compare').open && state.histLen !== sim.history.length) renderCompare();
  }

  function drawChart(lineHex) {
    const cv = $('chart'), dpr = window.devicePixelRatio || 1, w = cv.clientWidth, h = cv.clientHeight;
    if (cv.width !== Math.round(w * dpr)) { cv.width = Math.round(w * dpr); cv.height = Math.round(h * dpr); }
    const g = cv.getContext('2d'); g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const P = TQ.PARAMS, x = (t) => ((t - P.dayStart) / 86400) * w, base = h - 16;
    g.font = '12px "Barlow Semi Condensed", sans-serif'; g.textBaseline = 'alphabetic';
    for (let hr = 5; hr <= 29; hr += 3) {
      const X = x(hr * 3600);
      g.fillStyle = '#2b3d54'; g.fillRect(X, 0, 1, base);
      g.fillStyle = '#9fb0c3'; g.textAlign = hr === 5 ? 'left' : hr === 29 ? 'right' : 'center'; g.fillText((hr % 24) + ' h', X, h - 3);
    }
    const s = sim.series, n = s.t.length;
    const plot = (arr, max, color, fill) => {
      if (n < 2) return;
      g.beginPath();
      for (let i = 0; i < n; i++) { const X = x(s.t[i]), Y = base - Math.min(1, arr[i] / max) * (base - 4); if (i === 0) g.moveTo(X, Y); else g.lineTo(X, Y); }
      g.strokeStyle = color; g.lineWidth = 2; g.stroke();
      if (fill) { g.lineTo(x(s.t[n - 1]), base); g.lineTo(x(s.t[0]), base); g.closePath(); g.fillStyle = fill; g.fill(); }
    };
    plot(s.congestion, 1, '#ff4d4f', 'rgba(255,77,79,.12)');
    if (sim.line) plot(s.lineLoad, (60 / sim.line.p.headway.peak) * sim.line.p.capacity, lineHex);
    const X = x(sim.t); g.fillStyle = '#eef3f8'; g.fillRect(X, 0, 1.5, base);
  }

  function econCells(s) {
    if (!s.line && !s.cab) return '<td>–</td><td>–</td><td>–</td><td>–</td>';
    const e = TQ.economics(s), col = (v) => `style="color:var(--${v < 0 ? 'bad' : 'ok'})"`;
    return `<td>${moneyText(e.capex)}</td><td ${col(e.annual.operating)}>${moneyText(e.annual.operating)}</td><td ${col(e.annual.net)}>${moneyText(e.annual.net)}</td><td ${col(e.net)}>${e.net < 0 ? '−' : ''}${fmt1.format(Math.abs(e.netPerRider))} $</td>`;
  }

  function renderCompare() {
    state.histLen = sim.history.length;
    const el = $('compare');
    if (!sim.history.length) { el.innerHTML = '<p class="empty">Aucune journée terminée pour l\'instant. Choisissez la vitesse « Maximum » : une journée complète prend environ une minute.</p>'; return; }
    const rows = sim.history.map((s) => `<tr><td>${esc(s.label)}</td><td>${fmt.format(s.line ? s.line.boardings : 0)}</td><td>${s.line ? fmt.format(s.line.peakLoad) : '–'}</td><td>${s.line ? fmt1.format(s.line.speed) : '–'}</td><td>${s.cab ? fmt.format(s.cab.rides) : '–'}</td><td>${s.cab ? fmt.format(s.cab.emptyShare * 100) + ' %' : '–'}</td><td>${fmt.format(s.carsRemoved)}</td><td>${fmt1.format(s.avgSpeed)}</td><td>+${fmt.format(s.congestion * 100)} %</td><td>${fmt1.format(s.co2Avoided)}</td>${econCells(s)}</tr>`).join('');
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Scénario</th><th>Montées sur la ligne</th><th>Charge max. par heure</th><th>Vitesse de la ligne (km/h)</th><th>Passagers Cybercab</th><th>Km à vide</th><th>Trajets auto évités</th><th>Vitesse auto (km/h)</th><th>Temps perdu</th><th>CO₂ évité (t)</th><th>Investissement</th><th>Résultat d'exploitation par an</th><th>Résultat par an, investissement compris</th><th>Résultat par passager</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  // ------------------------------------------------------------------ commandes
  function radio(groupId, attr, cb) {
    const group = $(groupId);
    group.addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b || b.getAttribute('aria-checked') === 'true') return;
      group.querySelectorAll('button').forEach((x) => x.setAttribute('aria-checked', String(x === b)));
      cb(b.dataset[attr]);
    });
  }

  function lineHint() {
    const k = sim.scenario.line;
    $('line-hint').textContent = k === 'tram' ? 'Rames de 240 places aux 4 minutes en pointe, tunnel sous la colline Parlementaire.'
      : k === 'bus' ? 'Bus articulés de 105 places aux 2 min 30 en pointe, en surface sur tout le trajet.'
      : 'Situation de référence : aucune ligne structurante, les voies restent aux autos.';
  }

  function bindUi() {
    // Tout changement repart 90 minutes plus tôt, calculées d'un coup, pour que les rues et la ligne soient déjà en charge.
    const restart = (t, cfg) => {
      Object.assign(sim.scenario, cfg || {});
      const from = Math.max(t - 5400, sim.tDayEnd - 86400); // sans remonter avant le début de la journée
      sim.reset(from); sim.step(t - from);
    };
    radio('line-choice', 'line', (v) => { restart(sim.t, { line: v }); lineHint(); });
    radio('cab-choice', 'cab', (v) => { $('cab-options').hidden = v === 'off'; restart(sim.t, { cab: v, fleet: +$('fleet').value }); });
    radio('speeds', 'speed', (v) => { state.speed = +v; });
    const fleet = $('fleet'), fare = $('fare');
    const outs = () => { $('fleet-out').textContent = fmt.format(+fleet.value); $('fare-out').textContent = fmt1.format(+fare.value).replace('.', ',') + '0 $'; };
    fleet.addEventListener('input', outs); fare.addEventListener('input', () => { outs(); sim.scenario.farePerKm = +fare.value; });
    fleet.addEventListener('change', () => { if (+fleet.value !== sim.scenario.fleet) restart(sim.t, { fleet: +fleet.value }); });
    outs(); lineHint();
    $('winter').addEventListener('change', (e) => restart(sim.t, { winter: e.target.checked }));
    document.querySelectorAll('.starts button').forEach((b) => b.addEventListener('click', () => {
      const h = +b.dataset.start;
      if (h * 3600 <= TQ.PARAMS.dayStart) sim.reset(TQ.PARAMS.dayStart); else restart(h * 3600);
    }));
    for (const k of ['cars', 'roads', 'zone']) $('ly-' + k).addEventListener('change', (e) => { state.layers[k] = e.target.checked; });
    $('play').addEventListener('click', () => { state.playing = !state.playing; $('play').textContent = state.playing ? '❚❚' : '▶'; $('play').setAttribute('aria-label', state.playing ? 'Mettre en pause' : 'Reprendre'); });
    $('assumptions').innerHTML = TQ.ASSUMPTIONS.map((s) => `<h3>${s.title}</h3><ul>${s.items.map((i) => `<li>${i}</li>`).join('')}</ul>`).join('');
    $('open-assumptions').addEventListener('click', () => $('dlg-assumptions').showModal());
    $('open-compare').addEventListener('click', () => { renderCompare(); $('dlg-compare').showModal(); });
    document.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); $('play').click(); } });
  }
})();
