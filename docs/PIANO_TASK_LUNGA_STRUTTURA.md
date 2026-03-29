# Task lunga proposta: Hardening end-to-end del Core Orchestrator

## Obiettivo
Portare Giuno da una base funzionale a una piattaforma più prevedibile, osservabile e testabile, senza bloccare l'operatività corrente.

---

## Perché questa task è ad alto impatto
Quasi tutte le funzionalità passano da:
1. **Ingress Slack** (`handlers`, `listeners`)
2. **Orchestrator** (`preflight`, `intentClassifier`, `contextBuilder`, `router`)
3. **Servizi DB/Tool/Agent**

Se rinforziamo questa pipeline, migliorano insieme:
- qualità delle risposte,
- affidabilità runtime,
- tempi di debug,
- facilità di estensione di nuove skill/tool.

---

## Scope (6-8 settimane)

### Fase 1 — Baseline e metriche (settimana 1)
- Definire KPI tecnici:
  - errore per modulo,
  - tempo medio di risposta,
  - tasso fallback,
  - tasso timeout,
  - % richieste classificate come `GENERAL`.
- Aggiungere logging strutturato con `request_id` / `thread_id` su pipeline orchestrator.
- Output: dashboard operativa minima + report baseline.

### Fase 2 — Contratti e validazione input/output (settimana 2-3)
- Introdurre schema di payload per passaggi principali:
  - evento Slack normalizzato,
  - context build result,
  - router decision,
  - tool result.
- Aggiungere validazione in boundary points (con fallback sicuri).
- Output: riduzione errori da dati incompleti/malformati.

### Fase 3 — Testability e regressioni (settimana 3-5)
- Creare test suite su casi ad alto rischio:
  - RBAC,
  - contextBuilder,
  - router intent→agent,
  - integrazione DB cache fallback.
- Aggiungere smoke test di bootstrap (Slack/Supabase/OAuth prerequisites).
- Output: quality gate in CI (lint + unit + smoke).

### Fase 4 — Resilienza operativa (settimana 5-6)
- Standardizzare policy retry/timeout per servizi esterni.
- Introdurre circuit-breaker leggero su provider LLM/tool critici.
- Migliorare gestione errori utente-friendly (messaggi consistenti).
- Output: meno incidenti e degradazione controllata.

### Fase 5 — Ottimizzazione costi/latency (settimana 6-8)
- Cache strategica su query ripetitive (profile/channel/entity snapshot).
- Riduzione chiamate inutili per messaggi triviali/ack.
- Analisi prompt/context size e trimming intelligente.
- Output: minor latency e minor costo per richiesta.

---

## Deliverable finali
- Documento architetturale aggiornato (flusso reale + error policy).
- Test suite con coverage minima concordata sui moduli core.
- Checklist di release + runbook incident response.
- KPI prima/dopo con delta misurabile.

---

## Rischi principali
- Refactor troppo ampi in aree senza test.
- Migliorie tecniche senza metriche (impatto non dimostrabile).
- Aumento complessità senza linee guida comuni.

### Mitigazioni
- Iterazioni piccole, merge frequenti, feature flag per cambi sensibili.
- “No silent failure” come regola di progetto.
- Retro settimanale con confronto KPI baseline vs corrente.

---

## Come partire subito (prossimo sprint)
1. Implementare request correlation id end-to-end.
2. Definire 10 scenari golden-path + 10 scenari failure-path.
3. Mettere in CI: `node --check`, smoke bootstrap, test unitari core.
