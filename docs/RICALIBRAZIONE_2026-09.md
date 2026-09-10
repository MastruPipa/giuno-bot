# Ricalibrazione Giuno — settembre 2026

> Obiettivo: far capire a Giuno il contesto delle chat Slack e dargli una memoria
> che regga, sfruttando i modelli attuali (Opus 5 / Sonnet 5). Questo documento è
> la diagnosi, cosa è cambiato e cosa resta da fare.

## 1. Diagnosi — perché "non capiva il contesto"

Le cause erano strutturali, non di prompt:

1. **Storia divisa per utente, non per thread.** La conversazione era salvata con
   chiave `userId:threadTs`. In un thread con tre persone Giuno vedeva tre
   conversazioni separate e non sapeva cosa si erano detti gli altri. Ogni
   mention top-level in canale era una conversazione nuova.
2. **Contesto iniettato dentro il messaggio utente e poi persistito.** Ogni turno
   salvava nel DB il testo dell'utente + fino a 9.000 caratteri di memorie, KB,
   roster, priorità… Il turno dopo rileggeva tutto quel blob come "storia":
   contesto vecchio in conflitto con quello nuovo, domanda dell'utente sepolta.
3. **Reply impliciti nei thread mai riconosciuti.** L'handler controllava se il
   `thread_ts` era un messaggio del bot, ma il bot risponde sempre *dentro* il
   thread dell'utente: il controllo falliva quasi sempre, quindi senza tag Giuno
   non seguiva il thread. Nel caso "follow-up entro 2 minuti" rispondeva aprendo
   un thread nuovo sotto il proprio messaggio.
4. **Rilevazione CC con `lastIndexOf('<@')`.** "@Giuno chiedi a @Antonio…" veniva
   classificato come "sei in copia" → "👀 Visto" e niente risposta. Per ogni
   reply implicito veniva chiamata `auth.test` (una API call in più).
5. **Retrieval del contextBuilder ignorato.** Il router costruiva memorie/KB/CRM
   via `unified_search` e poi `askGiuno` li buttava via, rifacendo una scansione
   entità propria (500 righe di `kb_entities` per ogni messaggio).
6. **KB inquinata dal watcher regex.** `slackMemoryWatcher` salvava in
   `knowledge_base` il testo grezzo di qualsiasi messaggio >100 caratteri o
   contenente "call", "modifica", "cliente"… fino a 15 volte l'ora per canale.
   Il retrieval pescava rumore.
7. **autoLearn con istruzione "salva troppo".** Haiku estraeva memorie da ogni
   scambio con la regola "preferisci salvare troppo": duplicati, ovvietà,
   memorie senza valore che poi tornavano come contesto.
8. **Gate che zittivano il bot.** Un "filler gate" sopprimeva le risposte che
   iniziavano con "non ho trovato…" nei canali (silenzio percepito come bug); il
   validator "nomi non ancorati" sostituiva la risposta con un rifiuto a partire
   da 3 nomi sconosciuti. Un "quality gate" Gemini aggiungeva una chiamata per
   ogni mention solo per scrivere un log.
9. **Parametri modello datati.** `max_tokens` 500/900, nessun prompt caching
   (data e ora nel prompt di sistema rigenerato ogni turno, ~100 tool
   rimandati ogni volta), modello hardcoded in 29 file, SDK Anthropic 0.24 (2024).

## 2. Cosa è cambiato

### Conversazione Slack-native (`src/services/slackTranscript.js`)
- La **storia del modello è il thread/DM Slack reale**, letto con
  `conversations.replies` / `conversations.history` ad ogni turno: turni umani
  (con autore `<@U…> (Nome):` nei thread di canale) e turni `assistant` per i
  messaggi del bot. Sopravvive a riavvii e deploy; il DB resta come fallback.
- **Chiave di conversazione condivisa**: `thread:<canale>:<ts>` per i thread di
  canale (tutti i partecipanti), `userId` per il DM (compatibile con lo storico).
- Id del bot risolto una volta (`auth.test`) e riusato ovunque.

### `askGiuno` (`src/services/anthropicService.js`)
- `system` in due blocchi: **statico cacheato** (identità, regole, roster, con
  `cache_control`) + **dinamico** (data/ora, modalità DM/canale, ruolo, chi
  scrive, contesto recuperato). Il messaggio dell'utente resta pulito.
- Il contesto arriva dal `contextBuilder` (memorie con età, KB, entità, Drive,
  Attio) tramite `generalAssistantAgent`; niente più scansione entità duplicata.
- Modello primario **Opus 5** con thinking adattivo, `output_config.effort`
  (default `medium`), `max_tokens` 4096, fallback lato server sui rifiuti,
  massimo 12 round di tool per turno, `is_error` sui tool falliti.
- Sentinel **`[NO_REPLY]`**: nei thread dove Giuno non è taggato (o è in CC)
  decide lui se il messaggio è rivolto a lui; in DM il silenzio non è ammesso.
- Validator "nomi non ancorati": solo nota in coda da 3 nomi in su, mai più
  soppressione della risposta.
- Prompt di sistema riscritto per un modello che ragiona (principi, non 40
  "MAI"): stesse regole di dominio (Attio come CRM, ore solo dai daily,
  conferme per email/eventi, privacy dei DM, formato Slack).

### Handler Slack (`src/handlers/slackHandlers.js`)
- Mention: si toglie solo il tag del bot (le altre menzioni restano), CC
  rilevato con l'id del bot (`src/utils/mentionUtils.js`), thread → transcript,
  top-level → ultimi 15 messaggi del canale come contesto. Via il topic-recap
  Haiku, il quality gate Gemini e il filler gate (la risposta è sempre nel
  thread, quindi non sporca il canale).
- Reply impliciti: Giuno segue i thread in cui ha scritto (`activeThreads` in
  memoria + chiave condivisa in DB dopo un riavvio), risponde **nello stesso
  thread**, e lascia decidere al modello se il messaggio è per lui.
- DM: storia dal DM Slack (ultimi 30 messaggi), thread nel DM inclusi.

### Router e agenti
- Il transcript viaggia nel `ctx` e arriva anche agli agenti specializzati
  (client retrieval, thread summary, CRM update, daily digest) e alle skill.
- Dentro una conversazione avviata, un messaggio breve (<80 caratteri) va
  sempre all'assistente generale: gli agenti specializzati perdevano il filo.
- Le parole "thread" e "summary" da sole non instradano più al riassunto.

### Memoria
- `slackMemoryWatcher` non scrive più testo grezzo in KB (resta il rilevamento
  dei segnali di completamento). L'apprendimento dai canali è del
  `realTimeListener` (batch + triage AI).
- `autoLearn` su Sonnet 5, criterio "lo scriverebbe un collega attento negli
  appunti?", riceve le memorie già in contesto come "GIÀ NOTO" per non
  duplicarle; aggiornamenti CRM solo su dichiarazione esplicita.
- Riassunto DM e compressione conversazioni su Sonnet 5.

### Modelli (`src/config/models.js`)
| Livello | Default | Override env | Usato per |
|---|---|---|---|
| PRIMARY | `claude-opus-5` | `GIUNO_MODEL_PRIMARY` | askGiuno, skill, agenti, briefing |
| UTILITY | `claude-sonnet-5` | `GIUNO_MODEL_UTILITY` | riassunti, autoLearn, consolidamento, parsing daily |
| FAST | `claude-haiku-4-5` | `GIUNO_MODEL_FAST` | intent, triage canali, scanner, validatori |

Altre variabili: `GIUNO_EFFORT` (`low|medium|high`, default `medium`),
`GIUNO_REFUSAL_FALLBACK=0` per disattivare il fallback sui rifiuti,
`GIUNO_BOT_USER_ID` (opzionale, altrimenti `auth.test`).
SDK `@anthropic-ai/sdk` aggiornato a 0.124.

## 3. Cosa osservare dopo il deploy
- Log `[ASK-GIUNO] … storia: N turni (slack)`: se compare `(db)` o `(none)` in
  un thread, Slack non ha risposto alla lettura del thread (permessi
  `channels:history` / `groups:history` / `im:history`).
- Log `[API] cache — read: … write: …`: `read` > 0 dal secondo turno conferma
  il prompt caching. Se resta 0, qualcosa nel blocco statico cambia ad ogni
  chiamata (roster?).
- Latenza: con Opus 5 + effort `medium` un turno con 2-3 tool sta sotto i 55s
  del timeout agente. Se si avvicina, `GIUNO_EFFORT=low`.
- Costi: `get_api_costs` / tabella `api_usage` con i nuovi ID modello.

## 4. Fase 2 (stessa settimana)

- **Pulizia KB** — `src/jobs/kbNoiseCleanupJob.js`: rigetta (non cancella) il
  dump grezzo del vecchio watcher e le entry `auto_learn` mai usate da oltre
  60 giorni. `/giuno admin kb-cleanup` mostra l'anteprima, `… apply` esegue;
  cron ogni domenica 5:30. Reversibile con un UPDATE su `validation_status`.
- **Eval** — cartella `eval/` con runner (`npm run eval`), importer di thread
  reali (`npm run eval:import`) e sei casi seed. Vedi `eval/README.md`.
- **Agenti** — rimossi `threadSummaryAgent` e `clientRetrievalAgent` (con il
  thread Slack in mano l'assistente generale fa meglio e non perde contesto);
  il classificatore intent è solo a parole chiave, senza fallback Haiku.
  Restano: daily digest, quote support, CRM update, prospecting, scan.
- **Due CRM che si confrontano** — `src/orchestrator/crmCompare.js`: quando il
  contesto contiene dati Attio, cerca i lead locali omonimi e segnala al
  modello le discrepanze di stato/valore (regola: fa fede Attio, proporre
  l'allineamento). Tool `crm_compare` per il report completo on-demand
  ("confronta i CRM"). L'agente CRM aggiorna Attio e allinea l'interno.

## 5. Fase 3 — urgenze e manutenzione

- **Gemini era spento.** `gemini-2.0-flash` risulta dismesso da Google: ogni
  chiamata (ask_gemini, ricerca web, news, prospecting) falliva in silenzio nel
  circuit breaker. Ora il modello è `GEMINI_MODEL` (default `gemini-2.5-flash`).
  Nota: il pacchetto `@google/generative-ai` è deprecato a favore di
  `@google/genai`; da migrare quando si tocca di nuovo Gemini.
- **Registro dei cron** — `src/jobs/scheduler.js` è un proxy di node-cron: ogni
  job (45, in quattro file) ha nome, espressione, lock, ultimo esito, durata ed
  errori, e non riparte se la corsa precedente è ancora in esecuzione.
  I job che inviano messaggi e non avevano un lock distribuito (routine,
  recap, daily, planner, digest, briefing pre-call…) ora lo prendono tramite
  lo scheduler (`lockTtl`): niente più invii doppi durante un redeploy.
  `/giuno admin cron` mostra la tabella con gli errori in evidenza.
- **Dashboard e metriche chiuse in produzione.** Senza `OAUTH_ADMIN_TOKEN`,
  `/dashboard` e `/metrics` rispondono 401 su Railway (prima erano aperti a
  chiunque avesse l'URL). In locale restano aperti. `/healthz` sempre aperto.
- **Scritture automatiche CRM disattivabili**: `GIUNO_AUTOLEARN_CRM_WRITES=0`
  ferma lead e contatti creati da autoLearn (memorie e KB continuano).
- **Dipendenze**: `@slack/bolt` 3.22 → 5.1 (richiede Node ≥ 20; il codice usa
  solo l'API JS stabile: App, event/message/command/action/view, client),
  `@slack/web-api` 7 → 8 di conseguenza, `@supabase/supabase-js` 2.116,
  `node-cron` 4.6, `googleapis` 178; `engines.node >= 20`, CI su Node 22;
  `npm audit` a zero. `dotenv` lasciato a 16: la 17 stampa una riga di log per
  ogni `config()` e qui viene chiamato in 14 file.
- **Repo**: rimossi `.DS_Store` e `user_tokens.json` (era un esempio; il
  fallback JSON crea il file da solo se serve).

## 6. Da fare
1. **Conversazioni legacy in DB**: le chiavi `userId:threadTs` restano come
   fallback in lettura; si possono cancellare dopo qualche settimana.
2. **Casi eval reali**: i sei seed coprono i comportamenti base; servono
   20-30 thread veri importati con `npm run eval:import` e annotati.
3. **Decidere il destino della tabella `leads`**: oggi è allineata "a mano"
   dal confronto; se Attio resta l'unico CRM, `leads` può diventare una cache
   di sola lettura sincronizzata da un job.
