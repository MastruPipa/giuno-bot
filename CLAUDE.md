# Giuno — istruzioni per gli agenti (Codex, Claude Code e altri)

Prima di toccare il codice leggi `docs/LAVORO-PARALLELO.md`: aree, regole di
merge, tabella "In corso". Aggiorna la tabella quando inizi e quando finisci.

Contesto rapido:
- Node 22, Slack Bolt 5 in Socket Mode, Supabase, deploy automatico su Railway a ogni merge su `main`.
- `npm test` è la suite completa (node:test), va lanciata sul codice unito con `main` prima di ogni push.
- Storia delle modifiche e decisioni: `docs/RICALIBRAZIONE_2026-09.md` (Claude), `docs/reliability-first-block.md` e `docs/giunos.md` (Codex).
- Migrazioni: append a `supabase_migration.sql`, idempotenti, applicate subito.
- Un tool nuovo va anche in `src/tools/toolPacks.js` (nucleo o pacchetto): il test di copertura lo pretende.
