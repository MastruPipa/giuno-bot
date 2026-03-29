# Playbook esecutivo: rafforzamento completo Giuno (implementazione guidata)

> Obiettivo: darti un piano già pronto da eseguire a blocchi, con task tecnici, file da toccare, criteri di accettazione e check operativi.

## 0) Modalità di lavoro consigliata

- Branch per fase (`hardening/fase-1`, `hardening/fase-2`, ...)
- PR piccole e verticali (max 300-500 LOC)
- Ogni PR deve avere:
  1. test,
  2. rollback plan,
  3. metrica impattata.

---

## 1) Fase A — Osservabilità end-to-end (settimana 1)

### A.1 Correlation ID globale
**Scopo:** correlare ogni richiesta tra handler, orchestrator, tool e db.

**Task**
1. Creare `src/utils/requestContext.js` con helper:
   - `createRequestContext({ userId, channelId, threadTs })`
   - `withRequestContext(ctx, fn)`
   - `getRequestContext()`
2. Agganciare il context in:
   - `src/handlers/slackHandlers.js`
   - `src/listeners/realTimeListener.js`
3. Far sì che `logger` aggiunga automaticamente `request_id` se presente.

**Accettazione**
- In una richiesta singola, i log mostrano sempre lo stesso `request_id`.
- Errori in strumenti diversi sono tracciabili alla stessa request.

### A.2 KPI tecnici minimi
**Task**
1. Creare `src/services/metricsService.js` con contatori in-memory + flush periodico.
2. Registrare metriche:
   - `request_total`
   - `request_failed`
   - `router_fallback_total`
   - `tool_timeout_total`
   - `context_unified_search_hit_rate`
3. Esportare endpoint debug semplice (oauth server o route separata).

**Accettazione**
- È possibile leggere KPI via endpoint interno.
- Dashboard base compilabile da questi dati.

---

## 2) Fase B — Contratti e validazione (settimane 2-3)

### B.1 Schema input evento Slack
**Task**
1. Introdurre `src/contracts/slackEventContract.js`.
2. Validare payload in ingresso e normalizzare campi opzionali.
3. In caso invalidità: log warn + risposta safe all'utente.

### B.2 Schema context builder output
**Task**
1. Contratto `src/contracts/contextContract.js`.
2. Validare output di `buildContext` prima del router.
3. Fallback a `minimalContext` se invalid.

### B.3 Schema tool result
**Task**
1. Creare utility `src/tools/toolResultContract.js`.
2. Ogni tool deve ritornare shape uniforme: `{ ok, data, error, meta }`.

**Accettazione (fase B)**
- Nessun crash da payload malformati.
- Router riceve sempre context valido o fallback dichiarato.

---

## 3) Fase C — Resilienza servizi esterni (settimane 3-5)

### C.1 Timeout/retry policy condivisa
**Task**
1. Consolidare in `src/utils/retryPolicy.js`:
   - `withTimeout`
   - `withRetry` (exponential backoff + jitter)
2. Applicare a:
   - Supabase RPC critiche,
   - Slack API non bloccanti,
   - provider LLM.

### C.2 Circuit breaker light
**Task**
1. `src/utils/circuitBreaker.js` per provider esterni.
2. Stati: closed/open/half-open.
3. Hook nel router per scegliere fallback provider.

### C.3 Error taxonomy
**Task**
1. Introdurre `src/errors/index.js`:
   - `UserInputError`
   - `ExternalServiceError`
   - `PermissionError`
   - `TransientError`
2. Mappare risposta utente coerente per categoria.

**Accettazione (fase C)**
- Timeout non bloccano pipeline principale.
- In outage provider, degradazione controllata senza crash cascata.

---

## 4) Fase D — Test suite robusta (settimane 4-6)

### D.1 Unit test core
**Target**
- `contextBuilder`
- `router`
- `preflight`
- `rbac`
- `db client`

### D.2 Integration test
**Scenario pack**
1. DM semplice
2. menzione in canale
3. richiesta con entity + KB
4. tool failure + fallback
5. permesso negato

### D.3 Snapshot di prompt/context
**Task**
- Snapshot test su formattazione context per evitare regressioni nascoste.

**Accettazione (fase D)**
- Coverage minima moduli core >= 65% (iniziale).
- Pipeline CI blocca merge se smoke/integration falliscono.

---

## 5) Fase E — Ottimizzazione costo e latenza (settimane 6-8)

### E.1 Cache semantica e lookup intelligenti
**Task**
1. Cache short-TTL su query ripetitive (`profile`, `channel`, `entityContext`).
2. Dedup chiamate tool nella stessa request.

### E.2 Prompt budget manager
**Task**
1. Utility `src/orchestrator/promptBudget.js`.
2. Taglio progressivo context meno rilevante.
3. Regole per token ceiling per intent.

### E.3 Ranking quality loop
**Task**
1. Loggare decision traces del router.
2. Collegare feedback utente (`thumbs up/down`) a metriche qualità.

**Accettazione (fase E)**
- Latency p95 ridotta.
- Riduzione costo medio per richiesta.

---

## 6) Backlog pronto (ticket implementabili)

### Ticket 1 — Correlation ID
- **File:** `src/utils/requestContext.js`, `src/utils/logger.js`, `src/handlers/slackHandlers.js`
- **Stima:** 1-2 giorni
- **Rischio:** basso

### Ticket 2 — Metrics service
- **File:** `src/services/metricsService.js`, `src/app.js`
- **Stima:** 2 giorni
- **Rischio:** basso

### Ticket 3 — Context contract + fallback
- **File:** `src/contracts/contextContract.js`, `src/orchestrator/contextBuilder.js`, `src/orchestrator/router.js`
- **Stima:** 2-3 giorni
- **Rischio:** medio

### Ticket 4 — Retry/timeout unificato
- **File:** `src/utils/retryPolicy.js`, `src/services/db/*.js`, `src/services/*Service.js`
- **Stima:** 3-4 giorni
- **Rischio:** medio

### Ticket 5 — Circuit breaker provider LLM
- **File:** `src/utils/circuitBreaker.js`, `src/services/anthropicService.js`, `src/services/geminiService.js`
- **Stima:** 4-5 giorni
- **Rischio:** medio-alto

---

## 7) Checklist di esecuzione per ogni PR

1. ✅ Feature flag se impatta routing.
2. ✅ Test unit/integration del blocco.
3. ✅ Logging con `request_id` dove applicabile.
4. ✅ Aggiornamento docs tecniche.
5. ✅ Comando rollback definito.

---

## 8) Sequenza consigliata di implementazione (ordine pratico)

1. Correlation ID + logger propagation
2. Metrics service + endpoint debug
3. Contratti I/O su Slack event e context
4. Retry/timeout standard
5. Circuit breaker
6. Test suite integration
7. Prompt budget + ottimizzazioni costo

---

## 9) Definizione di Done finale

- Errori diagnostici in < 10 minuti (oggi molto più alti).
- Nessun crash per payload esterno malformato.
- Copertura test core sopra soglia concordata.
- KPI affidabili e comparabili settimana su settimana.
- Riduzione misurabile di latenza/costo senza peggiorare qualità risposte.
