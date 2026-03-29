[PIANO_SVILUPPO.md](https://github.com/user-attachments/files/26329490/PIANO_SVILUPPO.md)
# PIANO DI SVILUPPO — Giuno-Bot

> Ultimo aggiornamento: 29 marzo 2026
> Maintainer: Antonio (CEO Katania Studio)
> Repo: github.com/MastruPipa/giuno-bot
> Deploy: Railway (Socket Mode) → Supabase (eu-central-2)

---

## 1. Architettura attuale

```
Slack (Socket Mode)
  │
  ▼
app.js ─► slackHandlers ─► router.js
                              │
                   ┌──────────┼──────────┐
                   ▼          ▼          ▼
            skillRegistry  intentClassifier  contextBuilder
            (match first)  (Haiku 4.5)      (unified_search + embedding)
                   │          │
                   ▼          ▼
            executeSkill   agents/
            (Sonnet 4)     ├── generalAssistant
                           ├── dailyDigestAgent
                           ├── threadSummaryAgent
                           ├── clientRetrievalAgent
                           ├── quoteSupportAgent
                           └── historicalScanner
                              │
                              ▼
                        tools/registry.js
                        (12 moduli: slack, gmail, calendar, drive,
                         memory, profile, kb, sheets, leads,
                         quotes, web, suppliers)
                              │
                              ▼
                        Supabase + Google APIs + Anthropic + Gemini
```

**Stack**: Node.js, Slack Bolt SDK, Anthropic (Sonnet 4 + Haiku 4.5), Gemini (web search), Supabase (PostgreSQL + pgvector), Google Workspace APIs

**Modello di costo**: Sonnet 4 per agenti principali e skill, Haiku 4.5 per classificazione/scanner/autoLearn

---

## 2. Stato dei Batch

### BATCH 1 — Memoria e Knowledge Base ✅ DEPLOYATO (parziale)

**File deployati**: `src/services/anthropicService.js` (autoLearn), `src/services/knowledgeEngine.js`, `src/tools/modules/memory.js`, `src/tools/modules/kb.js`

**Cosa funziona**:
- autoLearn estrae memories, profile, KB, glossary da ogni messaggio (Haiku)
- pgvector abilitato per ricerca semantica (1536-dim)
- unified_search RPC in Supabase con fallback a embedding
- Validazione output (hallucination detection)

**Cosa manca**:
- `embeddingService.js` — servizio dedicato per generare/aggiornare embedding (patch pronta, non pushata)
- `memoryConsolidationJob.js` — job notturno che deduplica e consolida memories (patch pronta)
- `entityBackfillJob.js` — backfill entity_type su KB entries esistenti (patch pronta)
- `graphEnricherJob.js` — arricchisce il grafo relazionale (patch pronta)
- `kbQualitySweepJob.js` — pulizia periodica KB (duplicati, stale, low-confidence) (patch pronta)
- embeddingService.js deve usare OpenAI (`text-embedding-3-small`, 1536-dim) — key gia' configurata su Railway

**Patch pronte** (in `patches/`):
| File | Dimensione | Stato |
|------|-----------|-------|
| embeddingService.js | 10KB | Da pushare |
| memoryConsolidationJob.js | 12KB | Da pushare |
| entityBackfillJob.js | 9KB | Da pushare |
| graphEnricherJob.js | 10KB | Da pushare |
| kbQualitySweepJob.js | 9KB | Da pushare |

**Istruzioni**: `ISTRUZIONI_MEMORIA.md`, `PIANO_MEMORIA_V2.md`

---

### BATCH 2 — Historical Scanner ✅ DEPLOYATO (base)

**File deployati**: `src/agents/historicalScanner.js`, `src/commands/scanCommand.js`

**Cosa funziona**:
- Comando `/giuno scan` con scan incrementale
- Scansione canali con estrazione KB tramite Haiku
- Confidence scoring e validation_status

**Cosa manca**:
- Solo ~10 canali scansionati su ~78 totali (68 canali non scansionati)
- `historicalScannerV2.js` con rate limiting migliorato (patch 30KB, pronta)
- `scanCommandV2.js` con UX migliorata (patch pronta)
- Registrazione cron per scan periodici automatici

**Patch pronte**:
| File | Dimensione | Stato |
|------|-----------|-------|
| historicalScannerV2.js | 30KB | Da pushare |
| scanCommandV2.js | 5KB | Da pushare |

**Istruzioni**: `ISTRUZIONI_PUSH.md`

---

### BATCH 3 — Real-Time Listener + Drive Watcher ✅ DEPLOYATO (struttura)

**File deployati**: `src/listeners/realTimeListener.js` (stub), `src/app.js` (registra listener)

**Cosa funziona**:
- Struttura base registrata in app.js
- Listener attivo ma con funzionalità limitate

**Cosa manca**:
- `realTimeListener.js` completo — ascolta messaggi in tempo reale, estrae KB, aggiorna memories, rileva segnali PM (patch 13KB, pronta)
- `driveWatcherJob.js` — monitora modifiche Google Drive e sincronizza con KB (patch 15KB, pronta)
- `pmSignalsJob.js` — rileva segnali di project management (deadline, rischi, milestone) (patch 11KB, pronta)
- Registrazione cron per pmSignalsJob

**Patch pronte**:
| File | Dimensione | Stato |
|------|-----------|-------|
| realTimeListener.js | 13KB | Da pushare |
| driveWatcherJob.js | 15KB | Da pushare |
| pmSignalsJob.js | 11KB | Da pushare |

**Istruzioni**: `ISTRUZIONI_REALTIME.md`

---

### BATCH 4 — Sheet Scanner + CRM Tools ✅ DEPLOYATO (parziale)

**File deployati**: `src/tools/modules/sheets.js`, `src/tools/modules/leads.js`, `src/tools/modules/quotes.js`

**Cosa funziona**:
- Tool base per Google Sheets (read/write)
- Tool leads (CRM base) e quotes (preventivi)
- Rate card in Supabase

**Cosa manca**:
- `sheetScannerJob.js` — job che scansiona fogli specifici e importa dati in KB/CRM (patch 19KB, pronta)
- `crmToolsV2.js` — tool CRM potenziati con pipeline view, deal stages, activity log (patch 10KB, pronta)
- PLACEHOLDER_IDs in sheet_scan_registry — servono gli ID reali dei Google Sheets da monitorare
- `getSheetsPerUtente` mancante in googleAuthService

**Patch pronte**:
| File | Dimensione | Stato |
|------|-----------|-------|
| sheetScannerJob.js | 19KB | Da pushare |
| crmToolsV2.js | 10KB | Da pushare |

**Istruzioni**: `ISTRUZIONI_SHEET_SCANNER.md`, `ISTRUZIONI_CRM_TOOLS.md`

---

### BATCH 5 — Skill System 🔧 IN LAVORAZIONE

**File deployati**: `src/skills/skillRegistry.js`, `src/skills/skillDefinitions.js` (versione base)

**Cosa funziona**:
- 11 skill definite con keywords/regex/channels matching
- Skill matching avviene PRIMA della classificazione intent (score >= 10)
- RBAC con minRole
- delegateTo per redirect a agenti esistenti
- executeSkill con timeout 55s

**Cosa manca**:
- `skillDefinitions_v2.js` — prompt arricchiti (15-20 righe vs 2-3 deployate), loadContext più completi (patch 29KB, pronta, allineata alla struttura deployata)
- Smoke test aggiornato per struttura V2
- Istruzioni V2 con diff esatto

**Le 11 Skill**:
| # | ID | Nome | minRole | Note |
|---|-----|------|---------|------|
| 1 | standup_update | Standup / Daily Update | member | |
| 2 | pipeline_review | Pipeline CRM | manager | |
| 3 | draft_outreach | Draft Email Commerciale | member | |
| 4 | client_briefing | Client Briefing | member | |
| 5 | content_review | Content Review | member | |
| 6 | project_status | Project Status | member | |
| 7 | finance_overview | Finance Overview | admin | ⚠️ TAB separation |
| 8 | onboarding_guide | Onboarding Guide | member | |
| 9 | capacity_planning | Capacity Planning | manager | |
| 10 | quote_support | Quote Support | member | delegateTo: quoteSupportAgent |
| 11 | weekly_digest | Weekly Digest | member | delegateTo: dailyDigestAgent |

**Patch pronte**:
| File | Dimensione | Stato |
|------|-----------|-------|
| skillDefinitions_v2.js | 29KB | Pronta, da sostituire |
| skillMatchingTest.js | 7KB | Da aggiornare per V2 |
| skillRegistry.js | 7KB | Non necessario (deployato compatibile) |

**Istruzioni**: `ISTRUZIONI_SKILL.md` (da aggiornare per V2)

---

### BATCH 6 — Daily Digest Agent V3 🔧 PATCH PRONTA

**File deployato**: `src/agents/dailyDigestAgent.js` (V1)

**Cosa manca**:
- `dailyDigestAgentV3.js` — digest personalizzato per utente basato su `digest_scope`, include segnali PM, metriche pipeline, deadline imminenti (patch 17KB, pronta)
- Integrazione con `user_profiles.digest_scope` (full/team/minimal)

**Patch pronte**:
| File | Dimensione | Stato |
|------|-----------|-------|
| dailyDigestAgentV2.js | 9KB | Superato da V3 |
| dailyDigestAgentV3.js | 17KB | Da pushare |

---

### BATCH 7 — Context Builder V2 🔧 PATCH PRONTA

**File deployato**: `src/orchestrator/contextBuilder.js` (V2 base con unified_search)

**Miglioramenti nella patch**:
- `contextBuilderV2.js` — lazy loading ottimizzato, fallback chain migliorato, supporto per skill context injection (patch 11KB)
- `unifiedSearch.js` — RPC wrapper con retry e caching (patch 6KB)

**Patch pronte**:
| File | Dimensione | Stato |
|------|-----------|-------|
| contextBuilderV2.js | 11KB | Da valutare se necessario |
| unifiedSearch.js | 6KB | Da valutare se necessario |

---

## 3. Supabase — Stato Tabelle

**Tabelle principali attive**:
- `knowledge_base` — KB entries con pgvector (embedding 1536-dim)
- `memories` — memorie per-utente
- `user_profiles` — 10 profili team (tutti popolati con nome + ruolo)
- `leads` — pipeline CRM
- `quotes` — preventivi
- `channel_profiles` — profili canale
- `glossary` — terminologia aziendale
- `conversation_history` — storico conversazioni
- `scan_progress` — stato scansioni per canale

**User Profiles** (aggiornati 29/03/2026):
| Slack ID | Nome | Ruolo | Admin |
|----------|------|-------|-------|
| U053D... | Antonio | CEO / Co-founder | ✅ |
| U053D9B7WNL | Corrado | Co-founder / Direttore Creativo | ✅ |
| U053D9AMJ9E | Nicolò | Copywriter / SMM | ❌ |
| U053D... | Giusy | Office Manager | ❌ |
| U089... | Peppe | Project Manager | ❌ |
| U08E... | Paolo | Video Editor / Motion Designer | ❌ |
| U053D... | Gianna | Account Manager | ❌ |
| U08L282D140 | Gloria | Digital Ads Specialist | ❌ |
| U089027637Z | Alessandra | Brand Strategist | ❌ |
| U07R1900EHX | Claudia | Graphic Designer | ❌ |

**RBAC Roles**: admin > finance > manager > member > restricted

**Regola critica**: Take a Breath (TAB) e' 38% di Katania Studio — i dati finanziari NON devono MAI essere mischiati tra le due entita'.

---

## 4. Problemi Noti

### Priorita' ALTA
1. **68 canali non scansionati** — Solo ~10 su ~78 canali hanno KB entries. La knowledge base e' incompleta.
2. **embeddingService.js da aggiornare** — La patch usa Voyage ma ora si usa OpenAI. Serve aggiornare il client a `text-embedding-3-small`.
3. **Catch vuoti** — Codex ha fixato molti, ma verificare che tutti abbiano `logger.warn`.
4. **SYSTEM_PROMPT anti-trasparenza** — Contiene "NON DIRE MAI" rules che impediscono a Giuno di spiegare come funziona. Da rivedere.
5. **Sezione duplicata DATE NELLE MEMORIES** — Presente due volte nel system prompt di anthropicService.js.

### Priorita' MEDIA
6. **Max tokens troppo bassi** — 500 (DM) / 900 (canale) possono troncare risposte complesse. Valutare 800/1200.
7. **Nessun test automatico** — Zero test nel repo. Servono almeno smoke test per skill matching e routing.
8. **PLACEHOLDER_IDs in sheet_scan_registry** — Servono ID reali dei Google Sheets da monitorare.
9. **getSheetsPerUtente** mancante in googleAuthService — Necessario per sheetScannerJob.

### Priorita' BASSA
10. **README.md mancante** — Il repo non ha documentazione pubblica.
11. **Prompt skill troppo corti** — Le skill deployate hanno prompt di 2-3 righe. La V2 li porta a 15-20 righe.
12. **user_tokens.json nel repo** — File con token utente committato. Dovrebbe essere in .gitignore.

---

## 5. Priorita' di Deploy (Ordine Consigliato)

### Fase 1 — Quick Wins (questa settimana)

| # | Azione | File | Impatto |
|---|--------|------|---------|
| 1 | Sostituire skillDefinitions.js con V2 | `src/skills/skillDefinitions.js` | Prompt ricchi, loadContext completi |
| 2 | Configurare embeddingService per OpenAI | `src/services/embeddingService.js` | Sblocca ricerca semantica (key gia' su Railway) |
| 3 | Pulire SYSTEM_PROMPT | `src/services/anthropicService.js` | Rimuovi "NON DIRE MAI", dedup memories |
| 4 | Aumentare max tokens a 800/1200 | `src/services/anthropicService.js` | Risposte non troncate |

### Fase 2 — Memoria Avanzata (settimana prossima)

| # | Azione | File | Impatto |
|---|--------|------|---------|
| 5 | Push embeddingService.js | `src/services/embeddingService.js` | Embedding dedicati |
| 6 | Push memoryConsolidationJob.js | `src/jobs/memoryConsolidationJob.js` | Deduplica memories |
| 7 | Push entityBackfillJob.js | `src/jobs/entityBackfillJob.js` | Entity types su KB |
| 8 | Push kbQualitySweepJob.js | `src/jobs/kbQualitySweepJob.js` | Pulizia KB |
| 9 | Registrare cron per job 6-8 | `src/handlers/cronHandlers.js` | Automazione notturna |

### Fase 3 — Real-Time + Scanner (settimana 2)

| # | Azione | File | Impatto |
|---|--------|------|---------|
| 10 | Push realTimeListener.js completo | `src/listeners/realTimeListener.js` | KB real-time |
| 11 | Push historicalScannerV2.js | `src/agents/historicalScanner.js` | Scan 68 canali mancanti |
| 12 | Lanciare scan completo | Comando `/giuno scan --all` | KB completa |
| 13 | Push pmSignalsJob.js | `src/jobs/pmSignalsJob.js` | Segnali PM automatici |

### Fase 4 — CRM + Sheets (settimana 3)

| # | Azione | File | Impatto |
|---|--------|------|---------|
| 14 | Raccogliere ID Google Sheets reali | sheet_scan_registry in Supabase | Sblocca sheetScanner |
| 15 | Aggiungere getSheetsPerUtente | `src/services/googleAuthService.js` | Auth per sheets |
| 16 | Push sheetScannerJob.js | `src/jobs/sheetScannerJob.js` | Import dati da sheets |
| 17 | Push crmToolsV2.js | `src/tools/modules/leads.js` (merge) | CRM potenziato |

### Fase 5 — Digest + Polish (settimana 4)

| # | Azione | File | Impatto |
|---|--------|------|---------|
| 18 | Push dailyDigestAgentV3.js | `src/agents/dailyDigestAgent.js` | Digest personalizzati |
| 19 | Push driveWatcherJob.js | `src/jobs/driveWatcherJob.js` | Sync Drive → KB |
| 20 | Aggiungere smoke test base | `tests/skillMatching.test.js` | Test minimo |
| 21 | Creare README.md | `README.md` | Documentazione |

---

## 6. Struttura File — Patch vs Deployato

```
patches/                          →  src/ (destinazione nel repo)
─────────────────────────────────────────────────────────────────
skillDefinitions_v2.js            →  src/skills/skillDefinitions.js (SOSTITUIRE)
embeddingService.js               →  src/services/embeddingService.js (NUOVO)
memoryConsolidationJob.js         →  src/jobs/memoryConsolidationJob.js (NUOVO)
entityBackfillJob.js              →  src/jobs/entityBackfillJob.js (NUOVO)
graphEnricherJob.js               →  src/jobs/graphEnricherJob.js (NUOVO)
kbQualitySweepJob.js              →  src/jobs/kbQualitySweepJob.js (NUOVO)
historicalScannerV2.js            →  src/agents/historicalScanner.js (SOSTITUIRE)
scanCommandV2.js                  →  src/commands/scanCommand.js (SOSTITUIRE)
realTimeListener.js               →  src/listeners/realTimeListener.js (SOSTITUIRE)
driveWatcherJob.js                →  src/jobs/driveWatcherJob.js (NUOVO)
pmSignalsJob.js                   →  src/jobs/pmSignalsJob.js (NUOVO)
sheetScannerJob.js                →  src/jobs/sheetScannerJob.js (NUOVO)
crmToolsV2.js                     →  src/tools/modules/leads.js (MERGE)
dailyDigestAgentV3.js             →  src/agents/dailyDigestAgent.js (SOSTITUIRE)
contextBuilderV2.js               →  src/orchestrator/contextBuilder.js (VALUTARE)
unifiedSearch.js                  →  src/services/unifiedSearch.js (VALUTARE)
```

**IMPORTANTE**: Ogni patch e' stata scritta per essere compatibile con la struttura deployata attuale. Le patch "SOSTITUIRE" rimpiazzano il file intero. Le patch "NUOVO" aggiungono file che non esistono nel repo. Le patch "MERGE" richiedono integrazione manuale.

---

## 7. Variabili d'Ambiente Necessarie

| Variabile | Stato | Note |
|-----------|-------|------|
| SLACK_BOT_TOKEN | ✅ Presente | Socket Mode |
| SLACK_APP_TOKEN | ✅ Presente | Socket Mode |
| ANTHROPIC_API_KEY | ✅ Presente | Sonnet 4 + Haiku 4.5 |
| SUPABASE_URL | ✅ Presente | eu-central-2 |
| SUPABASE_KEY | ✅ Presente | service_role |
| GOOGLE_CLIENT_ID | ✅ Presente | OAuth web |
| GOOGLE_CLIENT_SECRET | ✅ Presente | OAuth web |
| GEMINI_API_KEY | ✅ Presente | Web search |
| OPENAI_API_KEY | ✅ Presente | Embedding (text-embedding-3-small, 1536-dim) |

---

## 8. Contributori e Workflow

- **Antonio (MastruPipa)** — Proprietario repo, deploy su Railway
- **Claude (Cowork)** — Sviluppo patch, analisi architetturale, Supabase
- **Codex** — Code review, fix automatici (catch vuoti, safeParse, logger)

**Workflow attuale**: Le patch vengono scritte in `patches/`, poi pushate manualmente da Antonio via GitHub. Codex opera direttamente sul repo con commit automatici.

**Branch strategy**: Tutto su `main` (175 commit). Nessun branch di sviluppo attivo.

---

## 9. Decisioni Architetturali

1. **Skill-first routing** — Le skill vengono matchate PRIMA della classificazione intent. Se nessuna skill matcha (score < 10), si passa al classifier Haiku.

2. **Separazione TAB** — Take a Breath ha dati finanziari separati. La skill `finance_overview` ha `minRole: 'admin'` e il prompt include warning esplicito sulla separazione.

3. **Modello di costo** — Sonnet 4 solo per agenti/skill che generano risposte. Haiku 4.5 per tutto il resto (classificazione, scan, autoLearn, compressione).

4. **Timeout 55s** — Tutte le chiamate Anthropic hanno timeout 55s per stare sotto il limite Railway/Slack di 60s.

5. **Allineamento patch → deploy** — Le patch seguono la struttura del codice deployato (keywords/regex/channels/loadContext), non la struttura originale dei patch precedenti (triggers/triggerRegex/channelHints/dataLoaders).

---

*Questo documento viene aggiornato ad ogni sessione di sviluppo.*
