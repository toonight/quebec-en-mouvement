"""Construit web/data/network.js (et data/network.json) à partir de data/raw/.

Produit :
  - graphe routier orienté (classes motorway à tertiary) : noeuds, segments, arêtes
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
# capacité par voie (véh/h), vitesse par défaut (km/h), facteur vitesse libre réelle / limite, voies par défaut (par sens)
CLASS_PARAMS = {
    "motorway": (2000, 100, 1.02, 2),
    "trunk": (1700, 80, 0.95, 2),
    "primary": (950, 50, 0.78, 2),
    "secondary": (850, 50, 0.74, 1),
    "tertiary": (700, 50, 0.70, 1),
    "motorway_link": (1500, 60, 0.95, 1),
    "link": (800, 50, 0.75, 1),
}


def road_class(hw):
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


def build_graph():
    ways = load("roads.json")["elements"]
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

    for w in ways:
        t = w["tags"]
        cls = road_class(t["highway"])
        cap_lane, v_def, f_free, lanes_def = CLASS_PARAMS[cls]
        ow = t.get("oneway", "")
        oneway = ow in ("yes", "1", "true", "-1") or t["highway"].startswith("motorway") or t.get("junction") in ("roundabout", "circular")
        if ow == "no":
            oneway = False
        reverse = ow == "-1"
        lanes_total = parse_int(t.get("lanes"), 0)
        if oneway:
            lanes = lanes_total or lanes_def
        else:
            lf = parse_int(t.get("lanes:forward"), 0)
            lanes = lf or (max(1, lanes_total // 2) if lanes_total else lanes_def)
        lanes = max(1, min(lanes, 5))
        lanes_back = lanes
        if not oneway:
            lb = parse_int(t.get("lanes:backward"), 0)
            lanes_back = max(1, min(lb or (lanes_total - lanes if lanes_total > lanes and t.get("lanes:forward") else lanes), 5))
        vmax = parse_int(t.get("maxspeed"), v_def)
        if vmax < 20 or vmax > 110:
            vmax = v_def
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
                        base = dict(seg=sid, len=round(length, 1), speed=speed, lanes=lanes, cap=cap_lane * lanes, cls=CLASSES.index(cls), name=t.get("name") or t.get("ref") or "")
                        if oneway:
                            if reverse:
                                edges.append(dict(base, a=b, b=a, rev=1))
                            else:
                                edges.append(dict(base, a=a, b=b, rev=0))
                        else:
                            edges.append(dict(base, a=a, b=b, rev=0))
                            edges.append(dict(base, a=b, b=a, rev=1, lanes=lanes_back, cap=cap_lane * lanes_back))
                start = i
    # plus grande composante fortement connexe (Kosaraju itératif)
    n = len(nodes)
    out = [[] for _ in range(n)]
    inn = [[] for _ in range(n)]
    for e in edges:
        out[e["a"]].append(e["b"])
        inn[e["b"]].append(e["a"])
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
    print(f"graphe : {len(new_nodes)} noeuds, {len(new_edges)} arêtes, {len(new_segs)} segments (composante principale {sizes[best]}/{n})")
    return new_nodes, new_segs, new_edges


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
GATES = [
    ("A-73 Nord (Stoneham)", 46.966, -71.335, {9: 0.35, 11: 0.15}), ("A-40 / R-138 Est (Côte-de-Beaupré)", 46.895, -71.090, {9: 0.30}),
    ("A-573 / R-369 (Shannon, Val-Cartier)", 46.900, -71.460, {9: 0.15}), ("A-40 Ouest (Portneuf)", 46.745, -71.545, {9: 0.20, 11: 0.25}),
    ("A-73 Sud (Beauce)", 46.684, -71.262, {10: 0.50, 11: 0.10}), ("A-20 Est (Bellechasse)", 46.775, -71.085, {10: 0.25, 11: 0.20}),
    ("A-20 Ouest (Lotbinière)", 46.713, -71.300, {10: 0.25, 11: 0.30}),
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


def build_demand(nodes, edges, zone_of):
    # noeuds « de rue » : au moins une arête non autoroutière
    street = set()
    fast = set()
    for e in edges:
        if e["cls"] in (2, 3, 4, 6):
            street.update((e["a"], e["b"]))
        if e["cls"] in (0, 1):
            fast.update((e["a"], e["b"]))
    for e in edges:
        if e["cls"] not in (0, 1):  # exclut les extrémités de bretelles et les carrefours
            fast.discard(e["a"])
            fast.discard(e["b"])
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
            if best is None or d2 < best[0]:
                best = (d2, it[2])
        if best is None:
            raise SystemExit("porte sans noeud autoroutier : " + name)
        node = best[1]
        print(f"  porte {name[:34]:34s} -> ({nodes[node][1]:.4f}, {nodes[node][0]:.4f}) à {best[0] ** 0.5 / 1000:.1f} km")
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


def main():
    nodes, segs, edges = build_graph()
    line, lpts, lcum = build_line()
    flag_corridor(edges, segs, line, lpts, lcum)
    zone_of, outlines = build_zoning()
    points, poles, gates = build_demand(nodes, edges, zone_of)
    od = read_od()
    counts = build_counts(nodes, segs, edges)
    names, name_idx = [], {}
    for e in edges:
        if e["name"] not in name_idx:
            name_idx[e["name"]] = len(names)
            names.append(e["name"])
    data = dict(
        meta=dict(built="2026-11-19", sources=["OpenStreetMap (ODbL)", "Ville de Québec (CC-BY 4.0)", "MTMD – EOD 2023", "MTMD – DJMA (CC-BY 4.0)"]),
        classes=CLASSES, zones=ZONES, nodes=nodes, segs=segs,
        edges=dict(a=[e["a"] for e in edges], b=[e["b"] for e in edges], seg=[e["seg"] for e in edges], rev=[e["rev"] for e in edges],
                   len=[e["len"] for e in edges], speed=[e["speed"] for e in edges], lanes=[e["lanes"] for e in edges], cap=[e["cap"] for e in edges],
                   cls=[e["cls"] for e in edges], cor=[e["cor"] for e in edges], name=[name_idx[e["name"]] for e in edges]),
        names=names, line=line, outlines=outlines, points=points, poles=poles, gates=gates, od=od, counts=counts,
    )
    os.makedirs(os.path.join(ROOT, "web", "data"), exist_ok=True)
    js = json.dumps(data, ensure_ascii=False, separators=(",", ":"))
    with open(os.path.join(ROOT, "data", "network.json"), "w", encoding="utf-8") as f:
        f.write(js)
    with open(os.path.join(ROOT, "web", "data", "network.js"), "w", encoding="utf-8") as f:
        f.write("window.TQ_DATA=" + js + ";\n")
    print(f"écrit : web/data/network.js ({len(js)/1e6:.2f} Mo)")


if __name__ == "__main__":
    sys.stdout.reconfigure(encoding="utf-8")
    main()
