# Hardening status (snapshot)

## ✅ Completato
- Runtime guard variabili ambiente (`src/config/runtime.js`)
- Logger strutturato + request context (`src/utils/logger.js`, `src/utils/requestContext.js`)
- Metriche con persistenza locale + endpoint `/metrics` (`src/services/metricsService.js`, `src/handlers/oauthHandler.js`)
- Retry/timeout policy + classifier Slack (`src/utils/retryPolicy.js`, `src/services/slackRetry.js`)
- Retry applicato in punti critici (`src/services/slackService.js`, `src/orchestrator/contextBuilder.js`)
- Circuit breaker leggero su Gemini (`src/utils/circuitBreaker.js`, `src/services/geminiService.js`)
- Error taxonomy + mapping user-facing (`src/errors/index.js`, `src/utils/errorResponse.js`)
- Tooling operativo (`scripts/check-conflicts.sh`, `scripts/post-deploy-check.sh`, `scripts/resolve-slackservice-conflict.sh`)
- CI quality gate (`.github/workflows/ci.yml`)
- Suite test unitari + integration smoke (`test/*.test.js`)

## 🔄 Rimane per chiudere il programma al 100%
1. Integration test più estesi sul flusso completo Slack -> router -> tool -> risposta (multi-scenario)
2. Consolidare *tutti* i catch dei sotto-command `/giuno` con mapper errori uniforme
3. Runbook incident response operativo (SLA, escalation, checklist on-call)
4. KPI persistenti su backend condiviso (Supabase) invece che solo file locale

## Stima residua
- Chiusura "production-ready": 2-4 giorni lavorativi.
- Chiusura estesa (observability storica + runbook completo): 1 settimana.
