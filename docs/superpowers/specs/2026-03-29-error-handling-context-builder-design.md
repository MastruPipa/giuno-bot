# Design: Error Handling + Context Builder

**Data:** 2026-03-29
**Stato:** Approvato

---

## Obiettivo

1. Eliminare i silent failures nel codebase — ogni errore deve essere loggato
2. Rendere il context builder più efficiente senza rischiare risposte misallineate

---

## Sezione 1 — Error Layer: `safeCall`

### Nuovo file: `src/utils/safeCall.js`

Unica funzione esportata:

```js
safeCall(label, fn, fallback) → Promise<any>
```

- Esegue `fn` (funzione async o sync)
- Se `fn` fallisce: logga `logger.warn('[label] fallita: ' + e.message)` e ritorna `fallback`
- `fallback` può essere un valore statico (`[]`, `null`, `{}`) o una funzione lazy `() => value`
- Non introduce categorie di errori, non è un retry — è un wrapper leggero

### Applicazione nel codebase

Tutti i `catch(e) {}` vuoti vengono sostituiti con `safeCall`. Pattern:

```js
// Prima
try {
  var result = await db.searchMemories(userId, message);
} catch(e) {}

// Dopo
var result = await safeCall('CTX.searchMemories', () => db.searchMemories(userId, message), []);
```

I `JSON.parse()` senza protezione vengono wrappati:

```js
// Prima
var data = JSON.parse(jsonMatch[0]);

// Dopo
var data = safeCall('AGENT.parseJSON', () => JSON.parse(jsonMatch[0]), null);
```

I 4 `console.error` in `scanCommand.js` diventano `logger.error`.

### File coinvolti

- `src/orchestrator/contextBuilder.js`
- `src/services/db/*.js` (tutti i moduli con catch vuoti)
- `src/agents/*.js` (9 agenti)
- `src/jobs/*.js` (7 job)
- `src/skills/skillRegistry.js`
- `src/commands/scanCommand.js`
- tutti i `JSON.parse` non protetti nel codebase

---

## Sezione 2 — Context Builder: skip messaggi triviali

### Problema

`contextBuilder.js` triggera ricerche Supabase (memories, kb, entities, drive, glossary) per ogni messaggio con `length > 5`, incluse pure conferme come "ok", "grazie", "sì".

### Soluzione

Aggiungere una funzione `isTrivialMessage(message)` che controlla una whitelist di pattern:

```js
var TRIVIAL_PATTERNS = [
  /^(ok|sì|si|no|grazie|perfetto|capito|certo|esatto|giusto|bene|dai|vabbè|oki|yep|yes|nope)$/i,
  /^(ok grazie|grazie mille|perfetto grazie|va bene|va benissimo|ottimo)$/i,
];

function isTrivialMessage(message) {
  var m = (message || '').trim();
  return TRIVIAL_PATTERNS.some(function(p) { return p.test(m); });
}
```

Se `isTrivialMessage` ritorna `true`, il context builder salta tutte le RPC e ritorna solo:
- `userId`, `userRole`, `profile`, `channelType`, `isDM`, `channelMapEntry`, date/temporali
- tutti gli array di risultati vuoti (`[]`)

**Tutto il resto fa la ricerca normale** — anche messaggi corti come "cosa faccio?" o "aiuto?".

La soglia `message.length > 5` rimane come guardia secondaria (non si rimuove).

### Comportamento atteso

| Messaggio | Comportamento |
|---|---|
| "ok" | skip ricerche |
| "grazie" | skip ricerche |
| "ok grazie" | skip ricerche |
| "cosa faccio?" | ricerca normale |
| "dimmi di Acme" | ricerca normale |
| "sì ma quando?" | ricerca normale (non matcha whitelist esatta) |

---

## Scope bloccato — NON tocchiamo

- `anthropicService.js` — troppo grosso, fuori scope
- `router.js` — error handling già adeguato
- Comportamento degli agenti — solo i catch vuoti, non la logica
- Architettura generale del routing

---

## Criteri di successo

- Zero `catch(e) {}` vuoti nel codebase
- Zero `JSON.parse` non protetti
- Log visibile ogni volta che una ricerca context fallisce
- Messaggi triviali non triggano RPC Supabase
- Nessuna regressione nel comportamento di risposta di Giuno
