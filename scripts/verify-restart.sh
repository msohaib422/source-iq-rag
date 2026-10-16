#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Restart-resilience check.
#
# Proves the documented project-local commands actually work twice in a row:
# start API + client, run a full workflow, stop everything, start again, run the
# same workflow. Also asserts the production build boots.
#
#   ./scripts/verify-restart.sh
# ---------------------------------------------------------------------------
set -uo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
API_PORT="${API_PORT:-5099}"
CLIENT_PORT="${CLIENT_PORT:-5199}"
LOG_DIR="$(mktemp -d)"
PASS=0
FAIL=0

cleanup() {
  [[ -n "${API_PID:-}" ]] && kill "$API_PID" 2>/dev/null
  [[ -n "${CLIENT_PID:-}" ]] && kill "$CLIENT_PID" 2>/dev/null
  wait 2>/dev/null
}
trap cleanup EXIT

ok()   { printf '  \033[32m✓\033[0m %s\n' "$1"; PASS=$((PASS+1)); }
bad()  { printf '  \033[31m✗\033[0m %s\n' "$1"; FAIL=$((FAIL+1)); }

wait_for() { # url, seconds, label
  local url="$1" limit="${2:-60}" i=0
  while (( i < limit )); do
    if curl -fsS "$url" >/dev/null 2>&1; then return 0; fi
    sleep 1; ((i++))
  done
  return 1
}

start_stack() {
  # Admin-only authentication: the single admin account is provisioned from the
  # environment on boot (registration is disabled by design). Pinning the values
  # here keeps the script independent of whatever server/.env holds.
  # MONGODB_URI is forced empty so the check always runs against the hermetic
  # in-memory store - it must never touch (or pollute) a configured Atlas
  # database with fixture documents.
  ( cd "$ROOT" && PORT=$API_PORT \
      MONGODB_URI="" \
      ADMIN_EMAIL="${ADMIN_EMAIL:-admin@gmail.com}" \
      ADMIN_PASSWORD="${ADMIN_PASSWORD:-12345678}" \
      BOOTSTRAP_ADMIN=true \
      npx tsx server/src/index.ts ) >"$LOG_DIR/api-$1.log" 2>&1 &
  API_PID=$!
  # The dev server proxies /api -> VITE_DEV_API_URL (see client/vite.config.ts),
  # so it must match the API port this script chose.
  ( cd "$ROOT/client" && VITE_DEV_API_URL="http://127.0.0.1:$API_PORT" npx vite --port "$CLIENT_PORT" --strictPort ) \
    >"$LOG_DIR/client-$1.log" 2>&1 &
  CLIENT_PID=$!

  if wait_for "http://127.0.0.1:$API_PORT/api/health" 90; then ok "API healthy on :$API_PORT"; else
    bad "API did not become healthy (see $LOG_DIR/api-$1.log)"; return 1
  fi
  if wait_for "http://127.0.0.1:$CLIENT_PORT/" 60; then ok "Client serving on :$CLIENT_PORT"; else
    bad "Client did not start (see $LOG_DIR/client-$1.log)"; return 1
  fi
}

stop_stack() {
  kill "$API_PID" "$CLIENT_PID" 2>/dev/null
  wait "$API_PID" "$CLIENT_PID" 2>/dev/null
  sleep 2
}

# Exercise the documented dev commands against a running stack.
workflow() {
  local tag="$1"
  local base="http://127.0.0.1:$API_PORT"

  # 1. admin sign-in (there is no public registration; the admin account is
  #    created automatically on first boot)
  local login
  login=$(curl -fsS -X POST "$base/api/auth/login" -H 'Content-Type: application/json' \
        -d "{\"email\":\"${ADMIN_EMAIL:-admin@gmail.com}\",\"password\":\"${ADMIN_PASSWORD:-12345678}\"}")
  local token
  token=$(printf '%s' "$login" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).token))")
  [[ -n "$token" ]] && ok "[$tag] signed in as admin + received JWT" || { bad "[$tag] admin sign-in"; return 1; }

  # 2. client actually proxies /api to the backend (same-origin check)
  local viaClient
  viaClient=$(curl -fsS "http://127.0.0.1:$CLIENT_PORT/api/health" | head -c 40)
  [[ "$viaClient" == *'"status":"ok"'* ]] \
    && ok "[$tag] Vite dev proxy forwards /api -> Express" \
    || bad "[$tag] dev proxy broken ($viaClient)"

  # 3. upload a real PDF and index it
  local pdf="$LOG_DIR/fixture-$tag.pdf"
  node -e '
    const fs=require("fs");
    const lines=["Restart Fixture Document","","The Mariana Trench reaches 10994 metres below sea level.","","Submarine pilots must withstand 1100 atmospheres at depth.","Only five crewed vessels have reached the Challenger Deep.","","Deep sea exploration uses submersible pressure hulls rated to 1500 bar."];
    const esc=s=>s.replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)");
    const content=["BT","/F1 12 Tf","72 720 Td","14 TL",...lines.map(l=>`(${esc(l)}) Tj T*`),"ET"].join("\n");
    const objs=["<< /Type /Catalog /Pages 2 0 R >>","<< /Type /Pages /Kids [3 0 R] /Count 1 >>","<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",`<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
    let pdf="%PDF-1.4\n";const offs=[];
    objs.forEach((b,i)=>{offs.push(Buffer.byteLength(pdf));pdf+=`${i+1} 0 obj\n${b}\nendobj\n`;});
    const x=Buffer.byteLength(pdf);
    pdf+=`xref\n0 ${objs.length+1}\n0000000000 65535 f \n`;for(const o of offs)pdf+=`${String(o).padStart(10,"0")} 00000 n \n`;
    pdf+=`trailer\n<< /Size ${objs.length+1} /Root 1 0 R >>\nstartxref\n${x}\n%%EOF\n`;
    fs.writeFileSync(process.argv[1], Buffer.from(pdf,"latin1"));
  ' "$pdf"

  local up
  up=$(curl -fsS -X POST "$base/api/documents" -H "Authorization: Bearer $token" -F "file=@$pdf;type=application/pdf")
  local chunks dims
  chunks=$(printf '%s' "$up" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).ingestion.chunkCount))")
  dims=$(printf '%s' "$up" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).ingestion.dimensions))")
  [[ "${chunks:-0}" -gt 0 ]] && ok "[$tag] indexed PDF into $chunks chunks @ ${dims}d" || bad "[$tag] indexing failed"

  # 4. ask a question and get a cited answer
  local ans
  ans=$(curl -fsS -X POST "$base/api/chat" -H "Authorization: Bearer $token" -H 'Content-Type: application/json' \
        -d '{"question":"How deep is the Mariana Trench?"}')
  local cites hasDeep
  cites=$(printf '%s' "$ans" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).citations.length))")
  hasDeep=$(printf '%s' "$ans" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.stringify(s).includes('10994')?'yes':'no'))")
  [[ "${cites:-0}" -gt 0 ]] && ok "[$tag] answered with $cites citation(s)" || bad "[$tag] no citations returned"
  [[ "$hasDeep" == "yes" ]] && ok "[$tag] retrieved the correct fact (10994 m)" || bad "[$tag] wrong passage retrieved"

  # 5. deep readiness probe: real 384-dim vector from the local model
  local ready
  ready=$(curl -fsS "$base/api/health/ready")
  local rdims rnorm
  rdims=$(printf '%s' "$ready" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).embedding.probe.dimensions))")
  rnorm=$(printf '%s' "$ready" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(JSON.parse(s).embedding.probe.l2Norm))")
  [[ "$rdims" == "384" ]] && ok "[$tag] readiness: ${rdims}-dim vector, L2 norm ${rnorm}" || bad "[$tag] readiness dims=$rdims"
}

echo ""
echo "  ── Run 1 (fresh start) ──────────────────────────────────────────"
start_stack run1 && workflow run1
stop_stack

echo ""
echo "  ── Run 2 (after full restart of API + client) ──────────────────"
start_stack run2 && workflow run2
stop_stack

echo ""
echo "  ── Production build boot ────────────────────────────────────────"
( cd "$ROOT" && NODE_ENV=production JWT_SECRET="$(openssl rand -hex 32)" MONGODB_URI="" \
    ADMIN_PASSWORD="${ADMIN_PASSWORD:-sourceiq-prod-admin-password}" PORT=5098 node server/dist/index.js ) >"$LOG_DIR/api-prod.log" 2>&1 &
PROD_PID=$!
if wait_for "http://127.0.0.1:5098/api/health" 90; then
  ok "compiled server/dist boots in production mode"
  curl -fsS "http://127.0.0.1:5098/api/health/ready" >/dev/null 2>&1 \
    && ok "production server passes the deep readiness probe" \
    || bad "production readiness probe failed"
else
  bad "production build failed to boot (see $LOG_DIR/api-prod.log)"
fi
kill $PROD_PID 2>/dev/null; wait $PROD_PID 2>/dev/null

echo ""
echo "  ───────────────────────────────────────────────────────────────"
printf '  %d passed, %d failed\n' "$PASS" "$FAIL"
[[ $FAIL -eq 0 ]] || { echo "  Logs: $LOG_DIR"; exit 1; }
echo "  Logs: $LOG_DIR"
exit 0