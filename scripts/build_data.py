"""Construit web/data/network.js (et data/network.json) à partir de data/raw/.

Produit :
  - graphe routier orienté (classes motorway à tertiary) : noeuds, segments, arêtes ; voies ouvertes aux autos
    par sens, voies réservées retirées (bus) et capacités réduites aux heures de pointe (peaks)
  - rues de raccord des bretelles et carrefours éclatés là où un virage est interdit (turns_off)
  - ligne du tramway (tracé OSM, relation 16197598) et 29 stations projetées sur le tracé
  - arêtes routières longeant le tracé (pour retirer une voie quand le site propre existe)
  - points de demande (domiciles = densité de rues résidentielles ; activités = pôles EOD)
  - matrices OD de l'EOD 2023 par grands secteurs (périodes et modes)
  - points de comptage DJMA du MTMD appariés au graphe (calage)

Usage : python scripts/build_data.py
"""
import json
import math
import os
import re
import sys
import zipfile
import xml.etree.ElementTree as ET
from collections import defaultdict

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
LAT0, LON0 = 46.80, -71.28
KX = 111320.0 * math.cos(math.radians(LAT0))
KY = 110574.0


def xy(lon, lat):
    return ((lon - LON0) * KX, (lat - LAT0) * KY)


def load(name):
    with open(os.path.join(RAW, name), encoding="utf-8") as f:
        return json.load(f)


# ----------------------------------------------------------------------------
# 1. Graphe routier
# ----------------------------------------------------------------------------
CLASSES = ["motorway", "trunk", "primary", "secondary", "tertiary", "motorway_link", "link"]
# capacité par voie (véh/h), vitesse par défaut (km/h), facteur vitesse libre réelle / limite,
# voies par défaut d'un sens unique, voies par défaut d'un double sens (par sens)
CLASS_PARAMS = {
    "motorway": (2000, 100, 1.02, 2, 2),
    "trunk": (1700, 80, 0.95, 2, 2),
    "primary": (950, 50, 0.78, 2, 1),
    "secondary": (850, 50, 0.74, 2, 1),
    "tertiary": (700, 50, 0.70, 2, 1),
    "motorway_link": (1500, 60, 0.95, 1, 1),
    "link": (800, 50, 0.75, 1, 1),
}
LANES_MAX = 6
# Sud, Ouest, Nord, Est : le cadre de la requête Overpass (scripts/fetch_raw.py)
BBOX = (46.68, -71.55, 46.97, -71.08)
# Exceptions par identifiant de way OSM, quand une autre source contredit OSM ou le complète.
#   inverser : sens unique à retourner ; voies : voies par sens (avant, arrière), bus comprises ;
#   bus : voies réservées par sens ; coupe : (noeud OSM, voies) pour la partie du way au-delà de ce noeud.
# Image : orthophotos du gouvernement du Québec (WMTS geoegl.msp.gouv.qc.ca, 0,20 m par pixel), consultées le
# 2026-11-21. La date de prise de vue de ces tuiles n'est pas publiée (feuillage d'été). Seuls les cas nets
# sur l'image sont inscrits.
WAY_FIXES = {
    # tertiary_link, 95 m, avenue de Gaulle vers rue de Nemours : le Référentiel québécois du réseau routier
    # (version 2026-11-01) et les Voies publiques de la Ville de Québec le donnent dans le sens contraire de
    # celui d'OSM ; l'image le confirme (voie de virage de la rue de Nemours vers l'avenue de Gaulle).
    24445788: dict(inverser=True),
    # autoroute Dufferin-Montmorency : 3 voies sur l'image (OSM : 2, entre deux tronçons à 3)
    43024531: dict(voies=(3, None)),
    # 1re Avenue : 2 voies par sens sur l'image (OSM : sans balise)
    24445805: dict(voies=(2, 2)),
    # boulevard Henri-Bourassa : 1 voie par sens et bandes cyclables sur l'image (OSM : sans balise)
    25366467: dict(voies=(1, 1)),
    # boulevard Henri-Bourassa, plus au nord : 2 voies par sens au sud, 1 par sens et bandes cyclables au nord.
    # Sur l'image la bascule est à un carrefour, vers 58 % de la longueur : coupe au noeud OSM le plus proche.
    41547715: dict(voies=(2, 2), coupe=(269455363, (1, 1))),
    # boulevard de la Colline : 1 voie par sens sur l'image (OSM : sans balise)
    27720831: dict(voies=(1, 1)),
    # route des Rivières : losanges de voie réservée dans la voie de rive des deux sens sur l'image (OSM : sens
    # arrière seulement). Horaire illisible sur l'image : réservée en permanence, comme l'autre sens dans OSM.
    # Les tronçons voisins du sens avant (915182080, 40255442) n'ont pas été regardés : la voie réservée ajoutée
    # s'arrête aux bouts de ce way.
    40255437: dict(bus=(1, 0)),
}
# Voie centrale réversible du pont de Québec (minutes depuis minuit, jour de semaine). Le MTMD décrit « une voie
# dans chaque direction et une voie centrale dont la direction varie selon l'heure de pointe », sans publier
# l'horaire. Hypothèse : 2 voies vers Québec (nord) de 6 h à 9 h, 2 voies vers Lévis (sud) de 15 h à 18 h 30,
# 1 voie par sens le reste du temps (aucune source claire sur l'affectation hors pointe).
PONT_MATIN, PONT_SOIR = (360, 540), (900, 1110)
RESERVED_MODES = ("bus", "psv", "hov", "taxi")
NO_ACCESS = ("no", "private")
# Voie qui ne sert qu'à tourner (ou qui se rabat) : choix de modèle, elle compte pour une demi-voie de capacité.
TURN_ONLY = ("left", "right", "slight_left", "slight_right", "sharp_left", "sharp_right", "reverse", "merge_to_left", "merge_to_right")
ARTERIES = ("trunk", "primary", "secondary", "tertiary")
# Rues locales de raccord des bretelles (data/raw/connectors.json) : classe « link », 1 voie par sens,
# capacité d'une voie tertiaire, vitesse libre en km/h.
CONNECTOR_SPEED = 30.0
# Arête de liaison d'un carrefour éclaté (mouvement permis) : longueur (m), vitesse (km/h) et capacité (véh/h)
# choisies pour ne rien freiner.
LINK_LEN, LINK_SPEED, LINK_CAP = 1.0, 100.0, 50000
PORT_OFFSET = 0.5  # recul des ports d'un carrefour éclaté le long de leur tronçon (m)


def road_class(hw):
    if hw == "connector":
        return "link"
    if hw == "motorway_link":
        return "motorway_link"
    if hw.endswith("_link"):
        return "link"
    return hw


def parse_int(s, default):
    if not s:
        return default
    m = re.match(r"\d+", s)
    return int(m.group(0)) if m else default


def drivable(t):
    """Faux pour un tronçon fermé aux autos : privé, interdit, réservé ou en construction.
    Les balises :conditional (fermeture saisonnière ou datée) ne ferment rien."""
    mv, mc = t.get("motor_vehicle"), t.get("motorcar")
    if mv in NO_ACCESS or mc in NO_ACCESS:
        return False
    if mv is None and mc is None and t.get("access") in NO_ACCESS:
        return False
    return t.get("construction") != "yes"


def lane_positions(value, word):
    return {i for i, v in enumerate((value or "").split("|")) if v.strip() == word}


def reserved_lanes(t, sfx):
    """Voies réservées permanentes d'un sens (sfx : "" pour un sens unique, ":forward" ou ":backward").
    Renvoie les positions interdites aux autos, les positions désignées (bus, taxi, covoiturage : une voie
    désignée pour plusieurs modes ne compte qu'une fois) et le nombre donné par lanes:bus / lanes:psv.
    Deux balises qui ne découpent pas la chaussée en autant de voies (l'une restée à l'ancienne largeur) ne
    parlent pas des mêmes positions : on ne les réunit pas, on garde le découpage qui réserve le plus de voies."""
    no = lane_positions(t.get("motor_vehicle:lanes" + sfx), "no")
    by_width = defaultdict(set)
    for m in RESERVED_MODES:
        v = t.get(m + ":lanes" + sfx)
        if v:
            by_width[v.count("|")] |= lane_positions(v, "designated")
    des = max(by_width.items(), key=lambda kv: (len(kv[1]), kv[0]), default=(0, set()))[1]
    return no, des, max(parse_int(t.get("lanes:bus" + sfx), 0), parse_int(t.get("lanes:psv" + sfx), 0))


def turn_only(t, sfx):
    """Positions des voies exclusivement de virage d'un sens (turn:lanes) et nombre de voies que la balise découpe."""
    v = t.get("turn:lanes" + sfx)
    if not v:
        return set(), 0
    lanes = [[p.strip() for p in x.split(";")] for x in v.split("|")]
    return {i for i, x in enumerate(lanes) if all(p in TURN_ONLY for p in x)}, len(lanes)


def lane_count(t, sfx):
    """Nombre de voies d'un sens d'après le découpage des balises de voies réservées (« |designated » : 2 voies) ;
    0 si aucune de ces balises n'existe pour ce sens."""
    vals = [t.get(k + ":lanes" + sfx) for k in ("motor_vehicle",) + RESERVED_MODES]
    return max((v.count("|") + 1 for v in vals if v), default=0)


def peak_spans(cond):
    """« (Mo-Fr 06:00-09:00,15:00-18:00) » -> [(360, 540), (900, 1080)] ; None si la condition n'a pas cette forme."""
    m = re.match(r"^\(?\s*Mo-Fr\s+(\d\d:\d\d-\d\d:\d\d(?:\s*,\s*\d\d:\d\d-\d\d:\d\d)*)\s*\)?$", cond.strip())
    if not m:
        return None
    spans = []
    for part in m.group(1).split(","):
        h = [int(x) for x in re.findall(r"\d\d", part)]
        spans.append((h[0] * 60 + h[1], h[2] * 60 + h[3]))
    return spans


def reserved_peaks(t, sfx):
    """Voies réservées aux heures de pointe d'un sens (clés *:conditional) : {(début, fin): [positions, nombre]}.
    None si une condition est illisible."""
    out = {}
    keys = ["motor_vehicle:lanes"] + [m + ":lanes" for m in RESERVED_MODES] + ["lanes:" + m for m in RESERVED_MODES]
    for k in keys:
        v = t.get(k + sfx + ":conditional")
        if not v:
            continue
        val, _, cond = v.partition("@")
        spans = peak_spans(cond)
        if spans is None:
            return None
        for sp in spans:
            cur = out.setdefault(sp, [set(), 0])
            if k.startswith("lanes:"):
                cur[1] = max(cur[1], parse_int(val.strip(), 0))
            else:
                cur[0] |= lane_positions(val, "no" if k.startswith("motor_vehicle") else "designated")
    return out


def way_km(w):
    g = [xy(p["lon"], p["lat"]) for p in w["geometry"]]
    return sum(math.hypot(bx - ax, by - ay) for (ax, ay), (bx, by) in zip(g, g[1:])) / 1000


def strong_components(n, arcs):
    """Composantes fortement connexes (Kosaraju itératif) : numéro de composante de chaque sommet et tailles."""
    out = [[] for _ in range(n)]
    inn = [[] for _ in range(n)]
    for a, b in arcs:
        out[a].append(b)
        inn[b].append(a)
    order, seen = [], [False] * n
    for s in range(n):
        if seen[s]:
            continue
        stack = [(s, 0)]
        seen[s] = True
        while stack:
            v, i = stack.pop()
            if i < len(out[v]):
                stack.append((v, i + 1))
                u = out[v][i]
                if not seen[u]:
                    seen[u] = True
                    stack.append((u, 0))
            else:
                order.append(v)
    comp = [-1] * n
    sizes = []
    for s in reversed(order):
        if comp[s] != -1:
            continue
        c = len(sizes)
        comp[s] = c
        stack, size = [s], 0
        while stack:
            v = stack.pop()
            size += 1
            for u in inn[v]:
                if comp[u] == -1:
                    comp[u] = c
                    stack.append(u)
        sizes.append(size)
    return comp, sizes


def closed_lanes(pos, count, lanes, left):
    """Positions des `count` voies retirées d'un sens : celles que les balises situent, sinon la voie de rive."""
    pos = set(sorted(pos)[:count])
    for i in (range(lanes) if left else range(lanes - 1, -1, -1)):
        if len(pos) >= count:
            break
        pos.add(i)
    return pos


def build_graph():
    all_ways = load("roads.json")["elements"]
    # rues locales de raccord des bretelles (liste figée de scripts/fetch_raw.py)
    known = {w["id"] for w in all_ways}
    all_ways += [dict(w, tags=dict(w["tags"], highway="connector")) for w in load("connectors.json")["elements"] if w["id"] not in known]
    missing = sorted(set(WAY_FIXES) - {w["id"] for w in all_ways})
    if missing:
        raise SystemExit(f"exceptions sur des ways absents des données brutes : {missing}")
    # tronçons fermés aux autos : hors du graphe
    ways = []
    for w in all_ways:
        if not drivable(w["tags"]):
            continue
        cut = WAY_FIXES.get(w["id"], {}).get("coupe")
        if cut:  # deux parties, coupées au noeud donné
            k = w["nodes"].index(cut[0])
            ways.append(dict(w, nodes=w["nodes"][: k + 1], geometry=w["geometry"][: k + 1]))
            ways.append(dict(w, nodes=w["nodes"][k:], geometry=w["geometry"][k:], part=1))
        else:
            ways.append(w)
    closed = [w for w in all_ways if not drivable(w["tags"])]
    print(f"tronçons fermés aux autos (privés, interdits, réservés, en construction) : {len(closed)} ways, {sum(map(way_km, closed)):.1f} km")
    use = defaultdict(int)
    for w in ways:
        for i, n in enumerate(w["nodes"]):
            use[n] += 2 if i in (0, len(w["nodes"]) - 1) else 1
    node_idx = {}
    nodes = []  # [lon, lat]
    segs = []  # géométrie partagée : liste de [lon, lat]
    edges = []  # dict

    def nid(osm_id, pt):
        if osm_id not in node_idx:
            node_idx[osm_id] = len(nodes)
            nodes.append([round(pt["lon"], 6), round(pt["lat"], 6)])
        return node_idx[osm_id]

    # --- voies par sens lues sur les balises (None : inconnu) ---
    info = []
    for w in ways:
        t = w["tags"]
        fix = WAY_FIXES.get(w["id"], {})
        conn = t["highway"] == "connector"
        ow = t.get("oneway", "")
        oneway = ow in ("yes", "1", "true", "-1") or t["highway"].startswith("motorway") or t.get("junction") in ("roundabout", "circular")
        if ow == "no":
            oneway = False
        reverse = ow == "-1"
        if fix.get("inverser"):
            if not oneway:
                raise SystemExit(f"way {w['id']} : exception « inverser » sur un tronçon qui n'est pas à sens unique")
            reverse = not reverse
        alternating = ow == "alternating" and not conn  # une seule voie pour les deux sens
        total = parse_int(t.get("lanes"), 0)
        lf, lb, both = (parse_int(t.get("lanes:" + k), 0) for k in ("forward", "backward", "both_ways"))
        fwd = back = None
        half = False
        src = "balise"
        if conn:
            fwd, back, src = 1, None if oneway else 1, "raccord"
        elif alternating:
            fwd = back = 1
        elif oneway:
            # lanes peut compter les voies de l'autre sens et la voie centrale : on ne garde que celles du sens du way
            if lf:
                fwd = lf
            elif total:
                fwd = max(1, total - lb - both)
        else:
            # la voie centrale (lanes:both_ways) ne sert à aucun des deux sens ; total impair sans détail : arrondi vers le bas
            tot = max(0, total - both)
            if not lf and not lb:  # ni lanes:forward ni lanes:backward : le découpage des voies réservées d'un sens en tient lieu
                lf, lb = lane_count(t, ":forward"), lane_count(t, ":backward")
            # 3 ou 5 voies sans détail : on ignore quel sens a la voie de plus, chacun en reçoit la moitié en capacité
            half = not lf and not lb and tot >= 3 and tot % 2 == 1
            fwd = lf or ((max(1, tot - lb) if lb else max(1, tot // 2)) if total else None)
            back = lb or ((max(1, tot - lf) if lf else max(1, tot // 2)) if total else None)
        seen = fix.get("coupe", (0, None))[1] if w.get("part") else fix.get("voies")
        if seen:  # compté sur l'image : l'emporte sur les balises
            if (seen[1] is None) != oneway:
                raise SystemExit(f"way {w['id']} : exception « voies » qui ne correspond pas au statut du tronçon")
            fwd, back, half, src = seen[0], seen[1], False, "image"
        info.append(dict(oneway=oneway, reverse=reverse, alt=alternating, fwd=fwd, back=back, half=half, conn=conn, km=way_km(w), src=src))

    # --- tronçons sans nombre de voies : héritage du voisin de même nom et de même statut, de proche en proche ---
    def unknown(k):
        return info[k]["fwd"] is None or (not info[k]["oneway"] and info[k]["back"] is None)

    at_end = defaultdict(list)
    for k, w in enumerate(ways):
        for n in {w["nodes"][0], w["nodes"][-1]}:
            at_end[n].append(k)
    todo = [k for k in range(len(ways)) if unknown(k)]
    while todo:
        found = {}
        for k in todo:
            w, name = ways[k], ways[k]["tags"].get("name")
            if not name:
                continue
            vals = []
            for n in {w["nodes"][0], w["nodes"][-1]}:
                for j in at_end[n]:
                    x = ways[j]
                    if j == k or unknown(j) or info[j]["alt"] or info[j]["conn"] or info[j]["oneway"] != info[k]["oneway"] or x["tags"].get("name") != name:
                        continue
                    # deux ways tracés tête-bêche : l'avant de l'un est l'arrière de l'autre
                    same = (w["nodes"][0] == n and x["nodes"][-1] == n) or (w["nodes"][-1] == n and x["nodes"][0] == n)
                    vals.append((info[j]["fwd"], info[j]["back"]) if same or info[k]["oneway"] else (info[j]["back"], info[j]["fwd"]))
            if vals:  # voisins en désaccord : le plus petit
                found[k] = (min(v[0] for v in vals), None if info[k]["oneway"] else min(v[1] for v in vals))
        if not found:
            break
        for k, (f, b) in found.items():
            if info[k]["fwd"] is None:
                info[k]["fwd"] = f
            if not info[k]["oneway"] and info[k]["back"] is None:
                info[k]["back"] = b
            info[k]["src"] = "héritage"
        todo = [k for k in todo if k not in found]
    for k in todo:  # sinon valeur par défaut selon la classe et le statut
        d = CLASS_PARAMS[road_class(ways[k]["tags"]["highway"])][3 if info[k]["oneway"] else 4]
        if info[k]["fwd"] is None:
            info[k]["fwd"] = d
        if not info[k]["oneway"] and info[k]["back"] is None:
            info[k]["back"] = d
        info[k]["src"] = "défaut"
    by_src = defaultdict(lambda: [0, 0.0])
    for i in info:
        by_src[i["src"]][0] += 1
        by_src[i["src"]][1] += i["km"]
    print("nombre de voies : " + " ; ".join(f"{s} {by_src[s][0]} ways, {by_src[s][1]:.1f} km" for s in ("balise", "image", "héritage", "défaut", "raccord")))
    halves = [k for k, i in enumerate(info) if i["half"]]
    print(f"double sens à nombre impair de voies sans détail (la voie de plus partagée entre les deux sens) : {len(halves)} ways, {sum(info[k]['km'] for k in halves):.1f} km")

    # --- vitesse sans balise maxspeed : celle du voisin de même nom et de même classe, de proche en proche (défaut de
    # la classe sinon). Une limite sous 30 km/h est un aménagement local (rue partagée) : elle ne se propage pas. ---
    vmax_of = [None if i["conn"] else parse_int(w["tags"].get("maxspeed"), None) for w, i in zip(ways, info)]
    v_src = ["raccord" if i["conn"] else "défaut" if v is None else "balise" for v, i in zip(vmax_of, info)]
    todo = [k for k, v in enumerate(vmax_of) if v is None and not info[k]["conn"] and ways[k]["tags"].get("name")]
    while todo:
        found = {}
        for k in todo:
            w, t = ways[k], ways[k]["tags"]
            vals = [vmax_of[j] for n in {w["nodes"][0], w["nodes"][-1]} for j in at_end[n]
                    if j != k and (vmax_of[j] or 0) >= 30 and ways[j]["tags"].get("name") == t["name"] and ways[j]["tags"]["highway"] == t["highway"]]
            if vals:  # voisins en désaccord : la plus basse
                found[k] = min(vals)
        if not found:
            break
        for k, v in found.items():
            vmax_of[k], v_src[k] = v, "héritage"
        todo = [k for k in todo if k not in found]
    by_src = defaultdict(lambda: [0, 0.0])
    for s, i in zip(v_src, info):
        by_src[s][0] += 1
        by_src[s][1] += i["km"]
    moved = sum(i["km"] for w, i, v, s in zip(ways, info, vmax_of, v_src) if s == "héritage" and v != CLASS_PARAMS[road_class(w["tags"]["highway"])][1])
    print("vitesse : " + " ; ".join(f"{s} {by_src[s][0]} ways, {by_src[s][1]:.1f} km" for s in ("balise", "héritage", "défaut", "raccord"))
          + f" ; héritage différent du défaut de la classe : {moved:.1f} km")

    skipped = set()  # voies réservées de pointe non appliquées
    turning = [set(), 0.0, 0.0, set()]  # voies de virage : ways, km de sens, voie-km retirés, ways au découpage incohérent
    for w, inf, vmax in zip(ways, info, vmax_of):
        t = w["tags"]
        fix = WAY_FIXES.get(w["id"], {})
        cls = road_class(t["highway"])
        cap_lane, v_def, f_free = CLASS_PARAMS[cls][:3]
        oneway, reverse = inf["oneway"], inf["reverse"]
        half = 0.5 if inf["half"] else 0
        # --- par sens : (voies ouvertes aux autos, voies réservées retirées, capacité, [(capacité, début, fin)]) ---
        dirs = [("", inf["fwd"])] if oneway else [(":forward", inf["fwd"]), (":backward", inf["back"])]
        per_dir = []
        if inf["conn"]:
            per_dir = [(1, 0, CLASS_PARAMS["tertiary"][0], [])] * len(dirs)
        elif inf["alt"]:
            per_dir = [(1, 0, cap_lane // 2, [])] * 2  # circulation alternée : chaque sens a la voie la moitié du temps
        else:
            cond = {sfx: reserved_peaks(t, sfx) for sfx, _ in dirs}
            if not oneway:
                # clé de pointe sans suffixe sur un double sens : elle vaut pour le sens que désignent les balises
                # permanentes du même way (bus:lanes:backward, etc.) ; indécidable sinon
                loose = reserved_peaks(t, "")
                if loose is None or loose:
                    sides = [sfx for sfx, _ in dirs if any(reserved_lanes(t, sfx))]
                    if loose and len(sides) == 1 and not cond[sides[0]]:
                        cond[sides[0]] = loose
                    else:
                        skipped.add(w["id"])
            elif cond[""] and not any(p for p, _ in cond[""].values()) and not any(reserved_lanes(t, "")) and any(reserved_lanes(t, ":backward")):
                # sens unique dont les balises situent la voie de pointe dans l'autre sens, absent de ce way. Boulevard
                # Guillaume-Couture : ces ways sont la chaussée vers l'est du boulevard dédoublé et gardent les balises
                # de l'ancien tracé à double sens ; la voie de pointe (sens arrière) est sur la chaussée opposée, qui
                # porte ses propres balises. Rien à retirer ici.
                cond[""] = {}
                skipped.add(w["id"])
            for k, (sfx, lanes) in enumerate(dirs):
                lanes = max(1, min(lanes, LANES_MAX))
                no, des, count = reserved_lanes(t, sfx)
                side = ("busway:right", "busway:left") if oneway else (("busway:right",), ("busway:left",))[k]
                if any(t.get(b) == "lane" for b in side):
                    count = max(count, 1)
                count = max(count, fix.get("bus", (0, 0))[k])
                c = cond[sfx]
                if c is None:
                    skipped.add(w["id"])
                    c = {}
                kept = set()
                if c:
                    # une voie réservée seulement en pointe reste ouverte le reste du temps : les balises
                    # permanentes du même way qui la décrivent servent à la situer, pas à la retirer
                    in_peak = set().union(*(p for p, _ in c.values()))
                    loose_count = 0 if in_peak else max(num for _, num in c.values())  # pointe donnée en nombre de voies, sans position
                    # exception : une voie que motor_vehicle:lanes ferme aux autos sans condition reste retirée, même si
                    # les balises de pointe la répètent (autoroute Robert-Bourassa : la voie réservée y prolonge celle,
                    # permanente, des tronçons voisins)
                    kept = no & in_peak
                    if count:
                        # exception : une voie que busway ou lanes:bus disent réservée et que les balises de pointe
                        # ferment aux autres modes réservés (« no ») n'est pas la voie de pointe, elle reste retirée
                        shut = [lane_positions((t.get(m + ":lanes" + sfx + ":conditional") or "").partition("@")[0], "no") for m in RESERVED_MODES]
                        kept |= des & in_peak & set().union(*shut)
                    gone = (no | des) - (in_peak - kept)
                    r = max(0, max(len(no - (in_peak - kept)), len(des - (in_peak - kept))) - loose_count)
                else:
                    gone = no | des
                    r = max(len(no), len(des), count)
                open_lanes = max(1, lanes - r)
                # Voies exclusivement de virage des artères (turn:lanes) : chacune compte pour une demi-voie de capacité,
                # edges.lanes ne change pas. Une voie déjà retirée comme réservée n'est pas comptée une seconde fois ;
                # rien si toutes les voies tournent ou si la balise ne découpe pas la chaussée en autant de voies.
                turn, cut = turn_only(t, sfx) if cls in ARTERIES else (set(), 0)
                if turn and cut != lanes:
                    turn = set()
                    turning[3].add(w["id"])
                left = oneway and t.get("busway:left") == "lane"
                gone = closed_lanes(gone, lanes - open_lanes, lanes, left)

                def cap_of(n, shut_lanes):
                    k_turn = len(turn - shut_lanes)
                    return round(cap_lane * (n + half - (0.5 * k_turn if k_turn < n else 0)))

                cap = cap_of(open_lanes, gone)
                if cap < cap_lane * (open_lanes + half):
                    turning[0].add(w["id"])
                    turning[1] += inf["km"]
                    turning[2] += inf["km"] * (open_lanes + half - cap / cap_lane)
                peaks = []
                for (start, end), (pos, num) in sorted(c.items()):
                    peak_lanes = max(1, open_lanes - max(len(pos - kept), num))
                    if peak_lanes < open_lanes:
                        peaks.append((cap_of(peak_lanes, closed_lanes(gone | (pos - kept), lanes - peak_lanes, lanes, left)), start, end))
                per_dir.append((open_lanes, lanes - open_lanes, cap, peaks))
            if not oneway and "lanes:both_ways" in t and "turn:lanes:both_ways" not in t and "reversible" in (t.get("note") or "").lower():
                # voie centrale réversible (pont de Québec) : une voie de plus vers le nord le matin, vers le sud le soir
                north = 0 if w["geometry"][-1]["lat"] > w["geometry"][0]["lat"] else 1
                for k, span in ((north, PONT_MATIN), (1 - north, PONT_SOIR)):
                    o, r, cap, peaks = per_dir[k]
                    per_dir[k] = (o, r, cap, sorted(peaks + [(cap + cap_lane,) + span], key=lambda p: p[1]))
        for _, _, _, peaks in per_dir:
            assert all(a[2] <= b[1] for a, b in zip(peaks, peaks[1:])), (w["id"], peaks)
        # --- vitesse ---
        if inf["conn"]:
            speed = CONNECTOR_SPEED
        else:
            if vmax is None:
                vmax = v_def
            if vmax < 20:
                vmax = 20
            elif vmax > 110:
                vmax = v_def
            adv = t.get("maxspeed:advisory") or ""
            if adv.isdigit():  # vitesse conseillée (courbes des bretelles) : on roule un peu au-dessus
                vmax = min(vmax, int(adv) + 10)
            speed = round(vmax * f_free, 1)
        ids, geom = w["nodes"], w["geometry"]
        start = 0
        for i in range(1, len(ids)):
            if use[ids[i]] > 1 or i == len(ids) - 1:
                pts = geom[start : i + 1]
                coords = [[round(p["lon"], 6), round(p["lat"], 6)] for p in pts]
                length = 0.0
                for a, b in zip(coords, coords[1:]):
                    ax, ay = xy(*a)
                    bx, by = xy(*b)
                    length += math.hypot(bx - ax, by - ay)
                if length >= 1.0:
                    a, b = nid(ids[start], geom[start]), nid(ids[i], geom[i])
                    if a != b:
                        sid = len(segs)
                        segs.append(coords)
                        base = dict(seg=sid, len=round(length, 1), speed=speed, cls=CLASSES.index(cls), name=t.get("name") or t.get("ref") or "", way=w["id"])
                        for k, (lanes, bus, cap, peaks) in enumerate(per_dir):
                            if (k == 1) != (oneway and reverse):
                                edges.append(dict(base, a=b, b=a, rev=1, lanes=lanes, bus=bus, cap=cap, peaks=peaks))
                            else:
                                edges.append(dict(base, a=a, b=b, rev=0, lanes=lanes, bus=bus, cap=cap, peaks=peaks))
                start = i
    if skipped:
        print(f"voies réservées de pointe non appliquées (sens indécidable ou absent du way) : {len(skipped)} ways {sorted(skipped)}")
    print(f"voies exclusivement de virage (demi-voie de capacité) : {len(turning[0])} ways, {turning[1]:.1f} km de sens, {turning[2]:.1f} voie-km de capacité retirés ; "
          f"balise turn:lanes au découpage différent du nombre de voies, ignorée : {len(turning[3])} ways")
    sinks = add_turnarounds(nodes, segs, edges)
    # plus grande composante fortement connexe
    n = len(nodes)
    comp, sizes = strong_components(n, [(e["a"], e["b"]) for e in edges])
    best = max(range(len(sizes)), key=lambda c: sizes[c])
    keep = [comp[i] == best for i in range(n)]
    remap, new_nodes = {}, []
    for i in range(n):
        if keep[i]:
            remap[i] = len(new_nodes)
            new_nodes.append(nodes[i])
    new_edges, seg_map, new_segs = [], {}, []
    for e in edges:
        if keep[e["a"]] and keep[e["b"]]:
            if e["seg"] not in seg_map:
                seg_map[e["seg"]] = len(new_segs)
                new_segs.append(segs[e["seg"]])
            new_edges.append(dict(e, a=remap[e["a"]], b=remap[e["b"]], seg=seg_map[e["seg"]]))
    lost = {w["id"] for w in ways if w["tags"]["highway"].endswith("_link")} - {e["way"] for e in new_edges}
    print(f"composante principale : {sizes[best]}/{n} noeuds ; bretelles restées hors de la composante : {len(lost)} ways")
    ends = {remap[s] for s in sinks if s in remap}
    turns_off, ports = split_turns(new_nodes, new_segs, new_edges, {osm: remap[i] for osm, i in node_idx.items() if i in remap})
    assert not ends & ports
    print(f"graphe : {len(new_nodes)} noeuds, {len(new_edges)} arêtes, {len(new_segs)} segments")
    connectors = {w["id"] for w in all_ways if w["tags"]["highway"] == "connector"}
    return new_nodes, new_segs, new_edges, dict(ends=ends, ports=ports, turns_off=turns_off, connectors=connectors)


def split_turns(nodes, segs, edges, osm_node):
    """Interdictions de virage d'OpenStreetMap (relations « restriction » à noeud via), sans rien demander au moteur :
    le carrefour est éclaté en un port d'entrée par arête entrante et un port de sortie par arête sortante, reliés
    par une courte arête de liaison pour chaque mouvement permis. no_* interdit un mouvement, only_* interdit tous
    les autres mouvements depuis le même tronçon. Sont ignorées : les restrictions à via way, conditionnelles ou
    visant d'autres véhicules, et le demi-tour sur place, qu'un plus court chemin ne fait pas.
    Renvoie les paires [arête entrante, arête sortante] interdites et l'ensemble des ports."""
    into, outof, by_way = defaultdict(list), defaultdict(list), defaultdict(list)
    for i, e in enumerate(edges):
        into[e["b"]].append(i)
        outof[e["a"]].append(i)
        by_way[e["way"]].append(i)
    why = defaultdict(int)
    todo = []  # (relation, noeud, paires interdites)
    rels = [r for r in load("restrictions.json")["elements"] if r["type"] == "relation"]
    for r in rels:
        t = r.get("tags", {})
        kind = t.get("restriction")
        if kind is None or "@" in kind:
            why["conditionnelle" if kind or "restriction:conditional" in t else "autre véhicule"] += 1
            continue
        mem = defaultdict(list)
        for m in r["members"]:
            mem[m["role"], m["type"]].append(m["ref"])
        frm, to, via = mem["from", "way"], mem["to", "way"], mem["via", "node"]
        verb = kind.split("_")[0]
        if mem["via", "way"]:
            why["via way"] += 1
        elif verb not in ("no", "only") or len(via) != 1 or not frm or not to or (verb == "only" and len(frm) + len(to) != 2):
            why["mal formée"] += 1
        elif via[0] not in osm_node or any(x not in by_way for x in frm + to):
            why["hors du graphe"] += 1
        else:
            v = osm_node[via[0]]
            ins = [[i for i in by_way[x] if edges[i]["b"] == v] for x in frm]
            outs = [[o for o in by_way[x] if edges[o]["a"] == v] for x in to]
            if any(len(x) > 1 for x in ins + outs):
                why["ambiguë (tronçon non coupé au noeud via)"] += 1
            elif not all(ins + outs):
                why["sans objet (sens de circulation)"] += 1
            else:
                if verb == "no":
                    pairs = {(i[0], o[0]) for i in ins for o in outs}
                else:
                    pairs = {(ins[0][0], o) for o in outof[v] if o != outs[0][0]}
                if all(edges[i]["seg"] == edges[o]["seg"] for i, o in pairs):
                    why["demi-tour sur place" if pairs else "sans objet (aucun autre mouvement)"] += 1
                else:
                    todo.append((r["id"], v, pairs))

    # une interdiction qui casserait la connexité forte n'est pas appliquée (graphe des mouvements entre arêtes)
    def cut_off(rules):  # noeuds touchés par une arête coupée du reste quand ces interdictions s'appliquent
        off = set().union(*(p for _, _, p in rules))
        comp, sizes = strong_components(len(edges), [(i, o) for v in list(outof) for i in into[v] for o in outof[v] if (i, o) not in off])
        best = max(range(len(sizes)), key=lambda c: sizes[c])
        return {edges[i][k] for i in range(len(edges)) if comp[i] != best for k in "ab"}

    dropped = []
    while True:
        bad = cut_off(todo)
        if not bad:
            break
        drop = [x for x in todo if x[1] in bad]
        if not drop:
            raise SystemExit("graphe des mouvements non connexe sans qu'une interdiction de virage soit en cause")
        dropped += drop
        todo = [x for x in todo if x[1] not in bad]
    for x in sorted(dropped):  # à un même carrefour, seules celles qui cassent vraiment la connexité restent écartées
        if not cut_off(todo + [x]):
            todo.append(x)
    dropped = [x for x in dropped if x not in todo]
    todo.sort()

    def dist(p, q):
        (ax, ay), (bx, by) = xy(*p), xy(*q)
        return math.hypot(bx - ax, by - ay)

    def port(s, first):
        """Recule de PORT_OFFSET (au plus le tiers du segment) le bout du segment s et renvoie ses nouvelles coordonnées."""
        c = segs[s] if first else segs[s][::-1]
        d = [dist(a, b) for a, b in zip(c, c[1:])]
        off, k = min(PORT_OFFSET, sum(d) / 3), 0
        while d[k] < off:
            off -= d[k]
            k += 1
        f = off / d[k]
        p = [round(c[k][0] + f * (c[k + 1][0] - c[k][0]), 6), round(c[k][1] + f * (c[k + 1][1] - c[k][1]), 6)]
        c = [p] + c[k + 1:]
        segs[s] = c if first else c[::-1]
        return p

    by_node = defaultdict(set)
    for _, v, pairs in todo:
        by_node[v] |= pairs
    turns_off, ports, n0, e0 = [], set(), len(nodes), len(edges)
    for v in sorted(by_node):
        # le bout d'un segment à double sens sert de port d'entrée à un sens et de port de sortie à l'autre
        at = {}
        for i in into[v] + outof[v]:
            e = edges[i]
            if e["seg"] not in at:
                at[e["seg"]] = port(e["seg"], (e["a"] == v) == (e["rev"] == 0))
        p_in, p_out = {}, {}
        for k, i in enumerate(into[v]):  # le noeud d'origine devient le premier port d'entrée
            p_in[i] = v if k == 0 else len(nodes)
            if k == 0:
                nodes[v] = list(at[edges[i]["seg"]])
            else:
                nodes.append(list(at[edges[i]["seg"]]))
        for o in outof[v]:
            p_out[o] = len(nodes)
            nodes.append(list(at[edges[o]["seg"]]))
        for i in into[v]:
            edges[i]["b"] = p_in[i]
        for o in outof[v]:
            edges[o]["a"] = p_out[o]
        ports.update(p_in.values(), p_out.values())
        for i in into[v]:
            for o in outof[v]:
                if (i, o) in by_node[v]:
                    turns_off.append([i, o])
                else:
                    segs.append([list(nodes[p_in[i]]), list(nodes[p_out[o]])])
                    edges.append(dict(seg=len(segs) - 1, len=LINK_LEN, speed=LINK_SPEED, cls=CLASSES.index("link"), name="", way=0,
                                      a=p_in[i], b=p_out[o], rev=0, lanes=1, bus=0, cap=LINK_CAP, peaks=[]))
    # contrôles : connexité forte du graphe éclaté, aucun mouvement interdit resté possible
    comp, sizes = strong_components(len(nodes), [(e["a"], e["b"]) for e in edges])
    if len(sizes) != 1:
        raise SystemExit(f"graphe éclaté non fortement connexe : {len(sizes)} composantes")
    after = defaultdict(set)
    for e in edges:
        after[e["a"]].add(e["b"])
    for i, o in turns_off:
        assert edges[o]["a"] not in after[edges[i]["b"]] and edges[o]["a"] != edges[i]["b"], (i, o)
    print(f"interdictions de virage : {len(rels)} relations, {len(todo)} appliquées ({len(turns_off)} mouvements interdits à {len(by_node)} carrefours), "
          f"{len(dropped)} écartées car elles cassent la connexité {sorted(x[0] for x in dropped)}")
    print("  ignorées : " + " ; ".join(f"{k} {n}" for k, n in sorted(why.items(), key=lambda kv: -kv[1])))
    print(f"  carrefours éclatés : {len(nodes) - n0} noeuds et {len(edges) - e0} arêtes de liaison ajoutés")
    return turns_off, ports


def add_turnarounds(nodes, segs, edges):
    """Les routes coupées par le cadre de la zone finissent en cul-de-sac à sens unique, que le filtre de
    connexité retirerait en entier. On relie chaque bout sans sortie au bout sans entrée le plus proche
    (la chaussée opposée) par une courte arête de retournement, de même gabarit que ces chaussées. Quand la chaussée opposée commence plus loin
    que 400 m, on la coupe à son point le plus proche du bout sans sortie et on y raccorde le retournement.
    Renvoie les bouts sans sortie raccordés."""
    south, west, north, east = BBOX
    indeg, outdeg, seg_use = [0] * len(nodes), [0] * len(nodes), defaultdict(int)
    for e in edges:
        outdeg[e["a"]] += 1
        indeg[e["b"]] += 1
        seg_use[e["seg"]] += 1

    def at_frame(i):
        # Hors de la zone ou à moins de 250 m de son cadre. Overpass rend les ways entiers : une route coupée finit
        # dehors. Plus loin à l'intérieur, un bout sans sortie est une bretelle vers une rue locale ou une halte.
        lon, lat = nodes[i]
        if lat < south or lat > north or lon < west or lon > east:
            return True
        return min((lat - south) * KY, (north - lat) * KY, (lon - west) * KX, (east - lon) * KX) < 250

    def dist(p, q):
        (ax, ay), (bx, by) = xy(*p), xy(*q)
        return math.hypot(bx - ax, by - ay)

    ends = [i for i in range(len(nodes)) if at_frame(i)]
    sinks = [i for i in ends if outdeg[i] == 0 and indeg[i] > 0]
    sources = [i for i in ends if indeg[i] == 0 and outdeg[i] > 0]
    first = [e for e in edges if e["a"] in set(sources) and e["rev"] == 0 and seg_use[e["seg"]] == 1]  # départs des chaussées entrantes
    added, cut, alone, done = 0, 0, [], []
    for s in sinks:
        d, q = min(((dist(nodes[s], nodes[q]), q) for q in sources), default=(1e9, -1))
        if d >= 400:
            d, e, j = min(((dist(nodes[s], p), k, j) for k, e in enumerate(first) for j, p in enumerate(segs[e["seg"]][1:-1], 1)), default=(1e9, -1, -1))
            if d >= 400:
                alone.append(s)
                continue
            # le début de la chaussée entrante, au-delà du point de retournement, est abandonné
            e = first[e]
            q = len(nodes)
            segs[e["seg"]] = segs[e["seg"]][j:]
            nodes.append(list(segs[e["seg"]][0]))
            e["a"] = q
            e["len"] = round(sum(dist(a, b) for a, b in zip(segs[e["seg"]], segs[e["seg"]][1:])), 1)
            cut += 1
        segs.append([list(nodes[s]), list(nodes[q])])
        # le retournement prolonge la route au-delà du cadre : il ne doit pas l'étrangler. Il prend la classe, la
        # vitesse, les voies et la capacité de la plus étroite des deux chaussées qu'il raccorde.
        ends_cap = [max((e for e in edges if e[k] == n), key=lambda e: e["cap"]) for k, n in (("b", s), ("a", q))]
        m = min(ends_cap, key=lambda e: e["cap"])
        edges.append(dict(seg=len(segs) - 1, len=round(max(d, 1.0), 1), speed=m["speed"], cls=m["cls"], name="", way=0,
                          a=s, b=q, rev=0, lanes=m["lanes"], bus=0, cap=m["cap"], peaks=[]))
        added += 1
        done.append(s)
    print(f"bords de la zone : {len(sinks)} bouts sans sortie, {len(sources)} bouts sans entrée, {added} arêtes de retournement (dont {cut} sur une chaussée opposée coupée)")
    for s in alone:
        print(f"  bout sans sortie resté seul (rien à moins de 400 m) : ({nodes[s][1]:.4f}, {nodes[s][0]:.4f})")
    return done


# ----------------------------------------------------------------------------
# 2. Ligne du tramway et stations
# ----------------------------------------------------------------------------
# Noms et ordre : carte officielle TramCité 2026 ; coordonnées approximatives (Wikipédia FR),
# projetées ensuite sur le tracé OSM.
STATIONS = [
    ("Le Gendre", 46.7731, -71.3531, True), ("Chaudière", 46.7736, -71.3447, False), ("McCartney", 46.7661, -71.3300, False),
    ("Pie-XII", 46.7608, -71.3203, False), ("Bégon", 46.7636, -71.3158, False), ("Duchesneau", 46.7675, -71.3100, False),
    ("Roland-Beaudin", 46.7722, -71.2992, False), ("Sainte-Foy", 46.7669, -71.2914, True), ("CHUL", 46.7697, -71.2833, False),
    ("Place Sainte-Foy", 46.7733, -71.2764, False), ("Université Laval", 46.7772, -71.2747, True), ("Desjardins", 46.7797, -71.2700, False),
    ("Myrand", 46.7836, -71.2628, False), ("Maguire", 46.7864, -71.2578, False), ("Holland", 46.7917, -71.2489, False),
    ("Collège Saint-Charles-Garnier", 46.7942, -71.2444, False), ("Belvédère", 46.7969, -71.2394, False), ("Brown", 46.8000, -71.2342, False),
    ("Cartier", 46.8042, -71.2267, False), ("Colline Parlementaire", 46.8089, -71.2175, False), ("D'Youville", 46.8119, -71.2153, False),
    ("Jean-Paul-L'Allier", 46.8133, -71.2242, False), ("Saint-Roch", 46.8189, -71.2294, True), ("9e Rue", 46.8242, -71.2322, False),
    ("Hôpital Saint-François d'Assise", 46.8275, -71.2353, False), ("18e Rue", 46.8303, -71.2381, False), ("Patro Roc-Amadour", 46.8336, -71.2414, False),
    ("Des Peupliers", 46.8383, -71.2453, False), ("Charlesbourg", 46.8419, -71.2489, True),
]


def build_line():
    els = load("tram.json")["elements"]
    rel = next(e for e in els if e["type"] == "relation")
    ways = {e["id"]: e for e in els if e["type"] == "way"}
    parts = []
    for m in rel["members"]:
        if m["type"] != "way":
            continue
        g = [(p["lon"], p["lat"]) for p in m["geometry"]]
        parts.append(dict(g=g, tunnel=ways.get(m["ref"], {}).get("tags", {}).get("tunnel") == "yes"))

    def d(p, q):
        ax, ay = xy(*p)
        bx, by = xy(*q)
        return math.hypot(ax - bx, ay - by)

    # départ : extrémité la plus proche de Le Gendre
    start_pt = (STATIONS[0][2], STATIONS[0][1])
    chain = []
    cur = None
    remaining = parts[:]
    while remaining:
        ref = cur if cur else start_pt
        best = min(((min(d(ref, p["g"][0]), d(ref, p["g"][-1])), i) for i, p in enumerate(remaining)))
        p = remaining.pop(best[1])
        if best[0] > 60 and cur:
            raise SystemExit(f"tracé non contigu : saut de {best[0]:.0f} m")
        g = p["g"] if d(ref, p["g"][0]) <= d(ref, p["g"][-1]) else p["g"][::-1]
        chain.append((g, p["tunnel"]))
        cur = g[-1]
    coords, cum, tunnel = [], [], [None, None]
    dist = 0.0
    for g, tun in chain:
        if tun:
            tunnel[0] = dist
        for i, p in enumerate(g):
            if coords and i == 0:
                dist += d(coords[-1], p)
                if d(coords[-1], p) < 0.5:
                    continue
            elif i > 0:
                dist += d(g[i - 1], p)
            coords.append(p)
            cum.append(dist)
        if tun:
            tunnel[1] = dist
    # projection des stations
    pts = [xy(*c) for c in coords]

    def project(lon, lat, lo, hi):
        px, py = xy(lon, lat)
        best = (1e18, 0.0)
        for i in range(len(pts) - 1):
            if cum[i + 1] < lo or cum[i] > hi:
                continue
            ax, ay = pts[i]
            bx, by = pts[i + 1]
            dx, dy = bx - ax, by - ay
            l2 = dx * dx + dy * dy
            t = 0 if l2 == 0 else max(0, min(1, ((px - ax) * dx + (py - ay) * dy) / l2))
            dd = math.hypot(px - ax - t * dx, py - ay - t * dy)
            s = cum[i] + t * math.sqrt(l2)
            if dd < best[0] and lo <= s <= hi:
                best = (dd, s)
        return best

    total = cum[-1]
    stations = []
    prev = -1.0
    n = len(STATIONS)
    for k, (name, lat, lon, hub) in enumerate(STATIONS):
        if k == 0:
            s, off = 0.0, 0.0
        elif k == n - 1:
            s, off = total, 0.0
        else:
            # fenêtre monotone : au moins 300 m après la station précédente
            off, s = project(lon, lat, prev + 300, total - 300 * (n - 1 - k))
        stations.append(dict(name=name, s=round(s, 1), hub=hub, off=round(off)))
        prev = s
    for st in stations:
        st["underground"] = bool(tunnel[0] is not None and tunnel[0] <= st["s"] <= tunnel[1])
    gaps = [round(b["s"] - a["s"]) for a, b in zip(stations, stations[1:])]
    print(f"ligne : {total/1000:.2f} km, tunnel {tunnel[0]/1000:.2f}-{tunnel[1]/1000:.2f} km, interstations min {min(gaps)} m, max {max(gaps)} m")
    print("  décalage projection (m) :", [(s["name"][:10], s["off"]) for s in stations if s["off"] > 250])
    return dict(coords=[[round(a, 6), round(b, 6)] for a, b in coords], cum=[round(c, 1) for c in cum], length=round(total, 1), tunnel=[round(tunnel[0], 1), round(tunnel[1], 1)], stations=stations), pts, cum


class Grid:
    def __init__(self, cell):
        self.cell = cell
        self.g = defaultdict(list)

    def add(self, x, y, item):
        self.g[(int(x // self.cell), int(y // self.cell))].append((x, y, item))

    def near(self, x, y, r):
        k = int(r // self.cell) + 1
        cx, cy = int(x // self.cell), int(y // self.cell)
        for i in range(cx - k, cx + k + 1):
            for j in range(cy - k, cy + k + 1):
                for it in self.g.get((i, j), ()):
                    if (it[0] - x) ** 2 + (it[1] - y) ** 2 <= r * r:
                        yield it


def flag_corridor(edges, segs, line, lpts, lcum):
    """Arêtes routières qui longent le tracé en surface (le site propre y retire une voie par sens)."""
    grid = Grid(100)
    for i in range(len(lpts) - 1):
        (ax, ay), (bx, by) = lpts[i], lpts[i + 1]
        steps = max(1, int(math.hypot(bx - ax, by - ay) // 20))
        for k in range(steps + 1):
            t = k / steps
            grid.add(ax + t * (bx - ax), ay + t * (by - ay), (lcum[i] + t * (lcum[i + 1] - lcum[i]), math.atan2(by - ay, bx - ax)))
    t0, t1 = line["tunnel"]
    count = 0
    km = 0.0
    for e in edges:
        e["cor"] = 0
        if e["cls"] in (0, 5) or e["len"] < 25:
            continue
        c = segs[e["seg"]]
        ok, tot = 0, 0
        for a, b in zip(c, c[1:]):
            ax, ay = xy(*a)
            bx, by = xy(*b)
            ang = math.atan2(by - ay, bx - ax)
            for t in (0.25, 0.75):
                tot += 1
                x, y = ax + t * (bx - ax), ay + t * (by - ay)
                for (_, _, (s, lang)) in grid.near(x, y, 28):
                    if t0 - 30 <= s <= t1 + 30:
                        continue
                    dd = abs((ang - lang + math.pi / 2) % math.pi - math.pi / 2)
                    if dd < math.radians(25):
                        ok += 1
                        break
        if tot and ok / tot >= 0.6:
            e["cor"] = 1
            count += 1
            km += e["len"] / 1000
    print(f"corridor : {count} arêtes ({km:.1f} km directionnels) longent le tracé en surface")


# ----------------------------------------------------------------------------
# 3. Zones, points de demande
# ----------------------------------------------------------------------------
ZONES = ["Beauport", "Charlesbourg", "Les Rivières", "La Cité-Limoilou", "La Haute-Saint-Charles", "Sainte-Foy–Sillery–Cap-Rouge",
         "Desjardins (Lévis)", "Chutes-de-la-Chaudière-Est (Lévis)", "Chutes-de-la-Chaudière-Ouest (Lévis)", "Ceinture nord", "Ceinture sud", "Hors territoire"]
ARR_TO_ZONE = {"BEA": 0, "CHA": 1, "RIV": 2, "CIL": 3, "HSC": 4, "SSC": 5}
RIVER = [(-71.56, 46.668), (-71.46, 46.705), (-71.36, 46.737), (-71.288, 46.745), (-71.235, 46.768), (-71.20, 46.800), (-71.185, 46.822), (-71.15, 46.845), (-71.07, 46.867)]

# Pôles de destination de l'EOD 2023 (déplacements attirés par jour, tableau des principales zones de
# destination) ; coordonnées placées à la main (approximatives).
POLES = [
    ("Lebourgneuf", 46.8320, -71.2975, 57600), ("Colline Parlementaire", 46.8090, -71.2165, 50400),
    ("Plateau centre de Sainte-Foy (boul. Laurier)", 46.7680, -71.2860, 47200), ("Université Laval – Cégep Sainte-Foy", 46.7810, -71.2750, 45400),
    ("Saint-Roch – Vieux-Port", 46.8150, -71.2230, 25500), ("Méga Centre Rive-Sud", 46.7370, -71.2470, 21500),
    ("Lévis centre – Président-Kennedy", 46.7930, -71.1670, 20800), ("Méga Centre Beauport", 46.8680, -71.1950, 18000),
    ("Trait-Carré – Charlesbourg", 46.8610, -71.2700, 14500), ("Boul. Wilfrid-Hamel", 46.8120, -71.2750, 14200),
    ("Vanier – Pierre-Bertrand", 46.8220, -71.2620, 12100), ("Parc industriel Colbert", 46.7850, -71.3300, 12000),
    ("Parcs Jean-Talon – Duberger", 46.8120, -71.3000, 11000), ("Méga Centre Duplessis", 46.7755, -71.3500, 10900),
    ("Armand-Viau – Les Saules", 46.8180, -71.3300, 10400), ("Cité Desjardins – UQAR", 46.8070, -71.1700, 10200),
    ("Cégep Garneau", 46.7935, -71.2620, 7000), ("Hôtel de ville de Lévis", 46.8030, -71.1780, 6700),
    ("Hôtel-Dieu de Lévis", 46.8120, -71.1720, 6000), ("Hôpital de l'Enfant-Jésus", 46.8370, -71.2260, 5800),
    ("IUCPQ – Plaza Laval", 46.7785, -71.2990, 5500), ("Sainte-Foy Ouest – Marly", 46.7570, -71.3300, 4100),
]
# Portes d'entrée du territoire modélisé (zones externes) : nom, lat, lon, {zone: poids}
# Une porte s'accroche au bout de sa route, là où elle sort de la zone (bout sans sortie portant un retournement,
# à moins de 5 km), sinon au noeud autoroutier le plus proche.
GATES = [
    ("A-73 Nord (Stoneham)", 46.966, -71.335, {9: 0.35, 11: 0.15}), ("A-40 / R-138 Est (Côte-de-Beaupré)", 46.895, -71.090, {9: 0.30}),
    ("A-573 / R-369 (Shannon, Val-Cartier)", 46.900, -71.460, {9: 0.15}), ("A-40 Ouest (Portneuf)", 46.745, -71.545, {9: 0.20, 11: 0.25}),
    ("A-73 Sud (Beauce)", 46.684, -71.262, {10: 0.50, 11: 0.10}), ("A-20 Est (Bellechasse)", 46.813, -71.066, {10: 0.25, 11: 0.20}),
    ("A-20 Ouest (Lotbinière)", 46.680, -71.340, {10: 0.25, 11: 0.30}),
]


def river_lat(lon):
    for (x0, y0), (x1, y1) in zip(RIVER, RIVER[1:]):
        if x0 <= lon <= x1:
            return y0 + (y1 - y0) * (lon - x0) / (x1 - x0)
    return RIVER[0][1] if lon < RIVER[0][0] else RIVER[-1][1]


def rings_of(geom):
    if geom["type"] == "Polygon":
        return [geom["coordinates"][0]]
    return [poly[0] for poly in geom["coordinates"]]


def in_ring(lon, lat, ring):
    inside = False
    j = len(ring) - 1
    for i in range(len(ring)):
        xi, yi = ring[i][0], ring[i][1]
        xj, yj = ring[j][0], ring[j][1]
        if (yi > lat) != (yj > lat) and lon < (xj - xi) * (lat - yi) / (yj - yi) + xi:
            inside = not inside
        j = i
    return inside


def build_zoning():
    arr = load("arrondissements.geojson")["features"]
    polys = []
    for f in arr:
        z = ARR_TO_ZONE[f["properties"]["ABREVIATION"]]
        for ring in rings_of(f["geometry"]):
            xs = [p[0] for p in ring]
            ys = [p[1] for p in ring]
            polys.append((z, ring, (min(xs), min(ys), max(xs), max(ys)), [xy(p[0], p[1]) for p in ring[::6]]))

    def zone_of(lon, lat):
        for z, ring, (x0, y0, x1, y1), _ in polys:
            if x0 <= lon <= x1 and y0 <= lat <= y1 and in_ring(lon, lat, ring):
                return z
        if lat < river_lat(lon):
            # Chutes-de-la-Chaudière-Ouest à l'ouest de la rivière Chaudière ; Desjardins à l'est de Saint-Romuald
            # et de Saint-Jean-Chrysostome (limites approximatives, placées à la main)
            chaud = -71.283 if lat > 46.715 else -71.283 + (46.715 - lat) * 0.5
            if lon < chaud:
                return 8
            return 7 if lon < (-71.215 if lat > 46.745 else -71.165) else 6
        px, py = xy(lon, lat)
        best = (1e18, 9)
        for z, _, _, sample in polys:
            for sx, sy in sample:
                dd = (sx - px) ** 2 + (sy - py) ** 2
                if dd < best[0]:
                    best = (dd, z)
        return best[1] if best[0] < 3500 ** 2 else 9

    outlines = []
    for f in arr:
        for ring in rings_of(f["geometry"]):
            outlines.append(dict(zone=ARR_TO_ZONE[f["properties"]["ABREVIATION"]], ring=[[round(p[0], 5), round(p[1], 5)] for p in ring[::3]]))
    return zone_of, outlines


def build_demand(nodes, edges, zone_of, ends, ports, connectors):
    # noeuds « de rue » : au moins une arête non autoroutière
    street = set()
    fast = set()
    real, raccord = set(), set()  # noeuds d'une vraie rue (hors classe « link »), noeuds d'une rue de raccord
    for e in edges:
        if e["cls"] in (2, 3, 4, 6):
            street.update((e["a"], e["b"]))
        if e["cls"] in (2, 3, 4):
            real.update((e["a"], e["b"]))
        if e["way"] in connectors:
            raccord.update((e["a"], e["b"]))
        if e["cls"] in (0, 1):
            fast.update((e["a"], e["b"]))
    for e in edges:
        if e["cls"] not in (0, 1):  # exclut les extrémités de bretelles et les carrefours
            fast.discard(e["a"])
            fast.discard(e["b"])
    # rien ne s'accroche à un port de carrefour éclaté : tous les mouvements n'y sont pas permis
    street -= ports
    fast -= ports
    # ni à une rue de raccord (30 km/h, une voie), sauf là où elle rejoint une vraie rue
    street -= raccord - real
    g_street, g_fast = Grid(400), Grid(400)
    for i, (lon, lat) in enumerate(nodes):
        x, y = xy(lon, lat)
        if i in street:
            g_street.add(x, y, i)
        if i in fast:
            g_fast.add(x, y, i)

    def snap(lon, lat, grid, rmax):
        x, y = xy(lon, lat)
        for r in (300, 800, rmax):
            best = min(((it[0] - x) ** 2 + (it[1] - y) ** 2, it[2]) for it in grid.near(x, y, r)) if any(True for _ in grid.near(x, y, r)) else None
            if best:
                return best[1]
        return None

    res = load("residential.json")["elements"]
    cells = defaultdict(lambda: [0, 0.0, 0.0])
    for w in res:
        c = w.get("center")
        if not c:
            continue
        x, y = xy(c["lon"], c["lat"])
        k = (int(x // 700), int(y // 700))
        cells[k][0] += len(w.get("nodes", [])) - 1 or 1
        cells[k][1] += c["lon"]
        cells[k][2] += c["lat"]
    # nombre de tronçons de rue résidentielle par cellule = indicateur de population
    counts = defaultdict(int)
    for w in res:
        c = w.get("center")
        if c:
            x, y = xy(c["lon"], c["lat"])
            counts[(int(x // 700), int(y // 700))] += 1
    pts = {}  # node -> dict

    def point(node, zone, lon, lat):
        if node not in pts:
            pts[node] = dict(node=node, zone=zone, home=0.0, act=0.0, lon=lon, lat=lat, label="")
        return pts[node]

    lost = 0
    for k, (segs_n, slon, slat) in cells.items():
        n = counts[k]
        lon, lat = slon / n, slat / n
        node = snap(lon, lat, g_street, 2500)
        if node is None:
            lost += n
            continue
        z = zone_of(lon, lat)
        p = point(node, z, nodes[node][0], nodes[node][1])
        p["home"] += segs_n
    home_total = sum(p["home"] for p in pts.values())
    pole_total = sum(p[3] for p in POLES)
    # activités diffuses (commerces et services de quartier) : 55 % des destinations hors domicile
    for p in pts.values():
        p["act"] += p["home"] / home_total * pole_total * 0.55 / 0.45
    poles_out = []
    for name, lat, lon, w in POLES:
        node = snap(lon, lat, g_street, 2500)
        z = zone_of(lon, lat)
        p = point(node, z, nodes[node][0], nodes[node][1])
        p["act"] += w
        p["label"] = name
        poles_out.append(dict(name=name, lon=lon, lat=lat, w=w, node=node, zone=z))
    gates_out = []
    for name, lat, lon, zw in GATES:
        south = lat < river_lat(lon)
        x, y = xy(lon, lat)
        best = None
        for it in g_fast.near(x, y, 7000):
            nlon, nlat = nodes[it[2]]
            if (nlat < river_lat(nlon)) != south:
                continue
            d2 = (it[0] - x) ** 2 + (it[1] - y) ** 2
            key = (it[2] not in ends or d2 > 5000 ** 2, d2)
            if best is None or key < best[0]:
                best = (key, it[2])
        if best is None:
            raise SystemExit("porte sans noeud autoroutier : " + name)
        node = best[1]
        print(f"  porte {name[:34]:34s} -> ({nodes[node][1]:.4f}, {nodes[node][0]:.4f}) à {best[0][1] ** 0.5 / 1000:.1f} km{'' if best[0][0] else ', bout de route'}")
        gates_out.append(dict(name=name, node=node, lon=nodes[node][0], lat=nodes[node][1], zones=zw))
    out = sorted(pts.values(), key=lambda p: p["node"])
    for p in out:
        p["home"] = round(p["home"], 1)
        p["act"] = round(p["act"], 1)
    byz = defaultdict(lambda: [0, 0.0, 0.0])
    for p in out:
        byz[p["zone"]][0] += 1
        byz[p["zone"]][1] += p["home"]
        byz[p["zone"]][2] += p["act"]
    print(f"demande : {len(out)} points ({lost} rues non rattachées)")
    for z in sorted(byz):
        print(f"  {ZONES[z][:28]:28s} points={byz[z][0]:4d} domiciles={byz[z][1]:7.0f} activités={byz[z][2]:8.0f}")
    return out, poles_out, gates_out


# ----------------------------------------------------------------------------
# 4. Matrices OD (EOD 2023)
# ----------------------------------------------------------------------------
def read_od():
    ns = {"m": "http://schemas.openxmlformats.org/spreadsheetml/2006/main", "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships"}
    z = zipfile.ZipFile(os.path.join(RAW, "eod2023_matrices_gs.xlsx"))

    def xml(name):
        raw = z.read(name)
        if b"<!DOCTYPE" in raw or b"<!ENTITY" in raw:  # pas de DTD ni d'entités dans un XLSX légitime
            raise SystemExit("XML inattendu dans " + name)
        return ET.fromstring(raw)

    ss = ["".join(t.itertext()) for t in xml("xl/sharedStrings.xml").findall("m:si", ns)]
    wb = xml("xl/workbook.xml")
    rels = {r.get("Id"): r.get("Target") for r in xml("xl/_rels/workbook.xml.rels")}
    sheets = {s.get("name"): rels[s.get("{%s}id" % ns["r"])] for s in wb.find("m:sheets", ns)}
    cols = "DEFGHIJKLMNO"

    def matrix(name):
        root = xml("xl/" + sheets[name].lstrip("/").replace("xl/", ""))
        rows = {}
        for row in root.iter("{%s}row" % ns["m"]):
            r = int(row.get("r"))
            if 14 <= r <= 25:
                vals = {}
                for c in row.findall("m:c", ns):
                    v = c.find("m:v", ns)
                    if v is None:
                        continue
                    col = re.match(r"[A-Z]+", c.get("r")).group(0)
                    vals[col] = ss[int(v.text)] if c.get("t") == "s" else v.text
                line = []
                for col in cols:
                    s = (vals.get(col) or "0").strip()
                    try:
                        line.append(float(s))
                    except ValueError:
                        line.append(0.0)
                rows[r] = line
        return [rows[r] for r in range(14, 26)]

    od = {}
    for per in "JAHP":
        for mode in ("TO", "AU", "TC", "NM"):
            od[per + mode] = matrix(f"M{per}X{mode}23T")
    tot = sum(map(sum, od["JTO"]))
    print(f"OD : total 24 h {tot:,.0f} ; auto {sum(map(sum, od['JAU'])):,.0f} ; TC {sum(map(sum, od['JTC'])):,.0f} ; non motorisés {sum(map(sum, od['JNM'])):,.0f}")
    return od


# ----------------------------------------------------------------------------
# 5. Comptages DJMA
# ----------------------------------------------------------------------------
def build_counts(nodes, segs, edges):
    feats = load("djma.geojson")["features"]
    grid = Grid(150)
    for ei, e in enumerate(edges):
        if e["cls"] > 2:
            continue
        c = segs[e["seg"]]
        if e["rev"]:
            c = c[::-1]
        for a, b in zip(c, c[1:]):
            ax, ay = xy(*a)
            bx, by = xy(*b)
            grid.add((ax + bx) / 2, (ay + by) / 2, (ei, math.atan2(by - ay, bx - ax)))
    out = []
    for f in feats:
        p = f["properties"]
        val = None
        for k in range(1, 5):
            s = str(p.get(f"val_djma_annee_{k}") or "").replace(" ", "")
            if s:
                try:
                    val = float(s)
                    year = int(p[f"djma_annee_{k}"])
                    break
                except ValueError:
                    pass
        if not val or val < 20000:
            continue
        g = f["geometry"]
        line = g["coordinates"] if g["type"] == "LineString" else max(g["coordinates"], key=len)
        if len(line) < 2:
            continue
        mid = len(line) // 2
        a, b = line[max(0, mid - 1)], line[min(len(line) - 1, mid)]
        if a == b:
            continue
        ax, ay = xy(a[0], a[1])
        bx, by = xy(b[0], b[1])
        mx, my, ang = (ax + bx) / 2, (ay + by) / 2, math.atan2(by - ay, bx - ax)
        best = {}
        for (x, y, (ei, eang)) in grid.near(mx, my, 90):
            dd = (ang - eang + math.pi) % (2 * math.pi) - math.pi
            side = 0 if abs(dd) < math.radians(30) else (1 if abs(abs(dd) - math.pi) < math.radians(30) else None)
            if side is None:
                continue
            d2 = (x - mx) ** 2 + (y - my) ** 2
            if side not in best or d2 < best[side][0]:
                best[side] = (d2, ei)
        if len(best) == 2:
            out.append(dict(name=f"{p['des_debut_sous_route']} → {p['des_fin_sous_route']}", lon=round((a[0] + b[0]) / 2, 5), lat=round((a[1] + b[1]) / 2, 5), djma=val, year=year, edges=[best[0][1], best[1][1]]))
    print(f"comptages DJMA appariés (deux sens, ≥ 20 000 véh/j) : {len(out)}")
    return out


# Décodeur placé à la fin de web/data/network.js : il remet window.TQ_DATA exactement comme data/network.json.
DECODER = """(function(D){var q=D.nodes,N=[],x=0,y=0,i;for(i=0;i<q.length;i+=2){x+=q[i];y+=q[i+1];N.push([x/1e6,y/1e6]);}D.nodes=N;var e=D.edges;function u(a){for(var i=1;i<a.length;i++)a[i]+=a[i-1];}u(e.a);u(e.seg);u(e.name);for(i=0;i<e.b.length;i++)e.b[i]+=e.a[i];["rev","cor","lanes","bus","cls"].forEach(function(k){e[k]=Array.from(e[k],Number);});var n=D.segs.n,d=D.segs.d,S=new Array(n.length),A=new Array(n.length),B=new Array(n.length),k=0,s;for(i=e.a.length-1;i>=0;i--){s=e.seg[i];A[s]=e.rev[i]?e.b[i]:e.a[i];B[s]=e.rev[i]?e.a[i]:e.b[i];}for(s=0;s<n.length;s++){var a=N[A[s]],b=N[B[s]],c=[[a[0],a[1]]];x=Math.round(a[0]*1e6);y=Math.round(a[1]*1e6);for(i=0;i<n[s];i++){x+=d[k++];y+=d[k++];c.push([x/1e6,y/1e6]);}c.push([b[0],b[1]]);S[s]=c;}D.segs=S;})(window.TQ_DATA);"""


def pack(data):
    """Forme compacte servie à la page (moitié moins lourde une fois compressée) : coordonnées en micro-degrés
    entiers et en différences. Chaque hypothèse est vérifiée : mieux vaut un build qui échoue qu'un fichier faux."""
    def I(v):
        n = round(v * 1e6)
        assert n / 1e6 == v, v
        return n

    def delta(a):
        return [v - p for v, p in zip(a, [0] + a[:-1])]

    def digits(a):
        assert all(type(v) is int and 0 <= v <= 9 for v in a)
        return "".join(map(str, a))

    E, nodes, segs = data["edges"], data["nodes"], data["segs"]
    o, e = dict(data), dict(E)
    flat = [I(c) for p in nodes for c in p]
    o["nodes"] = [v - (flat[i - 2] if i > 1 else 0) for i, v in enumerate(flat)]
    e.update(a=delta(E["a"]), b=[b - a for a, b in zip(E["a"], E["b"])], seg=delta(E["seg"]), name=delta(E["name"]),
             rev=digits(E["rev"]), cor=digits(E["cor"]), lanes=digits(E["lanes"]), bus=digits(E["bus"]), cls=digits(E["cls"]))
    o["edges"] = e
    ends = {}
    for a, b, s, r in zip(E["a"], E["b"], E["seg"], E["rev"]):
        ends.setdefault(s, (b, a) if r else (a, b))
    n, d = [], []
    for s, c in enumerate(segs):
        a, b = ends[s]
        assert list(c[0]) == list(nodes[a]) and list(c[-1]) == list(nodes[b]) and len(c[0]) == 2, s
        n.append(len(c) - 2)
        x, y = I(c[0][0]), I(c[0][1])
        for p in c[1:-1]:
            X, Y = I(p[0]), I(p[1])
            d += [X - x, Y - y]
            x, y = X, Y
    o["segs"] = dict(n=n, d=d)
    return o


def write_web(data):
    """Écrit web/data/network.js à partir des données complètes (celles de data/network.json)."""
    packed = json.dumps(pack(data), ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(ROOT, "web", "data", "network.js"), "w", encoding="utf-8", newline="\n") as f:
        f.write("window.TQ_DATA=" + packed + ";" + DECODER + "\n")
    print(f"écrit : web/data/network.js ({len(packed)/1e6:.2f} Mo)")


def main():
    nodes, segs, edges, extra = build_graph()
    # le moteur range les numéros d'arête de ses arbres de plus courts chemins sur 16 bits signés
    assert len(edges) < 32768, len(edges)
    line, lpts, lcum = build_line()
    flag_corridor(edges, segs, line, lpts, lcum)
    zone_of, outlines = build_zoning()
    points, poles, gates = build_demand(nodes, edges, zone_of, extra["ends"], extra["ports"], extra["connectors"])
    od = read_od()
    counts = build_counts(nodes, segs, edges)
    names, name_idx = [], {}
    for e in edges:
        if e["name"] not in name_idx:
            name_idx[e["name"]] = len(names)
            names.append(e["name"])
    data = dict(
        meta=dict(built="2026-11-21", sources=["OpenStreetMap (ODbL)", "Ville de Québec (CC-BY 4.0)", "MTMD – EOD 2023", "MTMD – DJMA (CC-BY 4.0)"]),
        classes=CLASSES, zones=ZONES, nodes=nodes, segs=segs,
        edges=dict(a=[e["a"] for e in edges], b=[e["b"] for e in edges], seg=[e["seg"] for e in edges], rev=[e["rev"] for e in edges],
                   len=[e["len"] for e in edges], speed=[e["speed"] for e in edges], lanes=[e["lanes"] for e in edges], cap=[e["cap"] for e in edges], bus=[e["bus"] for e in edges],
                   cls=[e["cls"] for e in edges], cor=[e["cor"] for e in edges], name=[name_idx[e["name"]] for e in edges]),
        # capacité réduite ou accrue à heure fixe : [arête, véh/h, minute de début, minute de fin], jour de semaine
        peaks=[[i, cap, start, end] for i, e in enumerate(edges) for cap, start, end in e["peaks"]],
        # virages interdits, appliqués par éclatement du carrefour : [arête entrante, arête sortante]
        turns_off=extra["turns_off"],
        names=names, line=line, outlines=outlines, points=points, poles=poles, gates=gates, od=od, counts=counts,
    )
    os.makedirs(os.path.join(ROOT, "web", "data"), exist_ok=True)
    js = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(ROOT, "data", "network.json"), "w", encoding="utf-8") as f:
        f.write(js)
    write_web(json.loads(js))  # relu depuis le texte : exactement ce que contient network.json


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    if "--web" in sys.argv:  # ne régénère que web/data/network.js, à partir de data/network.json
        with open(os.path.join(ROOT, "data", "network.json"), encoding="utf-8") as f:
            write_web(json.load(f))
        sys.exit(0)
    main()
