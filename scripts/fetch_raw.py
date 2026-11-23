"""Télécharge une seule fois les données ouvertes brutes dans data/raw/ (cache disque).

Sources :
  - OpenStreetMap via Overpass (ODbL) : réseau routier majeur, interdictions de virage, rues de raccord
    des bretelles, tracé du tramway, rues résidentielles
  - Ville de Québec / Données Québec (CC-BY 4.0) : limites des arrondissements
  - MTMD : matrices de l'Enquête Origine-Destination 2023 Québec-Lévis
  - MTMD (CC-BY 4.0) : débits de circulation DJMA (pour le calage)

Usage : python scripts/fetch_raw.py
"""
import os
import sys
import time
import urllib.parse
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
RAW = os.path.join(ROOT, "data", "raw")
UA = "TransportQuebecSim/0.1 (simulation educative; requetes ponctuelles avec cache)"

# Sud, Ouest, Nord, Est
BBOX = (46.68, -71.55, 46.97, -71.08)
B = "%s,%s,%s,%s" % BBOX

OVERPASS = [
    "https://overpass.openstreetmap.fr/api/interpreter",
    "https://overpass-api.de/api/interpreter",
    "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
]

MAJOR = '"highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"'

# Rues locales (hors des classes extraites) qui raccordent au réseau une bretelle dont un bout débouche sur
# une rue residential / unclassified / service : sans elles la bretelle est un cul-de-sac à sens unique, que
# le filtre de connexité retire. Liste figée, relevée le 2026-11-21 : pour chaque bout pendant de bretelle
# (extrémité d'un way _link qu'aucun autre way de roads.json ne touche, à plus de 250 m du cadre), plus court
# chemin praticable dans le bon sens jusqu'à un noeud du réseau conservé, par les rues residential,
# unclassified et living_street, ou par les voies de service quand il n'y a rien d'autre.
# « paire » : aucun chemin vers le réseau à moins de 900 m, la rue ne relie que la sortie à l'entrée voisine.
# Non raccordés : 179279635 (rue Jean-Brillant), 391299807 et 391299808, 40537779 et 40538598 (halte du
# Cap-de-Pierre), bretelles elles-mêmes coupées du réseau conservé ; 1556767783 (voie de service privée).
CONNECTORS = [
    # 27006740 (primary_link, bout 296023926) : rue de l'Abbé-Pierre -> boulevard Wilfrid-Hamel
    473588410,
    # 27650115 (tertiary_link, bout 303683389) : rue du Périgord -> boulevard Jean-Talon Ouest
    472998482, 472998457, 472998484,
    # 27650117 (motorway_link, bout 303683397) : boulevard Jean-Talon Ouest (partie unclassified)
    472998454, 27650120, 472998455, 27650116,
    # 39919424 (primary_link, bout 479281126) : voies de service -> boulevard Guillaume-Couture
    522528800, 39919428,
    # 40247488 et 40249312 (primary_link, bouts 1175999065 et 6385012475) : rue de la Mission, paire
    330837902,
    # 103092567 (primary_link, bout 1190335509) : rue de la Concorde -> chemin du Sault
    40249041, 40245722,
    # 156833880 + 1554648390 (trunk_link, bout 1690706198) : rue de l'Agriculture, avenue de la Médecine,
    # avenue des Sciences-Humaines -> boulevard Laurier
    156833772, 156833771, 156833340, 156833347, 156833364, 156833353, 471097176,
    # 157698111 (secondary_link, bout 13205965485) : rue de Marly -> boulevard Neilson
    157697923,
    # 243502774 (trunk_link, bout 2508985900) : rues sans nom -> boulevard Sainte-Anne
    243502776, 243502773, 1526440472, 243502775,
    # 250583418 (primary_link, bout 2570072910) : rue De Saint-Vallier Est, rue du Parvis -> boulevard Charest Est
    749684073, 245807695, 471523538,
    # 373694999 (tertiary_link, bout 3771299806) : 6e Rue de l'Aéroport -> rue Principale
    483558837,
    # 888451497 (primary_link, bout 8260073626) : voies de service -> route du Président-Kennedy
    917211465, 888451495,
    # 917611532 (primary_link, bout 8522513550) : rue des Émeraudes -> boulevard Guillaume-Couture
    917611533,
    # 1017266913 (trunk_link, bout 9382959097) : rue Dugal -> boulevard Sainte-Anne
    482472038, 482472039, 39434187,
    # 1051044505 + 1565244372 + 1565244374 (motorway_link, bout 9658666494) : rue Gertrude-Roy -> boulevard Lebourgneuf
    1565593333, 1051044504, 1565593405, 1565593387, 1051044502, 492045553,
    # 1358759588 et 1358759589 (tertiary_link, bouts 12574995879 et 12574995891) : voies de service, paire
    1358759590, 1358759591,
    # 1541167529 (motorway_link, bout 14029996999) : rue de la Concorde -> chemin du Sault
    522201549, 1428262015, 1428262013, 1428262011,
    # 25366395 + 1580273766 et 25366398 + 1580273769 (motorway_link, bouts 1919546538 et 1919546540) :
    # rues Irma-Levasseur, Bourdages, de Stadaconé, Julien -> rue de la Pointe-aux-Lièvres
    1580273780, 1486463880, 1436270236, 25635520, 25465239,
    # 25366389 + 1580314738 et 25366391 + 1580314739 (motorway_link, bouts 14385004425 et 276487687) :
    # rue du Cardinal-Maurice-Roy -> rue de la Croix-Rouge
    1580315515, 1580946650, 470509520, 470509521,
]

QUERIES = {
    "roads.json": f'[out:json][timeout:180];way[{MAJOR}]({B});out geom;',
    # relations d'interdiction ou d'obligation de virage dont un membre est un tronçon des classes extraites
    "restrictions.json": f'[out:json][timeout:180];way[{MAJOR}]({B});rel(bw)["type"="restriction"];out body;',
    "connectors.json": "[out:json][timeout:120];way(id:%s);out geom;" % ",".join(map(str, CONNECTORS)),
    "tram.json": f'[out:json][timeout:120];(relation(16197598);way["proposed:railway"="tram"]({B});way["construction:railway"="tram"]({B}););out geom;',
    "residential.json": f'[out:json][timeout:180];way["highway"~"^(residential|living_street)$"]({B});out center;',
}

FILES = {
    "arrondissements.geojson": "https://www.donneesquebec.ca/recherche/dataset/5ddf584d-b73d-4cd7-b203-28c3b5364d66/resource/5c5671d1-802f-4fa4-8c18-ebd3ce3d373b/download/vdq-arrondissement.geojson",
    "eod2023_matrices_gs.xlsx": "https://cdn-contenu.quebec.ca/cdn-contenu/adm/min/transports/transports/recherches-statistiques/planification/EOD/quebec/2023/MatricesOD_GSQUE2023.xlsx",
    "djma.geojson": "https://ws.mapserver.transports.gouv.qc.ca/swtq?service=wfs&version=2.0.0&request=getfeature&typename=ms:circulation_routier&srsname=EPSG:4326&outputformat=geojson&bbox=46.68,-71.55,46.97,-71.08,urn:ogc:def:crs:EPSG::4326",
}


def fetch(url, data=None, timeout=240):
    req = urllib.request.Request(url, data=data, headers={"User-Agent": UA})
    with urllib.request.urlopen(req, timeout=timeout) as r:
        return r.read()


def main():
    os.makedirs(RAW, exist_ok=True)
    ok = True
    for name, url in FILES.items():
        path = os.path.join(RAW, name)
        if os.path.exists(path) and os.path.getsize(path) > 1000:
            print("cache", name)
            continue
        try:
            body = fetch(url)
            open(path, "wb").write(body)
            print("ok", name, len(body))
        except Exception as e:  # noqa: BLE001
            ok = False
            print("ECHEC", name, e)
    for name, q in QUERIES.items():
        path = os.path.join(RAW, name)
        if os.path.exists(path) and os.path.getsize(path) > 1000:
            print("cache", name)
            continue
        done = False
        for attempt in range(2):
            for ep in OVERPASS:
                try:
                    t = time.time()
                    body = fetch(ep, data=urllib.parse.urlencode({"data": q}).encode())
                    if not body.lstrip().startswith(b"{"):
                        raise ValueError("reponse non JSON: %r" % body[:120])
                    open(path, "wb").write(body)
                    print("ok", name, len(body), "octets via", ep, "en %.0fs" % (time.time() - t))
                    done = True
                    break
                except Exception as e:  # noqa: BLE001
                    print("  echec", ep, str(e)[:150])
                    time.sleep(5)
            if done:
                break
        ok = ok and done
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    main()
