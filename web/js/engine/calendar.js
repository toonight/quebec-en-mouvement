/* Calendrier 2026-2027 : jour de la semaine, saison, jours fériés et périodes spéciales d'une date.
   Sans dépendance ; chargé avant sim.js. Les dates sont des chaînes AAAA-MM-JJ, calculées en UTC pur
   (aucun fuseau local : une date reste la même date partout).
   Facteurs de la demande : par rapport à un jour ouvrable d'automne (septembre à novembre), la journée de l'enquête
   Origine-Destination 2023, qui vaut exactement 1 (jour sans date : résultats inchangés). Débits du ministère des
   Transports (MTMD), A-540, A-73 et A-40 : des autoroutes, appliquées à toute la demande (hypothèse). Statuts : assumptions.js.
   Sources des dates : Bureau du coroner du Québec, calendrier des jours fériés 2025-2026-2027 ; CCQ, dates des
   congés et vacances ; CSS de la Capitale, calendrier scolaire 2026-2027 ; Université Laval, session A2026. */
(function () {
  const TQ = (globalThis.TQ = globalThis.TQ || {});

  const DAY = 86400000;
  const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
  const MONTHS = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

  // kind : 'ferie' (horaire et profil d'un jour férié) ou 'ouvrable' (jour presque normal : Vendredi saint).
  // legal : jour férié selon la loi ; sinon jour chômé de la fonction publique (veilles, lendemains de Noël et du jour
  // de l'An), traité comme un férié (hypothèse).
  const H = (date, key, label, kind, legal) => ({ date, key, label, kind: kind || 'ferie', legal: legal !== false });
  const holidays = [];
  for (const [y, gf, em, pat, lab, act] of [
    [2026, '04-03', '04-06', '05-18', '09-07', '10-12'],
    [2027, '03-26', '03-29', '05-24', '09-06', '10-11'],
  ]) {
    holidays.push(
      H(`${y}-01-01`, 'jour-de-l-an', 'jour de l\'An'),
      H(`${y}-01-02`, 'lendemain-du-jour-de-l-an', 'lendemain du jour de l\'An', 'ferie', false),
      H(`${y}-${gf}`, 'vendredi-saint', 'Vendredi saint', 'ouvrable'),
      H(`${y}-${em}`, 'lundi-de-paques', 'lundi de Pâques'),
      H(`${y}-${pat}`, 'patriotes', 'Journée nationale des patriotes'),
      H(`${y}-06-24`, 'fete-nationale', 'Fête nationale'),
      H(`${y}-07-01`, 'fete-du-canada', 'fête du Canada'),
      H(`${y}-${lab}`, 'fete-du-travail', 'fête du Travail'),
      H(`${y}-${act}`, 'action-de-grace', 'Action de grâce'),
      H(`${y}-12-24`, 'veille-de-noel', 'veille de Noël', 'ferie', false),
      H(`${y}-12-25`, 'noel', 'Noël'),
      H(`${y}-12-26`, 'lendemain-de-noel', 'lendemain de Noël', 'ferie', false),
      H(`${y}-12-31`, 'veille-du-jour-de-l-an', 'veille du jour de l\'An', 'ferie', false),
    );
  }

  // périodes spéciales, bornes comprises ; assumed : bornes supposées (aucune source publiée pour ces dates)
  const S = (key, label, from, to, assumed) => ({ key, label, from, to, assumed: !!assumed });
  const specials = [
    S('retour-des-fetes', 'retour des Fêtes', '2026-01-02', '2026-01-05'),
    // vacances de la construction : CCQ, du dimanche 0 h 01 au samedi 24 h
    S('construction', 'vacances de la construction', '2026-07-19', '2026-08-01'),
    // août avant la rentrée, puis semaine de la rentrée : début des classes le 28 août 2026 (CSS de la Capitale),
    // début de session le 31 août 2026 (Université Laval)
    S('aout', 'fin de l\'été, avant la rentrée', '2026-08-02', '2026-08-23'),
    S('rentree', 'rentrée scolaire', '2026-08-24', '2026-08-31'),
    // décembre avant les Fêtes : aucune hausse de débit mesurée (pas de majoration pour le magasinage)
    S('avant-noel', 'approche de Noël', '2026-12-01', '2026-12-20'),
    S('fetes', 'période des Fêtes', '2026-12-21', '2026-12-31'),
    S('retour-des-fetes', 'retour des Fêtes', '2027-01-02', '2027-01-05'),
    // semaine de relâche scolaire 2027 (CSS de la Capitale ; celle de 2026 n'est pas vérifiée)
    S('relache', 'semaine de relâche', '2027-03-01', '2027-03-05'),
    S('construction', 'vacances de la construction', '2027-07-25', '2027-08-07'),
    // le calendrier scolaire 2027-2028 n'est pas encore publié : bornes supposées, sur le modèle de 2026
    S('aout', 'fin de l\'été, avant la rentrée', '2027-08-08', '2027-08-22', true),
    S('rentree', 'rentrée scolaire', '2027-08-23', '2027-08-31', true),
    S('avant-noel', 'approche de Noël', '2027-12-01', '2027-12-20'),
    S('fetes', 'période des Fêtes', '2027-12-21', '2027-12-31'),
  ];

  TQ.CALENDAR = { first: '2026-01-01', last: '2027-12-31', holidays, specials };

  const RE = /^(\d{4})-(\d{2})-(\d{2})$/;
  /** Date AAAA-MM-JJ -> millisecondes UTC à minuit ; erreur si la chaîne n'est pas une date réelle. */
  function parse(iso) {
    const m = typeof iso === 'string' && RE.exec(iso);
    const ms = m ? Date.UTC(+m[1], +m[2] - 1, +m[3]) : NaN;
    const d = new Date(ms);
    if (!m || !isFinite(ms) || d.getUTCFullYear() !== +m[1] || d.getUTCMonth() !== +m[2] - 1 || d.getUTCDate() !== +m[3]) {
      throw new Error(`Date refusée : « ${iso} » n'est pas une date valide au format AAAA-MM-JJ.`);
    }
    return ms;
  }
  const iso = (ms) => new Date(ms).toISOString().slice(0, 10);

  /** Date décalée de n jours, en calcul UTC pur. */
  TQ.addDays = (date, n) => iso(parse(date) + Math.round(n) * DAY);

  /** « mercredi 22 juillet 2026 » */
  TQ.formatDate = function (date) {
    const d = new Date(parse(date));
    return `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate() === 1 ? '1er' : d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  };

  const SEASONS = ['hiver', 'hiver', 'printemps', 'printemps', 'printemps', 'été', 'été', 'été', 'automne', 'automne', 'automne', 'hiver'];
  const neutralF = () => ({ A: 1, H: 1, P: 1, N: 1 });
  const same = (v) => ({ A: v, H: v, P: v, N: v });

  // ---------------------------------------------------------------- facteurs de la demande
  // Périodes de l'enquête O-D : A 6-9 h, H 9-15 h, P 15-18 h, N le reste.
  // Mois : débit moyen du mois sur l'A-540 (MTMD 2025) divisé par la moyenne de septembre à novembre. Septembre à
  // novembre imposés à 1,00 (hypothèse : la fenêtre de l'enquête O-D est la référence). Décembre : jours ouvrables du
  // 1er au 19 (MTMD, A-540). Même facteur pour les quatre périodes (hypothèse).
  const MONTH = [0.89, 0.91, 0.94, 0.99, 1.04, 1.07, 1.09, 1.06, 1, 1, 1, 0.95];
  // Périodes spéciales des jours ouvrables : elles remplacent le facteur du mois. day : facteur de la journée.
  const SPECIAL = {
    // MTMD A-540 2025, 21 juillet au 1er août contre l'automne : journée 0,98 ; 6-9 h 0,73 ; jour 1,08 ; 15-18 h 0,93.
    // Soir et nuit 1,27 : hypothèse, déduite pour que la journée fasse 0,98.
    construction: { day: 0.98, f: { A: 0.73, H: 1.08, P: 0.93, N: 1.27 } },
    // MTMD A-540 2025 : pointe du matin 0,88 du 4 au 22 août, 0,95 la semaine de la rentrée ; le reste suit le mois
    aout: { A: 0.88 },
    rentree: { A: 0.95 },
    // MTMD A-540 2025, jours ouvrables du 22 au 31 décembre : journée 0,77 ; 6-9 h 0,41 ; 15-18 h 0,76.
    // Jour, soir et nuit 0,97 : hypothèse, déduite pour que la journée fasse 0,77.
    fetes: { day: 0.77, f: { A: 0.41, H: 0.97, P: 0.76, N: 0.97 } },
    // 2 au 5 janvier : hypothèse (retour progressif, non mesuré) : journée 0,85, pointe du matin 0,60
    'retour-des-fetes': { day: 0.85, f: { A: 0.6, H: 0.93, P: 0.93, N: 0.93 } },
  };
  // Fin de semaine, total de la journée : samedi 0,88, dimanche 0,79 (MTMD : A-540, A-40 et A-73).
  // Le facteur du mois ou de la période s'y applique aussi (hypothèse : même part de fins de semaine chaque mois).
  const WEEKEND = { 6: 0.88, 0: 0.79 };
  // Jours fériés, total de la journée : MTMD A-540 2025 (un site, une année). Vendredi saint (1,06) : gardé comme un
  // jour ouvrable ordinaire. 2 janvier : non mesuré, 0,72 comme le 26 décembre (hypothèse).
  // Un férié qui tombe une fin de semaine prend le plus bas des deux facteurs (hypothèse).
  const HOLIDAY = {
    'jour-de-l-an': 0.48, 'lundi-de-paques': 0.84, patriotes: 0.73, 'fete-nationale': 0.68, 'fete-du-canada': 0.78,
    'fete-du-travail': 0.73, 'action-de-grace': 0.78, 'veille-de-noel': 0.75, noel: 0.56, 'lendemain-de-noel': 0.72,
    'veille-du-jour-de-l-an': 0.71, 'lendemain-du-jour-de-l-an': 0.72,
  };
  // Profils horaires (part de la journée par heure, de 0 h à 23 h) : MTMD 2024, A-40 à Charlesbourg, total des directions.
  // Fériés : profil du dimanche (hypothèse). Les heures de 0 h à 4 h du dimanche comprennent la nuit du samedi.
  const norm = (a) => { const s = a.reduce((x, y) => x + y, 0); return Object.freeze(a.map((v) => v / s)); };
  const PROFILE = {
    samedi: norm([0.0141, 0.0075, 0.0049, 0.0044, 0.0037, 0.0063, 0.0143, 0.0273, 0.0457, 0.0631, 0.0737, 0.0757, 0.0789, 0.0795, 0.0778, 0.0776, 0.0760, 0.0638, 0.0450, 0.0368, 0.0335, 0.0343, 0.0316, 0.0244]),
    dimanche: norm([0.0158, 0.0083, 0.0052, 0.0046, 0.0033, 0.0052, 0.0117, 0.0222, 0.0370, 0.0597, 0.0755, 0.0811, 0.0866, 0.0884, 0.0865, 0.0857, 0.0800, 0.0648, 0.0475, 0.0406, 0.0342, 0.0256, 0.0170, 0.0135]),
  };
  TQ.CALENDAR.factors = { MONTH, SPECIAL, WEEKEND, HOLIDAY, PROFILE };
  // part de chaque période dans un jour ouvrable de l'enquête O-D 2023 : sert seulement au facteur de la journée affiché
  const EOD_SHARE = { A: 0.236, H: 0.28, P: 0.319, N: 0.165 };
  const dayOf = (f) => EOD_SHARE.A * f.A + EOD_SHARE.H * f.H + EOD_SHARE.P * f.P + EOD_SHARE.N * f.N;
  // RTC, horaires des jours fériés 2026-2027 : du 28 au 30 décembre, service spécial au niveau du samedi
  // (décembre 2027 : hypothèse, sur le modèle de 2026)
  const saturdayService = (date) => { const md = date.slice(5); return md >= '12-28' && md <= '12-30'; };

  /** Description d'une journée. null : jour type d'automne, la journée de l'enquête Origine-Destination 2023
   *  (résultats actuels). Une date hors de 2026-2027 est refusée par une erreur.
   *  f : facteurs des quatre périodes d'un jour ouvrable (null quand profile est posé) ;
   *  profile : part de chaque heure (samedi, dimanche, férié) ; total : facteur de la journée ;
   *  peakLanes : voies réservées de pointe en vigueur ; service : grille horaire de la ligne ('semaine' ou 'fin-de-semaine'). */
  TQ.dayInfo = function (date) {
    if (date == null) {
      return { date: null, weekday: null, weekdayLabel: 'jour ouvrable', season: 'automne', type: 'ouvrable-automne', label: 'Jour type d\'automne', holiday: null, special: null, winter: false, f: neutralF(), profile: null, total: 1, peakLanes: true, service: 'semaine', neutral: true };
    }
    const d = new Date(parse(date));
    if (date < TQ.CALENDAR.first || date > TQ.CALENDAR.last) {
      throw new Error(`Date refusée : ${date} est hors du calendrier connu (${TQ.CALENDAR.first} au ${TQ.CALENDAR.last}).`);
    }
    const weekday = d.getUTCDay(), month = d.getUTCMonth();
    const hol = holidays.find((h) => h.date === date) || null;
    const sp = specials.find((s) => date >= s.from && date <= s.to) || null;
    const type = hol && hol.kind === 'ferie' ? 'ferie' : weekday === 6 ? 'samedi' : weekday === 0 ? 'dimanche' : 'ouvrable';
    // facteurs d'un jour ouvrable à cette date : le mois, ou la période spéciale
    const m = MONTH[month], rule = sp && SPECIAL[sp.key];
    let f = !rule ? same(m) : rule.f ? Object.assign({}, rule.f) : Object.assign(same(m), rule);
    const base = rule && rule.day != null ? rule.day : dayOf(f); // journée d'un jour ouvrable à cette date
    let profile = null, total = rule ? base : m;
    if (type !== 'ouvrable') {
      const we = base * WEEKEND[weekday]; // NaN un jour de semaine : un férié prend alors son propre facteur
      total = type === 'ferie' ? (we < HOLIDAY[hol.key] ? we : HOLIDAY[hol.key]) : we;
      profile = type === 'samedi' ? PROFILE.samedi : PROFILE.dimanche;
      f = null;
    }
    const off = type !== 'ouvrable';
    return {
      date, weekday, weekdayLabel: WEEKDAYS[weekday], season: SEASONS[month], type,
      label: hol ? hol.label : sp ? sp.label : SEASONS[month],
      holiday: hol ? hol.key : null, special: sp ? sp.key : null,
      // conditions d'hiver de décembre à mars (définition du débit journalier moyen d'hiver du MTMD)
      winter: month === 11 || month <= 2,
      f, profile, total,
      // voies réservées de pointe : du lundi au vendredi selon les balises d'OpenStreetMap, donc libres les fins de
      // semaine ; libres aussi les jours fériés selon la loi, Vendredi saint compris (comme au règlement R.C.A.2V.Q. 21,
      // « à l'exception des jours fériés ») ; les 24, 26 et 31 décembre et le 2 janvier, traités comme des fériés : hypothèse
      peakLanes: !off && !(hol && hol.legal),
      // grille de la ligne : celle de la fin de semaine les samedis, dimanches et fériés (fériés : hypothèse, horaire du
      // dimanche au RTC) et du 28 au 30 décembre (RTC, service spécial au niveau du samedi)
      service: off || saturdayService(date) ? 'fin-de-semaine' : 'semaine',
      neutral: false,
    };
  };
})();
