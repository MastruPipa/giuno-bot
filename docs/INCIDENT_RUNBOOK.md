# Incident Runbook (Giuno)

## Severity
- **SEV-1**: bot non risponde / crash continuo
- **SEV-2**: risposte degradate o tool critici KO
- **SEV-3**: errori sporadici con fallback attivo

## 1) Prime verifiche (5 minuti)
1. `npm run check:conflicts`
2. Verifica endpoint: `/dashboard`, `/metrics`
3. Controlla log recenti per `request_id` e `CIRCUIT_OPEN`

## 2) Errori Knowledge Base
- Sintomi: query KB vuote, tool error, risposte incoerenti
- Azioni:
  1. verificare `search_kb` input
  2. controllare `knowledge_base` / cache locale
  3. se necessario bypass temporaneo su risposte conservative

## 3) Timeout / Provider degradato
- Controllare stato circuit breaker Gemini
- Se circuito aperto: attendere cooldown e ridurre chiamate non essenziali

## 4) Escalation
- SEV-1: rollback immediato all'ultimo deploy stabile
- SEV-2: hotfix + monitor 30 min
- SEV-3: fix in backlog prioritario

## 5) Chiusura incidente
- Registrare root cause
- Aggiungere test regressione
- Aggiornare runbook se manca una procedura
