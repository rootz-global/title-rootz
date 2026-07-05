#!/bin/bash
# Box guardian for title.rootz.global stability. Runs every 5 min via cron.
# Addresses the Jun 19 2026 outages: a crash-looping neighbor spawned headless
# Chrome that piled up and starved the 2-core box, timing out title's endpoints.
#
# 1) Kill runaway headless-chrome (>12 min old = a stuck scraper, not a normal
#    short scrape). This caps the box-starvation class no matter which service
#    misbehaves, without touching anyone's app config.
# 2) Restart title-records only if it genuinely leaks past ~2GB (its normal
#    working set is ~1.3GB, so this fires only on real runaway memory).

MAX_CHROME_AGE=720          # seconds (12 min)
MEM_LIMIT=2100000000        # bytes (~2GB) — well above the ~1.3GB baseline
msg=""

k=0
for p in $(pgrep -f 'chrome-headless-shell|chrome-headless' 2>/dev/null); do
  e=$(ps -o etimes= -p "$p" 2>/dev/null | tr -d ' ')
  if [ -n "$e" ] && [ "$e" -gt "$MAX_CHROME_AGE" ]; then kill -9 "$p" 2>/dev/null && k=$((k+1)); fi
done
[ "$k" -gt 0 ] && msg="killed $k runaway chrome proc(s)"

mem=$(pm2 jlist 2>/dev/null | python3 -c 'import sys,json
try:
  print(next(p["monit"]["memory"] for p in json.load(sys.stdin) if p["name"]=="title-records"))
except Exception: pass' 2>/dev/null)
if [ -n "$mem" ] && [ "$mem" -gt "$MEM_LIMIT" ]; then
  pm2 restart title-records >/dev/null 2>&1 && msg="$msg; restarted title-records (mem $((mem/1048576))MB)"
fi

[ -n "$msg" ] && echo "$(date -u +%FT%TZ) guardian: $msg"
exit 0
