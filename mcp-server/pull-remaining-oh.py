#!/usr/bin/env python3
"""Pull Cuyahoga, Summit, Montgomery OH counties using urllib (no encoding issues)"""
import json, urllib.request, os, time, sys

DATA_DIR = '/var/www/title.rootz.global/data/ohio'

COUNTIES = [
    {
        'id': 'cuyahoga', 'name': 'Cuyahoga (Cleveland)', 'expected': 500000, 'batch': 5000,
        'base': 'https://gis.cuyahogacounty.us/server/rest/services/CCFO/APPRAISAL_PARCELS_CAMA_WGS84/MapServer/2/query',
        'fields': '*'
    },
    {
        'id': 'summit', 'name': 'Summit (Akron)', 'expected': 250000, 'batch': 3000,
        'base': 'https://scgis.summitoh.net/hosted/rest/services/parcels_web_GEODATA_Tax_Parcels/FeatureServer/0/query',
        'fields': '*'
    },
    {
        'id': 'montgomery', 'name': 'Montgomery (Dayton)', 'expected': 250000, 'batch': 2000,
        'base': 'https://gis.mcohio.org/server/rest/services/VantagePoints/AUDGIS_B1/MapServer/7/query',
        'fields': '*'
    }
]

for county in COUNTIES:
    print(f"\nPulling: {county['name']}")
    outfile = os.path.join(DATA_DIR, f"{county['id']}-parcels.jsonl")
    oid = 0
    total = 0
    empty_runs = 0
    start = time.time()

    with open(outfile, 'w') as f:
        while empty_runs < 5:
            end = oid + county['batch']
            # Build URL with proper encoding — urllib won't double-encode
            params = urllib.parse.urlencode({
                'where': f'OBJECTID > {oid} AND OBJECTID <= {end}',
                'outFields': county['fields'],
                'returnGeometry': 'false',
                'f': 'json'
            })
            url = f"{county['base']}?{params}"

            try:
                with urllib.request.urlopen(url, timeout=60) as resp:
                    data = json.loads(resp.read())

                features = data.get('features', [])
                if not features:
                    empty_runs += 1
                else:
                    empty_runs = 0
                    for feat in features:
                        f.write(json.dumps(feat['attributes']) + '\n')
                    total += len(features)

                if data.get('error'):
                    print(f"  Error at OID {oid}: {data['error'].get('message', '?')}")
                    empty_runs += 1

            except Exception as e:
                print(f"  Fetch error at OID {oid}: {e}")
                empty_runs += 1

            oid = end

            if total > 0 and total % 30000 < county['batch']:
                elapsed = time.time() - start
                rate = int(total / elapsed) if elapsed > 0 else 0
                print(f"  {total:,} records | {int(elapsed)}s | {rate}/s | OID: {oid}")

            if oid > county['expected'] * 3:
                break

            time.sleep(0.15)

    size_mb = os.path.getsize(outfile) / 1024 / 1024
    elapsed = (time.time() - start) / 60
    print(f"  Done: {total:,} records ({size_mb:.1f}MB) in {elapsed:.1f}min")

print("\n=== SUMMARY ===")
grand = 0
for c in COUNTIES:
    path = os.path.join(DATA_DIR, f"{c['id']}-parcels.jsonl")
    if os.path.exists(path):
        lines = sum(1 for _ in open(path))
        mb = os.path.getsize(path) / 1024 / 1024
        print(f"  {c['id']}: {lines:,} records ({mb:.1f}MB)")
        grand += lines
print(f"  + Franklin (493,866) + Hamilton (329,092)")
print(f"  = {grand + 493866 + 329092:,} total OH parcels")
