#!/bin/bash
# Pull Cuyahoga County (Cleveland) parcels using curl
# Avoids Node fetch URL encoding issues

OUT=/var/www/title.rootz.global/data/ohio/cuyahoga-parcels.jsonl
BASE="https://gis.cuyahogacounty.us/server/rest/services/CCFO/APPRAISAL_PARCELS_CAMA_WGS84/MapServer/2/query"
FIELDS="OBJECTID%2CPARCELPIN%2Cparcel_owner%2Csecond_owner%2Cpar_addr_all%2Cpar_city%2Cpar_zip%2Cmail_addr_all%2Ctax_market_total%2Ctax_market_land%2Ctax_market_bldg%2Clast_sales_amount%2Clast_transfer_date%2Cproperty_class%2Chomestead_flag%2Cforeclosure_flag%2Ctotal_res_liv_area%2Cyear_built_str%2Cnum_bedrooms%2Cnum_full_baths%2Cnum_half_baths"
BATCH=5000
OID=0
EMPTY=0
TOTAL=0

> "$OUT"
echo "Pulling Cuyahoga County (Cleveland)..."

while [ "$EMPTY" -lt 5 ]; do
  END=$((OID + BATCH))
  URL="${BASE}?where=OBJECTID+%3E+${OID}+AND+OBJECTID+%3C%3D+${END}&outFields=${FIELDS}&returnGeometry=false&f=json"

  RESULT=$(curl -s --max-time 60 "$URL")
  COUNT=$(echo "$RESULT" | python3 -c "import sys,json; d=json.loads(sys.stdin.read()); print(len(d.get('features',[])))" 2>/dev/null)

  if [ -z "$COUNT" ] || [ "$COUNT" = "0" ]; then
    EMPTY=$((EMPTY + 1))
  else
    EMPTY=0
    echo "$RESULT" | python3 -c "
import sys,json
d=json.loads(sys.stdin.read())
for f in d.get('features',[]):
    print(json.dumps(f['attributes']))
" >> "$OUT"
    TOTAL=$((TOTAL + COUNT))
  fi

  OID=$END

  if [ $((TOTAL % 30000)) -lt $BATCH ] && [ "$TOTAL" -gt 0 ]; then
    echo "  $TOTAL records | OID: $OID"
  fi

  if [ "$OID" -gt 1500000 ]; then break; fi
  sleep 0.15
done

echo "Done: $TOTAL records ($(du -h "$OUT" | cut -f1))"
