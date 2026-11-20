/* Interface : carte MapLibre, calques deck.gl, commandes et indicateurs. */
(function () {
  const TQ = window.TQ, $ = (id) => document.getElementById(id);
  const fmt = new Intl.NumberFormat('fr-CA', { maximumFractionDigits: 0 });
  const fmt1 = new Intl.NumberFormat('fr-CA', { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  const fmt2 = new Intl.NumberFormat('fr-CA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
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
  if (!window.maplibregl || !window.deck) return fail('La carte n\'a pas pu se charger. Rechargez la page.');

  // ------------------------------------------------------------------ initialisation
  setTimeout(() => {
    sim = new TQ.Simulation(window.TQ_DATA, { scenario: readHash() });
    window.sim = sim;
    prepareStatic();
    initMap();
    bindUi();
    status.hidden = true;
    requestAnimationFrame(frame);
  }, 30);

  // ------------------------------------------------------------------ lien partageable
  // curseur de coût -> [chemin dans TQ.ECON, multiplicateur, décimales, unité]
  const COSTS = { tram: ['line.tram.capex', 1e9, 1, 'G$'], bus: ['line.bus.capex', 1e9, 1, 'G$'], veh: ['cab.vehicle', 1e3, 0, 'k$'], km: ['cab.opexKm', 1, 2, '$'], taux: ['discount', 0.01, 1, '%'] };
  const dig = (root, path) => path.split('.').reduce((o, k) => o[k], root);
  const econSet = (path, v) => { const ks = path.split('.'), last = ks.pop(); (ks.length ? dig(TQ.ECON, ks.join('.')) : TQ.ECON)[last] = v; };
  const costValue = (id) => +(dig(TQ.ECON, COSTS[id][0]) / COSTS[id][1]).toFixed(2);

  /** Scénario et coûts lus dans l'adresse (#ligne=tram&cab=wide&flotte=3000...). Toute valeur hors bornes est ignorée. */
  function readHash() {
    const q = new URLSearchParams(location.hash.slice(1)), sc = { line: 'tram', cab: 'off', fleet: 3000 };
    const num = (k, lo, hi) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
    if (['none', 'tram', 'bus', 'cablane'].includes(q.get('ligne'))) sc.line = q.get('ligne');
    if (['off', 'corridor', 'wide'].includes(q.get('cab'))) sc.cab = q.get('cab');
    const f = num('flotte', 200, 20000), p = num('tarif', 0.3, 2);
    if (f) sc.fleet = Math.round(f / 100) * 100;
    if (p) sc.farePerKm = Math.round(p * 10) / 10;
    if (q.get('hiver') === '1') sc.winter = true;
    state.view3d = q.get('vue') === '3d';
    if (q.get('partage') === '1') sc.pool = true;
    const nc = num('sansauto', 0, 30);
    if (nc) sc.carFree = Math.round(nc) / 100;
    // la voie réservée aux Cybercab n'a de sens qu'avec une flotte
    if (sc.line === 'cablane' && sc.cab === 'off') sc.cab = 'corridor';
    for (const id in COSTS) {
      const el = $('c-' + id), v = num(id, +el.min, +el.max);
      if (v == null) continue;
      // alignée sur le pas du curseur, pour que la valeur appliquée soit celle qui s'affiche
      const st = +el.step, lo = +el.min;
      econSet(COSTS[id][0], +(lo + Math.round((v - lo) / st) * st).toFixed(2) * COSTS[id][1]);
    }
    return sc;
  }

  function writeHash() {
    const s = sim.scenario, q = new URLSearchParams();
    q.set('ligne', s.line); q.set('cab', s.cab);
    if (s.cab !== 'off') { q.set('flotte', s.fleet); q.set('tarif', s.farePerKm); }
    if (s.winter) q.set('hiver', '1');
    if (state.view3d) q.set('vue', '3d');
    if (s.cab !== 'off' && s.pool) q.set('partage', '1');
    if (s.cab !== 'off' && s.carFree > 0) q.set('sansauto', Math.round(s.carFree * 100));
    for (const id in COSTS) if (dig(TQ.ECON, COSTS[id][0]) !== dig(TQ.ECON_DEFAULTS, COSTS[id][0])) q.set(id, costValue(id));
    try { history.replaceState(null, '', '#' + q.toString()); } catch (e) { /* adresse non modifiable (aperçu local) */ }
  }

  /** Aligne les commandes sur le scénario et les coûts en vigueur. */
  function syncControls() {
    const s = sim.scenario;
    const check = (group, attr, v) => $(group).querySelectorAll('button').forEach((b) => { const on = b.dataset[attr] === String(v); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    check('line-choice', 'line', s.line); check('cab-choice', 'cab', s.cab); check('speeds', 'speed', state.speed);
    $('cab-options').hidden = s.cab === 'off';
    $('fleet').value = s.fleet; $('fare').value = s.farePerKm; $('winter').checked = !!s.winter;
    $('pool').checked = !!s.pool; $('carfree').value = Math.round((s.carFree || 0) * 100);
    $('carfree-out').textContent = Math.round((s.carFree || 0) * 100) + ' %';
    $('fleet-out').textContent = fmt.format(s.fleet); $('fare-out').textContent = fmt2.format(s.farePerKm) + ' $';
    for (const id in COSTS) {
      const [, , dec, unit] = COSTS[id], v = costValue(id);
      $('c-' + id).value = v;
      $('c-' + id + '-out').textContent = (dec === 2 ? fmt2 : dec === 1 ? fmt1 : fmt).format(v) + ' ' + unit;
    }
  }

  function prepareStatic() {
    const d = window.TQ_DATA, net = sim.net;
    roadData = d.segs.map((path, i) => ({ path, i, cls: 4, name: '' }));
    for (let e = 0; e < net.E; e++) {
      const r = roadData[net.eseg[e]];
      r.cls = Math.min(r.cls, net.ecls[e] === 5 ? 3 : net.ecls[e] === 6 ? 4 : net.ecls[e]); r.name = d.names[d.edges.name[e]];
      r.lanes = Math.max(r.lanes || 1, net.elanes[e]); r.two = net.etwo[e] === 1; r.cor = r.cor || net.ecor[e] === 1; (r.edges = r.edges || []).push(e);
    }
    state.segRatio = new Float32Array(d.segs.length);
    const L = d.line, surfA = [], tun = [], surfB = [];
    L.coords.forEach((c, i) => { const s = L.cum[i]; if (s <= L.tunnel[0]) surfA.push(c); if (s >= L.tunnel[0] && s <= L.tunnel[1]) tun.push(c); if (s >= L.tunnel[1]) surfB.push(c); });
    lineParts = [{ path: surfA, tunnel: false }, { path: tun, tunnel: true }, { path: surfB, tunnel: false }];
    // tracé simplifié (un point aux 900 m) : un trait très large sur un tracé dense se déchire aux jointures
    state.zonePath = []; let lastS = -1e9;
    L.coords.forEach((c, i) => { if (L.cum[i] - lastS >= 900 || i === L.coords.length - 1) { state.zonePath.push(c); lastS = L.cum[i]; } });
    stationData = L.stations.map((s, i) => ({ i, name: s.name, hub: s.hub, underground: s.underground, pos: sim.stationLL[i] }));
    // milieu de chaque arête, pour ne traiter en vue 3D que les tronçons à l'écran
    // Pour chaque rue qui longe le tracé : écart latéral de l'emprise réservée (mètres à droite de l'axe de la rue,
    // dans le sens de circulation) et positions le long du tracé du début et de la fin du tronçon.
    const KX = TQ.geo.KX, KY = TQ.geo.KY, LC = L.coords, LS = L.cum;
    const project = (lon, lat) => {
      let best = 1e18, bs = 0, bx = 0, by = 0;
      for (let i = 0; i < LC.length - 1; i++) {
        const ax = (LC[i][0] - lon) * KX, ay = (LC[i][1] - lat) * KY, bx2 = (LC[i + 1][0] - lon) * KX, by2 = (LC[i + 1][1] - lat) * KY;
        const dx = bx2 - ax, dy = by2 - ay, l2 = dx * dx + dy * dy;
        const t = l2 > 0 ? Math.min(1, Math.max(0, -(ax * dx + ay * dy) / l2)) : 0;
        const px = ax + dx * t, py = ay + dy * t, dd = px * px + py * py;
        if (dd < best) { best = dd; bs = LS[i] + (LS[i + 1] - LS[i]) * t; bx = px; by = py; }
      }
      return { s: bs, x: bx, y: by };
    };
    state.corLat = new Float32Array(net.E).fill(1e6); state.corS0 = new Float32Array(net.E); state.corS1 = new Float32Array(net.E);
    const o3 = [0, 0, 0];
    for (let e = 0; e < net.E; e++) {
      if (!net.ecor[e]) continue;
      net.edgePosLane(e, net.elen[e] / 2, 0, o3, 0);
      const h = (o3[2] * Math.PI) / 180, pm = project(o3[0], o3[1]);
      state.corLat[e] = pm.x * Math.sin(h) - pm.y * Math.cos(h);
      net.edgePosLane(e, 0, 0, o3, 0); state.corS0[e] = project(o3[0], o3[1]).s;
      net.edgePosLane(e, net.elen[e], 0, o3, 0); state.corS1[e] = project(o3[0], o3[1]).s;
    }
    state.ebox = new Float32Array(net.E * 4); state.byEdge = new Map();
    for (let e = 0; e < net.E; e++) {
      let x0 = 180, x1 = -180, y0 = 90, y1 = -90;
      for (const c of d.segs[net.eseg[e]]) { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; }
      state.ebox.set([x0, y0, x1, y1], e * 4);
    }
    state.posBuf = new Float32Array(2 * 40000); state.colBuf = new Uint8Array(4 * 40000);
    state.cabPos = new Float32Array(2 * 12000); state.cabCol = new Uint8Array(4 * 12000);
    // noms affichés sur la carte : terminus et pôles d'échanges
    state.labels = stationData.filter((s, i) => s.hub || i === 0 || i === stationData.length - 1);
    state.labelChars = [...new Set(state.labels.map((s) => s.name).join(''))];
    state.allChars = [...new Set(stationData.map((s) => s.name).join(''))];
    state.twoWay = roadData.filter((r) => r.two);
    // marquages posés quelques centimètres au-dessus de l'asphalte, pour une superposition nette
    for (const r of state.twoWay) r.path3 = r.path.map((c) => [c[0], c[1], 0.06]);
    for (const part of lineParts) part.path3 = part.path.map((c) => [c[0], c[1], 0.12]);
  }

  function initMap() {
    map = new maplibregl.Map({
      container: 'map', style: state.view3d ? STYLE_3D : STYLE_2D, maxPitch: 70, center: [-71.262, 46.803], zoom: 11.6, minZoom: 9.5, maxZoom: 18.5,
      attributionControl: false, maxBounds: [[-72.2, 46.4], [-70.4, 47.25]],
    });
    map.addControl(new maplibregl.AttributionControl({ compact: true, customAttribution: 'Réseau : © contributeurs OpenStreetMap · Demande et débits : EOD 2023 et DJMA, MTMD · Limites : Ville de Québec' }), 'bottom-right');
    map.addControl(new maplibregl.NavigationControl({ showCompass: false }), 'bottom-right');
    map.on('error', (e) => { if (e && e.error && /style|Failed to fetch/i.test(String(e.error.message))) console.warn('Fond de carte indisponible', e.error.message); });
    // calques dessinés dans la scène de la carte : en vue 3D, les bâtiments cachent les véhicules qui passent derrière
    overlay = new deck.MapboxOverlay({ interleaved: true, layers: [], getTooltip: tooltip });
    map.addControl(overlay);
    window.tqMap = map;
    $('view3d').addEventListener('click', () => { setView3d(!state.view3d); writeHash(); });
    if (state.view3d) { document.body.classList.add('v3d'); $('view3d').setAttribute('aria-pressed', 'true'); $('view3d').textContent = 'Vue en plan'; map.jumpTo({ pitch: 62, bearing: -24, zoom: 16.9, center: sim.stationLL[stationData.findIndex((d) => d.name === 'Saint-Roch')] || [-71.2265, 46.8135] }); }
    // en vue 3D, les icônes et libellés de commerces du fond de carte encombrent la scène
    map.on('styledata', () => {
      if (!state.view3d || state.styled3d === map.getStyle().name + map.getStyle().layers.length) return;
      state.styled3d = map.getStyle().name + map.getStyle().layers.length;
      try {
        for (const l of map.getStyle().layers) {
          if (l.type === 'symbol' && /poi|housenumber|shield/.test(l.id)) map.setLayoutProperty(l.id, 'visibility', 'none');
          else if (l.type === 'symbol' && !state.labelLayer3d) state.labelLayer3d = l.id;
          // rues du fond de carte : le même asphalte que les artères simulées
          if (l.type === 'line' && /^(road|bridge|tunnel|highway)/.test(l.id) && !/rail|path|pedestrian|track|steps|ferry|area|pattern/.test(l.id)) map.setPaintProperty(l.id, 'line-color', /casing|outline/.test(l.id) ? '#6f757c' : '#8b9198');
          // bâtiments : pierre claire pour les maisons, verre bleuté pour les tours
          if (l.type === 'fill-extrusion') { map.setPaintProperty(l.id, 'fill-extrusion-color', ['interpolate', ['linear'], ['coalesce', ['get', 'render_height'], 6], 0, '#efe6d6', 12, '#e0d3bd', 30, '#c9ccd0', 70, '#a9bccd', 150, '#8aa5c0']); map.setPaintProperty(l.id, 'fill-extrusion-opacity', 0.96); }
        }
        state.labelLayer = state.labelLayer3d;
        if (map.setSky) map.setSky({ 'sky-color': '#8ec5ee', 'horizon-color': '#e4eef5', 'fog-color': '#eef3f6', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.75 });
        map.setLight({ anchor: 'map', position: [1.4, 215, 42], intensity: 0.45, color: '#fff6e4' });
      } catch (e) { console.warn('Habillage 3D partiel', e.message); }
    });
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
    // une rue fluide s'efface : seules les rues chargées attirent l'œil, de l'ambre au rouge sombre
    if (r < 0.5) return [60, 104, 118, 38];
    if (r < 0.8) { const t = (r - 0.5) / 0.3; return [60 + t * 170, 104 + t * 56, 118 - t * 70, 38 + t * 92]; }
    if (r < 1) { const t = (r - 0.8) / 0.2; return [230 - t * 12, 160 - t * 96, 48 + t * 8, 130 + t * 70]; }
    return [214, 52, 60, 225];
  }

  // ------------------------------------------------------------------ vue 3D
  const STYLE_2D = 'https://tiles.openfreemap.org/styles/dark', STYLE_3D = 'https://tiles.openfreemap.org/styles/liberty';
  // Formes des véhicules : assemblages de boîtes dans un volume unité (x = longueur, y = largeur, z = hauteur, posé au sol).
  const meshOf = (boxes) => {
    const pos = [], nor = [];
    for (const [x0, x1, y0, y1, z0, z1] of boxes) {
      const faces = [
        [[0, 0, 1], [x0, y0, z1], [x1, y0, z1], [x1, y1, z1], [x0, y1, z1]], [[0, 0, -1], [x0, y1, z0], [x1, y1, z0], [x1, y0, z0], [x0, y0, z0]],
        [[1, 0, 0], [x1, y0, z0], [x1, y1, z0], [x1, y1, z1], [x1, y0, z1]], [[-1, 0, 0], [x0, y1, z0], [x0, y0, z0], [x0, y0, z1], [x0, y1, z1]],
        [[0, 1, 0], [x1, y1, z0], [x0, y1, z0], [x0, y1, z1], [x1, y1, z1]], [[0, -1, 0], [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1]],
      ];
      for (const [n, p, q, r, t] of faces) for (const v of [p, q, r, p, r, t]) { pos.push(...v); nor.push(...n); }
    }
    return { attributes: { positions: { value: new Float32Array(pos), size: 3 }, normals: { value: new Float32Array(nor), size: 3 }, texCoords: { value: new Float32Array((pos.length / 3) * 2), size: 2 } } };
  };
  // chaque véhicule : une carrosserie peinte et un vitrage sombre, dessinés en deux passes
  const MESH = {
    car: meshOf([[-0.5, 0.5, -0.5, 0.5, 0.08, 0.55], [-0.24, 0.22, -0.46, 0.46, 0.92, 1], [-0.42, -0.24, -0.5, 0.5, 0, 0.08], [0.24, 0.42, -0.5, 0.5, 0, 0.08]]),
    carGlass: meshOf([[-0.27, 0.25, -0.45, 0.45, 0.55, 0.92]]),
    cab: meshOf([[-0.5, 0.5, -0.5, 0.5, 0.08, 0.52], [-0.3, 0.12, -0.46, 0.46, 0.9, 1], [-0.42, -0.24, -0.5, 0.5, 0, 0.08], [0.24, 0.42, -0.5, 0.5, 0, 0.08]]),
    cabGlass: meshOf([[-0.36, 0.2, -0.45, 0.45, 0.52, 0.9]]),
    module: meshOf([[-0.49, 0.49, -0.5, 0.5, 0.1, 0.48], [-0.49, 0.49, -0.5, 0.5, 0.84, 1], [-0.4, -0.22, -0.46, 0.46, 0, 0.1], [0.22, 0.4, -0.46, 0.46, 0, 0.1]]),
    moduleGlass: meshOf([[-0.47, 0.47, -0.48, 0.48, 0.48, 0.84]]),
  };
  const CAR_PAINT = [[232, 236, 240], [48, 56, 66], [150, 158, 168], [176, 44, 44], [38, 84, 150], [205, 208, 212], [28, 32, 38], [120, 132, 110]];
  const tmp4 = [0, 0, 0, 0];

  function setView3d(on, instant) {
    state.view3d = on;
    document.body.classList.toggle('v3d', on);
    $('view3d').setAttribute('aria-pressed', String(on));
    $('view3d').textContent = on ? 'Vue en plan' : 'Vue 3D';
    map.setStyle(on ? STYLE_3D : STYLE_2D);
    const cam = on ? { pitch: 62, bearing: -24, zoom: Math.max(map.getZoom(), 16.9) } : { pitch: 0, bearing: 0, zoom: Math.min(map.getZoom(), 12.6) };
    if (instant) map.jumpTo(cam); else map.easeTo(Object.assign(cam, { duration: 1400 }));
  }

  /** Direction (degrés, sens trigonométrique depuis l'est) d'un véhicule sur l'arête e à la fraction f. */
  function heading(net, e, f) {
    const a = f > 0.9 ? f - 0.1 : f, b = f > 0.9 ? f : f + 0.1;
    net.edgePos(e, a, tmp4, 0); net.edgePos(e, b, tmp4, 2);
    return (Math.atan2((tmp4[3] - tmp4[1]) * TQ.geo.KY, (tmp4[2] - tmp4[0]) * TQ.geo.KX) * 180) / Math.PI;
  }

  /** Calques de la vue 3D : la ville en volume vient du fond de carte, les véhicules sont de petits volumes orientés. */
  function buildLayers3d() {
    const net = sim.net, L = sim.line, F = sim.fleet, layers = [];
    const lane = sim.cabLane, lineKey = L ? L.kind : lane ? 'cablane' : 'none', lit = !!L || lane;
    const lineColor = L ? COLORS[L.kind] : lane ? COLORS.cab : [130, 146, 166];
    const tun = (d) => d.tunnel && (!L || L.kind === 'tram');
    // Échelle de la scène : en vue rapprochée tout est à taille réelle ; plus loin, chaussées et véhicules
    // grossissent ensemble, pour que les véhicules restent toujours sur leur voie.
    const zoom = map.getZoom();
    const big = Math.min(2.4, Math.max(1, Math.pow(2, 17 - zoom)));
    const LANE = 3.5 * big, AXIS = 0.3 * big; // largeur d'une voie ; demi-terre-plein entre les deux sens
    const reserved = net.cond.laneDrop; // une voie du tracé est prise par le tramway, les bus ou les Cybercab
    const STRIP = AXIS + LANE; // demi-largeur de l'emprise réservée : une voie par sens
    // Voies des autos sur l'arête e : [bord gauche du bloc de voies (mètres à droite de l'axe), nombre de voies].
    // Le long du tracé, la rue perd une voie et le bloc s'écarte de l'emprise réservée pour ne jamais la chevaucher.
    const block = (ed) => {
      const two = net.etwo[ed] === 1, onLine = reserved && net.ecor[ed] === 1;
      const k = Math.max(1, net.elanes[ed] - (onLine ? 1 : 0)), W = k * LANE;
      let x0 = two ? AXIS : -W / 2;
      if (onLine) {
        const a = state.corLat[ed] - STRIP, b = state.corLat[ed] + STRIP;
        if (a < x0 + W && b > x0) x0 = two || b - x0 <= x0 + W - a ? b + 0.25 * big : a - W - 0.25 * big;
      }
      return [x0, k, W];
    };
    const widthOf = (d) => { let ext = 0; for (const ed of d.edges) { const [x0, , W] = block(ed); ext = Math.max(ext, Math.abs(x0), Math.abs(x0 + W)); } return 2 * ext + 0.8 * big; };
    const under = state.labelLayer && map.getLayer(state.labelLayer) ? state.labelLayer : undefined; // sous les noms de rues
    layers.push(new deck.PathLayer({
      id: 'asphalt', data: roadData, getPath: (d) => d.path, beforeId: under,
      // l'asphalte se réchauffe légèrement quand la rue se charge ; ce sont les files d'autos qui montrent la congestion
      getColor: (d) => { const r = state.layers.roads ? state.segRatio[d.i] : 0; return r < 0.7 ? [86, 92, 100, 255] : r < 0.9 ? [104, 96, 88, 255] : r < 1 ? [116, 92, 84, 255] : [126, 84, 82, 255]; },
      getWidth: widthOf, widthUnits: 'meters', widthMinPixels: 1.5, capRounded: true, jointRounded: true, pickable: true,
      updateTriggers: { getColor: [state.colorTick, state.layers.roads], getWidth: [big, reserved] }, getPolygonOffset: () => [0, -200],
    }));
    // ligne médiane des rues à double sens
    layers.push(new deck.PathLayer({
      id: 'median', data: state.twoWay, getPath: (d) => d.path3, beforeId: under, getColor: [236, 200, 90, 230],
      getWidth: 0.22 * big, widthUnits: 'meters', widthMinPixels: 0.6, getPolygonOffset: () => [0, -600], updateTriggers: { getWidth: [big] },
    }));
    // l'emprise réservée : deux voies au centre de la rue, une par sens
    layers.push(new deck.PathLayer({
      id: 'line3d', data: lineParts.filter((d) => !tun(d)), getPath: (d) => d.path3, beforeId: under, getColor: lit ? [...lineColor.map((c) => Math.round(c * 0.55 + 40)), 255] : [104, 110, 118, 255],
      getWidth: 2 * STRIP - 0.5 * big, widthUnits: 'meters', widthMinPixels: 2, capRounded: true, jointRounded: true, updateTriggers: { getColor: [lineKey], getWidth: [big] }, getPolygonOffset: () => [0, -1000],
    }));
    if (!deck.SimpleMeshLayer || zoom < 14.6) return layers.concat(stationLayers3d(lineColor, lineKey));
    // Le moteur ne suit pas chaque auto au mètre près : pour l'affichage, les véhicules d'un même tronçon sont rangés
    // en files, voie par voie, sans jamais se chevaucher. Ceux qui n'ont plus de place ne sont pas dessinés.
    const bb = map.getBounds(), w = bb.getWest(), e = bb.getEast(), s = bb.getSouth(), n = bb.getNorth();
    const carLen = 4.5 * big, gap = carLen + 2.4 * big, box = state.ebox, byEdge = state.byEdge;
    byEdge.clear();
    for (let i = 0; i < net.vn; i++) {
      const type = net.vType[i];
      if (type === 0 && !state.layers.cars) continue;
      const ed = net.vEdge[i], q = ed * 4;
      if (box[q + 2] < w || box[q] > e || box[q + 3] < s || box[q + 1] > n) continue;
      let list = byEdge.get(ed);
      if (!list) byEdge.set(ed, (list = []));
      list.push(i);
    }
    const cars = [], cabs = [], out = [0, 0, 0];
    const lp = [0, 0], lq = [0, 0];
    for (const [ed, list] of byEdge) {
      const len = net.elen[ed], onLine = reserved && net.ecor[ed] === 1;
      const [x0, carLanes, W] = block(ed);
      const lateral = (k) => x0 + LANE * (k + 0.5);
      // les carrefours restent dégagés : personne ne s'arrête dans les derniers mètres d'un tronçon
      const clear = Math.min(len * 0.25, Math.max(Math.abs(x0), Math.abs(x0 + W)) + carLen * 0.5), end = len - clear;
      list.sort((p, q) => net.vProg[q] - net.vProg[p]);
      const last = new Array(carLanes).fill(Infinity);
      let lastCab = Infinity;
      for (const i of list) {
       const type = net.vType[i], copies = Math.max(1, Math.round(net.vW[i]));
       for (let c = 0; c < copies; c++) {
        // un agent du moteur représente plusieurs véhicules réels : ils se suivent, à quelques longueurs d'écart
        const h = (((i * 7 + c * 13) * 2654435761) >>> 0) / 4294967296;
        const want = Math.min(end, net.vProg[i] * len - c * gap * (1.5 + 1.5 * h));
        if (want < clear) break;
        if (type > 0 && net.cabLane && onLine) {
          // voie réservée : les Cybercab se suivent en convoi serré
          const at = Math.min(want, lastCab - (carLen + 0.9 * big));
          if (at < clear || cabs.length >= 9000) break;
          lastCab = at;
          // sur l'emprise elle-même, à droite de son axe dans le sens de marche
          const s0 = state.corS0[ed], s1 = state.corS1[ed], sl = s0 + ((s1 - s0) * at) / len, fw = s1 >= s0 ? 1 : -1;
          sim.lineLL(sl - 4 * fw, lp); sim.lineLL(sl + 4 * fw, lq);
          const dx = (lq[0] - lp[0]) * TQ.geo.KX, dy = (lq[1] - lp[1]) * TQ.geo.KY, dl = Math.hypot(dx, dy) || 1, off = AXIS + LANE / 2;
          out[0] = (lp[0] + lq[0]) / 2 + ((dy / dl) * off) / TQ.geo.KX; out[1] = (lp[1] + lq[1]) / 2 - ((dx / dl) * off) / TQ.geo.KY; out[2] = (Math.atan2(dy, dx) * 180) / Math.PI;
          if (out[0] < w || out[0] > e || out[1] < s || out[1] > n) continue;
          cabs.push({ p: [out[0], out[1], 0], yaw: out[2], i: i * 4 + c, type });
          continue;
        }
        let k = 0;
        for (let q = 1; q < carLanes; q++) if (last[q] > last[k]) k = q;
        const at = Math.min(want, last[k] - gap);
        if (at < clear) break;
        last[k] = at;
        net.edgePosLane(ed, at, lateral(k), out, 0);
        if (out[0] < w || out[0] > e || out[1] < s || out[1] > n) continue;
        const v = { p: [out[0], out[1], 0], yaw: out[2], i: i * 4 + c, type };
        if (type === 0) { if (cars.length < 14000) cars.push(v); } else if (cabs.length < 9000) cabs.push(v);
       }
      }
    }
    const mesh = { sizeScale: big, getPosition: (d) => d.p, getOrientation: (d) => [0, d.yaw, 0], material: { ambient: 0.5, diffuse: 0.65, shininess: 40, specularColor: [70, 70, 70] } };
    const GLASS = [34, 42, 54];
    layers.push(new deck.SimpleMeshLayer(Object.assign({ id: 'cars3d', data: cars, mesh: MESH.car, getScale: [4.5, 1.85, 1.5], getColor: (d) => CAR_PAINT[d.i % CAR_PAINT.length] }, mesh)));
    layers.push(new deck.SimpleMeshLayer(Object.assign({ id: 'cars3d-glass', data: cars, mesh: MESH.carGlass, getScale: [4.5, 1.85, 1.5], getColor: GLASS }, mesh)));
    if (F) {
      // Cybercab : carrosserie dorée quand il transporte quelqu'un, plus pâle à vide
      layers.push(new deck.SimpleMeshLayer(Object.assign({ id: 'cabs3d', data: cabs, mesh: MESH.cab, getScale: [4.3, 1.85, 1.3], getColor: (d) => (d.type === 2 ? [226, 180, 70] : [210, 196, 158]) }, mesh)));
      layers.push(new deck.SimpleMeshLayer(Object.assign({ id: 'cabs3d-glass', data: cabs, mesh: MESH.cabGlass, getScale: [4.3, 1.85, 1.3], getColor: GLASS }, mesh)));
    }
    if (L) {
      // rames et autobus articulés : des caisses qui suivent chacune la courbe, à droite de l'axe selon le sens
      const parts = L.kind === 'tram' ? 5 : 2, partLen = (L.p.length * big) / parts, veh = [], a = [0, 0], b = [0, 0], c = [0, 0];
      for (const v of L.vehicles) {
        if (!v.active || (L.kind === 'tram' && v.s > L.tunnel[0] - L.p.length && v.s < L.tunnel[1] + L.p.length)) continue;
        for (let q = 0; q < parts; q++) {
          const sc = v.s + (q - (parts - 1) / 2) * partLen;
          L.posAt(sc - partLen / 2, a, 0); L.posAt(sc, b, 0); L.posAt(sc + partLen / 2, c, 0);
          let dx = (c[0] - a[0]) * TQ.geo.KX, dy = (c[1] - a[1]) * TQ.geo.KY;
          if (v.dir === 1) { dx = -dx; dy = -dy; }
          const l = Math.hypot(dx, dy) || 1;
          const off = AXIS + LANE / 2;
          veh.push({ v, p: [b[0] + ((dy / l) * off) / TQ.geo.KX, b[1] - ((dx / l) * off) / TQ.geo.KY, 0], yaw: (Math.atan2(dy, dx) * 180) / Math.PI });
        }
      }
      const size = [partLen / big, L.p.width, L.kind === 'tram' ? 3.4 : 3.1];
      layers.push(new deck.SimpleMeshLayer(Object.assign({}, mesh, { id: 'line-veh', data: veh, mesh: MESH.module, getScale: size, getColor: lineColor, pickable: true })));
      layers.push(new deck.SimpleMeshLayer(Object.assign({}, mesh, { id: 'line-veh-glass', data: veh, mesh: MESH.moduleGlass, getScale: size, getColor: [34, 42, 54] })));
    }
    return layers.concat(stationLayers3d(lineColor, lineKey));
  }

  function stationLayers3d(lineColor, lineKey) {
    const layers = [];
    layers.push(new deck.ScatterplotLayer({
      id: 'stations', data: stationData, getPosition: (d) => d.pos, pickable: true, stroked: true, filled: true,
      getFillColor: [255, 255, 255, 255], getLineColor: [...lineColor, 255], lineWidthUnits: 'pixels', getLineWidth: 3,
      getRadius: (d) => (d.hub ? 7 : 5), radiusUnits: 'pixels', updateTriggers: { getLineColor: [lineKey] }, parameters: { depthTest: false },
    }));
    if (deck.TextLayer) layers.push(new deck.TextLayer({
      id: 'station-names', data: stationData, getPosition: (d) => d.pos, getText: (d) => d.name, characterSet: state.allChars,
      fontFamily: '"Barlow Semi Condensed", "Segoe UI", sans-serif', fontWeight: 600, getSize: 14, getColor: [20, 32, 47, 255],
      getPixelOffset: [0, -18], getTextAnchor: 'middle', getAlignmentBaseline: 'bottom',
      fontSettings: { sdf: true, fontSize: 40, buffer: 14 }, outlineWidth: 4, outlineColor: [255, 255, 255, 255], parameters: { depthTest: false },
    }));
    return layers;
  }

  function buildLayers() {
    if (state.view3d) return buildLayers3d();
    const net = sim.net, L = sim.line, F = sim.fleet, layers = [];
    const lane = sim.cabLane, lineKey = L ? L.kind : lane ? 'cablane' : 'none', lit = !!L || lane; // tracé en service
    const lineColor = L ? COLORS[L.kind] : lane ? COLORS.cab : [130, 146, 166];
    const tun = (d) => d.tunnel && (!L || L.kind === 'tram'); // le bus reste en surface
    if (state.layers.roads) {
      layers.push(new deck.PathLayer({
        id: 'roads', data: roadData, getPath: (d) => d.path, getColor: (d) => rampColor(state.segRatio[d.i]),
        getWidth: (d) => (d.cls === 0 ? 4 : d.cls <= 2 ? 2.6 : 1.7), widthUnits: 'pixels', widthMinPixels: 1, capRounded: true, jointRounded: true,
        pickable: true, updateTriggers: { getColor: state.colorTick }, parameters: { depthTest: false },
      }));
    }
    if (F && state.layers.zone && sim.scenario.cab === 'corridor') {
      layers.push(new deck.PathLayer({ id: 'cab-zone', data: [{ path: state.zonePath }], getPath: (d) => d.path, getColor: [255, 92, 147, 22], getWidth: 2400, widthUnits: 'meters', capRounded: true, jointRounded: true }));
    }
    if (F && state.layers.zone && sim.scenario.cab === 'wide') {
      layers.push(new deck.PathLayer({ id: 'cab-zone-wide', data: window.TQ_DATA.outlines.filter((o) => o.zone <= 5), getPath: (d) => d.ring, getColor: [255, 92, 147, 120], getWidth: 1.5, widthUnits: 'pixels' }));
    }
    // le tracé : un halo, un liseré sombre qui le détache des rues, puis le trait
    if (lit) layers.push(new deck.PathLayer({ id: 'line-glow', data: lineParts.filter((d) => !tun(d)), getPath: (d) => d.path, getColor: [...lineColor, 34], getWidth: 16, widthUnits: 'pixels', capRounded: true, jointRounded: true, updateTriggers: { getColor: [lineKey] } }));
    layers.push(new deck.PathLayer({ id: 'line-casing', data: lineParts.filter((d) => !tun(d)), getPath: (d) => d.path, getColor: [12, 21, 34, 235], getWidth: 8, widthUnits: 'pixels', capRounded: true, jointRounded: true }));
    layers.push(new deck.PathLayer({
      id: 'line', data: lineParts, getPath: (d) => d.path, getColor: (d) => [...lineColor, lit ? (tun(d) ? 90 : 230) : 110],
      getWidth: (d) => (tun(d) ? 3 : 4), widthUnits: 'pixels', capRounded: true, jointRounded: true, updateTriggers: { getColor: [lineKey], getWidth: [lineKey] },
    }));
    // véhicules routiers
    // autos : petits points pâles ; Cybercab : points plus gros, dessinés par-dessus pour rester lisibles
    const n = net.vn, pos = state.posBuf, col = state.colBuf, cpos = state.cabPos, ccol = state.cabCol;
    let k = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const type = net.vType[i];
      if (type === 0) {
        if (!state.layers.cars || k >= 40000) continue;
        net.edgePos(net.vEdge[i], net.vProg[i], pos, k * 2);
        const o = k * 4; col[o] = 205; col[o + 1] = 216; col[o + 2] = 230; col[o + 3] = 125;
        k++;
      } else if (c < 12000) {
        net.edgePos(net.vEdge[i], net.vProg[i], cpos, c * 2);
        const o = c * 4; ccol[o] = 255; ccol[o + 1] = type === 2 ? 92 : 168; ccol[o + 2] = type === 2 ? 147 : 198; ccol[o + 3] = type === 2 ? 255 : 170;
        c++;
      }
    }
    if (F) {
      for (let i = 0; i < F.n && c < 12000; i++) {
        if (F.state[i] !== 0 && F.state[i] !== 3) continue;
        const p = sim.info[F.point[i]], j = ((i * 2654435761) >>> 0) / 4294967296;
        cpos[c * 2] = p.lon + (j - 0.5) * 0.0016; cpos[c * 2 + 1] = p.lat + (((j * 7919) % 1) - 0.5) * 0.0011;
        const o = c * 4; ccol[o] = 255; ccol[o + 1] = 92; ccol[o + 2] = 147; ccol[o + 3] = F.state[i] === 3 ? 40 : 80;
        c++;
      }
    }
    layers.push(new deck.ScatterplotLayer({
      id: 'vehicles', data: { length: k, attributes: { getPosition: { value: pos, size: 2 }, getFillColor: { value: col, size: 4, normalized: true } } },
      getRadius: 11, radiusUnits: 'meters', radiusMinPixels: 1.1, radiusMaxPixels: 4, parameters: { depthTest: false },
    }));
    if (F) layers.push(new deck.ScatterplotLayer({
      id: 'cabs', data: { length: c, attributes: { getPosition: { value: cpos, size: 2 }, getFillColor: { value: ccol, size: 4, normalized: true } } },
      getRadius: 16, radiusUnits: 'meters', radiusMinPixels: 2, radiusMaxPixels: 6, parameters: { depthTest: false },
    }));
    layers.push(new deck.ScatterplotLayer({
      id: 'stations', data: stationData, getPosition: (d) => d.pos, pickable: true, stroked: true, filled: true,
      getFillColor: [12, 21, 34, 255], getLineColor: (d) => [...lineColor, lit ? 255 : 110], lineWidthUnits: 'pixels', getLineWidth: (d) => (d.hub ? 2.5 : 1.5),
      getRadius: (d) => (d.hub ? 5.5 : 3.6) + (L ? Math.min(7, Math.sqrt(L.waitingAt(d.i)) * 0.35) : 0), radiusUnits: 'pixels',
      updateTriggers: { getRadius: state.colorTick, getLineColor: [lineKey] },
    }));
    if (deck.TextLayer) layers.push(new deck.TextLayer({
      id: 'station-names', data: state.labels, getPosition: (d) => d.pos, getText: (d) => d.name, characterSet: state.labelChars,
      fontFamily: '"Barlow Semi Condensed", "Segoe UI", sans-serif', fontWeight: 600, getSize: 13, getColor: [238, 243, 248, L ? 235 : 150],
      getPixelOffset: [12, 0], getTextAnchor: 'start', getAlignmentBaseline: 'center',
      fontSettings: { sdf: true, fontSize: 40, buffer: 14 }, outlineWidth: 3, outlineColor: [12, 21, 34, 255], parameters: { depthTest: false },
      updateTriggers: { getColor: [!!L] },
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
    if (state.playing && !document.hidden && !state.batch) {
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
    setText('key-line', L ? `Charge du tronçon le plus chargé (${L.kind === 'tram' ? 'tramway' : 'bus'})` : sim.cabLane ? 'Voie réservée aux Cybercab : pas de ligne à horaire' : 'Aucune ligne sur le tracé');
    if (F) {
      const c = F.counts(), tot = Math.max(1, c.idle + c.toPickup + c.loaded + c.charging + c.reposition);
      const parts = [['En course', c.loaded, '#ff5c93'], ['En approche ou à vide', c.toPickup + c.reposition, '#ff9cbd'], ['Libres', c.idle, '#5a3a4c'], ['En recharge', c.charging, '#2b3d54']];
      $('cab-split').innerHTML = parts.map(([, v, col]) => `<span style="flex:0 0 ${(v / tot) * 100}%;background:${col}"></span>`).join('');
      $('cab-legend').innerHTML = parts.map(([l, v, col]) => `<li><span><i style="background:${col}"></i>${l}</span><b>${fmt.format(v)}</b></li>`).join('');
      kpi('k-rides', fmt.format(s.cab.rides)); kpi('k-cwait', fmt1.format(s.cab.avgWait), 'min');
      kpi('k-empty', fmt.format(s.cab.emptyShare * 100), '%'); kpi('k-unserved', fmt.format(s.cab.unserved));
      kpi('k-cspeed', s.cab.speed ? fmt.format(s.cab.speed) : '–', 'km/h');
      kpi('k-pooled', fmt.format(s.cab.rides > 0 ? Math.min(100, (s.cab.pooled / s.cab.rides) * 100) : 0), '%');
      $('row-pooled').hidden = !sim.scenario.pool;
    }
    $('sec-econ').hidden = !L && !F;
    if (L || F) {
      const e = TQ.economics(s);
      kpi('k-rev', ...money(e.revenue)); kpi('k-opex', ...money(e.opex));
      kpi('k-oper', ...money(e.operating)); kpi('k-net', ...money(e.net));
      // recettes face aux coûts, à la même échelle
      const top = Math.max(e.revenue, e.opex + e.capital, 1), pct = (v) => ((v / top) * 100).toFixed(1) + '%';
      $('eb-rev').style.width = pct(e.revenue); $('eb-opex').style.width = pct(e.opex); $('eb-cap').style.width = pct(e.capital);
      $('k-oper').style.color = e.operating < 0 ? 'var(--bad)' : 'var(--ok)';
      $('k-net').style.color = e.net < 0 ? 'var(--bad)' : 'var(--ok)';
      setText('k-capex', `Investissement à amortir : ${e.parts.map((p) => `${moneyText(p.capex)} (${p.kind === 'tram' ? 'tramway' : p.kind === 'bus' ? 'voies réservées et bus' : p.kind === 'cablane' ? 'voie réservée' : 'Cybercab et recharge'})`).join(' + ')}.`);
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

  /** Barres divergentes : résultat de l'exploitant et bilan pour la société, à la même échelle. */
  function econChart() {
    const rows = sim.history.filter((s) => s.line || s.cab).map((s) => { const a = TQ.economics(s).annual; return { label: s.label, v: [a.net, a.society.net] }; });
    if (!rows.length) return '';
    const top = Math.max(1, ...rows.flatMap((r) => r.v.map(Math.abs)));
    const bar = (v, cls) => `<div class="dv ${cls}"><i style="${v < 0 ? 'right' : 'left'}:50%;width:${((Math.abs(v) / top) * 50).toFixed(2)}%;background:var(--${v < 0 ? 'bad' : 'ok'})"></i><b style="${v < 0 ? 'left' : 'right'}:calc(50% + 6px)">${moneyText(v)}</b></div>`;
    return `<div class="dvchart" role="img" aria-label="Résultat de l'exploitant et bilan pour la société, par scénario">
      <p class="dvkey"><span><i class="k1"></i>Résultat de l'exploitant</span><span><i class="k2"></i>Bilan pour la société</span><span>pertes à gauche, gains à droite</span></p>
      ${rows.map((r) => `<div class="dvrow"><span>${esc(r.label)}</span><div>${bar(r.v[0], 'a')}${bar(r.v[1], 'b')}</div></div>`).join('')}</div>`;
  }

  function econRow(s) {
    if (!s.line && !s.cab) return `<tr><td>${esc(s.label)}</td>${'<td>–</td>'.repeat(10)}</tr>`;
    const e = TQ.economics(s), a = e.annual, y = a.society;
    const signed = (v, strong) => (v == null ? '<td>–</td>' : `<td style="color:var(--${v < 0 ? 'bad' : 'ok'})${strong ? ';font-weight:600' : ''}">${moneyText(v)}</td>`);
    return `<tr><td>${esc(s.label)}</td><td>${moneyText(e.capex)}</td><td>${moneyText(a.revenue)}</td><td>${moneyText(a.opex)}</td><td>${moneyText(a.capital)}</td>${signed(a.net, true)}${signed(y.riders)}${signed(y.drivers)}${signed(y.co2)}${signed(y.rtcLoss)}${signed(y.net, true)}</tr>`;
  }

  function renderCompare() {
    state.histLen = sim.history.length;
    const el = $('compare');
    if (!sim.history.length) { el.innerHTML = '<p class="empty">Aucune journée terminée pour l\'instant. Utilisez un des boutons ci-dessus, ou laissez tourner la simulation jusqu\'à 5 h.</p>'; return; }
    const rows = sim.history.map((s) => `<tr><td>${esc(s.label)}</td><td>${fmt.format(s.line ? s.line.boardings : 0)}</td><td>${s.line ? fmt.format(s.line.peakLoad) : '–'}</td><td>${s.line ? fmt1.format(s.line.speed) : '–'}</td><td>${s.cab ? fmt.format(s.cab.rides) : '–'}</td><td>${s.cab ? fmt.format(s.cab.emptyShare * 100) + ' %' : '–'}</td><td>${fmt.format(s.carsRemoved)}</td><td>${fmt1.format(s.avgSpeed)}</td><td>+${fmt.format(s.congestion * 100)} %</td><td>${fmt1.format(s.co2Avoided)}</td></tr>`).join('');
    el.innerHTML = `<div class="table-wrap"><table><thead><tr><th>Scénario</th><th>Montées sur la ligne</th><th>Charge max. par heure</th><th>Vitesse de la ligne (km/h)</th><th>Passagers Cybercab</th><th>Km à vide</th><th>Trajets auto évités</th><th>Vitesse auto (km/h)</th><th>Temps perdu</th><th>CO₂ évité (t)</th></tr></thead><tbody>${rows}</tbody></table></div>
      <h3>Rentabilité, par année</h3>
      ${econChart()}
      <div class="table-wrap"><table><thead><tr><th>Scénario</th><th>Investissement</th><th>Recettes</th><th>Exploitation</th><th>Investissement étalé</th><th>Résultat de l'exploitant</th><th>Gain des voyageurs</th><th>Temps des automobilistes</th><th>CO₂ évité</th><th>Recettes perdues par le RTC</th><th>Bilan pour la société</th></tr></thead><tbody>${sim.history.map(econRow).join('')}</tbody></table></div>
      <p class="hint">Le bilan pour la société additionne le résultat de l'exploitant et les quatre colonnes qui le précèdent. Il change avec les curseurs « Hypothèses de coûts ».</p>`;
  }

  // ------------------------------------------------------------------ commandes
  function radio(groupId, attr, cb) {
    const group = $(groupId);
    group.addEventListener('click', (ev) => {
      const b = ev.target.closest('button'); if (!b || b.getAttribute('aria-checked') === 'true') return;
      group.querySelectorAll('button').forEach((x) => { x.setAttribute('aria-checked', String(x === b)); x.tabIndex = x === b ? 0 : -1; });
      cb(b.dataset[attr]);
    });
    // au clavier, les flèches passent d'un choix à l'autre, comme pour des boutons radio
    group.addEventListener('keydown', (ev) => {
      const step = ev.key === 'ArrowRight' || ev.key === 'ArrowDown' ? 1 : ev.key === 'ArrowLeft' || ev.key === 'ArrowUp' ? -1 : 0;
      if (!step) return;
      const all = [...group.querySelectorAll('button')], i = all.indexOf(document.activeElement);
      if (i < 0) return;
      ev.preventDefault();
      const next = all[(i + step + all.length) % all.length];
      next.focus(); next.click();
    });
  }

  function lineHint() {
    const k = sim.scenario.line;
    $('line-hint').textContent = k === 'tram' ? 'Rames de 240 places aux 4 minutes en pointe, tunnel sous la colline Parlementaire.'
      : k === 'bus' ? 'Bus articulés de 105 places aux 2 min 30 en pointe, en surface sur tout le trajet.'
      : k === 'cablane' ? 'La voie du tramway est réservée aux Cybercab : ils y roulent en convois coordonnés à 45 km/h, sans feux ni autos. Aucun autre véhicule n\'y circule.'
      : 'Situation de référence : aucune ligne structurante, les voies restent aux autos.';
  }

  function bindUi() {
    // Tout changement repart 90 minutes plus tôt, calculées d'un coup, pour que les rues et la ligne soient déjà en charge.
    const restart = (t, cfg) => {
      state.batch = null; // un changement de scénario interrompt un calcul de journées en cours
      Object.assign(sim.scenario, cfg || {});
      const from = Math.max(t - 5400, sim.tDayEnd - 86400); // sans remonter avant le début de la journée
      sim.reset(from); sim.step(t - from);
      writeHash();
    };
    // la voie réservée aux Cybercab va avec une flotte : choisir l'une règle l'autre
    radio('line-choice', 'line', (v) => { restart(sim.t, v === 'cablane' && sim.scenario.cab === 'off' ? { line: v, cab: 'corridor' } : { line: v }); syncControls(); lineHint(); });
    radio('cab-choice', 'cab', (v) => { restart(sim.t, v === 'off' && sim.scenario.line === 'cablane' ? { cab: v, line: 'none' } : { cab: v, fleet: +$('fleet').value }); syncControls(); lineHint(); });
    $('pool').addEventListener('change', (e) => restart(sim.t, { pool: e.target.checked }));
    $('carfree').addEventListener('input', (e) => { $('carfree-out').textContent = e.target.value + ' %'; });
    $('carfree').addEventListener('change', (e) => { if (+e.target.value / 100 !== sim.scenario.carFree) restart(sim.t, { carFree: +e.target.value / 100 }); });
    radio('speeds', 'speed', (v) => { state.speed = +v; });
    const fleet = $('fleet'), fare = $('fare');
    const outs = () => { $('fleet-out').textContent = fmt.format(+fleet.value); $('fare-out').textContent = fmt2.format(+fare.value) + ' $'; };
    fleet.addEventListener('input', outs); fare.addEventListener('input', outs);
    // un nouveau tarif repart d'une journée cohérente, comme un changement de flotte
    fare.addEventListener('change', () => { if (+fare.value !== sim.scenario.farePerKm) restart(sim.t, { farePerKm: +fare.value }); });
    fleet.addEventListener('change', () => { if (+fleet.value !== sim.scenario.fleet) restart(sim.t, { fleet: +fleet.value }); });
    syncControls(); lineHint(); writeHash();
    // coûts : la rentabilité se recalcule à partir des journées déjà simulées
    const costsChanged = () => { syncControls(); writeHash(); if ($('dlg-compare').open) renderCompare(); };
    for (const id in COSTS) $('c-' + id).addEventListener('input', (e) => { econSet(COSTS[id][0], +e.target.value * COSTS[id][1]); costsChanged(); });
    $('costs-reset').addEventListener('click', () => { for (const id in COSTS) econSet(COSTS[id][0], dig(TQ.ECON_DEFAULTS, COSTS[id][0])); costsChanged(); });
    $('share').addEventListener('click', async () => {
      writeHash();
      const b = $('share'), label = 'Copier le lien de ce scénario';
      try { await navigator.clipboard.writeText(location.href); b.textContent = 'Lien copié'; } catch (e) { b.textContent = 'Copiez l\u2019adresse dans la barre du navigateur'; }
      setTimeout(() => { b.textContent = label; }, 2500);
    });
    // journées complètes calculées d'un seul coup, depuis 5 h ; l'animation attend pendant ce temps
    const batchButtons = [['run-day', $('run-day').textContent], ['run-all', $('run-all').textContent]];
    const runBatch = (list) => {
      const batch = (state.batch = { queue: list.slice(), total: list.length });
      const done = () => {
        if (state.batch === batch) state.batch = null;
        batchButtons.forEach(([id, label]) => { $(id).disabled = false; $(id).textContent = label; });
        syncControls(); lineHint(); writeHash(); renderCompare();
      };
      const next = () => {
        if (state.batch !== batch) return done();
        if (!batch.queue.length) return done();
        Object.assign(sim.scenario, batch.queue.shift());
        sim.reset(TQ.PARAMS.dayStart);
        const n = sim.history.length, rank = batch.total - batch.queue.length;
        const chunk = () => {
          if (state.batch !== batch) return done();
          const t0 = performance.now();
          while (sim.history.length === n && performance.now() - t0 < 40) sim.step(10);
          if (sim.history.length > n) { renderCompare(); return next(); }
          const label = `Simulation en cours : ${batch.total > 1 ? `scénario ${rank} sur ${batch.total}, ` : ''}${TQ.formatClock(sim.t)}`;
          batchButtons.forEach(([id]) => { $(id).disabled = true; $(id).textContent = label; });
          setTimeout(chunk, 0);
        };
        chunk();
      };
      next();
    };
    $('run-day').addEventListener('click', () => runBatch([{}]));
    // quatre scénarios types, pour remplir la comparaison d'un clic
    // aux réglages de départ (tarif, saison), pour que les quatre lignes se comparent entre elles
    const base = { farePerKm: TQ.PARAMS.cab.farePerKm, winter: false, pool: false, carFree: 0 };
    $('run-all').addEventListener('click', () => runBatch([
      { line: 'tram', cab: 'off' }, { line: 'bus', cab: 'off' },
      { line: 'cablane', cab: 'corridor', fleet: 3000 }, { line: 'none', cab: 'wide', fleet: 1500 },
    ].map((c) => Object.assign({}, base, c))));
    // un lien collé dans l'onglet déjà ouvert remplace le scénario et les coûts
    window.addEventListener('hashchange', () => {
      const key = (c) => ['line', 'cab', 'fleet', 'farePerKm', 'winter', 'pool', 'carFree'].map((k) => c[k]).join('|');
      const before = key(sim.scenario), was3d = state.view3d;
      for (const id in COSTS) econSet(COSTS[id][0], dig(TQ.ECON_DEFAULTS, COSTS[id][0]));
      const sc = Object.assign({ fleet: 3000, farePerKm: TQ.PARAMS.cab.farePerKm, winter: false, pool: false, carFree: 0 }, readHash());
      if (key(sc) !== before) { state.batch = null; sim.scenario = sc; sim.reset(TQ.PARAMS.dayStart); }
      if (state.view3d !== was3d) setView3d(state.view3d);
      syncControls(); lineHint();
      if ($('dlg-compare').open) renderCompare();
    });
    $('winter').addEventListener('change', (e) => restart(sim.t, { winter: e.target.checked }));
    document.querySelectorAll('.starts button').forEach((b) => b.addEventListener('click', () => {
      const h = +b.dataset.start;
      if (h * 3600 <= TQ.PARAMS.dayStart) { state.batch = null; sim.reset(TQ.PARAMS.dayStart); } else restart(h * 3600);
    }));
    for (const k of ['cars', 'roads', 'zone']) $('ly-' + k).addEventListener('change', (e) => { state.layers[k] = e.target.checked; });
    $('play').addEventListener('click', () => { state.playing = !state.playing; $('play').textContent = state.playing ? '❚❚' : '▶'; $('play').setAttribute('aria-label', state.playing ? 'Mettre en pause' : 'Reprendre'); });
    $('assumptions').innerHTML = TQ.ASSUMPTIONS.map((s) => `<h3>${s.title}</h3><ul>${s.items.map((i) => `<li>${i}</li>`).join('')}</ul>`).join('');
    $('open-assumptions').addEventListener('click', () => $('dlg-assumptions').showModal());
    $('open-compare').addEventListener('click', () => { renderCompare(); $('dlg-compare').showModal(); });
    document.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); $('play').click(); } });
    // mot d'accueil à la première visite
    let seen = false;
    try { seen = localStorage.getItem('qem-accueil') === '1'; } catch (e) { /* stockage indisponible */ }
    $('open-welcome').addEventListener('click', () => $('dlg-welcome').showModal());
    $('dlg-welcome').addEventListener('close', () => { try { localStorage.setItem('qem-accueil', '1'); } catch (e) { /* stockage indisponible */ } });
    if (!seen && $('dlg-welcome').showModal) $('dlg-welcome').showModal();
  }
})();
