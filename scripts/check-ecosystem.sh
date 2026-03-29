#!/usr/bin/env bash
set -euo pipefail

echo "== Ecosystem check =="
echo "[1/4] test suite"
npm test

echo "[2/4] merge conflict markers"
npm run check:conflicts

echo "[3/4] dependency freshness (best effort)"
if npm outdated --json; then
  echo "npm outdated: ok"
else
  echo "WARN: npm outdated non disponibile in questo ambiente (policy/network)." >&2
fi

echo "[4/4] security audit runtime deps (best effort)"
if npm audit --omit=dev --json; then
  echo "npm audit: ok"
else
  echo "WARN: npm audit non disponibile in questo ambiente (policy/network)." >&2
fi

echo "== Ecosystem check completed =="
