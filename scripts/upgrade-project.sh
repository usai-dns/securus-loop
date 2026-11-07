#!/usr/bin/env bash
# Carry one project into v2 with short synchronous calls (the Workers runtime
# does not keep a fetch handler's background work alive for a long replay).
# Usage: scripts/upgrade-project.sh <contact> <tag> [chunk=8]
# Env:   SECURUS_AGENT_URL (default https://securus-agent.usai-dlh.workers.dev), DASH_TOKEN
set -euo pipefail
contact="${1:?contact}"; tag="${2:?tag}"; chunk="${3:-8}"
base="${SECURUS_AGENT_URL:-https://securus-agent.usai-dlh.workers.dev}"
tok="${DASH_TOKEN:?DASH_TOKEN required}"
get() { curl -s --max-time 590 "$base/upgrade-project?contact=$contact&tag=$tag&token=$tok&$1"; }

echo "[$tag] step 1: sections + entries + doc-seeded state (no history, no sweep)"
get "history=0&sweep=0" | python3 -c "import json,sys; d=json.load(sys.stdin); print('   ', d.get('error') or {k:(v if k!='state' else {kk:vv for kk,vv in v.items() if kk!='keys'}) for k,v in d.get('steps',{}).items()})"

from=0
while :; do
  echo "[$tag] step 2: history replay from pair $from (chunk $chunk)"
  out=$(get "sections=0&entries=0&state=0&sweep=0&history=1&historyFrom=$from&historyLimit=$chunk")
  next=$(printf '%s' "$out" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('ERR'); sys.exit()
h=d.get('steps',{}).get('history') or {}
print('    exchanges', h.get('exchanges'), '/', h.get('total'), '| applied', h.get('applied'), '| superseded', len(h.get('superseded',[])), file=sys.stderr)
for s in h.get('superseded',[]): print('      ', s[:110], file=sys.stderr)
print(h.get('nextFrom') if h.get('nextFrom') is not None else '')")
  [ "$next" = "ERR" ] && { echo "    chunk failed (non-JSON) — retrying once"; sleep 20; continue; }
  [ -z "$next" ] && break
  from="$next"
done

echo "[$tag] step 3: consistency sweep against the registry (one section per call)"
for i in $(seq 1 12); do
  out=$(get "sections=0&entries=0&state=0&registrySweep=1&sweepLimit=1")
  more=$(printf '%s' "$out" | python3 -c "
import json,sys
try: d=json.load(sys.stdin)
except Exception: print('ERR'); sys.exit()
s=d.get('steps',{}); sw=s.get('sweep') or {}
print('    keys', len((s.get('registrySweep') or {}).get('supersededKeys',[])), '| swept', [x.get('heading','')[:35] for x in sw.get('sections',[])], '| remaining', len(sw.get('remaining',[])), '|', sw.get('note'), file=sys.stderr)
print('yes' if sw.get('remaining') else '')")
  [ "$more" = "ERR" ] && { echo "    sweep call failed (non-JSON) — retrying"; sleep 20; continue; }
  [ -z "$more" ] && break
done
echo "[$tag] done"
