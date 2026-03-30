# Prossime azioni consigliate (prima di procedere)

## Priorità alta (consigliata subito)
1. **Integration tests end-to-end**
   - Coprire flusso reale: Slack event -> router -> tool -> risposta.
   - Obiettivo: intercettare regressioni che i test unitari non vedono.

2. **Error mapping completo nei handler**
   - Uniformare tutti i catch nei command path `/giuno` e sotto-handler.
   - Obiettivo: evitare leak di errori tecnici e risposte incoerenti.

3. **Persistenza KPI**
   - Portare metriche da in-memory a storage persistente (es. Supabase table).
   - Obiettivo: trend storici, non solo snapshot runtime.

## Priorità media
4. **Circuit breaker leggero sui provider LLM**
   - Evitare failure cascata quando un provider degrada.

5. **Runbook incident response operativo**
   - Procedure rapide per timeout, ratelimit, regressioni KB.

## Go/No-go
- Se vuoi ridurre i bug live velocemente: partire dal punto **1**.
- Se vuoi migliorare UX errori subito: partire dal punto **2**.
- Se vuoi osservabilità storica: partire dal punto **3**.
