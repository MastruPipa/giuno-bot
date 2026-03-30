#!/usr/bin/env bash
set -euo pipefail

if rg -n "^(<<<<<<<|=======|>>>>>>>)" . --glob '!node_modules/**' --glob '!.git/**' >/tmp/merge_conflicts.txt; then
  echo "❌ Trovati marker di merge non risolti:"
  cat /tmp/merge_conflicts.txt
  exit 1
fi

echo "✅ Nessun marker di merge trovato."
