"""Télécharge une seule fois les données ouvertes brutes dans data/raw/ (cache disque).

Sources :
  - OpenStreetMap via Overpass (ODbL) : réseau routier majeur, tracé du tramway, rues résidentielles
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

QUERIES = {
    "roads.json": f'[out:json][timeout:180];way["highway"~"^(motorway|trunk|primary|secondary|tertiary)(_link)?$"]({B});out geom;',
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
