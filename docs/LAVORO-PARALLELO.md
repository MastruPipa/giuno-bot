# Lavoro in parallelo su Giuno (Claude Code + Codex)

Due agenti possono lavorare insieme senza sovrapporsi se rispettano queste
regole. Questo file è il punto di partenza di ogni sessione: chi comincia lo
legge, aggiorna la tabella "In corso" e la rispetta.

## 1. Aree e confini

Le aree sono definite per cartelle e file. Una sessione lavora in UNA area
per volta (eccezioni: test e doc della stessa area). Se serve toccare un
file di un'altra area, prima si controlla la tabella "In corso".

| Area | File principali | Note |
|---|---|---|
| A. Conversazione e memoria | `src/services/anthropicService.js`, `src/services/slackTranscript.js`, `src/orchestrator/*`, `src/tools/toolPacks.js`, `src/tools/registry.js`, `src/services/db/actionLog.js`, `eval/*` | Il prompt di sistema e la selezione dei tool vivono qui |
| B. Slack: handler, comandi, campagne, roster | `src/handlers/slackHandlers.js`, `src/tools/slackTools.js`, `src/agents/messageCampaigns.js`, `src/jobs/teamRosterSyncJob.js`, `src/services/db/team.js`, `src/services/db/campaigns.js` | `slackHandlers.js` è il file più conteso: modifiche piccole e mirate |
| C. Daily, planner, ore | `src/handlers/dailyStandupV2.js`, `src/handlers/timeTracking*.js`, `src/handlers/weeklyPlanner.js`, `src/agents/dailyEstimator.js`, `src/services/timeRecording.js`, `src/services/db/timeLogs.js`, `src/services/workloadService.js` | Area di Codex il 10/9 (PR #134) |
| D. Progetti e dossier | `src/agents/projectDossier.js`, `src/agents/geminiNotesScanner.js`, `src/agents/projectFollowups.js`, `src/jobs/projectDedupJob.js`, `src/jobs/*ProjectSync*.js`, `src/services/projectMatcher.js`, `src/services/db/dossiers.js`, `src/services/db/projects.js`, `src/tools/projectTools.js` | |
| E. CRM e pipeline | `src/services/attioService.js`, `src/agents/pipelineFollowups.js`, `src/tools/leadsTools.js`, `src/tools/attioTools.js`, `src/orchestrator/crmCompare.js` | |
| F. Cron e infrastruttura | `src/jobs/scheduler.js`, `src/handlers/cronHandlers.js` (solo registrazioni), `src/handlers/oauthHandler.js`, `src/app.js`, `railway.json`, `package.json` | Aggiungere un cron = una riga in `cronHandlers.js`: non è un motivo per bloccare l'area |
| G. Dashboard e web | `src/giunos/*`, `src/handlers/workloadDashboard.js`, `scripts/giunos-dev.js` | Area di Codex (PR #133) |
| H. Integrazioni esterne | `src/services/mcp*.js`, `src/services/googleAuthService.js`, `src/tools/driveTools.js`, `src/tools/gmailTools.js`, `src/tools/calendarTools.js` | |
| I. Retrospettiva e auto-sviluppo | `src/agents/selfReview.js`, `scripts/eval-run.js`, `src/utils/evalRunner.js` | |

File condivisi da tutti e da toccare con prudenza: `src/handlers/cronHandlers.js`
(solo aggiunte in coda), `src/services/db/index.js` (solo export nuovi),
`supabase_migration.sql` (solo append), `src/tools/toolPacks.js` (un tool
nuovo va aggiunto al nucleo o a un pacchetto: il test lo pretende).

## 2. Regole

1. **Un ramo per sessione, piccolo, mergiato in giornata.** Più un ramo resta
   aperto più si allontana da `main`.
2. **Chi arriva secondo riunisce**: prima di aprire o aggiornare una PR si fa
   `git merge origin/main`, si risolve, si lancia `npm test` completo (non
   solo i propri test) e solo poi si pusha.
3. **Niente merge su `main` mentre l'altro ha una PR aperta sulla stessa
   area.** Se le aree sono diverse, si può.
4. **Migrazioni**: si appendono a `supabase_migration.sql` con data e
   commento, si applicano subito su Supabase (idempotenti: `IF NOT EXISTS`),
   e si scrivono nella PR. Mai rinominare o cancellare colonne senza avvisare.
5. **Tool nuovi**: definizione + esecuzione nel modulo giusto, nome nel
   nucleo o in un pacchetto di `toolPacks.js`, riga nel prompt solo se serve
   al modello per sceglierlo.
6. **Cron nuovi**: `cron.schedule(expr, fn, { timezone, name, lockTtl })` in
   `cronHandlers.js`; la funzione restituisce la promise (niente `.catch`
   interno) così errori e durate finiscono nel registro.
7. **Documentare**: ogni PR aggiunge una sezione a
   `docs/RICALIBRAZIONE_2026-09.md` (Claude) o al proprio doc (Codex), con
   cosa, perché, cosa deve fare Antonio dopo il merge.
8. **Non riscrivere ciò che l'altro ha appena fatto.** Se una cosa sembra
   sbagliata, si apre una nota nella PR o si chiede ad Antonio.

## 3. In corso

Aggiornare a inizio e fine sessione. Una riga per sessione attiva.

| Agente | Area | Ramo / PR | Da | Stato |
|---|---|---|---|---|
| Claude | D (registro delle evidenze pesate: `src/agents/lifecycleEvidence.js`, fonti canali/mail/Attio/foglio contabilità) | `claude/hopeful-dijkstra-uq0ulb` / nuova PR | 12/9 | in corso |
| Codex | G (dashboard giun.os) + C (ore, sync progetti) | #133, #134, #136, #137 mergiate; #135 (contratti) in bozza | 10/9 | in corso |

## 4. Prossimi lavori concordati (chi li prende lo scrive qui)

- Livello 2 dell'auto-sviluppo (Giuno propone il codice): area I, richiede
  token GitHub su Railway.
- Pannello di controllo esterno: area G, parte dalla dashboard giun.os.
- Costi: routing Sonnet/Opus per turno, misurato con l'eval: area A.
