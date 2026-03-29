# Error Handling + Context Builder Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Eliminare tutti i silent failures nel codebase e rendere il context builder più efficiente skippando le RPC Supabase per messaggi triviali.

**Architecture:** Si crea un modulo `safeCall` con due helper (`safeCall` per async, `safeParse` per JSON.parse) che loggano gli errori invece di silenziarli. Tutti i `catch(e) {}` vuoti vengono sostituiti. Il context builder guadagna una funzione `isTrivialMessage` che bypassa le RPC per conferme senza contenuto.

**Tech Stack:** Node.js, winston logger (`src/utils/logger`), Supabase client

---

## File map

| File | Azione |
|---|---|
| `src/utils/safeCall.js` | Crea — utility safeCall + safeParse |
| `src/orchestrator/contextBuilder.js` | Modifica — trivial detection + safeCall su 6 catch vuoti |
| `src/orchestrator/preflight.js` | Modifica — 1 catch vuoto |
| `src/handlers/slackHandlers.js` | Modifica — 3 catch vuoti |
| `src/agents/dailyDigestAgent.js` | Modifica — 6 catch vuoti |
| `src/agents/generalAssistantAgent.js` | Modifica — 1 catch vuoto |
| `src/skills/skillDefinitions.js` | Modifica — 1 catch vuoto |
| `src/services/geminiService.js` | Modifica — 1 catch vuoto |
| `src/services/slackService.js` | Modifica — 2 catch vuoti |
| `src/services/db/memories.js` | Modifica — 1 catch vuoto |
| `src/services/db/cron.js` | Modifica — 1 catch vuoto |
| `src/services/db/client.js` | Modifica — 2 catch vuoti |
| `src/tools/driveTools.js` | Modifica — 1 catch vuoto |
| `src/tools/slackTools.js` | Modifica — 5 catch vuoti |
| `src/tools/leadsTools.js` | Modifica — 1 catch vuoto |
| `src/handlers/cronHandlers.js` | Modifica — 10 catch vuoti |
| `src/jobs/historicalScanner.js` | Modifica — 1 catch vuoto + JSON.parse |
| `src/jobs/pmSignalsJob.js` | Modifica — 1 catch vuoto + JSON.parse |
| `src/jobs/kbQualitySweepJob.js` | Modifica — JSON.parse |
| `src/jobs/sheetScannerJob.js` | Modifica — JSON.parse |
| `src/jobs/driveWatcherJob.js` | Modifica — JSON.parse |
| `src/jobs/memoryConsolidationJob.js` | Modifica — JSON.parse |
| `src/listeners/realTimeListener.js` | Modifica — JSON.parse |
| `src/agents/knowledgeEngine.js` | Modifica — JSON.parse (riga 154, già protetta la 35) |
| `src/agents/quoteSupportAgent.js` | Modifica — 2 JSON.parse |
| `src/commands/scanCommand.js` | Modifica — 4 console.* → logger |

---

## Task 1: Crea `src/utils/safeCall.js`

**Files:**
- Crea: `src/utils/safeCall.js`

- [ ] **Step 1: Crea il file**

```js
// ─── Safe call utilities ──────────────────────────────────────────────────────
// safeCall: esegue fn async loggando errori invece di silenziarli.
// safeParse: JSON.parse con fallback loggato.
'use strict';

var logger = require('./logger');

/**
 * safeCall(label, fn, fallback)
 * Esegue fn(). Se fallisce, logga warn e ritorna fallback.
 * @param {string}   label    — prefisso nel log, es. 'CTX.searchMemories'
 * @param {Function} fn       — funzione async da eseguire
 * @param {*}        fallback — valore di ritorno in caso di errore (default null)
 */
async function safeCall(label, fn, fallback) {
  try {
    return await fn();
  } catch (e) {
    logger.warn('[' + label + '] fallita: ' + e.message);
    return (fallback !== undefined ? fallback : null);
  }
}

/**
 * safeParse(label, str, fallback)
 * JSON.parse con log warn se il JSON è malformato.
 * @param {string} label    — prefisso nel log
 * @param {string} str      — stringa da parsare
 * @param {*}      fallback — valore di ritorno in caso di errore (default null)
 */
function safeParse(label, str, fallback) {
  try {
    return JSON.parse(str);
  } catch (e) {
    logger.warn('[' + label + '] JSON malformato: ' + e.message);
    return (fallback !== undefined ? fallback : null);
  }
}

module.exports = { safeCall: safeCall, safeParse: safeParse };
```

- [ ] **Step 2: Verifica che il file esista e non abbia errori di sintassi**

```bash
node -e "var s = require('./src/utils/safeCall'); console.log(Object.keys(s));"
```
Expected output: `[ 'safeCall', 'safeParse' ]`

- [ ] **Step 3: Commit**

```bash
git add src/utils/safeCall.js
git commit -m "feat: add safeCall + safeParse error utilities"
```

---

## Task 2: Aggiorna `contextBuilder.js` — trivial detection + safeCall

**Files:**
- Modifica: `src/orchestrator/contextBuilder.js`

- [ ] **Step 1: Aggiungi l'import di safeCall in cima al file (dopo gli altri require)**

Trova:
```js
var embeddingService = require('../services/embeddingService');
```
Sostituisci con:
```js
var embeddingService = require('../services/embeddingService');
var { safeCall } = require('../utils/safeCall');
```

- [ ] **Step 2: Aggiungi la funzione `isTrivialMessage` dopo la CONTEXT_NEEDS map (riga ~24)**

Trova:
```js
// ─── Main builder ────────────────────────────────────────────────────────────
```
Sostituisci con:
```js
// ─── Trivial message detection ───────────────────────────────────────────────

var TRIVIAL_PATTERNS = [
  /^(ok|sì|si|no|grazie|perfetto|capito|certo|esatto|giusto|bene|dai|vabbè|oki|yep|yes|nope|np|ok!)$/i,
  /^(ok grazie|grazie mille|perfetto grazie|va bene|va benissimo|ottimo|fatto|ricevuto|confermato)$/i,
];

function isTrivialMessage(message) {
  var m = (message || '').trim();
  return TRIVIAL_PATTERNS.some(function(p) { return p.test(m); });
}

// ─── Main builder ────────────────────────────────────────────────────────────
```

- [ ] **Step 3: Aggiungi il check trivial all'inizio di `buildContext`, prima della chiamata a unified search**

Trova:
```js
  var unifiedWorked = false;
  if (message.length > 5 && (needs.memories || needs.kb || needs.entities || needs.drive)) {
```
Sostituisci con:
```js
  var unifiedWorked = false;
  if (!isTrivialMessage(message) && message.length > 5 && (needs.memories || needs.kb || needs.entities || needs.drive)) {
```

- [ ] **Step 4: Sostituisci i 6 catch vuoti nel fallback section con safeCall**

Trova (righe ~108–166, intero blocco fallback):
```js
  // Fallback to cache-based search if unified didn't work
  if (!unifiedWorked) {
    if (needs.memories) {
      try {
        var rawMem = await db.searchMemories(userId, message) || [];
        // Confidence gate: filter low-quality
        relevantMemories = rawMem.filter(function(m) {
          return (m.confidence_score || m.final_score || 0.5) >= 0.3;
        }).slice(0, 5);
      } catch(e) {}
    }
    if (needs.kb) {
      try {
        var rawKB = db.searchKB(message) || [];
        kbResults = rawKB.filter(function(k) {
          return (k.confidence_score || 0.5) >= 0.3;
        }).slice(0, 3);
      } catch(e) {}
    }

    // Semantic search layer (if embeddings available)
    if (embeddingService.getProvider() && message.length > 10) {
      try {
        var semResults = await embeddingService.semanticSearch(message, { limit: 3 });
        if (semResults && semResults.length > 0) {
          semResults.forEach(function(sr) {
            kbResults.push({ content: sr.content, confidence_tier: 'semantic_match', confidence_score: sr.similarity || 0.7 });
          });
        }
      } catch(e) {}
    }
  }

  // Channel context from RPC or options
  var channelContext = options.channelContext || null;
  if (options.channelId && !channelProfile) {
    try {
      var rpcCtx = await db.getChannelContext(options.channelId, 8);
      if (rpcCtx) channelProfile = rpcCtx;
    } catch(e) {}
  }

  // Entity graph context
  if (needs.entities && relevantEntities.length > 0) {
    try {
      var entityCtx = await db.getEntityContext(relevantEntities[0].name, 1);
      if (entityCtx && entityCtx.found) teamContext = entityCtx;
    } catch(e) {}
  }

  // Glossary
  var glossaryContext = null;
  if (needs.glossary) {
    try {
      var gm = db.searchGlossary(message) || [];
      if (gm.length > 0) {
        glossaryContext = gm.slice(0, 5).map(function(g) {
          return g.term + ': ' + g.definition + (g.synonyms && g.synonyms.length > 0 ? ' (sinonimi: ' + g.synonyms.join(', ') + ')' : '');
        }).join('\n');
      }
    } catch(e) {}
  }
```
Sostituisci con:
```js
  // Fallback to cache-based search if unified didn't work
  if (!unifiedWorked) {
    if (needs.memories) {
      var rawMem = await safeCall('CTX.searchMemories', function() { return db.searchMemories(userId, message); }, []) || [];
      relevantMemories = rawMem.filter(function(m) {
        return (m.confidence_score || m.final_score || 0.5) >= 0.3;
      }).slice(0, 5);
    }
    if (needs.kb) {
      var rawKB = (await safeCall('CTX.searchKB', function() { return db.searchKB(message); }, [])) || [];
      kbResults = rawKB.filter(function(k) {
        return (k.confidence_score || 0.5) >= 0.3;
      }).slice(0, 3);
    }

    // Semantic search layer (if embeddings available)
    if (embeddingService.getProvider() && message.length > 10) {
      var semResults = await safeCall('CTX.semanticSearch',
        function() { return embeddingService.semanticSearch(message, { limit: 3 }); }, []) || [];
      semResults.forEach(function(sr) {
        kbResults.push({ content: sr.content, confidence_tier: 'semantic_match', confidence_score: sr.similarity || 0.7 });
      });
    }
  }

  // Channel context from RPC or options
  var channelContext = options.channelContext || null;
  if (options.channelId && !channelProfile) {
    var rpcCtx = await safeCall('CTX.getChannelContext',
      function() { return db.getChannelContext(options.channelId, 8); }, null);
    if (rpcCtx) channelProfile = rpcCtx;
  }

  // Entity graph context
  if (needs.entities && relevantEntities.length > 0) {
    var entityCtx = await safeCall('CTX.getEntityContext',
      function() { return db.getEntityContext(relevantEntities[0].name, 1); }, null);
    if (entityCtx && entityCtx.found) teamContext = entityCtx;
  }

  // Glossary
  var glossaryContext = null;
  if (needs.glossary) {
    var gm = (await safeCall('CTX.searchGlossary', function() { return db.searchGlossary(message); }, [])) || [];
    if (gm.length > 0) {
      glossaryContext = gm.slice(0, 5).map(function(g) {
        return g.term + ': ' + g.definition + (g.synonyms && g.synonyms.length > 0 ? ' (sinonimi: ' + g.synonyms.join(', ') + ')' : '');
      }).join('\n');
    }
  }
```

**Nota:** `db.searchKB` e `db.searchGlossary` sono probabilmente sync. `safeCall` usa `await` internamente, che su un valore non-Promise ritorna il valore direttamente. Non è un problema.

- [ ] **Step 5: Verifica sintassi**

```bash
node -e "require('./src/orchestrator/contextBuilder');" 2>&1
```
Expected: nessun output (nessun errore).

- [ ] **Step 6: Commit**

```bash
git add src/orchestrator/contextBuilder.js
git commit -m "fix: context builder — trivial message skip + safeCall su fallback"
```

---

## Task 3: Patch `preflight.js` e `slackHandlers.js`

**Files:**
- Modifica: `src/orchestrator/preflight.js`
- Modifica: `src/handlers/slackHandlers.js`

- [ ] **Step 1: `preflight.js` — aggiungi import logger e logga il catch**

Aggiungi in cima al file (dopo `'use strict';`):
```js
var logger = require('../utils/logger');
```

Trova:
```js
  } catch(e) {}
```
(riga 36 — unico catch nel file)

Sostituisci con:
```js
  } catch(e) {
    logger.warn('[PREFLIGHT] pattern check fallito:', e.message);
  }
```

- [ ] **Step 2: `slackHandlers.js` — patch 3 catch vuoti**

I tre catch vuoti sono nel blocco `app_mention` alle righe ~68, ~87, ~95. Sono tentativi di arricchire il `channelContext` tramite Slack API — best-effort, debug level.

Trova (primo catch vuoto, dopo `conversations.info`):
```js
    } catch(e) {}

    try {
      var recentMsgs;
```
Sostituisci con:
```js
    } catch(e) {
      logger.debug('[SLACK-HANDLER] conversations.info ignorato:', e.message);
    }

    try {
      var recentMsgs;
```

Trova (secondo catch vuoto, dopo `conversations.replies/history`):
```js
    } catch(e) {}

    try {
      var membersRes
```
Sostituisci con:
```js
    } catch(e) {
      logger.debug('[SLACK-HANDLER] fetch messaggi recenti ignorato:', e.message);
    }

    try {
      var membersRes
```

Trova (terzo catch vuoto, dopo `conversations.members`):
```js
    } catch(e) {}

    var mentionChannelType
```
Sostituisci con:
```js
    } catch(e) {
      logger.debug('[SLACK-HANDLER] fetch membri canale ignorato:', e.message);
    }

    var mentionChannelType
```

- [ ] **Step 3: Verifica sintassi**

```bash
node -e "require('./src/orchestrator/preflight');" 2>&1
node -e "// slackHandlers ha side effects, controlla solo sintassi" && node --check src/handlers/slackHandlers.js 2>&1
```
Expected: nessun errore.

- [ ] **Step 4: Commit**

```bash
git add src/orchestrator/preflight.js src/handlers/slackHandlers.js
git commit -m "fix: log catch vuoti in preflight e slackHandlers"
```

---

## Task 4: Patch agenti — `dailyDigestAgent.js`, `generalAssistantAgent.js`, `skillDefinitions.js`

**Files:**
- Modifica: `src/agents/dailyDigestAgent.js`
- Modifica: `src/agents/generalAssistantAgent.js`
- Modifica: `src/skills/skillDefinitions.js`

- [ ] **Step 1: `dailyDigestAgent.js` — patch 6 catch vuoti**

Apri il file. I 6 catch vuoti sono alle righe 64, 104, 141, 157, 170, 183.
Sostituiscili tutti aggiungendo un logger.warn. Il pattern è sempre lo stesso:

```js
} catch(e) {}
```
→
```js
} catch(e) {
  logger.warn('[DAILY-DIGEST] fetch fallito:', e.message);
}
```

Verifica che il file importi già `logger` (riga 1-10). Se non c'è, aggiungi:
```js
var logger = require('../utils/logger');
```

- [ ] **Step 2: `generalAssistantAgent.js` — patch 1 catch vuoto (riga ~58)**

Trova:
```js
      } catch(e) {}
    }

    if (lastAssistant) {
```
Sostituisci con:
```js
      } catch(e) {
        logger.warn('[GENERAL-AGENT] context recovery fallito:', e.message);
      }
    }

    if (lastAssistant) {
```

- [ ] **Step 3: `skillDefinitions.js` — patch 1 catch vuoto (riga ~65)**

Trova il catch vuoto nel file e sostituisci con:
```js
    } catch(e) {
      logger.warn('[SKILL-DEFS] esecuzione skill fallita:', e.message);
    }
```
Verifica che `logger` sia importato; se no, aggiungilo in cima.

- [ ] **Step 4: Verifica sintassi**

```bash
node --check src/agents/dailyDigestAgent.js 2>&1
node --check src/agents/generalAssistantAgent.js 2>&1
node --check src/skills/skillDefinitions.js 2>&1
```
Expected: nessun output.

- [ ] **Step 5: Commit**

```bash
git add src/agents/dailyDigestAgent.js src/agents/generalAssistantAgent.js src/skills/skillDefinitions.js
git commit -m "fix: log catch vuoti in dailyDigest, generalAssistant, skillDefinitions"
```

---

## Task 5: Patch services — `geminiService.js`, `slackService.js`, `db/memories.js`, `db/cron.js`, `db/client.js`

**Files:**
- Modifica: `src/services/geminiService.js`
- Modifica: `src/services/slackService.js`
- Modifica: `src/services/db/memories.js`
- Modifica: `src/services/db/cron.js`
- Modifica: `src/services/db/client.js`

- [ ] **Step 1: `geminiService.js` riga ~100 — catch interno best-effort (estrazione metadata)**

Il catch interno è dentro un outer try-catch che già logga. Aggiunge solo debug:
```js
    } catch(e) {
      logger.debug('[GEMINI] grounding metadata non disponibile:', e.message);
    }
```

- [ ] **Step 2: `slackService.js` — 2 catch vuoti (righe ~52, ~59)**

Questi sono operazioni Slack best-effort. Sostituisci:
```js
    } catch(e) {}
```
con:
```js
    } catch(e) {
      logger.debug('[SLACK-SVC] operazione Slack ignorata:', e.message);
    }
```
Per il secondo (conversations.join):
```js
  try { await app.client.conversations.join({ channel: channelId }); } catch(e) {}
```
→
```js
  try { await app.client.conversations.join({ channel: channelId }); } catch(e) {
    logger.debug('[SLACK-SVC] join canale ignorato:', e.message);
  }
```

- [ ] **Step 3: `db/memories.js` riga ~137 — catch vuoto**

Trova il catch vuoto e sostituisci con:
```js
  } catch(e) {
    logger.warn('[DB-MEMORIES] operazione fallita:', e.message);
  }
```

- [ ] **Step 4: `db/cron.js` riga ~29 — release lock catch vuoto**

```js
  try { await c.getClient().from('cron_locks').delete().eq('job_name', jobName).eq('locked_by', INSTANCE_ID); } catch(e) {}
```
→
```js
  try {
    await c.getClient().from('cron_locks').delete().eq('job_name', jobName).eq('locked_by', INSTANCE_ID);
  } catch(e) {
    logger.warn('[DB-CRON] release lock fallita:', e.message);
  }
```
Verifica che `logger` sia importato nel file.

- [ ] **Step 5: `db/client.js` — 2 catch vuoti (righe ~9, ~26)**

Riga ~9 (require supabase a startup — se fallisce il processo crasha comunque, log warn):
```js
try { createClient = require('@supabase/supabase-js').createClient; } catch(e) {}
```
→
```js
try { createClient = require('@supabase/supabase-js').createClient; } catch(e) {
  console.warn('[DB-CLIENT] supabase-js non disponibile:', e.message);
}
```
(Qui `console.warn` perché `logger` potrebbe non essere ancora inizializzato al bootstrap)

Riga ~26 (writeFileSync cache):
```js
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {}
```
→
```js
  try { fs.writeFileSync(file, JSON.stringify(data, null, 2)); } catch(e) {
    console.warn('[DB-CLIENT] cache write fallita:', e.message);
  }
```

- [ ] **Step 6: Verifica sintassi**

```bash
node --check src/services/geminiService.js src/services/slackService.js src/services/db/memories.js src/services/db/cron.js src/services/db/client.js 2>&1
```
Expected: nessun output.

- [ ] **Step 7: Commit**

```bash
git add src/services/geminiService.js src/services/slackService.js src/services/db/memories.js src/services/db/cron.js src/services/db/client.js
git commit -m "fix: log catch vuoti in services e db modules"
```

---

## Task 6: Patch tools — `driveTools.js`, `slackTools.js`, `leadsTools.js`

**Files:**
- Modifica: `src/tools/driveTools.js`
- Modifica: `src/tools/slackTools.js`
- Modifica: `src/tools/leadsTools.js`

- [ ] **Step 1: `driveTools.js` riga ~422 — catch vuoto**

Trova il catch vuoto, sostituisci con:
```js
    } catch(e) {
      logger.warn('[DRIVE-TOOLS] operazione fallita:', e.message);
    }
```

- [ ] **Step 2: `slackTools.js` — 5 catch vuoti**

I catch alle righe 392, 475, 554, 558, 777. I catch a 475 e 777 sono `conversations.join` best-effort:

Per i `conversations.join` (righe 475 e 777):
```js
      try { await app.client.conversations.join({ channel: target.id }); } catch(e) {}
```
→
```js
      try { await app.client.conversations.join({ channel: target.id }); } catch(e) {
        logger.debug('[SLACK-TOOLS] join canale ignorato:', e.message);
      }
```

Per gli altri 3 (righe 392, 554, 558):
```js
      } catch(e) {}
```
→
```js
      } catch(e) {
        logger.warn('[SLACK-TOOLS] operazione fallita:', e.message);
      }
```

- [ ] **Step 3: `leadsTools.js` riga ~398 — catch vuoto**

```js
    } catch(e) {}
```
→
```js
    } catch(e) {
      logger.warn('[LEADS-TOOLS] operazione fallita:', e.message);
    }
```

- [ ] **Step 4: Verifica sintassi**

```bash
node --check src/tools/driveTools.js src/tools/slackTools.js src/tools/leadsTools.js 2>&1
```
Expected: nessun output.

- [ ] **Step 5: Commit**

```bash
git add src/tools/driveTools.js src/tools/slackTools.js src/tools/leadsTools.js
git commit -m "fix: log catch vuoti in tools"
```

---

## Task 7: Patch `cronHandlers.js` — 10 catch vuoti

**Files:**
- Modifica: `src/handlers/cronHandlers.js`

- [ ] **Step 1: Patch tutti i 10 catch vuoti**

Apri `src/handlers/cronHandlers.js`. Le righe con catch vuoti sono: 61, 157, 177, 271, 290, 596, 716, 730, 740, 837, 957, 959.

La riga 271 è un `conversations.join` best-effort → debug level.
Tutte le altre sono operazioni dati → warn level.

Per il `conversations.join` a riga ~271:
```js
      try { await app.client.conversations.join({ channel: target.id }); } catch(e) {}
```
→
```js
      try { await app.client.conversations.join({ channel: target.id }); } catch(e) {
        logger.debug('[CRON] join canale ignorato:', e.message);
      }
```

Per tutti gli altri `catch(e) {}` nel file, trova ognuno e sostituisci con:
```js
    } catch(e) {
      logger.warn('[CRON] operazione fallita:', e.message);
    }
```
(nota: l'indentazione può variare — mantieni quella esistente)

- [ ] **Step 2: Verifica sintassi**

```bash
node --check src/handlers/cronHandlers.js 2>&1
```
Expected: nessun output.

- [ ] **Step 3: Commit**

```bash
git add src/handlers/cronHandlers.js
git commit -m "fix: log catch vuoti in cronHandlers"
```

---

## Task 8: Patch jobs e listeners

**Files:**
- Modifica: `src/jobs/historicalScanner.js`
- Modifica: `src/jobs/pmSignalsJob.js`

- [ ] **Step 1: `historicalScanner.js` — catch vuoto a riga ~133**

Il catch è su un `conversations.join` best-effort:
```js
    try { await app.client.conversations.join({ channel: channelId }); } catch(e) {}
```
→
```js
    try { await app.client.conversations.join({ channel: channelId }); } catch(e) {
      logger.debug('[SCANNER] join canale ignorato:', e.message);
    }
```

- [ ] **Step 2: `pmSignalsJob.js` — catch vuoto a riga ~71**

```js
    } catch(e) {}
```
→
```js
    } catch(e) {
      logger.warn('[PM-SIGNALS] operazione fallita:', e.message);
    }
```

- [ ] **Step 3: Verifica sintassi**

```bash
node --check src/jobs/historicalScanner.js src/jobs/pmSignalsJob.js 2>&1
```
Expected: nessun output.

- [ ] **Step 4: Commit**

```bash
git add src/jobs/historicalScanner.js src/jobs/pmSignalsJob.js
git commit -m "fix: log catch vuoti in jobs e listeners"
```

---

## Task 9: Wrap tutti i `JSON.parse` non protetti con `safeParse`

**Files:**
- Modifica: `src/agents/knowledgeEngine.js`
- Modifica: `src/agents/quoteSupportAgent.js`
- Modifica: `src/jobs/historicalScanner.js`
- Modifica: `src/jobs/kbQualitySweepJob.js`
- Modifica: `src/jobs/sheetScannerJob.js`
- Modifica: `src/jobs/pmSignalsJob.js`
- Modifica: `src/jobs/driveWatcherJob.js`
- Modifica: `src/jobs/memoryConsolidationJob.js`
- Modifica: `src/listeners/realTimeListener.js`
- Modifica: `src/handlers/cronHandlers.js`

- [ ] **Step 1: Aggiungi import di `safeParse` in tutti i file sopra**

In cima a ogni file, dopo gli altri `require`, aggiungi:
```js
var { safeParse } = require('../utils/safeCall');
```
(per i file in `src/handlers/` e `src/agents/`, il path relativo è `'../utils/safeCall'`; per i file in `src/jobs/` e `src/listeners/`, idem)

- [ ] **Step 2: Sostituisci ogni `JSON.parse(x)` con `safeParse('LABEL', x, null)`**

Usa questa tabella:

| File | Riga | Pattern da trovare | Sostituzione |
|---|---|---|---|
| `knowledgeEngine.js` | 154 | `return JSON.parse(jsonMatch[0]);` | `return safeParse('KB-ENGINE', jsonMatch[0], null);` |
| `quoteSupportAgent.js` | 52 | `JSON.parse(rateCardData.resources)` | `safeParse('QUOTE.resources', rateCardData.resources, [])` |
| `quoteSupportAgent.js` | 72 | `return match ? JSON.parse(match[0]) : null;` | `return match ? safeParse('QUOTE.parse', match[0], null) : null;` |
| `historicalScanner.js` | 69 | `return match ? JSON.parse(match[0]) : null;` | `return match ? safeParse('SCANNER.parse', match[0], null) : null;` |
| `kbQualitySweepJob.js` | 88 | `var scores = JSON.parse(match[0]);` | `var scores = safeParse('KB-SWEEP', match[0], null);` |
| `sheetScannerJob.js` | 57 | `return match ? JSON.parse(match[0]) : null;` | `return match ? safeParse('SHEET-SCANNER', match[0], null) : null;` |
| `pmSignalsJob.js` | 48 | `JSON.parse(match[0]).forEach(...)` | `var pmData = safeParse('PM-SIGNALS', match[0], []); if (pmData) pmData.forEach(...)` |
| `driveWatcherJob.js` | 46 | `return match ? JSON.parse(match[0]) : null;` | `return match ? safeParse('DRIVE-WATCHER', match[0], null) : null;` |
| `memoryConsolidationJob.js` | 68 | `var result = JSON.parse(match[0]);` | `var result = safeParse('MEM-CONSOLIDATION', match[0], null);` |
| `realTimeListener.js` | 124 | `var result = JSON.parse(match[0]);` | `var result = safeParse('RT-LISTENER', match[0], null);` |
| `cronHandlers.js` | 459 | `var parsed = JSON.parse(jsonMatch[0]);` | `var parsed = safeParse('CRON.459', jsonMatch[0], null);` |
| `cronHandlers.js` | 517 | `var analysis = JSON.parse(jsonMatch[0]);` | `var analysis = safeParse('CRON.517', jsonMatch[0], null);` |
| `cronHandlers.js` | 698 | `var parsed = JSON.parse(rcJson[0]);` | `var parsed = safeParse('CRON.698', rcJson[0], null);` |
| `cronHandlers.js` | 813 | `var data = JSON.parse(extJson[0]);` | `var data = safeParse('CRON.813', extJson[0], null);` |
| `cronHandlers.js` | 1020 | `var result = JSON.parse(jsonMatch[0]);` | `var result = safeParse('CRON.1020', jsonMatch[0], null);` |

**Nota:** Per `kbQualitySweepJob.js:88`, dopo la sostituzione aggiungi un guard:
```js
var scores = safeParse('KB-SWEEP', match[0], null);
if (!scores) continue; // skip se JSON malformato
```

Per `pmSignalsJob.js:48`, il pattern è diverso — cerca il contesto e adatta di conseguenza.

- [ ] **Step 3: Verifica sintassi di tutti i file modificati**

```bash
node --check src/agents/knowledgeEngine.js src/agents/quoteSupportAgent.js src/jobs/historicalScanner.js src/jobs/kbQualitySweepJob.js src/jobs/sheetScannerJob.js src/jobs/pmSignalsJob.js src/jobs/driveWatcherJob.js src/jobs/memoryConsolidationJob.js src/listeners/realTimeListener.js src/handlers/cronHandlers.js 2>&1
```
Expected: nessun output.

- [ ] **Step 4: Commit**

```bash
git add src/agents/knowledgeEngine.js src/agents/quoteSupportAgent.js src/jobs/historicalScanner.js src/jobs/kbQualitySweepJob.js src/jobs/sheetScannerJob.js src/jobs/pmSignalsJob.js src/jobs/driveWatcherJob.js src/jobs/memoryConsolidationJob.js src/listeners/realTimeListener.js src/handlers/cronHandlers.js
git commit -m "fix: wrap JSON.parse con safeParse in agents, jobs, listeners, handlers"
```

---

## Task 10: Fix `scanCommand.js` — `console.*` → `logger`

**Files:**
- Modifica: `src/commands/scanCommand.js`

- [ ] **Step 1: Aggiungi import logger**

Apri `src/commands/scanCommand.js`. Se `logger` non è già importato, aggiungi in cima:
```js
var logger = require('../utils/logger');
```

- [ ] **Step 2: Sostituisci i 4 console.***

Trova:
```js
      .catch(function(e) { console.error('[scan]', e.message); });
```
Sostituisci con:
```js
      .catch(function(e) { logger.error('[scan]', e.message); });
```

Trova:
```js
      .catch(function(e) { console.error('[scan-drive]', e.message); });
```
Sostituisci con:
```js
      .catch(function(e) { logger.error('[scan-drive]', e.message); });
```

Trova:
```js
      .then(function(r) { console.log('[scan] Sheets done:', r); })
      .catch(function(e) { console.error('[scan-sheets]', e.message); })
```
Sostituisci con:
```js
      .then(function(r) { logger.info('[scan] Sheets done:', r); })
      .catch(function(e) { logger.error('[scan-sheets]', e.message); })
```

- [ ] **Step 3: Verifica sintassi**

```bash
node --check src/commands/scanCommand.js 2>&1
```
Expected: nessun output.

- [ ] **Step 4: Verifica finale — zero catch vuoti rimasti**

```bash
grep -rn "catch(e) {}" src/ --include="*.js" | grep -v node_modules
```
Expected: nessun output (o solo i `conversations.join` che abbiamo lasciato in una sola riga — in quel caso verifica che siano stati patchati nel task precedente).

- [ ] **Step 5: Verifica finale — zero JSON.parse non protetti critici**

```bash
grep -rn "JSON\.parse(" src/ --include="*.js" | grep -v "safeParse\|try {" | grep -v node_modules
```
Controlla il risultato: quelli che rimangono dovrebbero essere solo dentro blocchi try-catch già esistenti.

- [ ] **Step 6: Commit finale**

```bash
git add src/commands/scanCommand.js
git commit -m "fix: console.* → logger in scanCommand"
```
