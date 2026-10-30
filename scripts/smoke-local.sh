#!/usr/bin/env bash
# Local smoke: boots the real server on a temp DB, probes health/auth/live VIN decode, runs the bench, scans logs for PII.
set -uo pipefail
cd "$(dirname "$0")/.."
set -a; source .env; set +a
TMP="${TMPDIR:-/tmp}"
export DATABASE_PATH="$TMP/cvq-smoke.sqlite" PORT=3917
rm -f "$DATABASE_PATH" "$DATABASE_PATH-wal" "$DATABASE_PATH-shm"
bun src/index.ts > "$TMP/cvq-server.log" 2>&1 &
PID=$!
trap 'kill $PID 2>/dev/null' EXIT
for _ in $(seq 1 30); do curl -sf -m 1 "http://127.0.0.1:$PORT/health" >/dev/null && break; sleep 0.2; done
B="http://127.0.0.1:$PORT"
H=(-H "x-tool-secret: $TOOL_SECRET" -H 'content-type: application/json')
echo "--- health:"; curl -s -D - "$B/health" | grep -iE '^HTTP|x-robots' ; curl -s "$B/health"; echo
echo "--- tool without secret:"; curl -s -o /dev/null -w "%{http_code}\n" -X POST "$B/tools/get_quote" -d '{}'
echo "--- ops without login:"; curl -s -o /dev/null -w "%{http_code}\n" "$B/ops"
curl -s -X POST "$B/tools/start_quote" "${H[@]}" -d '{"conversation_id":"smoke1","eval_tag":"smoke","caller_name":"Sarah Smith","zip":"08540","prior_insurance_months":36}' >/dev/null
echo "--- live NHTSA VIN decode (cold, then cached):"
for _ in 1 2; do curl -s -w "  [%{time_total}s]\n" -X POST "$B/tools/save_vehicle" "${H[@]}" -d '{"conversation_id":"smoke1","eval_tag":"smoke","vehicle_index":1,"vin":"1HGCM82633A004352","usage":"commute","annual_miles":11000}'; done
echo "--- bench:"; bun scripts/bench.ts "$B" 40 2>&1 | tail -12
echo "--- full license numbers in server log: $(grep -c 'S10000000000001' "$TMP/cvq-server.log")"
