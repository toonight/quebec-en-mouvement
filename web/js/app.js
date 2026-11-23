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
  const signedMoney = (v) => (v > 0.5 ? '+' : '') + moneyText(v);
  const replacedTripsCO2 = 'CO₂ évité par les trajets auto remplacés';
  const scenarioKey = (c) => [c.line, c.cab, c.fleet, c.farePerKm, !!c.winter, !!c.pool, c.carFree || 0, !!c.auto, !!c.farePerOccupant].join('|');
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

  /** Un seul mode sur le tracé : rien (line none, cab off), tramway ou autobus (sans flotte), ou Cybercab
   *  (line none, flotte le long du tracé ou sur le réseau élargi, dans la circulation générale).
   *  Une ligne et une flotte ne roulent jamais ensemble : la ligne l'emporte. Le moteur refuse d'ailleurs le mélange
   *  (une erreur) : le lien, les choix de mode, restart() et runBatch passent par ici. */
  function exclusive(sc) {
    if (sc.line !== 'none') sc.cab = 'off';
    return sc;
  }

  /** Mode affiché dans le choix « Sur le tracé » : none, tram, bus ou cab. */
  const modeOf = (s) => (s.line === 'none' && s.cab !== 'off' ? 'cab' : s.line);

  /** Scénario et coûts lus dans l'adresse (#ligne=tram&cab=wide&flotte=3000...). Toute valeur hors bornes est ignorée. */
  function readHash() {
    const q = new URLSearchParams(location.hash.slice(1)), sc = { line: 'tram', cab: 'off', fleet: 3000 };
    const num = (k, lo, hi) => { const v = parseFloat(q.get(k)); return Number.isFinite(v) && v >= lo && v <= hi ? v : null; };
    if (['none', 'tram', 'bus'].includes(q.get('ligne'))) sc.line = q.get('ligne');
    if (['off', 'corridor', 'wide'].includes(q.get('cab'))) sc.cab = q.get('cab');
    // compatibilité : un ancien lien vers la voie réservée retirée devient le Cybercab sans voie
    if (q.get('ligne') === 'cablane') { sc.line = 'none'; if (sc.cab === 'off') sc.cab = 'corridor'; }
    // un lien sans « ligne » mais avec une flotte garde la flotte (sinon le tramway par défaut l'emporterait)
    if (!q.has('ligne') && sc.cab !== 'off') sc.line = 'none';
    const f = num('flotte', 200, 20000), p = num('tarif', 0.3, 2);
    if (f) sc.fleet = Math.round(f / 100) * 100;
    if (p) sc.farePerKm = Math.round(p * 10) / 10;
    if (q.get('hiver') === '1') sc.winter = true;
    if (q.get('auto') === '1') sc.auto = true;
    // « photo » : vue 3D avec les bâtiments réels ; la clé d'API, elle, ne figure jamais dans le lien
    state.view3d = q.get('vue') === '3d' || q.get('vue') === 'photo'; state.wantPhoto = q.get('vue') === 'photo';
    if (q.get('partage') === '1') sc.pool = true;
    const nc = num('sansauto', 0, 30);
    if (nc) sc.carFree = Math.round(nc) / 100;
    // un lien qui mêlerait une ligne et une flotte est ramené à un seul mode (celui de la ligne)
    exclusive(sc);
    for (const id in COSTS) {
      const el = $('c-' + id), v = num(id, +el.min, +el.max);
      if (v == null) continue;
      // alignée sur le pas du curseur, pour que la valeur appliquée soit celle qui s'affiche
      const st = +el.step, lo = +el.min;
      econSet(COSTS[id][0], +(lo + Math.round((v - lo) / st) * st).toFixed(2) * COSTS[id][1]);
    }
    return sc;
  }

  /** Légende des autos : un point pour quatre en plan, une maquette par auto en vue 3D. */
  function legendCars() {
    const a = sim && sim.scenario.auto;
    $('lg-car').textContent = state.view3d ? (a ? '1 véhicule = 1 auto autonome' : '1 véhicule = 1 automobile') : a ? '1 point = 4 autos autonomes' : '1 point = 4 automobiles';
  }

  function writeHash() {
    const s = sim.scenario, q = new URLSearchParams();
    q.set('ligne', s.line); q.set('cab', s.cab);
    if (s.cab !== 'off') { q.set('flotte', s.fleet); q.set('tarif', s.farePerKm); }
    if (s.winter) q.set('hiver', '1');
    if (s.auto) q.set('auto', '1');
    if (state.view3d) q.set('vue', state.photo ? 'photo' : '3d');
    if (s.cab !== 'off' && s.pool) q.set('partage', '1');
    if (s.cab !== 'off' && s.carFree > 0) q.set('sansauto', Math.round(s.carFree * 100));
    for (const id in COSTS) if (dig(TQ.ECON, COSTS[id][0]) !== dig(TQ.ECON_DEFAULTS, COSTS[id][0])) q.set(id, costValue(id));
    try { history.replaceState(null, '', '#' + q.toString()); } catch (e) { /* adresse non modifiable (aperçu local) */ }
  }

  /** Aligne les commandes sur le scénario et les coûts en vigueur. */
  function syncControls() {
    const s = sim.scenario;
    const check = (group, attr, v) => $(group).querySelectorAll('button').forEach((b) => { const on = b.dataset[attr] === String(v); b.setAttribute('aria-checked', String(on)); b.tabIndex = on ? 0 : -1; });
    check('line-choice', 'line', modeOf(s)); check('cab-choice', 'cab', s.cab); check('speeds', 'speed', state.speed);
    $('cab-options').hidden = s.cab === 'off';
    $('fleet').value = s.fleet; $('fare').value = s.farePerKm; $('winter').checked = !!s.winter; $('auto').checked = !!s.auto; $('auto-hint').hidden = !s.auto;
    // le parc autonome se voit sur la carte : bandeau, légende et couleur des autos
    $('auto-badge').hidden = !s.auto; document.body.classList.toggle('autos', !!s.auto); legendCars();
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
    state.ahead = { e: 0, p: 0, tt: 1, hops: 0 };
    state.posBuf = new Float32Array(2 * 40000); state.colBuf = new Uint8Array(4 * 40000);
    state.cabPos = new Float32Array(2 * 12000); state.cabCol = new Uint8Array(4 * 12000);
    // noms affichés sur la carte : terminus et pôles d'échanges
    state.labels = stationData.filter((s, i) => s.hub || i === 0 || i === stationData.length - 1);
    state.labelChars = [...new Set(state.labels.map((s) => s.name).join(''))];
    state.allChars = [...new Set(stationData.map((s) => s.name).join(''))];
    state.twoWay = roadData.filter((r) => r.two);
    // marquages posés quelques centimètres au-dessus de l'asphalte, pour une superposition nette
    for (const r of roadData) { r.path3 = r.path.map((c) => [c[0], c[1], 0.06]); const c = net.ecls[r.edges[0]]; r.fast = c === 0 || c === 1 || c === 5; }
    state.streets = roadData.filter((r) => !r.fast);
    for (const part of lineParts) { part.path3 = part.path.map((c) => [c[0], c[1], 0.12]); part.path4 = part.path.map((c) => [c[0], c[1], 0.17]); }
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
    // les arbres des parcs et des boisés sont replantés quand la vue s'arrête de bouger
    map.on('idle', () => { if (state.view3d) plantTrees(); });
    if (state.view3d) { pace3d(true); document.body.classList.add('v3d'); $('view3d').setAttribute('aria-pressed', 'true'); $('view3d').textContent = 'Vue en plan'; map.jumpTo({ pitch: 62, bearing: -24, zoom: 16.9, center: sim.stationLL[stationData.findIndex((d) => d.name === 'Saint-Roch')] || [-71.2265, 46.8135] }); }
    initPhoto();
    if (state.view3d && state.wantPhoto) setPhoto(true);
    // en vue 3D, les icônes et libellés de commerces du fond de carte encombrent la scène
    map.on('styledata', () => {
      if (!state.view3d || state.styled3d === map.getStyle().name + map.getStyle().layers.length) return;
      state.styled3d = map.getStyle().name + map.getStyle().layers.length;
      try {
        dress3d();
        state.labelLayer = state.labelLayer3d;
        if (map.setSky) map.setSky({ 'sky-color': '#8ec5ee', 'horizon-color': '#e4eef5', 'fog-color': '#eef3f6', 'sky-horizon-blend': 0.7, 'horizon-fog-blend': 0.6, 'fog-ground-blend': 0.75 });
        map.setLight({ anchor: 'map', position: [1.4, 215, 42], intensity: 0.45, color: '#fff6e4' });
      } catch (e) { console.warn('Habillage 3D partiel', e.message); }
    });
  }

  /**
   * Habillage du fond de carte en vue 3D : toutes les rues deviennent de l'asphalte bordé de trottoirs, à leur
   * largeur réelle en mètres ; pelouses, parcs et eau prennent des teintes franches ; les bâtiments varient.
   */
  function dress3d() {
    const mpp = (z) => 53575 / Math.pow(2, z); // mètres par pixel à la latitude de Québec (tuiles de 512 px)
    const meters = (m) => ['interpolate', ['exponential', 2], ['zoom'], 12, Math.max(0.5, m / mpp(12)), 15, m / mpp(15), 20, m / mpp(20)];
    const set = (id, k, v) => { try { map.setPaintProperty(id, k, v); } catch (e) { /* propriété absente de ce calque */ } };
    const hide = (id) => map.setLayoutProperty(id, 'visibility', 'none');
    // largeur de chaussée (m) et largeur des deux trottoirs ou accotements (m) par famille de rue
    const ROADS = [[/motorway_link/, 6, 1.6, 1], [/motorway/, 11.5, 2.4, 1], [/trunk_primary/, 14, 5.2, 0], [/secondary_tertiary/, 10.5, 5, 0], [/service_track/, 4.2, 0.6, 1], [/link/, 6.5, 1.6, 1], [/minor|street/, 7.5, 4.6, 0]];
    const FILLS = { background: '#b3bf9a', landuse_residential: '#a8bb8b', park: '#7fb069', landcover_wood: '#5f9a55', landcover_grass: '#8fbf6f', landuse_pitch: '#6dab62', landuse_track: '#b98a6a', landuse_cemetery: '#9db888', landuse_hospital: '#c6c2b0', landuse_school: '#c6c2b0', water: '#4f8fc0', landcover_sand: '#dfd2a6', building: '#a8a296', road_area_pattern: '#c2bfb4', aeroway_fill: '#b9b7ae' };
    for (const l of map.getStyle().layers) {
      const id = l.id;
      if (l.type === 'symbol') {
        if (/poi|housenumber|shield|one_way|highway-name/.test(id)) hide(id); else if (!state.labelLayer3d) state.labelLayer3d = id;
        continue;
      }
      if (l.type === 'background') { set(id, 'background-color', FILLS.background); continue; }
      if (l.type === 'fill' && FILLS[id]) { if (id === 'road_area_pattern') set(id, 'fill-pattern', undefined); set(id, 'fill-color', FILLS[id]); set(id, 'fill-opacity', 1); set(id, 'fill-outline-color', FILLS[id]); continue; }
      if (l.type === 'line' && /^waterway/.test(id)) { set(id, 'line-color', FILLS.water); continue; }
      if (l.type === 'line' && /park_outline|boundary/.test(id)) { hide(id); continue; }
      if (l.type === 'line' && /^(road|bridge|tunnel)_/.test(id)) {
        if (/^tunnel_|hatching/.test(id)) { hide(id); continue; }
        if (/rail/.test(id)) { set(id, 'line-color', '#5f5b55'); set(id, 'line-width', meters(1.8)); set(id, 'line-dasharray', undefined); continue; }
        if (/path_pedestrian/.test(id)) { set(id, 'line-color', /casing/.test(id) ? '#b4b1a6' : '#d6d0c0'); set(id, 'line-width', meters(/casing/.test(id) ? 2.8 : 2.2)); set(id, 'line-dasharray', undefined); continue; }
        const fam = ROADS.find((r) => r[0].test(id));
        if (!fam) continue;
        const casing = /casing/.test(id);
        set(id, 'line-color', !casing ? '#484c52' : fam[3] ? '#6c7076' : '#bcbab2');
        set(id, 'line-width', meters(casing ? fam[1] + fam[2] : fam[1]));
        set(id, 'line-opacity', 1); set(id, 'line-dasharray', undefined); set(id, 'line-gap-width', 0);
        continue;
      }
      if (l.type === 'fill-extrusion') {
        // façades : brique, pierre grise et crépi des quartiers ; verre bleuté pour les tours
        const h = ['coalesce', ['get', 'render_height'], 6];
        set(id, 'fill-extrusion-color', ['case', ['>', h, 60], '#8fa9c2', ['>', h, 32], '#aab7c2',
          ['match', ['%', ['round', ['*', h, 13]], 6], 0, '#a8705a', 1, '#cbbda3', 2, '#d6d1c6', 3, '#9f978c', 4, '#b99c84', '#ddd5c4']]);
        set(id, 'fill-extrusion-opacity', 1);
      }
    }
    state.labelLayer = state.labelLayer3d;
  }

  function tooltip({ object, layer }) {
    if (!object || !layer) return null;
    if (layer.id === 'stations' || layer.id === 'stations3d') {
      const waiting = sim.line ? sim.line.waitingAt(object.i) : 0;
      const kind = object.hub ? 'Pôle d\'échanges' : object.underground && sim.scenario.line !== 'bus' ? 'Station souterraine' : 'Station';
      return { html: `<b>${esc(object.name)}</b><br>${kind}${sim.line ? `<br>${fmt.format(waiting)} personnes en attente<br>${fmt.format(sim.line.stationBoard[object.i])} montées depuis le départ` : ''}` };
    }
    if (layer.id === 'line-veh' || layer.id === 'line-veh3d') {
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
  // parc entièrement autonome : une flotte homogène, aux teintes d'un seul constructeur (blanc surtout, gris, noir, bleu, rouge)
  const AUTO_PAINT = [[240, 242, 244], [240, 242, 244], [240, 242, 244], [92, 98, 106], [22, 24, 28], [30, 62, 128], [166, 30, 36], [198, 202, 206]];
  const tmp4 = [0, 0, 0, 0];

  /** En vue 3D la journée défile en temps réel : à ×120, une auto franchirait plusieurs rues entre deux images. */
  function pace3d(on) {
    if (on) { if (state.speed === 0 || state.speed > 30) { state.speedBefore = state.speed; state.speed = 1; } }
    else if (state.speedBefore != null) { state.speed = state.speedBefore; state.speedBefore = null; }
    document.querySelectorAll('#speeds [data-speed]').forEach((b) => { const sel = +b.dataset.speed === state.speed; b.setAttribute('aria-checked', String(sel)); b.tabIndex = sel ? 0 : -1; });
  }

  function setView3d(on, instant) {
    state.view3d = on;
    pace3d(on); legendCars();
    if (!on) setPhoto(false);
    document.body.classList.toggle('v3d', on);
    $('view3d').setAttribute('aria-pressed', String(on));
    $('view3d').textContent = on ? 'Vue en plan' : 'Vue 3D';
    map.setStyle(on ? STYLE_3D : STYLE_2D, { diff: false }); // deux fonds sans rien de commun : inutile de les comparer
    const cam = on ? { pitch: 62, bearing: -24, zoom: Math.max(map.getZoom(), 16.9) } : { pitch: 0, bearing: 0, zoom: Math.min(map.getZoom(), 12.6) };
    if (instant) map.jumpTo(cam); else map.easeTo(Object.assign(cam, { duration: 1400 }));
  }

  // ------------------------------------------------------------------ bâtiments réels (photogrammétrie)
  // Tuiles 3D photoréalistes de Google : la ville telle qu'elle a été photographiée. Il faut une clé d'API au nom de
  // la personne qui consulte ; elle reste dans son navigateur et n'est envoyée qu'à Google, dans un en-tête.
  const PHOTO_URL = 'https://tile.googleapis.com/v1/3dtiles/root.json', PHOTO_HOST = 'https://tile.googleapis.com/', PHOTO_STORE = 'qem-cle-google';
  const photoKey = () => { try { return localStorage.getItem(PHOTO_STORE) || ''; } catch (e) { return ''; } };
  const photoReady = () => !!(deck.Tile3DLayer && deck._TerrainExtension && deck.SimpleMeshLayer);
  const photoFetch = (url, opt) => {
    if (!String(url).startsWith(PHOTO_HOST)) return fetch(url, opt);
    const run = state.photoRun;
    return fetch(url, Object.assign({}, opt, { headers: Object.assign({}, opt && opt.headers, { 'X-GOOG-API-KEY': photoKey() }) })).then((r) => {
      // clé refusée, API non activée ou quota atteint : on revient à la ville modélisée et on l'explique
      const refus = r.status === 400 || r.status === 401 || r.status === 403 || r.status === 429;
      // avant le premier affichage, tout échec (panne de Google, portail captif) ramène à la ville modélisée ;
      // une fois la ville affichée, un quota dépassé un instant sur une tuile ne coupe pas le mode
      if (!r.ok && (refus || !state.photoSeen) && !(r.status === 429 && state.photoSeen) && state.photo && run === state.photoRun) {
        // un refus isolé après chargement vient le plus souvent d'une session expirée : on en redemande une, une seule fois
        const renew = (r.status === 400 || r.status === 403) && state.photoSeen && performance.now() - (state.photoRenewAt || -1e9) > 120000;
        // la raison précise du refus est dans la réponse de Google : on la lit sur une copie, sans toucher à l'originale
        const why = renew ? Promise.resolve(null) : r.clone().json().then((j) => (j && j.error) || null, () => null);
        why.then((err) => { if (!state.photo || run !== state.photoRun) return; if (!renew) { photoFail(refus ? r.status : 0, err); return; }
          // la caméra garde sa visée : sans cela, elle plongerait puis bondirait pendant le rechargement
          const z = map.transform.elevation || 0, at = state.photoAt, g = state.photoG;
          state.photoRenewAt = performance.now(); setPhoto(false); setPhoto(true);
          if (state.photo) { if (map.transform.setElevation) map.transform.setElevation(z); state.photoAt = at; state.photoG = g; state.photoHit = performance.now(); map.triggerRepaint(); }
        });
      }
      return r;
    }, (e) => { if (state.photo && run === state.photoRun && !state.photoSeen) setTimeout(() => photoFail(0), 0); throw e; });
  };
  const PHOTO_LOAD = { fetch: photoFetch };

  /** Cause d'un refus, d'après la réponse de Google ('' si elle n'est pas reconnue). */
  function photoWhy(err) {
    if (!err) return '';
    const text = typeof err.message === 'string' ? err.message : '';
    const reasons = (Array.isArray(err.details) ? err.details : []).map((d) => (d && typeof d.reason === 'string' ? d.reason : '')).join(' ');
    const all = reasons + ' ' + text;
    if (/BILLING/i.test(all)) return 'La facturation n\'est pas activée sur le projet Google Cloud de cette clé : activez-la dans la console, puis réessayez.';
    if (/SERVICE_DISABLED|has not been used|is disabled/i.test(all)) return '« Map Tiles API » n\'est pas activée dans le projet Google Cloud de cette clé : activez-la dans « API et services », attendez une minute, puis réessayez.';
    if (/API_KEY_SERVICE_BLOCKED/i.test(all)) return 'Les restrictions d\'API de cette clé n\'autorisent pas « Map Tiles API » : ajoutez-la dans les restrictions de la clé.';
    if (/REFERRER_BLOCKED|referer|referrer/i.test(all)) {
      return /^https?:$/.test(location.protocol) && location.origin !== 'null'
        ? 'Les restrictions de site de cette clé n\'autorisent pas ' + location.origin + ' : ajoutez ' + location.origin + '/* aux sites autorisés.'
        : 'Cette clé est restreinte à des sites web : elle ne fonctionne pas depuis un fichier local ou un aperçu. Servez la page en http(s) et autorisez cette adresse, ou utilisez une clé sans restriction de site.';
    }
    if (/IP_ADDRESS_BLOCKED|ANDROID_APP_BLOCKED|IOS_APP_BLOCKED/i.test(all)) return 'Cette clé est restreinte à un autre type d\'application : choisissez la restriction « Sites web » (ou aucune) dans la console.';
    if (/API_KEY_INVALID|API key not valid/i.test(all)) return 'Google ne reconnaît pas cette clé : recopiez-la en entier depuis « Identifiants » dans la console.';
    return '';
  }

  function photoFail(status, err) {
    if (!state.photo) return;
    setPhoto(false); writeHash();
    const raw = err && typeof err.message === 'string' && err.message ? ' Réponse de Google : « ' + err.message.slice(0, 300) + ' »' : '';
    const msg = status === 429 ? 'Google signale que le quota de la clé est atteint. Réessayez plus tard ou vérifiez le quota dans la console Google Cloud.'
      : status ? (photoWhy(err) || 'Google a refusé la clé (erreur ' + status + '). Vérifiez qu\'elle est exacte, que « Map Tiles API » est activée et que ses restrictions autorisent ce site.') + raw
      : 'Les tuiles de Google sont injoignables (connexion, panne ou bloqueur de contenu). La ville modélisée reste affichée.';
    // une saisie en cours (« Changer la clé ») n'est pas effacée
    const dlg = $('dlg-photo');
    if (!dlg.open) { $('photo-key').value = ''; if (dlg.showModal) dlg.showModal(); }
    const again = photoKey() ? ' Pour réessayer avec la clé enregistrée, laissez le champ vide et validez.' : '';
    $('photo-msg').textContent = ''; $('photo-msg').textContent = msg + again; // écrit une fois le dialogue ouvert, pour être annoncé
  }

  function photoLayer() {
    return new deck.Tile3DLayer({
      id: 'google-3d', data: PHOTO_URL, loadOptions: PHOTO_LOAD, operation: 'terrain+draw',
      pickable: true, // pour lire l'altitude du relief sous le centre de l'écran (voir photoProbe)
      onTilesetLoad: (tileset) => {
        state.photoSeen = true;
        // Le plafond d'origine (32 Mo) est bien trop bas pour une ville photographiée : les tuiles affichées seraient
        // purgées en continu. Les tuiles qui ne font que renvoyer à un sous-arbre ne pèsent rien et ne se rechargent
        // pas une fois purgées (le quartier resterait flou) : on les garde toujours.
        // (plus bas sur téléphone et tablette, qui n'annoncent pas toujours leur mémoire)
        const mem = navigator.deviceMemory, touch = !!(window.matchMedia && matchMedia('(pointer: coarse)').matches);
        const cap = touch ? (mem >= 8 ? 512 : 256) : (mem || 8) >= 8 ? 1024 : 512;
        tileset.maximumMemoryUsage = cap; tileset.options.maximumMemoryUsage = cap;
        const cache = tileset._cache;
        if (cache && cache.unloadTile && !cache.keepsTrees) {
          const unload = cache.unloadTile.bind(cache);
          // sans « done », c'est une destruction de tuile et non une purge : elle suit son cours
          cache.unloadTile = (ts, tile, done) => { if (!done || !tile.hasTilesetContent) unload(ts, tile, done); };
          cache.keepsTrees = true;
        }
        // Défaut du parcours d'origine : une tuile vide (rien à charger) qu'il est inutile d'affiner est comptée comme
        // « pas encore chargée ». Sa voisine ne s'affine alors jamais et le quartier reste flou. On la compte chargée.
        const trav = tileset._traverser;
        if (trav && trav.executeEmptyTraversal && trav._emptyTraversalStack && !trav.skipsEmpty) {
          trav.executeEmptyTraversal = function (root, frameState) {
            let all = true;
            const stack = this._emptyTraversalStack;
            stack.push(root);
            while (stack.length > 0) {
              const t = stack.pop();
              const go = !t.hasRenderContent && this.canTraverse(t, frameState), leaf = !t.hasRenderContent && t.children.length === 0;
              if (!go && !t.contentAvailable && !leaf && !t.hasEmptyContent) all = false;
              this.updateTile(t, frameState);
              if (!t.isVisibleAndInRequestVolume) { this.loadTile(t, frameState); this.touchTile(t, frameState); }
              if (go) for (const child of t.children) stack.push(child);
            }
            return root.hasEmptyContent || all;
          };
          trav.skipsEmpty = true;
        }
        // mention des sources exigée par Google : celles des tuiles affichées
        tileset.options.onTraversalComplete = (tiles) => {
          const seen = new Set();
          for (const t of tiles) { const c = t.content && t.content.gltf && t.content.gltf.asset && t.content.gltf.asset.copyright; if (c) for (const part of String(c).split(';')) if (part.trim()) seen.add(part.trim()); }
          const txt = [...seen].join(' · ');
          if (txt !== state.photoCredits) { state.photoCredits = txt; $('photo-src').textContent = txt; }
          const est = photoGround(tiles);
          state.photoBest = est; state.photoDirty = performance.now();
          return tiles;
        };
      },
    });
  }

  /** Active ou coupe les bâtiments réels. Sans clé, sans vue 3D ou sans le moteur nécessaire, le mode reste coupé. */
  /**
   * Point bas de la tuile fine qui couvre le centre de la carte (null s'il n'y en a pas) : le niveau du sol,
   * immeubles exclus. Chaque tuile est une boîte orientée.
   */
  function photoGround(tiles) {
    const c = map.getCenter(), la = (c.lat * Math.PI) / 180, lo = (c.lng * Math.PI) / 180;
    const up = [Math.cos(la) * Math.cos(lo), Math.cos(la) * Math.sin(lo), Math.sin(la)];
    const E2 = 0.00669437999014, N = 6378137 / Math.sqrt(1 - E2 * up[2] * up[2]);
    const p0 = [N * up[0], N * up[1], N * (1 - E2) * up[2]]; // le centre de la carte, au niveau de l'ellipsoïde
    let best = null, bestSize = 3 * 300 * 300; // tuiles de moins de 600 m de côté environ
    for (const t of tiles) {
      const bv = t.boundingVolume, org = t.content && t.content.cartographicOrigin;
      if (!bv || !bv.halfAxes || !bv.center || !org || !Number.isFinite(org[2])) continue;
      const h = org[2], ax = bv.halfAxes, ctr = bv.center;
      const dx = p0[0] + up[0] * h - ctr[0], dy = p0[1] + up[1] * h - ctr[1], dz = p0[2] + up[2] * h - ctr[2];
      let inside = true, hz = 0, size = 0;
      for (let i = 0; i < 3; i++) {
        const a0 = ax[3 * i], a1 = ax[3 * i + 1], a2 = ax[3 * i + 2], l2 = a0 * a0 + a1 * a1 + a2 * a2;
        if (Math.abs(dx * a0 + dy * a1 + dz * a2) > l2) inside = false;
        hz += Math.abs(a0 * up[0] + a1 * up[1] + a2 * up[2]); size += l2;
      }
      if (inside && size < bestSize) { bestSize = size; best = h - hz; }
    }
    return best != null && best > -80 && best < 400 ? best : null;
  }

  // Altitude visée après un grand saut : au-dessus de tout le relief de la région, d'où l'on voit forcément le sol.
  const PHOTO_SAFE = 160;

  /**
   * La caméra vise le sol réel : sans cela, elle passerait sous le relief en haute-ville (le sol y est une centaine
   * de mètres plus haut qu'en basse-ville). On lit l'altitude du relief autour du centre de l'écran, plusieurs fois
   * par seconde, et la visée la suit en douceur.
   */
  function photoProbe() {
    if (!state.photo || !overlay || !overlay._deck || document.hidden) return;
    const now = performance.now(), tick = (state.photoTick = (state.photoTick || 0) + 1);
    // rien ne bouge et rien ne se charge : un contrôle par seconde suffit
    if (!map.isMoving() && now - (state.photoDirty || 0) > 2000 && tick % 5) return;
    const tr = map.transform, w = tr.width, h = tr.height, c = map.getCenter(), at = state.photoAt;
    // un grand saut (lien, clic sur une station éloignée) : on repart d'en haut plutôt que de risquer d'arriver sous le sol
    if (!at || Math.hypot((c.lng - at[0]) * TQ.geo.KX, (c.lat - at[1]) * TQ.geo.KY) > 400) { photoElev(PHOTO_SAFE, !at || !map.isMoving()); state.photoHit = now; } // d'un coup seulement pour un vrai saut
    state.photoAt = [c.lng, c.lat];
    const mpp = (40075016.686 * Math.cos((c.lat * Math.PI) / 180)) / (512 * Math.pow(2, map.getZoom()));
    const camAlt = (tr.elevation || 0) + 1.5 * h * mpp * Math.cos((map.getPitch() * Math.PI) / 180);
    let low = Infinity, near = Infinity, nearZ = NaN;
    for (const [fx, fy] of [[0, 0], [-0.12, 0], [0.12, 0], [0, -0.12], [0, 0.12]]) {
      let info = null;
      try { info = overlay._deck.pickObject({ x: w * (0.5 + fx), y: h * (0.5 + fy), unproject3D: true, layerIds: ['google-3d'] }); } catch (err) { /* calque pas encore prêt */ }
      const p = info && info.coordinate, z = p ? p[2] : NaN;
      // un point plus haut que la caméra n'est pas le sol qu'elle survole
      if (!(Number.isFinite(z) && z > -80 && z < camAlt - 3)) continue;
      // seul le relief proche du centre compte : un point lu au loin (le pied du coteau) ferait osciller la visée
      const d = Math.hypot((p[0] - c.lng) * TQ.geo.KX, (p[1] - c.lat) * TQ.geo.KY);
      if (d <= 40) low = Math.min(low, z);
      if (d < near) { near = d; nearZ = z; }
    }
    if (low === Infinity && Number.isFinite(nearZ)) low = nearZ; // visée encore trop haute ou trop basse : le point le plus proche guide
    if (low === Infinity) { if (now - (state.photoHit || 0) > 1200) photoElev(PHOTO_SAFE); return; } // rien en vue : on prend de la hauteur
    state.photoHit = now;
    // le point bas de la tuile sous le centre évite de monter sur les toits ; le relief lu à l'écran le borne
    const b = state.photoBest, g = b == null ? low : Math.min(low, Math.max(b, low - 30));
    if (state.photoG == null || Math.abs(g - state.photoG) > 2.5) photoElev(g);
  }

  /** Réglage de l'altitude visée : progressif, ou immédiat après un saut. */
  function photoElev(target, now) {
    const set = (z) => { const tr = map.transform; if (tr.setElevation) tr.setElevation(z); else map.jumpTo({ elevation: z }); map.triggerRepaint(); };
    state.photoG = target;
    if (now) { set(target); return; }
    if (state.photoRaf) return;
    const step = () => {
      state.photoRaf = 0;
      if (!state.photo) return;
      const cur = map.transform.elevation || 0, d = state.photoG - cur;
      if (Math.abs(d) < 0.3) return;
      set(Math.abs(d) < 1 ? state.photoG : cur + d * 0.14);
      state.photoRaf = requestAnimationFrame(step);
    };
    state.photoRaf = requestAnimationFrame(step);
  }

  function setPhoto(on) {
    on = !!on && state.view3d && !!photoKey() && photoReady();
    if (on !== !!state.photo) {
      // Le calque ne suit l'altitude visée par la carte que si celle-ci annonce un relief : on l'annonce le temps du mode.
      if (!state.terrain0) state.terrain0 = map.getTerrain;
      map.getTerrain = on ? () => state.terrain0.call(map) || { source: 'google-3d' } : state.terrain0;
      if (map.setCenterClampedToGround) map.setCenterClampedToGround(!on);
      if (!on && map.transform.setElevation) { map.transform.setElevation(0); map.triggerRepaint(); }
      state.photo = on; state.photoRun = (state.photoRun || 0) + 1; state.photoSeen = false; state.photoCredits = '';
      state.photoAt = null; state.photoG = null; state.photoBest = null; state.photoHit = 0;
      clearInterval(state.photoTimer); state.photoTimer = on ? setInterval(photoProbe, 200) : 0;
      // rien d'affiché après 20 s (réponse illisible d'un proxy, panne) : on n'attend pas indéfiniment devant une ville vide
      clearTimeout(state.photoGuard); const run = state.photoRun;
      state.photoGuard = on ? setTimeout(() => { if (state.photo && run === state.photoRun && !state.photoSeen) photoFail(0); }, 20000) : 0;
      // la ville photographiée a son propre relief : elle est dessinée par-dessus la carte, avec sa propre profondeur
      // le calque de la ville photographiée a son propre contexte graphique : on le libère en le quittant
      // (jamais celui du calque ordinaire, qui est le contexte de la carte elle-même)
      const dev = !on && overlay._deck ? overlay._deck.device : null;
      map.removeControl(overlay);
      try { if (dev && dev.loseDevice) dev.loseDevice(); } catch (err) { /* contexte déjà perdu */ }
      // Les hauteurs de Google sont mesurées depuis l'ellipsoïde : en basse-ville, le sol réel passe sous le plan de la
      // carte. On voit donc plus loin que prévu, sinon le fond de la vue serait coupé.
      const far = on && deck.MapView ? { views: new deck.MapView({ id: 'mapbox', farZMultiplier: 4 }) } : {};
      overlay = new deck.MapboxOverlay(Object.assign({ interleaved: !on, layers: [], getTooltip: tooltip }, far));
      map.addControl(overlay);
      map.setMaxZoom(on ? 17.6 : 18.5); // de plus près, la caméra entrerait dans les immeubles de la haute-ville
    }
    document.body.classList.toggle('photo', on);
    $('photo').setAttribute('aria-pressed', String(on));
    $('photo-credits').hidden = !on; $('photo-src').textContent = state.photoCredits || '';
  }

  function initPhoto() {
    const dlg = $('dlg-photo'), open = () => { $('photo-msg').textContent = photoKey() ? 'Une clé est déjà enregistrée dans ce navigateur.' : ''; $('photo-key').value = ''; dlg.showModal(); };
    if (!photoReady()) { $('photo').hidden = true; return; }
    // « Changer la clé » disparaît avec le mode : le focus revient alors au bouton toujours visible
    dlg.addEventListener('close', () => { if ($('photo-credits').hidden && state.view3d) $('photo').focus(); });
    $('photo').addEventListener('click', () => {
      if (state.photo) setPhoto(false); else if (photoKey()) setPhoto(true); else { open(); return; }
      writeHash();
    });
    $('photo-edit').addEventListener('click', open);
    $('photo-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const k = $('photo-key').value.trim();
      // champ vide, clé déjà enregistrée, mode éteint : c'est un nouvel essai
      if (!k && photoKey() && !state.photo) { dlg.close(); setPhoto(true); writeHash(); return; }
      if (!/^[A-Za-z0-9_-]{20,}$/.test(k)) { $('photo-msg').textContent = k ? 'Cette clé n\'a pas la forme attendue (une suite de lettres, chiffres, tirets, sans espace).' : 'Collez votre clé dans le champ.'; return; }
      try { localStorage.setItem(PHOTO_STORE, k); } catch (err) { $('photo-msg').textContent = 'Ce navigateur refuse d\'enregistrer la clé (stockage local désactivé).'; return; }
      $('photo-key').value = ''; dlg.close();
      if (state.photo) { setPhoto(false); } // nouvelle clé : on recharge les tuiles
      setPhoto(true); writeHash();
    });
    $('photo-clear').addEventListener('click', () => {
      try { localStorage.removeItem(PHOTO_STORE); } catch (err) { /* stockage indisponible */ }
      setPhoto(false); writeHash();
      $('photo-key').value = ''; $('photo-msg').textContent = 'Clé effacée de ce navigateur.';
    });
  }

  // ------------------------------------------------------------------ arbres
  /** Surface de révolution autour de l'axe vertical : profil [rayon, hauteur] du bas vers le haut. */
  const lathe = (profile, n) => {
    const pos = [], nor = [];
    for (let i = 0; i < profile.length - 1; i++) {
      const [r0, z0] = profile[i], [r1, z1] = profile[i + 1], dz = z1 - z0, dr = r1 - r0, l = Math.hypot(dz, dr) || 1;
      for (let j = 0; j < n; j++) {
        const a = (j / n) * 2 * Math.PI, b = ((j + 1) / n) * 2 * Math.PI, m = (a + b) / 2;
        const A = [r0 * Math.cos(a), r0 * Math.sin(a), z0], B = [r0 * Math.cos(b), r0 * Math.sin(b), z0], C = [r1 * Math.cos(b), r1 * Math.sin(b), z1], D = [r1 * Math.cos(a), r1 * Math.sin(a), z1];
        const nn = [(dz / l) * Math.cos(m), (dz / l) * Math.sin(m), -dr / l]; // facettes franches, comme un arbre de maquette
        for (const v of [A, B, C, A, C, D]) { pos.push(...v); nor.push(...nn); }
      }
    }
    return { attributes: { positions: { value: new Float32Array(pos), size: 3 }, normals: { value: new Float32Array(nor), size: 3 }, texCoords: { value: new Float32Array((pos.length / 3) * 2), size: 2 } } };
  };
  const TREE = {
    crown: lathe([[0, 0], [0.34, 0.12], [0.5, 0.42], [0.42, 0.74], [0.2, 0.94], [0, 1]], 7),
    fir: lathe([[0, 0], [0.5, 0.02], [0.3, 0.4], [0.36, 0.42], [0.16, 0.74], [0.2, 0.76], [0, 1]], 7),
    trunk: lathe([[0.5, 0], [0.4, 1]], 5),
  };
  const GREENS = [[70, 128, 62], [88, 146, 70], [60, 112, 58], [104, 152, 76], [78, 136, 84]];
  const inRing = (x, y, ring) => { let c = false; for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) { const a = ring[i], b = ring[j]; if ((a[1] > y) !== (b[1] > y) && x < ((b[0] - a[0]) * (y - a[1])) / (b[1] - a[1]) + a[0]) c = !c; } return c; };
  const inPoly = (x, y, rings) => { let c = false; for (const r of rings) if (inRing(x, y, r)) c = !c; return c; };
  const polysOf = (f) => (f.geometry.type === 'Polygon' ? [f.geometry.coordinates] : f.geometry.type === 'MultiPolygon' ? f.geometry.coordinates : []);
  const boxOf = (rings) => { let x0 = 180, y0 = 90, x1 = -180, y1 = -90; for (const c of rings[0]) { if (c[0] < x0) x0 = c[0]; if (c[0] > x1) x1 = c[0]; if (c[1] < y0) y0 = c[1]; if (c[1] > y1) y1 = c[1]; } return [x0, y0, x1, y1]; };

  /**
   * Plante les arbres visibles : serrés dans les boisés, clairsemés dans les parcs, d'après les polygones du fond de
   * carte. La grille est fixe sur le territoire : un arbre ne change pas de place quand la vue bouge.
   */
  function plantTrees() {
    const zoom = map.getZoom(), bb = map.getBounds(), ctr = map.getCenter();
    // zone plantée : un rectangle fixe autour du centre de la vue (arrondi), replanté seulement quand la vue s'éloigne
    const cx = Math.round(ctr.lng / 0.004) * 0.004, cy = Math.round(ctr.lat / 0.003) * 0.003;
    const key = [zoom < 15.3 ? 0 : 1, cx.toFixed(3), cy.toFixed(3), map.areTilesLoaded() ? 1 : 0].join('|');
    if (state.treeKey === key) return;
    state.treeKey = key;
    if (zoom < 15.3 || !map.getSource('openmaptiles')) { state.trees = []; return; }
    const W = Math.max(bb.getWest(), cx - 0.022), S = Math.max(bb.getSouth(), cy - 0.015), E = Math.min(bb.getEast(), cx + 0.022), N = Math.min(bb.getNorth(), cy + 0.015), KX = TQ.geo.KX, KY = TQ.geo.KY;
    const q = (layer) => { try { return map.querySourceFeatures('openmaptiles', { sourceLayer: layer }); } catch (e) { return []; } };
    // ni dans l'eau, ni dans un bâtiment : obstacles rangés dans une grille d'environ 80 m pour ne tester que les voisins
    const CELL = 0.001, grid = new Map(), cellOf = (x, y) => Math.floor(x / CELL) * 100000 + Math.floor(y / CELL);
    for (const layer of ['water', 'building']) for (const f of q(layer)) for (const rings of polysOf(f)) {
      const b = boxOf(rings);
      if (b[2] < W || b[0] > E || b[3] < S || b[1] > N) continue;
      const item = [b, rings];
      for (let gx = Math.floor(Math.max(b[0], W) / CELL); gx <= Math.floor(Math.min(b[2], E) / CELL); gx++) for (let gy = Math.floor(Math.max(b[1], S) / CELL); gy <= Math.floor(Math.min(b[3], N) / CELL); gy++) {
        const k = gx * 100000 + gy; let cell = grid.get(k);
        if (!cell) grid.set(k, (cell = []));
        cell.push(item);
      }
    }
    const trees = [], seen = new Set();
    const plant = (rings, step, wood) => {
      const b = boxOf(rings), x0 = Math.max(b[0], W), x1 = Math.min(b[2], E), y0 = Math.max(b[1], S), y1 = Math.min(b[3], N);
      if (x0 > x1 || y0 > y1) return;
      const dx = step / KX, dy = step / KY;
      for (let ix = Math.floor(x0 / dx); ix <= Math.ceil(x1 / dx) && trees.length < 7000; ix++) for (let iy = Math.floor(y0 / dy); iy <= Math.ceil(y1 / dy); iy++) {
        const h = (Math.imul(ix, 73856093) ^ Math.imul(iy, 19349663)) >>> 0, h2 = Math.imul(h, 2654435761) >>> 0, h3 = Math.imul(h2, 2246822519) >>> 0;
        if (!wood && h3 % 100 < 35) continue; // des clairières dans les parcs
        const x = (ix + 0.15 + 0.7 * (h / 4294967296)) * dx, y = (iy + 0.15 + 0.7 * (h2 / 4294967296)) * dy, k = step + ':' + ix + ':' + iy;
        if (x < W || x > E || y < S || y > N || seen.has(k) || !inPoly(x, y, rings)) continue;
        let free = true;
        for (const [bx, br] of grid.get(cellOf(x, y)) || []) if (x >= bx[0] && x <= bx[2] && y >= bx[1] && y <= bx[3] && inPoly(x, y, br)) { free = false; break; }
        if (!free) continue;
        seen.add(k);
        const t = (h3 % 1000) / 1000, height = 6.5 + 6 * t, fir = wood && h3 % 4 === 0;
        trees.push({ p: [x, y, 0], top: [x, y, height * 0.28], crown: fir ? [height * 0.42, height * 0.42, height * 0.78] : [height * 0.62, height * 0.62, height * 0.74], trunk: [0.5, 0.5, height * 0.34], fir, color: GREENS[h2 % GREENS.length], yaw: h % 360 });
      }
    };
    const jobs = [];
    for (const f of q('landcover')) {
      const c = f.properties.class, sub = f.properties.subclass;
      if (c === 'wood') for (const rings of polysOf(f)) jobs.push([rings, 9, true]);
      else if (c === 'grass' && (sub === 'park' || sub === 'garden' || sub === 'village_green' || sub === 'recreation_ground')) for (const rings of polysOf(f)) jobs.push([rings, 19, false]);
    }
    for (const f of q('park')) for (const rings of polysOf(f)) jobs.push([rings, 19, false]);
    // le plafond d'arbres profite d'abord aux espaces verts les plus proches du centre de la vue
    const far = (rings) => { const b = boxOf(rings), dx = (Math.min(Math.max(ctr.lng, b[0]), b[2]) - ctr.lng) * KX, dy = (Math.min(Math.max(ctr.lat, b[1]), b[3]) - ctr.lat) * KY; return dx * dx + dy * dy; };
    for (const j of jobs) j.push(far(j[0]));
    jobs.sort((a, b) => a[3] - b[3]);
    for (const [rings, step, wood] of jobs) { if (trees.length >= 7000) break; plant(rings, step, wood); }
    state.trees = trees; state.leafy = trees.filter((t) => !t.fir); state.firs = trees.filter((t) => t.fir);
  }

  function treeLayers() {
    const mat = { ambient: 0.55, diffuse: 0.6, shininess: 4, specularColor: [20, 20, 20] };
    const crown = (id, data, mesh) => new deck.SimpleMeshLayer({ id, data, mesh, getPosition: (d) => d.top, getScale: (d) => d.crown, getOrientation: (d) => [0, d.yaw, 0], getColor: (d) => d.color, material: mat });
    return [
      new deck.SimpleMeshLayer({ id: 'tree-trunks', data: state.trees, mesh: TREE.trunk, getPosition: (d) => d.p, getScale: (d) => d.trunk, getColor: [96, 74, 56], material: mat }),
      crown('tree-crowns', state.leafy, TREE.crown), crown('tree-firs', state.firs, TREE.fir),
    ];
  }

  const EXT = {};
  function initExt() { if (!EXT.terrain && deck._TerrainExtension) EXT.terrain = new deck._TerrainExtension(); if (!EXT.dash && deck.PathStyleExtension) { EXT.dash = new deck.PathStyleExtension({ dash: true }); EXT.offset = new deck.PathStyleExtension({ offset: true }); EXT.dashOffset = new deck.PathStyleExtension({ dash: true, offset: true }); } }

  /**
   * Géométrie du sol : marquages, dalles de carrefour, passages piétons et lignes d'arrêt, déduits des voies de
   * chaque tronçon. Recalculée seulement quand l'échelle de la scène ou la voie réservée change.
   */
  function buildGround(net, big, block, LANE, STRIP, reserved) {
    initExt();
    const fast = (e) => { const c = net.ecls[e]; return c === 0 || c === 1 || c === 5; };
    const N = net.N, deg = new Uint8Array(N), R = new Float32Array(N), ext = new Float32Array(net.E), stopAt = new Float32Array(net.E), calm = new Uint8Array(N);
    const seen = new Uint8Array(roadData.length);
    for (let e = 0; e < net.E; e++) {
      const [x0, , W] = block(e); ext[e] = Math.max(Math.abs(x0), Math.abs(x0 + W));
      const a = net.ea[e], b = net.eb[e];
      if (ext[e] > R[a]) R[a] = ext[e]; if (ext[e] > R[b]) R[b] = ext[e];
      if (!fast(e)) { calm[a] = 1; calm[b] = 1; }
      if (!seen[net.eseg[e]]) { seen[net.eseg[e]] = 1; if (deg[a] < 250) deg[a]++; if (deg[b] < 250) deg[b]++; }
    }
    const solid = [], dash = [], zebra = [], stop = [], nodes = [], p = [0, 0, 0], q = [0, 0, 0];
    const across = (e, at, lo, hi, list) => { net.edgePosLane(e, at, lo, p, 0); net.edgePosLane(e, at, hi, q, 0); list.push({ path: [[p[0], p[1], 0.1], [q[0], q[1], 0.1]] }); };
    for (const r of roadData) {
      const e0 = r.edges[0], central = reserved && r.cor && Math.abs(state.corLat[e0]) < STRIP + 0.3 * big;
      // double ligne jaune dans l'axe des rues à double sens (sauf si l'emprise réservée occupe l'axe)
      if (r.two && !central) for (const off of [-0.16 * big, 0.16 * big]) solid.push({ path: r.path3, off, yellow: true });
      for (const e of r.edges) {
        const [x0, k, W] = block(e), sg = net.erev[e] ? -1 : 1, len = net.elen[e], a = net.ea[e], b = net.eb[e];
        for (let j = 1; j < k; j++) dash.push({ path: r.path3, off: sg * (x0 + j * LANE) });
        if (fast(e)) { solid.push({ path: r.path3, off: sg * (x0 + W - 0.25 * big) }); if (!r.two) solid.push({ path: r.path3, off: sg * (x0 + 0.25 * big), yellow: true }); continue; }
        if (len < R[a] + R[b] + 18 * big) continue;
        const lo = r.two ? -ext[e] : x0, hi = x0 + W;
        if (deg[b] >= 3) {
          const at = len - R[b] - 2 * big;
          across(e, at, lo, hi, zebra);
          // sans feux (autos coordonnées), personne ne s'arrête : pas de ligne d'arrêt
          if (!net.cond.auto) { stopAt[e] = len - at + 2.6 * big; across(e, len - stopAt[e], x0, hi, stop); }
        }
        if (!r.two && deg[a] >= 3) across(e, R[a] + 2 * big, lo, hi, zebra);
      }
    }
    const nd = net.data.nodes;
    for (let n = 0; n < N; n++) if (deg[n] >= 3 && R[n] > 0 && calm[n]) nodes.push({ pos: [nd[n][0], nd[n][1], 0.08], r: R[n] });
    return { solid, dash, zebra, stop, nodes, stopAt };
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
    const lineKey = L ? L.kind : 'none';
    // sans ligne (rien ou Cybercab), le tracé reste visible en gris
    const lineColor = L ? COLORS[L.kind] : [130, 146, 166];
    const tun = (d) => d.tunnel && (!L || L.kind === 'tram');
    // Échelle de la scène : en vue rapprochée tout est à taille réelle ; plus loin, chaussées et véhicules
    // grossissent ensemble, pour que les véhicules restent toujours sur leur voie.
    const zoom = map.getZoom();
    const big = Math.round(Math.min(2.4, Math.max(1, Math.pow(2, 17 - zoom))) * 10) / 10;
    const LANE = 3.5 * big, AXIS = 0.3 * big; // largeur d'une voie ; demi-terre-plein entre les deux sens
    const reserved = net.cond.laneDrop; // une voie du tracé est prise par le tramway ou les bus
    const STRIP = AXIS + LANE; // demi-largeur de l'emprise réservée : une voie par sens
    // Voies des autos sur l'arête e : [bord gauche du bloc de voies (mètres à droite de l'axe), nombre de voies].
    // Le long du tracé, la rue perd une voie et le bloc s'écarte de l'emprise réservée pour ne jamais la chevaucher.
    const block = (ed) => {
      const two = net.etwo[ed] === 1, onLine = reserved && net.ecor[ed] === 1;
      const k = Math.max(1, net.elanes[ed] - (onLine && !net.ebus[ed] ? 1 : 0)), W = k * LANE;
      let x0 = two ? AXIS : -W / 2;
      if (onLine) {
        const a = state.corLat[ed] - STRIP, b = state.corLat[ed] + STRIP;
        if (a < x0 + W && b > x0) x0 = two || b - x0 <= x0 + W - a ? b + 0.25 * big : a - W - 0.25 * big;
      }
      return [x0, k, W];
    };
    const widthOf = (d) => { let ext = 0; for (const ed of d.edges) { const [x0, , W] = block(ed); ext = Math.max(ext, Math.abs(x0), Math.abs(x0 + W)); } return 2 * ext + 0.8 * big; };
    const under = state.labelLayer && map.getLayer(state.labelLayer) ? state.labelLayer : undefined; // sous les noms de rues
    const gkey = big + '|' + reserved + '|' + !!net.cond.auto;
    if (state.groundKey !== gkey) { state.groundKey = gkey; state.ground = buildGround(net, big, block, LANE, STRIP, reserved); }
    const G = state.ground, detail = zoom >= 15.3;
    // bâtiments réels : la ville photographiée remplace le sol et les volumes dessinés ; tout le reste se pose sur son relief
    const photo = !!state.photo && !!EXT.terrain, TER = photo ? [EXT.terrain] : [];
    const ASPHALT = [72, 76, 82, 255], WHITE = [236, 236, 230, 255], YELLOW = [232, 190, 70, 255];
    // Le sol est peint à plat, couche après couche, juste avant les bâtiments du fond de carte : ceux-ci le recouvrent.
    const ground = map.getLayer('building-3d') ? 'building-3d' : under, NOZ = { depthTest: false, depthCompare: 'always', depthWriteEnabled: false };
    const flat = (id, data, props) => new deck.PathLayer(Object.assign({ id, data, getPath: (d) => d.path, widthUnits: 'meters', updateTriggers: { getWidth: [gkey], getOffset: [gkey], getColor: [gkey, lineKey] } }, photo ? { extensions: TER, terrainDrawMode: 'drape', opacity: 0.82 } : { beforeId: ground, parameters: NOZ }, props));
    if (photo) layers.push(photoLayer()); else {
    // trottoirs (ou accotements des autoroutes), bordure claire, puis chaussée
    layers.push(flat('sidewalk', roadData, { getColor: (d) => (d.fast ? [108, 112, 118, 255] : [188, 186, 178, 255]), getWidth: (d) => widthOf(d) + (d.fast ? 1.6 : 5) * big, widthMinPixels: 2, capRounded: true, jointRounded: true }));
    layers.push(flat('curb', state.streets, { getColor: [224, 222, 214, 255], getWidth: (d) => widthOf(d) + 0.5 * big, capRounded: true, jointRounded: true }));
    layers.push(new deck.PathLayer({
      id: 'asphalt', data: roadData, getPath: (d) => d.path, beforeId: ground, parameters: NOZ,
      // l'asphalte se réchauffe légèrement quand la rue se charge ; ce sont les files d'autos qui montrent la congestion
      getColor: (d) => { const r = state.layers.roads ? state.segRatio[d.i] : 0; return r < 0.7 ? ASPHALT : r < 0.9 ? [80, 78, 78, 255] : r < 1 ? [88, 79, 76, 255] : [96, 78, 74, 255]; },
      getWidth: widthOf, widthUnits: 'meters', widthMinPixels: 1.5, capRounded: true, jointRounded: true, pickable: true,
      updateTriggers: { getColor: [state.colorTick, state.layers.roads], getWidth: [gkey] },
    }));
    if (detail) {
      // marquages : lignes continues (axe jaune, rives d'autoroute), tirets blancs entre les voies
      layers.push(flat('marks-solid', G.solid, { getColor: (d) => (d.yellow ? YELLOW : WHITE), getWidth: 0.16 * big, getOffset: (d) => d.off / (0.16 * big), extensions: [EXT.offset] }));
      layers.push(flat('marks-dash', G.dash, { getColor: WHITE, getWidth: 0.16 * big, getOffset: (d) => d.off / (0.16 * big), getDashArray: [20, 40], extensions: [EXT.dashOffset] }));
      // carrefours : une dalle d'asphalte nu, puis passages piétons et lignes d'arrêt
      layers.push(new deck.ScatterplotLayer({ id: 'junctions', data: G.nodes, beforeId: ground, parameters: NOZ, getPosition: (d) => d.pos, getRadius: (d) => d.r, radiusUnits: 'meters', getFillColor: ASPHALT, updateTriggers: { getRadius: [gkey] } }));
      layers.push(flat('zebra', G.zebra, { getColor: WHITE, getWidth: 3 * big, getDashArray: [0.17, 0.17], extensions: [EXT.dash] }));
      layers.push(flat('stop-lines', G.stop, { getColor: WHITE, getWidth: 0.4 * big }));
    }
    }
    if (reserved) {
      // l'emprise réservée : plateforme du tramway avec ses rails, ou chaussée teintée des bus
      const kind = L.kind;
      if (state.stripKey !== kind) { state.stripKey = kind; state.strip = lineParts.filter((d) => !tun(d)); }
      const strip = state.strip;
      const surface = kind === 'tram' ? [164, 160, 150, 255] : [150, 92, 84, 255];
      layers.push(flat('line3d', strip, { getPath: (d) => d.path3, getColor: surface, getWidth: 2 * STRIP - 0.5 * big, widthMinPixels: 2, capRounded: true, jointRounded: true }));
      if (detail && !photo) {
        const c = AXIS + LANE / 2, g = 0.72 * big, w = 0.14 * big, rim = STRIP - 0.45 * big;
        const lines = kind === 'tram' ? [c - g, c + g, -c - g, -c + g].map((off) => ({ off, color: [56, 58, 62, 255] })).concat([rim, -rim].map((off) => ({ off, color: [...lineColor, 255] })))
          : [rim, -rim].map((off) => ({ off, color: WHITE })).concat([0.14 * big, -0.14 * big].map((off) => ({ off, color: YELLOW })));
        lines.forEach((ln, q) => layers.push(flat('line3d-mark' + q, strip, { getPath: (d) => d.path4, getColor: ln.color, getWidth: w, getOffset: ln.off / w, extensions: [EXT.offset] })));
      }
    }
    if (detail && !photo && state.trees && state.trees.length && deck.SimpleMeshLayer) layers.push(...treeLayers());
    if (!deck.SimpleMeshLayer || zoom < 14.6) return layers.concat(stationLayers3d(lineColor, lineKey, TER));
    // Le moteur ne suit pas chaque auto au mètre près : pour l'affichage, les véhicules d'un même tronçon sont rangés
    // en files, voie par voie, sans jamais se chevaucher. Ceux qui n'ont plus de place ne sont pas dessinés.
    const bb = map.getBounds(), w = bb.getWest(), e = bb.getEast(), s = bb.getSouth(), n = bb.getNorth();
    const carLen = 4.5 * big, gap = carLen + 2.4 * big, box = state.ebox, byEdge = state.byEdge, padX = (24 * gap) / TQ.geo.KX, padY = (24 * gap) / TQ.geo.KY;
    byEdge.clear();
    // Le moteur avance par pas de 2 s : entre deux pas, chaque véhicule est dessiné là où il sera quand le temps
    // déjà écoulé (rest) aura été simulé. dE, dP, dTT, dH : tronçon, avancement, temps de parcours et nombre de
    // tronçons franchis pour le dessin ; l'état du moteur n'est pas touché.
    const rest = sim.stepRest, ah = state.ahead;
    if (!state.dE || state.dE.length < net.vn) { const cap = net.vcap; state.dE = new Int32Array(cap); state.dP = new Float32Array(cap); state.dTT = new Float32Array(cap); state.dH = new Uint8Array(cap); }
    const dE = state.dE, dP = state.dP, dTT = state.dTT, dH = state.dH;
    // tronçon déjà parcouru, d rangs avant celui du dessin (0 : le précédent), ou -1
    const REAL = [net.vEdge, net.vPrev, net.vPrev2, net.vPrev3, net.vPrev4];
    const before = (i, d) => {
      const h = dH[i];
      if (d + 1 - h >= 0) return d + 1 - h < 5 ? REAL[d + 1 - h][i] : -1;
      // plusieurs tronçons très courts franchis depuis le dernier pas : on les retrouve en suivant le trajet
      const tn = net.tnext[net.vDest[i]];
      let ed = net.vEdge[i];
      for (let q = h - 1 - d; q > 0; q--) ed = tn[net.eb[ed]];
      return ed;
    };
    for (let i = 0; i < net.vn; i++) {
      const type = net.vType[i];
      if (type === 0 && !state.layers.cars) continue;
      net.aheadOf(i, rest, ah); dE[i] = ah.e; dP[i] = ah.p; dTT[i] = ah.tt; dH[i] = ah.hops;
      const ed = ah.e, q = ed * 4;
      // marge : les suiveurs d'un groupe roulent encore à l'écran quand sa tête vient d'en sortir
      if (box[q + 2] < w - padX || box[q] > e + padX || box[q + 3] < s - padY || box[q + 1] > n + padY) continue;
      let list = byEdge.get(ed);
      if (!list) byEdge.set(ed, (list = []));
      list.push(i);
    }
    const cars = [], cabs = [], out = [0, 0, 0];
    const pa = [0, 0, 0], pb = [0, 0, 0], pm = [0, 0, 0];
    const KX = TQ.geo.KX, KY = TQ.geo.KY, TURN = 8 * big, FADE = 10 * big;
    const lateralOf = (ed, k) => { const b = block(ed); return b[0] + LANE * ((k % b[1]) + 0.5); };
    // Pose d'une auto à `at` mètres du début du tronçon ed. Près d'un carrefour, elle suit une courbe qui relie sa voie
    // sur le tronçon quitté (prev) ou à venir (next) : elle tourne au lieu de sauter d'une rue à l'autre.
    const place = (ed, at, k, prev, next) => {
      const len = net.elen[ed];
      let A = -1, B = -1, u = 0;
      if (prev >= 0 && at < TURN) { A = prev; B = ed; u = at; } else if (next >= 0 && at > len - TURN) { A = ed; B = next; u = at - len; }
      const la = A < 0 ? 0 : net.elen[A], r = A < 0 ? 0 : Math.min(TURN, la * 0.45, net.elen[B] * 0.45);
      if (A < 0 || r < 0.5 || u <= -r || u >= r) { net.edgePosLane(ed, Math.min(len, Math.max(0, at)), lateralOf(ed, k), out, 0); return; }
      const latA = lateralOf(A, k), latB = lateralOf(B, k);
      net.edgePosLane(A, la - r, latA, pa, 0); net.edgePosLane(B, r, latB, pb, 0);
      // point de contrôle : là où se croisent la trajectoire d'arrivée et celle de départ (à défaut, entre les deux)
      const ax = pa[0] * KX, ay = pa[1] * KY, bx = pb[0] * KX, by = pb[1] * KY;
      const ca = Math.cos((pa[2] * Math.PI) / 180), sa = Math.sin((pa[2] * Math.PI) / 180), cb = Math.cos((pb[2] * Math.PI) / 180), sb = Math.sin((pb[2] * Math.PI) / 180);
      const den = ca * sb - sa * cb;
      let mx = (ax + bx) / 2, my = (ay + by) / 2;
      if (Math.abs(den) > 0.2) { const ta = ((bx - ax) * sb - (by - ay) * cb) / den; if (ta > 0 && ta < 4 * r) { mx = ax + ca * ta; my = ay + sa * ta; } }
      const t = (u + r) / (2 * r), w0 = (1 - t) * (1 - t), w1 = 2 * t * (1 - t), w2 = t * t;
      out[0] = (w0 * ax + w1 * mx + w2 * bx) / KX; out[1] = (w0 * ay + w1 * my + w2 * by) / KY;
      const tx = (1 - t) * (mx - ax) + t * (bx - mx), ty = (1 - t) * (my - ay) + t * (by - my);
      out[2] = Math.abs(tx) + Math.abs(ty) > 1e-6 ? (Math.atan2(ty, tx) * 180) / Math.PI : pb[2];
    };
    // Mémoire d'affichage : chaque auto garde d'une image à l'autre sa dernière position, pour ne jamais sauter ni
    // s'effacer en pleine rue. Elle est vidée quand la journée repart ou saute dans le temps.
    const mem = state.carMem || (state.carMem = new Map()), frame = (state.frame3 = (state.frame3 || 0) + 1);
    const tDraw = sim.t + rest, dT = state.t3 == null ? 0 : tDraw - state.t3; state.t3 = tDraw;
    if (dT < 0 || dT > 30 || state.resets3 !== sim.resets) mem.clear();
    state.resets3 = sim.resets;
    const simDt = dT < 0 || dT > 30 ? 0 : dT, smooth = simDt < 2, jumpMin = 2.5 + 45 * simDt;
    const show = (key, type, paint, sc, yaw, x, y) => {
      if (x < w || x > e || y < s || y > n) return;
      const v = { p: [x, y, 0], yaw, i: key, type, sc, paint };
      if (type === 0) { if (cars.length < 14000) cars.push(v); } else if (cabs.length < 9000) cabs.push(v);
    };
    // rt : tronçons qu'il lui reste à parcourir quand son groupe est sur le point d'arriver (null sinon) ; spd : m par seconde simulée
    const emit = (key, type, paint, sc, ed, at, k, prev, next, rt, spd) => {
      place(ed, at, k, prev, next);
      let x = out[0], y = out[1], m = mem.get(key);
      if (!m) mem.set(key, (m = { x, y, ox: 0, oy: 0 }));
      else if (smooth) {
        // un écart brusque (la file se réordonne, une auto change de tronçon) est rattrapé en douceur
        const jx = (x - m.x) * KX, jy = (y - m.y) * KY, j = Math.hypot(jx, jy);
        if (j > 60 * big) { m.ox = 0; m.oy = 0; } else if (j > jumpMin) { m.ox -= jx; m.oy -= jy; }
        m.ox *= 0.88; m.oy *= 0.88; m.x = x; m.y = y;
        x += m.ox / KX; y += m.oy / KY;
      } else { m.x = x; m.y = y; m.ox = 0; m.oy = 0; }
      m.f = frame; m.ed = ed; m.at = at; m.k = k; m.prev = prev; m.rt = rt; m.spd = spd; m.type = type; m.paint = paint; m.age = 0;
      show(key, type, paint, sc, out[2], x, y);
    };
    for (const [ed, list] of byEdge) {
      const len = net.elen[ed], endNode = net.eb[ed];
      const carLanes = block(ed)[1];
      list.sort((p, q) => dP[q] - dP[p]);
      const queue = [];
      for (const i of list) {
       const copies = Math.max(1, Math.round(net.vW[i])), id = net.vId[i];
       for (let c = 0; c < copies; c++) {
        // un agent du moteur représente plusieurs véhicules réels : ils se suivent, à quelques longueurs d'écart.
        // Chaque véhicule garde son numéro, donc sa couleur, sa voie et son écart, du départ à l'arrivée.
        const key = id * 8 + c, hs = (key * 2654435761) >>> 0, h = hs / 4294967296;
        const want = dP[i] * len - c * gap * (1.5 + 1.5 * h);
        queue.push({ i, key, hs, want });
       }
      }
      // de l'avant vers l'arrière : chacun reste dans sa voie, derrière celui qui le précède
      queue.sort((p, q) => q.want - p.want);
      const last = new Array(carLanes).fill(Infinity);
      for (const q of queue) {
        const i = q.i, type = net.vType[i], prev = before(i, 0), dest = net.vDest[i], k = (q.hs >>> 7) % carLanes;
        // tronçon suivant de son trajet (-1 : il arrive à destination au bout de celui-ci)
        const next = endNode === net.dnode[dest] ? -1 : net.tnext[dest][endNode];
        const last1 = next < 0, spd = len / dTT[i], paint = (q.hs >>> 11) & 7;
        const at = Math.min(q.want, last[k] - gap);
        last[k] = at;
        if (at >= 0) {
          // départ et arrivée : l'auto sort de son stationnement ou y entre, au lieu d'apparaître d'un coup
          const sc = prev < 0 && at < FADE ? Math.max(0.08, at / FADE) : next < 0 && at > len - FADE ? Math.max(0.08, (len - at) / FADE) : 1;
          emit(q.key, type, paint, sc, ed, at, k, prev, next, last1 ? [] : null, spd);
          continue;
        }
        // il suit de loin ou la file déborde : il roule encore sur un tronçon déjà quitté par la tête du groupe
        // (au départ, il n'est pas encore sorti de son stationnement)
        let back = at, nxt = ed;
        for (let d = 0; d < 4; d++) {
          const pe = before(i, d);
          if (pe < 0) break;
          back += net.elen[pe];
          if (back >= 0) {
            const older = d < 3 ? before(i, d + 1) : -1;
            let rt = null;
            if (last1) { rt = [ed]; for (let b = 0; b < d; b++) rt.unshift(before(i, b)); }
            emit(q.key, type, paint, older < 0 && back < FADE ? Math.max(0.08, back / FADE) : 1, pe, back, k, older, nxt, rt, spd);
            break;
          }
          nxt = pe;
        }
      }
    }
    // Les autos dont le groupe vient d'arriver finissent leur trajet jusqu'à destination au lieu de s'effacer en route.
    for (const [key, m] of mem) {
      if (m.f === frame) continue;
      if (!m.rt || (m.age += simDt) > 900) { if (frame - m.f > 2) mem.delete(key); continue; }
      m.at += m.spd * simDt;
      if (m.rt.length && m.at >= net.elen[m.ed]) { m.at -= net.elen[m.ed]; m.prev = m.ed; m.ed = m.rt.shift(); }
      const left = m.rt.length ? Infinity : net.elen[m.ed] - m.at;
      if (left < 0.4) { mem.delete(key); continue; }
      place(m.ed, m.at, m.k, m.prev, m.rt.length ? m.rt[0] : -1);
      m.ox *= 0.88; m.oy *= 0.88;
      show(key, m.type, m.paint, left < FADE ? Math.max(0.08, left / FADE) : 1, out[2], out[0] + m.ox / KX, out[1] + m.oy / KY);
    }
    const mesh = { sizeScale: big, extensions: TER, getPosition: (d) => d.p, getOrientation: (d) => [0, d.yaw, 0], material: { ambient: 0.5, diffuse: 0.65, shininess: 40, specularColor: [70, 70, 70] } };
    const GLASS = [34, 42, 54];
    layers.push(new deck.SimpleMeshLayer(Object.assign({ id: 'cars3d', data: cars, mesh: MESH.car, getScale: (d) => [4.5 * d.sc, 1.85 * d.sc, 1.5 * d.sc], getColor: (d) => (net.cond.auto ? AUTO_PAINT : CAR_PAINT)[d.paint], updateTriggers: { getColor: [!!net.cond.auto] } }, mesh)));
    layers.push(new deck.SimpleMeshLayer(Object.assign({ id: 'cars3d-glass', data: cars, mesh: MESH.carGlass, getScale: (d) => [4.5 * d.sc, 1.85 * d.sc, 1.5 * d.sc], getColor: GLASS }, mesh)));
    if (F) {
      // Cybercab : carrosserie dorée quand il transporte quelqu'un, plus pâle à vide
      layers.push(new deck.SimpleMeshLayer(Object.assign({ id: 'cabs3d', data: cabs, mesh: MESH.cab, getScale: (d) => [4.3 * d.sc, 1.85 * d.sc, 1.3 * d.sc], getColor: (d) => (d.type === 2 ? [226, 180, 70] : [210, 196, 158]) }, mesh)));
      layers.push(new deck.SimpleMeshLayer(Object.assign({ id: 'cabs3d-glass', data: cabs, mesh: MESH.cabGlass, getScale: (d) => [4.3 * d.sc, 1.85 * d.sc, 1.3 * d.sc], getColor: GLASS }, mesh)));
    }
    if (L) {
      // rames et autobus articulés : des caisses qui suivent chacune la courbe, à droite de l'axe selon le sens
      const parts = L.kind === 'tram' ? 5 : 2, partLen = (L.p.length * big) / parts, veh = [], a = [0, 0], b = [0, 0], c = [0, 0];
      for (const v of L.vehicles) {
        if (!v.active) continue;
        const vs = L.drawS(v, sim.t, rest);
        if (L.kind === 'tram' && vs > L.tunnel[0] - L.p.length && vs < L.tunnel[1] + L.p.length) continue;
        for (let q = 0; q < parts; q++) {
          const sc = vs + (q - (parts - 1) / 2) * partLen;
          L.posAt(sc - partLen / 2, a, 0); L.posAt(sc, b, 0); L.posAt(sc + partLen / 2, c, 0);
          let dx = (c[0] - a[0]) * TQ.geo.KX, dy = (c[1] - a[1]) * TQ.geo.KY;
          if (v.dir === 1) { dx = -dx; dy = -dy; }
          const l = Math.hypot(dx, dy) || 1;
          const off = AXIS + LANE / 2;
          veh.push({ v, p: [b[0] + ((dy / l) * off) / TQ.geo.KX, b[1] - ((dx / l) * off) / TQ.geo.KY, 0], yaw: (Math.atan2(dy, dx) * 180) / Math.PI });
        }
      }
      const size = [partLen / big, L.p.width, L.kind === 'tram' ? 3.4 : 3.1];
      layers.push(new deck.SimpleMeshLayer(Object.assign({}, mesh, { id: 'line-veh3d', data: veh, mesh: MESH.module, getScale: size, getColor: lineColor, pickable: true })));
      layers.push(new deck.SimpleMeshLayer(Object.assign({}, mesh, { id: 'line-veh-glass', data: veh, mesh: MESH.moduleGlass, getScale: size, getColor: [34, 42, 54] })));
    }
    return layers.concat(stationLayers3d(lineColor, lineKey, TER));
  }

  function stationLayers3d(lineColor, lineKey, ext) {
    const layers = [];
    layers.push(new deck.ScatterplotLayer({
      id: 'stations3d', data: stationData, getPosition: (d) => d.pos, pickable: true, stroked: true, filled: true,
      getFillColor: [255, 255, 255, 255], getLineColor: [...lineColor, 255], lineWidthUnits: 'pixels', getLineWidth: 3,
      getRadius: (d) => (d.hub ? 7 : 5), radiusUnits: 'pixels', updateTriggers: { getLineColor: [lineKey] }, parameters: { depthTest: false }, extensions: ext,
    }));
    if (deck.TextLayer) layers.push(new deck.TextLayer({
      id: 'station-names3d', extensions: ext, data: stationData, getPosition: (d) => d.pos, getText: (d) => d.name, characterSet: state.allChars,
      fontFamily: '"Barlow Semi Condensed", "Segoe UI", sans-serif', fontWeight: 600, getSize: 14, getColor: [20, 32, 47, 255],
      getPixelOffset: [0, -18], getTextAnchor: 'middle', getAlignmentBaseline: 'bottom',
      fontSettings: { sdf: true, fontSize: 40, buffer: 14 }, outlineWidth: 4, outlineColor: [255, 255, 255, 255], parameters: { depthTest: false },
    }));
    return layers;
  }

  function buildLayers() {
    if (state.view3d) return buildLayers3d();
    const net = sim.net, L = sim.line, F = sim.fleet, layers = [];
    const lineKey = L ? L.kind : 'none', lit = !!L; // tracé en service
    // sans ligne (rien ou Cybercab), le tracé reste visible en gris, éteint
    const lineColor = L ? COLORS[L.kind] : [130, 146, 166];
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
      id: 'line', data: lineParts, getPath: (d) => d.path,
      getColor: (d) => [...lineColor, lit ? (tun(d) ? 90 : 230) : 110],
      getWidth: (d) => (tun(d) ? 3 : 4), widthUnits: 'pixels', capRounded: true, jointRounded: true, updateTriggers: { getColor: [lineKey], getWidth: [lineKey] },
    }));
    // véhicules routiers
    // autos : petits points pâles ; Cybercab : points plus gros, dessinés par-dessus pour rester lisibles
    const n = net.vn, pos = state.posBuf, col = state.colBuf, cpos = state.cabPos, ccol = state.cabCol;
    // le moteur avance par pas de 2 s : entre deux pas, chaque véhicule est dessiné là où il sera
    // quand le temps déjà écoulé (rest) aura été simulé. L'état du moteur n'est pas touché.
    const rest = sim.stepRest, ah = state.ahead;
    let k = 0, c = 0;
    for (let i = 0; i < n; i++) {
      const type = net.vType[i];
      if (type === 0) {
        if (!state.layers.cars || k >= 40000) continue;
        net.aheadOf(i, rest, ah); net.edgePos(ah.e, ah.p, pos, k * 2);
        const o = k * 4;
        if (net.cond.auto) { col[o] = 96; col[o + 1] = 226; col[o + 2] = 212; col[o + 3] = 150; } // autos connectées : turquoise
        else { col[o] = 205; col[o + 1] = 216; col[o + 2] = 230; col[o + 3] = 125; }
        k++;
      } else if (c < 12000) {
        net.aheadOf(i, rest, ah); net.edgePos(ah.e, ah.p, cpos, c * 2);
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
        const vs = L.drawS(v, sim.t, rest);
        L.posAt(vs - half, a, 0); L.posAt(vs, b, 0); L.posAt(vs + half, c, 0);
        veh.push({ v, path: [a, b, c], tunnel: L.kind === 'tram' && vs > L.tunnel[0] && vs < L.tunnel[1] });
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
      // le temps écoulé est passé tel quel : le moteur le découpe lui-même en pas de 2 s et garde le reste
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
    setText('clock', TQ.formatClock(sim.t + sim.stepRest));
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
    setText('key-line', L ? `Charge du tronçon le plus chargé (${L.kind === 'tram' ? 'tramway' : 'bus'})` : F ? 'Cybercab : pas de ligne à horaire' : 'Aucune ligne sur le tracé');
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
      // cumul des journées enchaînées depuis le dernier départ, journée en cours comprise (la fin de journée à 5 h ne le
      // coupe pas) ; recalculé à chaque affichage, donc avec les coûts en vigueur
      const runList = sim.runSummaries(), e = TQ.economicsTotal(runList);
      const since = 'depuis le dernier changement de scénario, la dernière reprise (« Reprendre à ») ou le dernier calcul de journée';
      // le texte suit les journées gardées par le moteur (sim.run), pas seulement e.days : à 5 h pile la journée en cours
      // est vide mais le cumul contient déjà la journée qui vient de finir
      if (!sim.run.length) setText('k-days', `Journée en cours seulement, ${since}. Le cumul se poursuit après 5 h.`);
      else {
        const first = sim.run[0], hours = runList.reduce((a, s) => a + s.elapsedH, 0);
        const partial = first.elapsedH < 24 - 1e-6;
        const start = TQ.formatClock(Math.round((first.t - first.elapsedH * 3600) / 600) * 600).replace(' h 00', ' h');
        setText('k-days', `Cumul ${e.days > 1 ? `de ${fmt.format(e.days)} journées entamées` : 'd\'une journée'}, soit ${fmt.format(Math.round(hours))} h simulées`
          + `${partial ? ` (la première commencée à ${start})` : ''}, ${since}.`);
      }
      kpi('k-rev', ...money(e.revenue)); kpi('k-opex', ...money(e.opex));
      kpi('k-oper', ...money(e.operating)); kpi('k-net', ...money(e.net));
      // recettes face aux coûts, à la même échelle
      const top = Math.max(e.revenue, e.opex + e.capital, 1), pct = (v) => ((v / top) * 100).toFixed(1) + '%';
      $('eb-rev').style.width = pct(e.revenue); $('eb-opex').style.width = pct(e.opex); $('eb-cap').style.width = pct(e.capital);
      $('k-oper').style.color = e.operating < 0 ? 'var(--bad)' : 'var(--ok)';
      $('k-net').style.color = e.net < 0 ? 'var(--bad)' : 'var(--ok)';
      setText('k-capex', `Investissement à amortir : ${e.parts.map((p) => `${moneyText(p.capex)} (${p.kind === 'tram' ? 'tramway' : p.kind === 'bus' ? 'voies réservées et bus' : 'Cybercab et recharge'})`).join(' + ')}.`);
    }
    setText('k-co2', fmt1.format(Math.abs(s.co2Avoided)));
    setText('k-co2-title', s.scenario.auto ? replacedTripsCO2 + ' et l’électrification du parc' : replacedTripsCO2);
    setText('k-co2-label', s.co2Avoided >= 0 ? 'tonnes évitées depuis le départ' : 'tonnes ajoutées depuis le départ');
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
    const rows = sim.history.filter((s) => s.line || s.cab || s.scenario.auto).map((s) => { const a = TQ.economics(s).annual; return { label: s.label, v: [a.net, a.society.net] }; });
    if (!rows.length) return '';
    const top = Math.max(1, ...rows.flatMap((r) => r.v.map(Math.abs)));
    const bar = (v, cls) => `<div class="dv ${cls}"><i style="${v < 0 ? 'right' : 'left'}:50%;width:${((Math.abs(v) / top) * 50).toFixed(2)}%;background:var(--${v < 0 ? 'bad' : 'ok'})"></i><b style="${v < 0 ? 'left' : 'right'}:calc(50% + 6px)">${moneyText(v)}</b></div>`;
    return `<div class="dvchart" role="img" aria-label="Résultat de l'exploitant et bilan pour la société, par scénario">
      <p class="dvkey"><span><i class="k1"></i>Résultat de l'exploitant</span><span><i class="k2"></i>Bilan pour la société</span><span>pertes à gauche, gains à droite</span></p>
      ${rows.map((r) => `<div class="dvrow"><span>${esc(r.label)}</span><div>${bar(r.v[0], 'a')}${bar(r.v[1], 'b')}</div></div>`).join('')}</div>`;
  }

  function econRow(s) {
    if (!s.line && !s.cab && !(s.scenario && s.scenario.auto)) return `<tr><td>${esc(s.label)}</td>${'<td>–</td>'.repeat(11)}</tr>`;
    const e = TQ.economics(s), a = e.annual, y = a.society;
    const signed = (v, strong) => (v == null ? '<td>–</td>' : `<td style="color:var(--${v < 0 ? 'bad' : 'ok'})${strong ? ';font-weight:600' : ''}">${moneyText(v)}</td>`);
    return `<tr><td>${esc(s.label)}</td><td>${moneyText(e.capex)}</td><td>${moneyText(a.revenue)}</td><td>${moneyText(a.opex)}</td><td>${moneyText(a.capital)}</td>${signed(a.net, true)}${signed(y.riders)}${signed(y.carFree)}${signed(y.drivers)}${signed(y.co2)}${signed(y.rtcLoss)}${signed(y.net, true)}</tr>`;
  }

  // Cache raw daily results so both sides always use the current cost sliders.
  const comparisonDays = new Map();
  const failedDays = new Set();
  let comparisonRunning = false;
  let showFareComparison = false;

  function comparisonDay(scenario) {
    const key = scenarioKey(scenario);
    if (comparisonDays.has(key)) return comparisonDays.get(key);
    if (comparisonRunning || failedDays.has(key) || state.batch || !$('dlg-compare').open) return;
    let worker;
    function finish(summary) {
      if (summary) comparisonDays.set(key, summary);
      else failedDays.add(key);
      if (worker) worker.terminate();
      comparisonRunning = false;
      if ($('dlg-compare').open) renderCompare();
    }
    try {
      worker = new Worker('js/comparison-day.worker.js');
      comparisonRunning = true;
      worker.onmessage = ({ data }) => finish(data);
      worker.onerror = worker.onmessageerror = () => finish(null);
      worker.postMessage({ scenario, seed: sim.seed });
    } catch {
      if (worker) worker.terminate();
      comparisonRunning = false;
      failedDays.add(key);
    }
  }

  function carFreeComparison() {
    const affected = sim.history.filter(s => s.cab && s.scenario.carFree > 0);
    if (!affected.length) return '';
    const rows = affected.map(s => {
      const scenario = { ...s.scenario, carFree: 0 };
      const baseline = comparisonDay(scenario);
      const current = TQ.economics(s).annual.society.net;
      if (baseline) {
        const zero = TQ.economics(baseline).annual.society.net;
        return `<tr><th scope="row">${esc(s.label)}</th><td>${signedMoney(zero)}</td><td>${signedMoney(current)}</td><td><strong>${signedMoney(current - zero)}</strong></td></tr>`;
      }
      const status = failedDays.has(scenarioKey(scenario)) ? 'Calcul indisponible. Rouvrez la comparaison pour réessayer.' : 'Calcul de la journée à 0 %…';
      return `<tr><th scope="row">${esc(s.label)}</th><td>${status}</td><td>${signedMoney(current)}</td><td>–</td></tr>`;
    }).join('');
    return `<h3>Effet des déplacements faits sans auto</h3>
      <p class="hint">Bilan annuel pour la société avec la même flotte, les mêmes réglages et la même demande. L’écart mesure l’effet de passer de 0 % à la part choisie.</p>
      <div class="table-wrap"><table><thead><tr><th>Scénario</th><th>À 0 %</th><th>À la part choisie</th><th>Écart annuel</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function fareComparison() {
    if (!showFareComparison) return '';
    const rows = sim.history.filter(s => s.cab).map(s => {
      const scenario = { ...s.scenario, farePerOccupant: true };
      const other = comparisonDay(scenario);
      const status = failedDays.has(scenarioKey(scenario)) ? 'Calcul indisponible. Rouvrez la comparaison pour réessayer.' : 'Calcul en cours…';
      const result = other
        ? `<td>${fmt.format(other.cab.rides)}</td><td>${signedMoney(TQ.economics(other).annual.net)}</td>`
        : `<td colspan="2">${status}</td>`;
      return `<tr><th scope="row">${esc(s.label)}</th><td>${fmt.format(s.cab.rides)}</td><td>${signedMoney(TQ.economics(s).annual.net)}</td>${result}</tr>`;
    }).join('');
    if (!rows) return '';
    return `<h3>Quel prix le voyageur utilise-t-il pour choisir le Cybercab ?</h3>
      <p class="hint">La même journée est rejouée avec le prix de la course divisé par l’occupation moyenne (${fmt1.format(TQ.PARAMS.cab.occupancy)}). Le montant facturé par course reste identique. Le résultat annuel de l’exploitant est celui de la flotte seule.</p>
      <div class="table-wrap"><table><thead><tr><th rowspan="2">Scénario</th><th colspan="2" scope="colgroup">Course entière (par défaut)</th><th colspan="2" scope="colgroup">Prix par occupant</th></tr><tr><th>Passagers Cybercab/j</th><th>Exploitant/an</th><th>Passagers Cybercab/j</th><th>Exploitant/an</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  }

  function renderCompare() {
    state.histLen = sim.history.length;
    const el = $('compare');
    $('compare-fares').hidden = showFareComparison || !sim.history.some(s => s.cab);
    for (const s of sim.history) comparisonDays.set(scenarioKey(s.scenario), s);
    if (!sim.history.length) { el.innerHTML = '<p class="empty">Aucune journée terminée pour l\'instant. Utilisez un des boutons ci-dessus, ou laissez tourner la simulation jusqu\'à 5 h.</p>'; return; }
    const rows = sim.history.map((s) => `<tr><td>${esc(s.label)}</td><td>${fmt.format(s.line ? s.line.boardings : 0)}</td><td>${s.line ? fmt.format(s.line.peakLoad) : '–'}</td><td>${s.line ? fmt1.format(s.line.speed) : '–'}</td><td>${s.cab ? fmt.format(s.cab.rides) : '–'}</td><td>${s.cab ? fmt.format(s.cab.emptyShare * 100) + ' %' : '–'}</td><td>${fmt.format(s.carsRemoved)}</td><td>${fmt1.format(s.avgSpeed)}</td><td>+${fmt.format(s.congestion * 100)} %</td><td>${fmt1.format(s.co2Avoided)}</td></tr>`).join('');
    const co2Heading = sim.history.some(s => s.scenario.auto) ? replacedTripsCO2 + ' et, si activée, l’électrification du parc' : replacedTripsCO2;
    el.innerHTML = `${carFreeComparison()}${fareComparison()}<div class="table-wrap"><table><thead><tr><th>Scénario</th><th>Montées sur la ligne</th><th>Charge max. par heure</th><th>Vitesse de la ligne (km/h)</th><th>Passagers Cybercab</th><th>Km à vide</th><th>Trajets auto évités</th><th>Vitesse auto (km/h)</th><th>Temps perdu</th><th>${co2Heading} (t)</th></tr></thead><tbody>${rows}</tbody></table></div>
      <p class="hint">Les émissions du nouveau service sont déduites. Une valeur négative indique une hausse des émissions. Les changements d’itinéraire des autos restantes sont exclus.</p>
      <h3>Rentabilité, par année</h3>
      ${econChart()}
      <div class="table-wrap"><table><thead><tr><th>Scénario</th><th>Investissement</th><th>Recettes</th><th>Exploitation</th><th>Investissement étalé</th><th>Résultat de l'exploitant</th><th>Gain des voyageurs</th><th>Déplacements faits sans auto</th><th>Temps des automobilistes</th><th>Valeur du ${co2Heading}</th><th>Recettes des autobus du RTC</th><th>Bilan pour la société</th></tr></thead><tbody>${sim.history.map(econRow).join('')}</tbody></table></div>
      <p class="hint">Le bilan pour la société additionne le résultat de l'exploitant et les cinq colonnes qui le précèdent. « Déplacements faits sans auto » ne se remplit qu'avec l'option d'abandon de l'auto : c'est l'écart de coût généralisé (temps, attente, marche, tarif, stationnement, coût au kilomètre) entre l'auto et le mode de remplacement, sans les économies de possession de l'auto. « Recettes des autobus du RTC » est négatif quand des usagers quittent les autobus, positif quand des déplacements faits sans auto s'y reportent. Le résultat de l'exploitant et le bilan changent avec les curseurs « Hypothèses de coûts ».</p>`;
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
    const k = modeOf(sim.scenario);
    $('line-hint').textContent = k === 'tram' ? 'Rames de 240 places aux 4 minutes en pointe, tunnel sous la colline Parlementaire.'
      : k === 'bus' ? 'Bus articulés de 105 places aux 2 min 30 en pointe, en surface sur tout le trajet.'
      : k === 'cab' ? 'Pas de ligne : les Cybercab roulent dans la circulation générale, avec les autos, qui gardent toutes leurs voies. Choisissez la zone, la taille de la flotte et le tarif plus bas.'
      : 'Situation de référence : aucune ligne structurante, les voies restent aux autos.';
  }

  function bindUi() {
    // Tout changement repart 90 minutes plus tôt, calculées d'un coup, pour que les rues et la ligne soient déjà en charge.
    // La reprise et l'heure visée sont calées sur la grille des pas du moteur (2 s, comptés depuis 5 h) :
    // les pas tombent aux mêmes instants que dans une journée calculée d'un seul coup.
    const restart = (t, cfg) => {
      state.batch = null; // un changement de scénario interrompt un calcul de journées en cours
      exclusive(Object.assign(sim.scenario, cfg || {}));
      const S = TQ.Simulation.STEP, grid = (x) => TQ.PARAMS.dayStart + Math.round((x - TQ.PARAMS.dayStart) / S) * S;
      const from = grid(Math.max(t - 5400, sim.tDayEnd - 86400)); // sans remonter avant le début de la journée
      sim.reset(from); sim.step(grid(t) - from);
      writeHash();
    };
    // un seul mode à la fois : choisir le tramway ou l'autobus retire la flotte, choisir le Cybercab ou une zone retire la ligne,
    // « Aucune » flotte laisse le tracé vide (Rien)
    radio('line-choice', 'line', (v) => { restart(sim.t, v === 'cab' ? { line: 'none', cab: 'corridor', fleet: +$('fleet').value } : { line: v, cab: 'off' }); syncControls(); lineHint(); });
    radio('cab-choice', 'cab', (v) => { restart(sim.t, v === 'off' ? { cab: v, line: 'none' } : { cab: v, line: 'none', fleet: +$('fleet').value }); syncControls(); lineHint(); });
    $('pool').addEventListener('change', (e) => restart(sim.t, { pool: e.target.checked }));
    $('carfree').addEventListener('input', (e) => { $('carfree-out').textContent = e.target.value + ' %'; });
    $('carfree').addEventListener('change', (e) => { if (+e.target.value / 100 !== sim.scenario.carFree) restart(sim.t, { carFree: +e.target.value / 100 }); });
    radio('speeds', 'speed', (v) => { state.speed = +v; state.speedBefore = null; });
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
        exclusive(Object.assign(sim.scenario, batch.queue.shift()));
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
    // (le long du tracé, 500 Cybercab suffisent à la demande : au-delà, les véhicules en trop ne font que coûter)
    // aux réglages de départ (tarif, saison), pour que les quatre lignes se comparent entre elles
    const base = { farePerKm: TQ.PARAMS.cab.farePerKm, winter: false, pool: false, carFree: 0, auto: false };
    $('run-all').addEventListener('click', () => runBatch([
      { line: 'tram', cab: 'off' }, { line: 'bus', cab: 'off' },
      { line: 'none', cab: 'corridor', fleet: 500 }, { line: 'none', cab: 'wide', fleet: 1500 },
    ].map((c) => Object.assign({}, base, c))));
    // un lien collé dans l'onglet déjà ouvert remplace le scénario et les coûts
    window.addEventListener('hashchange', () => {
      const before = scenarioKey(sim.scenario), was3d = state.view3d;
      for (const id in COSTS) econSet(COSTS[id][0], dig(TQ.ECON_DEFAULTS, COSTS[id][0]));
      const sc = exclusive(Object.assign({ fleet: 3000, farePerKm: TQ.PARAMS.cab.farePerKm, winter: false, pool: false, carFree: 0, auto: false }, readHash()));
      if (scenarioKey(sc) !== before) { state.batch = null; sim.scenario = sc; sim.reset(TQ.PARAMS.dayStart); }
      if (state.view3d !== was3d) setView3d(state.view3d);
      if (state.view3d) setPhoto(state.wantPhoto);
      syncControls(); lineHint(); writeHash(); // l'adresse montre le scénario réellement simulé
      if ($('dlg-compare').open) renderCompare();
    });
    $('winter').addEventListener('change', (e) => restart(sim.t, { winter: e.target.checked }));
    $('auto').addEventListener('change', (e) => { $('auto-hint').hidden = !e.target.checked; restart(sim.t, { auto: e.target.checked }); syncControls(); });
    document.querySelectorAll('.starts button').forEach((b) => b.addEventListener('click', () => {
      const h = +b.dataset.start;
      if (h * 3600 <= TQ.PARAMS.dayStart) { state.batch = null; sim.reset(TQ.PARAMS.dayStart); } else restart(h * 3600);
    }));
    for (const k of ['cars', 'roads', 'zone']) $('ly-' + k).addEventListener('change', (e) => { state.layers[k] = e.target.checked; });
    $('play').addEventListener('click', () => { state.playing = !state.playing; $('play').textContent = state.playing ? '❚❚' : '▶'; $('play').setAttribute('aria-label', state.playing ? 'Mettre en pause' : 'Reprendre'); });
    $('assumptions').innerHTML = TQ.ASSUMPTIONS.map((s) => `<h3>${s.title}</h3><ul>${s.items.map((i) => `<li>${i}</li>`).join('')}</ul>`).join('');
    $('open-assumptions').addEventListener('click', () => $('dlg-assumptions').showModal());
    $('compare-fares').addEventListener('click', () => { showFareComparison = true; renderCompare(); });
    $('open-compare').addEventListener('click', () => { failedDays.clear(); $('dlg-compare').showModal(); renderCompare(); });
    document.addEventListener('keydown', (e) => { if (e.code === 'Space' && e.target === document.body) { e.preventDefault(); $('play').click(); } });
    // mot d'accueil à la première visite
    let seen = false;
    try { seen = localStorage.getItem('qem-accueil') === '1'; } catch (e) { /* stockage indisponible */ }
    $('open-welcome').addEventListener('click', () => $('dlg-welcome').showModal());
    $('dlg-welcome').addEventListener('close', () => { try { localStorage.setItem('qem-accueil', '1'); } catch (e) { /* stockage indisponible */ } });
    if (!seen && $('dlg-welcome').showModal) $('dlg-welcome').showModal();
  }
})();
