#!/usr/bin/env bash
set -euo pipefail

BASE_URL="${1:-${BASE_URL:-}}"

if [[ -z "${BASE_URL}" ]]; then
  echo "Usage: BASE_URL=https://your-host bash scripts/post-deploy-check.sh"
  exit 1
fi

check_endpoint() {
  local path="$1"
  local url="${BASE_URL}${path}"
  local code
  code=$(curl -sS -o /tmp/giuno-deploy-check.out -w "%{http_code}" --max-time 8 "$url" || true)

  if [[ "$code" != "200" ]]; then
    echo "❌ ${url} -> HTTP ${code}"
    if [[ -s /tmp/giuno-deploy-check.out ]]; then
      echo "--- body preview ---"
      head -c 400 /tmp/giuno-deploy-check.out || true
      echo
      echo "--------------------"
    fi
    return 1
  fi

  echo "✅ ${url} -> HTTP 200"
}

check_endpoint "/dashboard"
check_endpoint "/metrics"

echo "✅ Post-deploy smoke check completato"
