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

## 6. Daily stimato per chi non compila

- **17:30** (`daily_push`): per chi non ha risposto, `src/agents/dailyEstimator.js`
  raccoglie le tracce della giornata — piano scritto nel daily precedente,
  pianificazione settimanale, calendario Google, messaggi Slack (serve
  `SLACK_USER_TOKEN` con `search:read`), oggetti delle email — e Sonnet 5
  ricostruisce un daily (task con tracce reali, ore solo da calendario o
  piano, totale ≤ 8h). La proposta arriva in DM con **Confermo così** /
  **Lo compilo io**. Senza tracce, il push resta quello di prima.
- **18:00** (`daily_recap`): chi non ha risposto né confermato riceve una
  entry `source = 'estimate'`, pubblicata in #daily marcata "stima di Giuno,
  non confermata". Le ore stimate **entrano nel consuntivo** (`time_logs` con
  `notes = 'stima Giuno…'` e `validation.status = 'estimate'`), nel carico,
  nel prefill del planner e nei totali di `query_standup`, che però elenca a
  parte i giorni stimati così Giuno lo dichiara quando riporta le ore.
- **Sovrascrittura**: qualsiasi daily vero (modale, DM, canale, conferma del
  bottone → `estimate_confirmed`) sostituisce la stima e allora sì alimenta il
  consuntivo. Disattivabile con `DAILY_ESTIMATES_ENABLED=false`.

## 7. Higgsfield da Slack (connettore MCP, account unico)

Giuno genera immagini e video con Higgsfield senza API key: dichiara il
server `https://mcp.higgsfield.ai/mcp` nella richiesta all'API Anthropic
(connettore MCP, beta `mcp-client-2025-11-20`) e i tool del server compaiono
accanto a quelli interni. L'API esegue i tool dentro la stessa chiamata.

- **Un solo account**: il token OAuth vive in `mcp_connections` (Supabase,
  fallback `mcp_connections.json`). Lo collega un admin con
  `/giuno admin higgsfield` → link → login Higgsfield nel browser → callback
  `/oauth/mcp/higgsfield/callback` (stesso host dell'OAuth Google). Il client
  OAuth viene registrato dinamicamente la prima volta (PKCE S256, refresh
  automatico 60 s prima della scadenza). Migrazione: tabella `mcp_connections`
  in `supabase_migration.sql`.
- **Quando si allega**: solo se il messaggio (o le ultime due battute) parla
  di generare immagini/video (`mcpToolsets.isGenerationRequest`). Così il
  prefisso cacheato del prompt non cambia e non si pagano ~90 tool a turno.
  Lista `HIGGSFIELD_ALLOWED_TOOLS` (generazione, attesa job, upscale, sfondo,
  reframe, presets, balance): fuori website builder, TikTok, 3D, clipper.
- **Chi può generare**: `HIGGSFIELD_ALLOWED_USERS` (id Slack separati da
  virgola) oppure, se vuoto, tutti tranne i ruoli `restricted`. I crediti sono
  condivisi: `/giuno admin higgsfield` mostra stato, chi ha collegato, scadenza.
- **Timeout**: sul path GENERAL le richieste di generazione hanno 5 minuti
  (`GENERATION_TIMEOUT_MS`) invece di 55 s, perché `jobs_wait` di un video può
  durare minuti. I tool MCP usati contano per il validator e i risultati
  (URL) entrano nell'evidenza anti-allucinazione.
- **Env**: `HIGGSFIELD_MCP_URL` (override), `HIGGSFIELD_ALLOWED_USERS`. Nessuna
  chiave da mettere su Railway.
- `/giuno admin higgsfield disconnect` scollega (butta i token, tiene il client).

## 8. Incidente del 10/9: "Giuno mi ignora" e link Google "il sito va in down"

Due cause distinte, entrambe verificate sui dati (conversazioni in DB, DM
Slack, probe HTTP sul dominio Railway).

**Risposte vuote in DM.** Ogni volta che Antonio diceva "manda" (stesso
messaggio lungo a 7 persone) il modello emetteva 7 `send_dm` con il testo
completo in una sola risposta: oltre i 4096 token di `max_tokens`, risposta
troncata a metà `tool_use`, nessun testo, e askGiuno tornava `''` che il
DM handler scartava in silenzio. Sei turni di fila salvati con assistant vuoto.
Correzioni:
- `max_tokens` 4096 → 16000 (`GIUNO_MAX_TOKENS`); si paga solo l'output reale.
- Troncamento con tool completi → i tool vengono eseguiti e il modello
  continua con una nota; troncamento/risposta senza testo → un retry con
  istruzione di sintesi; se ancora vuota, in DM/mention arriva un fallback
  leggibile ("Mi sono incartato…"), mai il silenzio.
- `send_dm` accetta `target_user_ids`/`target_user_names`: un solo tool call
  per lo stesso testo a più persone (prompt aggiornato). La conferma per dati
  sensibili ora funziona via `confirmed=true` (prima usava un action_id che
  `confirm_action` non conosceva).
- Dedup sugli eventi DM (Slack rimandava l'evento → doppio "Eccomi!").

**Link Google.** `https://giuno-bot-production.up.railway.app/healthz` risponde
502 "Application failed to respond" mentre il bot su Slack è vivo: il dominio
pubblico Railway non arriva alla porta su cui il processo ascolta (dal 29/6 il
server binda `$PORT`; nessun token Google è più stato salvato dopo aprile).
Quindi il callback OAuth è rotto per tutti, e in più il modello, non avendo un
tool, ha "inventato" il link per Samuele. Correzioni:
- Il server HTTP ascolta su `PORT` e, su Railway, anche sulla 3000
  (`resolveListenPorts`), così il dominio funziona qualunque porta punti.
- Auto-verifica un minuto dopo il boot: se `<origine di OAUTH_REDIRECT_URI>/healthz`
  non risponde 200, log di errore e DM agli admin con l'istruzione precisa
  (Railway → Settings → Networking → porta del dominio, oppure `PORT`).
- Tool `send_google_link` (admin/finance/manager): genera il link personale
  del collega e glielo manda in DM; il prompt vieta gli URL OAuth scritti a mano.

**Da fare su Railway (Antonio):** dopo il deploy leggere nei log la riga
"OAuth + Dashboard server su porta …" e, se il DM di avviso arriva, allineare
la porta del dominio pubblico. Poi Samuele (e Gloria) possono collegare Google
con "collega Google" in DM o tramite `send_google_link`.

## 9. Dossier di progetto (fase 4)

Prima non esisteva una "scheda" di progetto: `projects` ha solo i campi CRM,
i recap Gemini finivano in KB taggati per cliente a stringa, i kick-off non
erano riconosciuti e lo scanner recap leggeva solo Gmail e allegati
calendario (2 recap in 30 giorni, mentre Drive ne aveva decine). Ora:

- **`geminiNotesScanner`** (cron `gemini_notes_scan`, 5 volte al giorno):
  cerca su Drive i Google Doc "… - Appunti di Gemini", "Note della
  riunione", "Kick-off" modificati negli ultimi 3 giorni, li legge, estrae
  in JSON (sintesi, decisioni, azioni con responsabile e data, scadenze,
  rischi; per i kick-off anche obiettivi, deliverable, referenti, budget),
  li salva in KB (`tipo:meeting_recap|kickoff`, `drive_file_id:`,
  `progetto:`), li collega al progetto in `project_documents` e marca il
  dossier da aggiornare. Le informazioni personali non di lavoro vengono
  scartate dal prompt di estrazione. Backfill manuale: `/giuno admin
  gemini-scan 60`.
- **`projectDossier`** (cron `project_dossier_refresh` alle 5:30 e 18:30):
  per ogni progetto attivo con fonti nuove o scheda vecchia di 7 giorni
  ricostruisce la scheda da kick-off + recap + canale Slack (digest e
  messaggi degli ultimi 14 giorni) + ore consuntivate + allocazioni +
  segnali PM. Il modello (`GIUNO_MODEL_DOSSIER`, default sonnet-5) produce
  JSON con stato, fase, obiettivi, deliverable, scadenze, team, referenti,
  decisioni, rischi, prossimi passi, domande aperte e **cambiamenti** rispetto
  alla versione precedente. Tabella `project_dossiers` (versione, changelog,
  fonti). Max 10 schede per run (`DOSSIER_MAX_PER_RUN`).
- **Proattività**: i cambiamenti con importanza alta (scadenza vicina,
  blocco, rischio, cambio budget/scope, decisione del cliente) arrivano in DM
  al responsabile del progetto (o agli admin) una sola volta per
  cambiamento (`followup_log`, `DOSSIER_NOTIFY_ENABLED=false` per spegnere).
  Lunedì 8:45 brief "stato progetti" agli admin (`project_dossier_weekly`).
- **Uso**: `/giuno progetto <nome>` (o senza nome per l'elenco), tool
  `get_project_dossier` / `refresh_project_dossier` / `list_project_dossiers`,
  e la scheda compatta entra da sola nel contesto quando il canale è
  collegato a un progetto o il messaggio lo nomina. Admin: `/giuno admin
  dossier refresh [nome|all]`, `dossier weekly`, `gemini-scan [giorni]`.

**Limiti noti.** La tabella `projects` ha 75 righe "attive" con duplicati
(Hammersud ×3, Tarocco ×2) perché nasce da tre sincronizzazioni (Attio,
canali, categorie): la scheda si costruisce per la riga che il catalogo
abbina per nome; una deduplica dei progetti è il passo successivo. Le
"sviluppi" del progetto oggi sono canale Slack + recap: i documenti di
lavoro modificati su Drive entrano solo se il `drive_watcher` li porta in KB.

## 10. Pulizia progetti e proattività (fase 5)

**Deduplica progetti** (`src/jobs/projectDedupJob.js`). La tabella `projects`
nasce da tre sync (deal Attio, canali Slack, categorie) più i manuali: lo
stesso progetto compariva due o tre volte e i canali di servizio (generale,
daily, casuale, ped…) erano "progetti". Ora:
- `/giuno admin progetti dedup` propone i gruppi (stesso nome compattato, nome
  contenuto con almeno un token forte, stesso cliente) e le righe rumore;
  `dedup apply` unisce; `merge <duplicato> -> <canonico>` per i casi ambigui
  (più deal Attio dello stesso cliente non si uniscono da soli).
- Canonico: manuale > deal Attio (porta budget e CRM) > canale con più dati.
  Il merge sposta ore, allocazioni, documenti e azioni sul canonico, aggiunge
  il nome del duplicato agli `aliases` (il matcher li usa), riempie
  `client_name`, marca il duplicato `status='merged'` + `merged_into`; le sync
  non lo resuscitano e il planner "Altro" rimanda al canonico.
- Lunedì 6:15 un controllo propone agli admin le unioni nuove (una volta).

**Proattività ancorata ai progetti** (`src/agents/projectFollowups.js`,
tabella `project_actions`):
- Le azioni con responsabile estratte dagli appunti Gemini ("Corrado →
  inviare documenti entro il 10/09") diventano righe `project_actions`,
  assegnate via roster. Alle 9:10 chi ha azioni dalla call del giorno prima
  riceve un DM con bottoni *Fatto / Ok, lo tengo / Non è mio*.
- Promemoria a ridosso: azioni in scadenza entro 2 giorni (max 2 volte) e
  scadenze di progetto dal dossier entro 3 giorni (al responsabile o agli
  admin, una volta). Tutto passa da `followup_log` e dalle preferenze
  notifiche.
- Briefing del mattino: sezione "Scadenze progetti (7 giorni)" (tutte per
  admin/manager/finance, solo le proprie per gli altri) + azioni personali.
- Pre-call briefing: la scheda progetto entra nel prompt prima del JSON
  (stato, prossima scadenza, rischio aperto).
- Brief del lunedì: sezione "Fermi da 14+ giorni" (scheda con cose aperte,
  canale muto, zero ore).

## 11. Campagne con conferma di lettura e roster automatico (fase 6)

**Campagne** (`src/agents/messageCampaigns.js`, tabella `message_campaigns`,
tool `send_campaign` / `campaign_status` / `cancel_campaign`). "Manda ai 7,
chiedi LETTO, sollecita chi non risponde, al terzo giro avvisami" ora è una
sola chiamata: Giuno manda i DM, registra la risposta attesa (o una reaction
sul messaggio), ogni `check_interval_min` sollecita chi manca fino a
`max_pushes`, poi marca "senza risposta" e riferisce a chi ha lanciato la
campagna a ogni giro e alla chiusura. Se la risposta è solo la conferma,
Giuno mette la spunta e non scomoda il modello; se contiene altro, la
registra e risponde normalmente. Cron `campaign_check` ogni 10 minuti;
`/giuno admin campagne [check|annulla <id>]`.

**Roster** (`src/jobs/teamRosterSyncJob.js`, cron `team_roster_sync` 7:20).
Il roster era fermo a giugno e Giuno dichiarava di aggiornarlo senza tool.
Ora: users.list → chi manca viene aggiunto (nome, alias, mansione dal
profilo Slack), chi è disattivato su Slack viene spento, ospiti e bot fuori,
riepilogo agli admin. Tool `team_member_joined` / `team_member_left` per
dirlo a Giuno in chat; il prompt vieta "segnato" senza tool. Il `team_join`
inserisce subito il nuovo collega nel roster. `/giuno admin team sync [dry]`.

## 12. Pacchetti di tool (fase 7)

Ogni turno mandava tutti i 143 tool: ~21.000 token di sole definizioni,
prima di contesto e storia (media reale il 10/9: 41.000 token in ingresso per
chiamata). Ora `src/tools/toolPacks.js`:
- **Nucleo** di ~45 tool sempre presenti (lettura Slack/mail/calendario/Drive,
  memoria, KB, progetti e dossier, standup e ore, CRM in lettura, DM e
  campagne, ricerca). L'ultimo tool del nucleo porta il `cache_control`, così
  il prefisso resta cacheato qualunque pacchetto segua.
- **Pacchetti** caricati dal testo del turno e dalle ultime due battute:
  `email_write`, `calendar_write`, `drive_write`, `crm_write`,
  `projects_write`, `agency`, `team_admin`, `slack_admin`, `memory_admin`.
- **`more_tools`**: se al modello manca uno strumento, chiede il pacchetto e
  dal round successivo lo ha. Nessuna funzione persa.
- Peso: nucleo ~7.500 token contro ~21.000 (−65%); con un pacchetto ~8.500;
  con tre pacchetti ~12.000. `GIUNO_TOOL_PACKS=off` ripristina tutti i tool.
- Il test `tool-packs.test.js` verifica che ogni tool del registro sia nel
  nucleo o in un pacchetto: un tool nuovo senza collocazione fa fallire la suite.

## 13. Memoria delle azioni e risposte nei DM (incidente del pomeriggio)

Alle 14:07 Giuno ha mandato il messaggio ai 7, alle 14:08 di nuovo, alle
15:03 ha detto "non ho traccia dell'invio" e alle 15:04 lo ha rimandato:
Alessandra lo ha ricevuto tre volte. Al "check" ha risposto "nessun LETTO"
mentre Alessandra aveva risposto. Cause: la storia che il modello vede è il
transcript Slack, senza i tool eseguiti nei turni precedenti; e le risposte
degli altri stanno nei DM fra Giuno e loro, che il modello non leggeva.
- `conversation_actions` + `src/services/db/actionLog.js`: ogni tool con
  effetto (DM, campagne, email, eventi, CRM, roster…) viene registrato e
  rientra nel contesto come "AZIONI GIÀ ESEGUITE" (24h). Il prompt vieta
  "non ho traccia" e le ripetizioni non richieste.
- `send_dm`: stesso testo alla stessa persona entro 30 minuti viene bloccato
  come doppione (`force=true` per rimandare davvero).
- Tool `check_dm_replies` (nel nucleo): legge i DM fra Giuno e le persone
  indicate e dice chi ha risposto e chi ha confermato la parola attesa.
- Le campagne, a ogni giro, rileggono anche la history dei DM: le risposte
  arrivate mentre il bot era giù (deploy) contano.

## 14. Recap duplicati ed eval con casi reali (fase 8)

- **Recap duplicati**: la cache KB in memoria non vedeva gli insert dello
  stesso giorno, quindi ogni giro del cron risalvava gli stessi recap (fino a
  4 copie, 15 righe cancellate il 10/9). Ora `db.kbHasTag` controlla il DB,
  un insieme per-run copre lo stesso evento su più calendari, e il doc Gemini
  letto dal calendario porta `drive_file_id:` così lo scanner Drive lo salta.
- **Eval**: 12 casi nuovi ricavati da conversazioni vere (thread
  #preventivi-clienti e #clienti-angela-intelisano, DM di Antonio e Paolo),
  anonimizzati con U1…U5: "segui qui?", silenzio quando i colleghi si
  organizzano tra loro, reminder con destinatari nei tag, to-do in testo
  libero, link Google a un collega, invio ai 7 in una chiamata, "hai
  mandato?" senza rimandare, "check" con `check_dm_replies`, uscita dal team
  col tool, CRM senza doppio asterisco, recap progetti con le persone giuste,
  immagine con Higgsfield collegato o no.
- Il runner **simula i tool con effetto** (DM, email, eventi, CRM, roster,
  reminder): i casi possono pretendere la chiamata senza scrivere davvero.
- **`/giuno admin eval [filtro] [nojudge]`** lancia l'harness in un processo
  separato su Railway (stesse chiavi) e risponde con superati/totale, punteggio
  del giudice e i casi falliti con motivo. Prima serviva un `.env` locale.

## 15. Daily precompilato e follow-up di pipeline (fase 9)

**Daily "al contrario"** (`dailyStandupV2`). Alle 16:00 non arriva più il
modulo vuoto: Giuno costruisce la stima della giornata (calendario, Slack,
mail, piano di ieri, pianificazione settimanale) e la manda con "Confermo
così" / "Correggo io". Il modale si apre già compilato con task e durate
della stima (`prefillFromEstimate`, `initial_value`/`initial_option`). Alle
17:30 chi non ha confermato riceve solo un promemoria con gli stessi bottoni;
alle 18:00 la stima entra come daily stimato, come prima.
`DAILY_PREFILL_ENABLED=false` per tornare al modulo vuoto.

**Pipeline Attio** (`src/agents/pipelineFollowups.js`). Lunedì e giovedì
alle 9:05 gli admin ricevono i deal aperti fermi da 14+ giorni (ultimo
movimento = `active_from` più recente fra i valori del record, esposto da
`attioService.queryRecords` come `last_activity_at`), con suggerimento
(follow-up, chiudere come Lost, aggiornare lo stage) e le proposte senza
valore. Throttle per deal: 7 giorni, massimo 3 volte. Tool `pipeline_review`
("come va la pipeline"), `/giuno admin pipeline [giorni|notify]`.
`PIPELINE_STALE_DAYS` per la soglia.

## 16. Retrospettiva serale (auto-sviluppo, livello 1)

Alle 21:00 nei giorni feriali `src/agents/selfReview.js` raccoglie i segnali
della giornata: risposte in fallback (vuote, "mi sono incartato", validator,
"a cosa ti riferisci?"), tool falliti (ring buffer in anthropicService),
cron con errori (registro scheduler), pattern di errore, feedback negativi,
ultima eval, costi API, conversazioni e azioni. Se c'è qualcosa da dire, il
modello (`MODELS.UTILITY`) produce sintesi, cosa ha funzionato, al massimo
tre proposte (evidenza, causa probabile, proposta, dove: prompt/tool/codice/
dati/processo, impatto, sforzo) e cosa non toccare. Va in DM agli admin e in
`self_reviews` (storico per il livello 2). `/giuno admin retrospettiva
[ieri|YYYY-MM-DD]` la forza. Il livello 2 (Giuno scrive la modifica e apre
la PR) richiede un token GitHub su Railway: da fare quando lo decidi.

## 17. Il lato dati della dashboard giun.os (budget, ore, backfill, copertura)

La dashboard di Codex (`src/giunos/*`) legge `projects`, `time_logs`,
`standup_entries`, `project_dossiers`, `project_actions` e `giunos_budgets`.
Se quelle tabelle sono vuote o sporche, mostra il vuoto. Quattro pezzi
alimentano il lato dati; nessuno decide da solo, tutti propongono agli admin.

1. **Budget ore per progetto** (`src/agents/budgetImporter.js`). Per ogni
   progetto attivo propone un budget in ore, in ordine di affidabilità:
   preventivo in `quotes` (giornate × 8, alta), documento di kick-off nel
   dossier (ore o giornate nel testo, media), valore in € del deal Attio o
   del preventivo diviso per la tariffa oraria media della rate card (bassa;
   `GIUNO_DEFAULT_HOURLY_RATE` se manca la rate card). Le proposte entrano in
   `giunos_budgets` con `verified=false` e scope `project`; le righe già
   verificate non si toccano. `/giuno admin budget` anteprima, `budget
   applica` scrive, `budget conferma <progetto> [ore]` verifica (o crea con
   le ore indicate). Cron `budget_proposals` il lunedì alle 6:40: scrive le
   proposte nuove e avvisa gli admin una volta per set (gate proattivo, 7
   giorni). Il tool `get_project_dossier` aggiunge "Budget ore: X · registrate
   Y · restano Z". La DDL è in `docs/giunos-budgets.sql` e ora anche in
   `supabase_migration.sql`: va applicata (Supabase MCP non era autenticato).
2. **Attribuzione delle ore orfane** (`src/agents/hoursAttribution.js`). Un
   task del daily senza `project_id` non entra nei consuntivi per progetto.
   Ogni sera alle 23:30 (`hours_attribution`) i task orfani degli ultimi 14
   giorni vengono riprovati col catalogo aggiornato (alias dei duplicati
   uniti, progetti nuovi); quelli risolti aggiornano `standup_entries` e il
   consuntivo tramite `syncTimeLogsFromDaily`. `/giuno admin attribuzione
   [giorni] [apply]` mostra chi ha ore senza progetto e con quali task.
3. **Backfill automatico** (`geminiNotesScanner`, opzione `autoBackfill`):
   se `project_documents` è vuota, la corsa oraria del cron guarda indietro
   60 giorni invece di 3, senza aspettare `gemini-scan 60` a mano. Il
   `refreshDossiers` delle 5:30/18:30 costruisce poi le schede.
4. **Report di copertura** (`src/agents/coverageReport.js`,
   `/giuno admin copertura [giorni]`): per ogni persona del roster Google
   collegato, daily veri/stimati, ore vere/stimate, preferenze spente; stato
   delle integrazioni (SLACK_USER_TOKEN, OAUTH_ADMIN_TOKEN, Attio, Gemini,
   Higgsfield); conteggi di progetti, dossier, documenti, azioni, recap,
   budget; gruppi di duplicati; e una lista "Da sbloccare" con le azioni
   concrete. È la pagina da leggere prima di fidarsi dei numeri.

Da fare a mano: applicare la DDL di `giunos_budgets`, poi `/giuno admin
copertura` e seguire la lista.

## 18. Evidenze operative dei progetti (ciclo di vita, dopo la PR #136)

La PR #136 di Codex ha reso i progetti importati (deal Attio Won, canali
Slack) dei candidati: status `planning`, contati tra gli attivi dalla
dashboard solo con `projects.lifecycle_evidence` = { state:'active',
source_url https, observed_on, valid_until } valida oggi. Nessuno la
compilava, e la sync (boot + ogni 2 ore) riporta a `planning` chi non ce
l'ha. Effetto: catalogo vuoto per la dashboard e, peggio, per il bot (matcher
del daily, dossier, planner, modale ore, dedup, follow-up, budget), che
leggeva solo `status='active'`.

Due interventi:

1. **Stati aperti ovunque nel bot.** `searchProjects` accetta `statuses:[…]`;
   il catalogo del matcher, la modale ore, i dossier, il dedup, i follow-up,
   il budget e i comandi admin leggono `active + planning (+ on_hold)`.
   Registrare ore su un progetto acquisito è possibile e anzi è un indizio.
   La dashboard continua a mostrare solo gli attivi con evidenza.
2. **Motore delle evidenze** (`src/agents/lifecycleEvidence.js`, cron
   `lifecycle_refresh` 7:05 feriali, `/giuno admin progetti evidenze [apply]`).
   Per ogni progetto aperto raccoglie prove datate con URL:
   kick-off su Drive (vale 90 giorni), recap di call su quella commessa (30),
   azioni aperte emerse dalle call con link alla fonte (scadenza + 14),
   riunioni in calendario col nome del progetto/cliente (giorno + 7),
   decisione esplicita di PM/admin (60). La più lunga diventa
   `lifecycle_evidence` e lo status passa ad `active`. Le ore dichiarate nel
   daily (≥ 2 giorni in 21) sono un indizio, non una prova: Giuno manda al
   PM (owner) o agli admin un DM con tre bottoni, "È operativo / Sospeso /
   Concluso", e la risposta diventa l'evidenza con il permalink Slack.
   Evidenza scaduta senza prove nuove, o scheda che dice "fermo"/"chiuso" →
   stessa domanda. Sospensioni e chiusure non sono mai automatiche.
   `/giuno admin progetti stato <nome> operativo|sospeso|concluso` registra
   la decisione in un DM a chi la prende, e quel permalink è la fonte.
   Il volume dei messaggi nei canali non conta.

Il report copertura mostra "attivi (con evidenza) · acquisiti da verificare".

Cosa manca ancora, per punti del brief: (1) collegamento commessa ↔ Attio ↔
contratto ↔ documenti: fatto per documenti e azioni; il contratto arriva con
la PR #135 di Codex (`project_contract_sources`); (2) stati distinti: fatto;
(3) fonte, data, validità: fatto; (4) venduto/utilizzato sullo stesso
periodo: il budget proposto (§17) e il confronto nel dossier usano il
periodo del budget; il venduto verificato senza assunzione 8h/giornata è
la #135; (5) attività e consegne: le azioni hanno già `description_key`
anti-duplicato, le consegne vengono dalla scheda; manca un registro
"consegne" con stato e data proprio, da fare dopo la #135.

## 19. Daily stimato: appello dal DB, fonti per tutti, ore sempre

Segnalazione del 10/9 (Antonio): Gianna aveva compilato alle 17:16 ma alle
18:00 era "mancante"; le stime uscivano solo per tre persone e solo dal
calendario; Samuele aveva task senza ore.

1. **Appello dal DB.** L'appello delle 18:00 e il push delle 17:30 leggevano
   `sd.risposte`, una cache in memoria: con due istanze sovrapposte durante
   un deploy (l'una salva, l'altra ha la copia vecchia) chi ha compilato
   risulta assente. Ora `respondedFromDb` legge `standup_entries` del giorno
   (source ≠ estimate) e la cache è solo un'aggiunta.
2. **Fonti anche senza token.** Prima le fonti erano calendario ed email
   della persona (serve il suo Google) e la ricerca Slack (serve
   SLACK_USER_TOKEN): chi non aveva né l'uno né l'altra non aveva stima.
   Ora il contesto di giornata, letto una volta per corsa, dà a tutti:
   documenti su Drive creati o modificati oggi (token degli admin/manager,
   raggruppati per ultimo autore, email o nome), messaggi e allegati nei
   canali dove c'è Giuno (token del bot), riunioni nei calendari degli admin
   dove la persona è invitata. Chi ha il proprio Google aggiunge il proprio
   calendario e le email, comprese quelle inviate.
3. **Ore sempre.** Il modello assegna una durata a ogni task (riunione =
   calendario, documento creato 1-2h, modificato 1h, email o scambio 30 min,
   supporto 1h, piano di ieri = pianificato); un task rimasto a 0 vale 30
   minuti. Tetto 8h. Il numero dei messaggi non conta.
4. In #daily, per chi resta senza stima Giuno dice che non ha trovato tracce.

## 20. Osservazione passiva: sessioni di lavoro e calibrazione

Le ore del daily stimato non le indovina più il modello. Ogni artefatto ha
un orario, e `src/agents/activitySessions.js` li mette in fila per persona:

- revisioni di oggi dei file su Drive (`revisions.list`, autore e ora: anche
  chi ha modificato senza essere l'ultimo autore);
- versioni dei file Figma modificati oggi nei progetti del team
  (`FIGMA_TOKEN` e `FIGMA_TEAM_ID` su Railway; senza, la fonte si salta);
- messaggi e allegati nei canali con Giuno (timestamp);
- riunioni con inizio e fine (calendario proprio o inviti negli admin).

Le pause sopra 45 minuti spezzano il blocco; una sessione vale almeno 15
minuti e al massimo 5 ore. Il prompt riceve "SESSIONI DI LAVORO RICOSTRUITE
DAI TIMESTAMP (totale …)" con gli estremi orari e le tracce di ciascuna; la
regola è che la somma dei task si avvicini al totale delle sessioni e che
ogni sessione vada al task indicato dalle sue tracce. Il numero di eventi non
pesa: contano gli estremi temporali.

Calibrazione (`src/services/estimateCalibration.js`): quando una persona
conferma o corregge una stima, la coppia ore stimate/ore reali finisce in
`daily_estimate_calibration` (migrazione in `supabase_migration.sql`). Con
almeno tre coppie, il prompt riceve "STORICO DELLE STIME PER QUESTA PERSONA:
… più basse/alte del reale di circa il N%" e il modello corregge le durate
dedotte, non quelle da calendario. La stima registra `sessions_minutes` e
il rapporto usato, così si può misurare se le stime migliorano nel tempo.

Fuori scope, per dopo: Drive Activity API (serve un nuovo scope OAuth),
registro cartelle/canali/file per progetto, commit GitHub.

## 21. Registro delle posizioni di progetto

Un artefatto va attribuito alla commessa per POSIZIONE, non per somiglianza
del nome: il file sta nella cartella del progetto, il messaggio è nel suo
canale, il file Figma è nel suo progetto Figma. `src/services/projectLocations.js`
tiene il registro in `project_locations` (kind: slack_channel, drive_folder,
figma_project, figma_file; source: channel_map, document, figma, admin).

Ricostruzione (cron `project_locations_sync` 6:50 feriali,
`/giuno admin progetti posizioni rebuild [apply]`): i canali dalla channel
map (`chan_<id>` → alta, per nome → media); la cartella Drive che contiene
il kick-off o il brief di un progetto (i recap no: stanno in "Appunti di
Gemini", che non è mai una cartella di progetto); i progetti Figma con nome
simile a progetto o cliente. Le righe impostate a mano
(`/giuno admin progetti posizione <nome> = <#canale | link cartella | link
progetto o file Figma>`) vincono e non vengono mai sovrascritte.

Uso nel daily stimato: documenti Drive (per cartella), messaggi (per canale)
e file Figma (per file o progetto) portano `[progetto: X]` nel prompt e
nelle sessioni di lavoro; il modello copia X nel campo `project` del task e
Giuno lo aggancia al catalogo per nome esatto prima del matcher. Senza
tabella il registro vive in memoria con i soli canali, e i comandi lo dicono.

## 22. Revisione dei criteri della dashboard giun.os

Richiesta di Antonio (11/9): "ci sono un bel po' di criteri sbagliati".
Letto tutto `src/giunos/*`. Cosa non tornava e cosa cambia:

1. **Venduto "nel periodo" sempre "Non verificato".** Il confronto usava
   solo budget con `scope=period` e date esattamente uguali al mese o
   trimestre di calendario: nessun contratto è fatto così, quindi la colonna
   restava vuota per sempre. Ora la colonna è "Usate / vendute sulla
   commessa": il budget dell'intera commessa (`scope=project`), con ore
   usate nel perimetro contrattuale, residue e percentuale. Se la baseline è
   verificata è "venduto verificato"; se è la proposta di Giuno (preventivo,
   kick-off, deal) resta visibile ma marcata "proposta, non confermata" e non
   genera allarmi. Due baseline sulla stessa commessa → "in conflitto", nessun
   numero. Il budget per periodo, quando c'è, resta in scheda.
2. **Tipologie di attività.** Quattro categorie generiche con regex grezze
   (`post` prendeva anche "posta"). Ora una tassonomia da agenzia: Revisioni,
   Riunioni e coordinamento, Commerciale, Strategia e analisi, Video e foto,
   Contenuti e copy, Design, Sviluppo, Pianificazione e gestione,
   Amministrazione, Formazione. La distribuzione esiste anche per progetto e
   per tutto il team in panoramica, non solo per persona.
3. **Milestone e blocchi non c'erano.** Il brief li chiede per progetto. La
   scheda ora mostra blocchi e rischi, milestone con data e stato (scadute
   in evidenza), prossimi passi con responsabile, azioni dalle call aperte e
   scadute, team dal dossier quando non ci sono ore.
4. **Segnali.** Prima solo "oltre budget nel periodo" (impossibile, vedi 1)
   e "attesa cliente". Ora in ordine di gravità: oltre il venduto sulla
   commessa (solo verificato), venduto quasi esaurito (≥ 80%), blocchi,
   azioni scadute, milestone scadute, attesa cliente, ore senza alcun budget.
5. **Stato dei progetti.** "Storico / stato operativo da verificare" metteva
   insieme acquisiti, sospesi e conclusi. Ora ogni progetto ha un ciclo di
   vita esplicito (operativo con evidenza e scadenza, da verificare, sospeso,
   concluso, archiviato); gli acquisiti in attesa di evidenza hanno una
   sezione propria in panoramica invece di sparire.
6. **Persone.** La colonna "azioni chiuse" (quasi sempre zero: le azioni
   vengono solo dalle call) lascia il posto a "dove va più tempo" (progetto
   principale e quota); nella scheda persona ogni progetto ha la quota del
   periodo, e "budget individuale non verificato" sparisce dove non ha senso.
   Nuova card di copertura: quante persone hanno ore nel periodo e quante
   solo stime.

Invariati, perché giusti: settimane lunedì-domenica e periodi di calendario;
ore registrate e stimate separate; solo `log_type=daily` (i weekly sono
piani); dedup delle correzioni; dettaglio del daily usato per le categorie
solo se torna col consuntivo; `consegnato` ≠ approvato; dati assenti = "—",
mai zero; 503 sugli errori, mai totali parziali.

Restano da fare: tempi di chiusura per tipologia con una base dati vera
(oggi solo le azioni dalle call), il venduto per persona (arriva con i ruoli
dei contratti della #135), un andamento per progetto oltre a quello per
persona.

## 23. Cliente → commesse, e il gruppo Interno

Antonio (11/9): "i progetti non sono raggruppati bene". Prima un progetto era
una riga qualsiasi: un deal Attio vinto, un canale Slack attivo, una riga
manuale; nessuna gerarchia, ordine per id. Il modello adesso è quello con cui
ragiona lo studio: **Cliente → Commesse**, più il cliente **Interno** per le
attività trasversali.

1. **Cliente della commessa.** La sync Attio legge l'azienda collegata al deal
   (`companyNameOf`, una chiamata per azienda con cache) e la salva in
   `client_name`. Con il cliente valorizzato la sync dei canali salta i canali
   dei clienti che hanno già commesse (regola già esistente, prima cieca).
2. **Deduplica.** Due deal dello stesso cliente sono due commesse, non
   doppioni. Un canale si unisce a un deal per "stesso cliente" solo se quel
   cliente ha una sola commessa; con più commesse resta al livello cliente e
   l'attribuzione passa dal registro posizioni (ambiguo → nessuna).
3. **Interno** (`src/services/transversalRules.js`): sei commesse fisse con
   `client_name = 'Interno'`, id `cat_*`: Daily e riunioni di team,
   Management e direzione, Team building e cultura, Formazione,
   Amministrazione e flussi interni, Commerciale e prospect. Gli id storici
   restano (le ore già registrate non si perdono; il seed rinomina).
4. **Aggancio deterministico.** `resolveTask`: prima un cliente del catalogo
   (una riunione interna su Elios resta su Elios), poi le regole trasversali
   ("daily", "management", "team building", "corso", "fatture",
   "preventivo"…; "daily con il cliente" e "SAL" non sono interni), poi il
   modello. Funziona anche con catalogo vuoto. Le stesse regole marcano le
   riunioni in calendario senza cliente nel titolo, quindi entrano nelle
   sessioni ricostruite col progetto giusto.
5. **Dashboard.** Tabella "Clienti e commesse": intestazione per cliente con
   ore, venduto verificato e proposto, blocchi e scadenze aggregate, poi le
   sue commesse; ordine per ore nel periodo. Sezione "Interno · attività
   trasversali" con ore e persone, e card "Tempo interno" (quota sul totale).
   Persone: colonna "Interno" per persona, e nella vista Persone una matrice
   persona × attività trasversale. La tipologia "Riunioni e coordinamento"
   resta sull'altro asse: somma le riunioni interne e quelle sui clienti.

## 24. Un solo criterio di presenza: dashboard, planner e pianificazione in giun.os

Antonio (11/9): il criterio di presenza dei progetti "dovrebbe essere lo
stesso applicato nel planning settimanale, che tra l'altro non è integrato in
visione su giun.os".

1. **Planner con lo stesso criterio.** Le opzioni del modulo di pianificazione
   (e della modale ore) usano `projectLifecycle`, che chiama lo stesso
   `isActiveProject` della dashboard: gruppi "Commesse operative" (per
   cliente, etichetta "Cliente · commessa"), "Acquisite · da confermare",
   "Sospese", "Interno · attività trasversali", poi "Altro". Chi pianifica
   vede subito se sta pianificando su una commessa che per Giuno non è
   ancora operativa.
2. **Pianificare è una prova.** Alla chiusura della finestra del planner
   (giovedì 18:00) Giuno pubblica il recap in #weekly e ne scrive il permalink
   nelle note delle righe `weekly` di quella settimana
   (`annotateWeeklyPlans`). Per il motore delle evidenze una pianificazione
   con permalink è una prova primaria (`weekly_plan`, vale fino alla domenica
   della settimana pianificata + 7); senza permalink (piani vecchi) è un
   indizio e Giuno chiede al PM. Pianificare su un acquisito lo rende
   operativo: è la persona che dichiara lavoro da fare, con data e link.
3. **Pianificazione in giun.os.** L'adattatore legge anche le righe
   `weekly`; il modello le tiene separate dalle registrate (`normalizePlans`,
   mai sommate). Panoramica: card "Pianificate" con copertura del planner
   della settimana corrente (quanti hanno pianificato su quanti). Commesse e
   persone: "pianificate X h" accanto alle ore registrate; scheda persona:
   pianificate per progetto e piano della settimana in corso; scheda
   commessa: persone con un piano anche se non hanno ancora ore.

## 25. Il livello attività: cliente → commessa → attività → microtask

Antonio (12/9): "Gambino è il macro progetto, poi ci sono le sotto task che
andrebbero aperte a tendina nella view generale ma non ha senso enumerarle
tutte nel progetto. Ha senso capire le singole task di ogni persona e
associarle a una task complessiva che a sua volta compone una macro task.
Quindi un sistema a matrioska. Se Giusy oggi scrive 'caption video gambino',
in automatico Giuno dovrebbe capire che questa microtask è un'azione che
serve a completare la task di gruppo più grande 'PED mese settembre'."

Prima c'erano due livelli: la commessa (`projects`) e la riga di ore. Ora:

1. **Quattro livelli.** Cliente (Attio) → commessa (`projects`, con venduto
   e budget) → attività (`project_activities`, nuova) → microtask (il task
   del daily in `standup_entries.oggi_tasks`, che riceve `activity_id` e
   `activity_name` accanto a `project_id`). Il consuntivo per commessa
   (`time_logs`) NON cambia: le ore per attività si ricavano dalle
   microtask e devono tornare con il consuntivo, come già le categorie.
2. **Attività con inizio e fine, o ricorrenti.** Una riga con `recurrence`
   (`mensile`, `settimanale`) è un modello: "PED" su "Gambino Vini · Social".
   Ogni mattina (cron `activities_roll`, 6:35) Giuno prima riaggancia le
   microtask degli ultimi tre giorni, poi apre l'istanza del periodo
   corrente ("PED settembre 2026", 1→30 settembre, stesso vocabolario del
   modello) e chiude quelle finite: `done`, mai cancellate, le ore restano
   lì. Un'istanza chiusa resta la candidata giusta per le microtask datate
   dentro il suo periodo (il daily del 31 agosto riagganciato a settembre va
   sul PED di agosto); l'aggancio usa sempre la data del daily, non oggi.
3. **Aggancio deterministico.** Trovata la commessa (come prima), la
   microtask cerca tra le attività aperte di quella commessa valide quel
   giorno. Una sola → quella. Più di una → vince chi ha più parole in
   comune tra il nome dell'attività e il suo vocabolario; a parità o senza
   parole in comune la microtask resta sulla commessa senza attività e il
   PM la vede tra le orfane. Mai un'attribuzione inventata. Il livello è
   agganciato in `enrichTasksWithProjects`, quindi vale per il daily
   compilato, per la stima di Giuno e per l'attribuzione notturna.
4. **Il vocabolario si impara.** Ogni microtask agganciata insegna le sue
   parole all'attività (senza le parole vuote: "della", "call", "cliente",
   "revisione"...; massimo 80). Dopo qualche daily "montaggio" e
   "vendemmia" bastano da sole.
5. **Comandi.** `/giuno admin attivita` elenca le aperte per commessa;
   `attivita nuova <commessa> = <nome> [mensile|settimanale] [entro
   AAAA-MM-GG] [parole: a, b, c]` crea (e riaggancia subito le microtask
   degli ultimi 14 giorni); `attivita chiudi <commessa> = <nome>`;
   `attivita orfane [giorni]` mostra le microtask che restano sulla sola
   commessa, per commessa, con esempi; `attivita rialloca [giorni] apply`;
   `attivita ricorrenze [apply]`.
6. **Nel DM della stima** ogni task mostra l'attività tra parentesi.

Da fare PRIMA del merge (il merge pubblica su Railway): applicare la
migrazione `project_activities` (in fondo a `supabase_migration.sql`); senza
tabella il codice degrada in silenzio (nessun aggancio, comandi che lo
dicono). Poi creare le prime attività, ad esempio
`/giuno admin attivita nuova Gambino = PED mensile parole: caption, post,
storie, reel, carosello`. La dashboard con le attività a tendina è la PR
successiva, insieme al registro delle evidenze pesate.

## 26. Il registro delle evidenze pesate: chi è davvero attivo

Antonio (12/9): "come fa Giuno a capire quali sono i progetti attivi? Dovrebbe
capirlo dal contesto Slack, dalle mail, dai canali attivi, da Attio, dal
documento 'Contabilità e Bilancio 26'. Non è una singola voce ma sono più
voci, perché ci possono essere più canali attivi su un singolo progetto o
progetti chiusi che rimangono su won su Attio. Quindi qui sta la chiave."

Il motore delle evidenze (§18) leggeva poche fonti e le trattava tutte allo
stesso modo. Ora ogni commessa ha un registro con più voci, ciascuna con
data e scadenza, divise in due pesi.

1. **Fonti forti, bastano da sole** (attivano la commessa con `source_url`
   https): kick-off, recap, azione aperta, calendario, decisione del PM,
   pianificazione con recap, e la nuova **fatturazione**: una riga del
   cliente in una scheda mensile del foglio "Contabilità e Bilancio <anno>"
   vale fino a fine mese + 15 giorni; i mesi futuri già pianificati contano
   da oggi (il contratto c'è). È la fonte più affidabile: quel cliente è
   sotto contratto quel mese.
2. **Indizi deboli, contano solo insieme**: ore dichiarate, pianificazione
   senza recap, messaggi del team nel canale della commessa negli ultimi 14
   giorni (dal registro delle posizioni, solo conteggio e data: il volume
   non fa ore), thread email con il cliente negli ultimi 30 giorni (Gmail di
   un admin, cercato per nome cliente), deal won su Attio. Due indizi di
   tipo diverso fanno chiedere al PM con i tre bottoni; uno solo non fa
   nulla. Un deal won da solo non basta più: un deal chiuso mesi fa senza
   altre voci resta "acquisito, da verificare". Le ore dichiarate da sole
   continuano a far chiedere (è la persona che dichiara).
3. **Mai attivazione automatica senza fonte documentale**, mai sospensione
   automatica: il PM ha l'ultima parola.

Lettura del foglio (`src/agents/billingSheet.js`): Sheets API con il token
Google di un admin; il foglio si trova per id (`BILANCIO_SHEET_ID`) o per
titolo su Drive; le schede mensili si riconoscono dal nome (gennaio…
dicembre) o dall'ordine; l'intestazione "Cl | 1Tantum | Mensilità | fattura
inviata | Incassato" si legge per nome, con o senza colonna descrizione.
Se la descrizione nomina un'altra commessa dello stesso cliente ("Gambino
Sito 1/3"), la riga va solo a quella. Cache di sei ore, sola lettura.

Il report di `/giuno admin progetti evidenze` dice quante righe di
fatturazione, canali attivi ed email ha trovato. Da fare dopo il merge:
`/giuno admin progetti evidenze` in anteprima, poi `apply`; se il foglio non
viene trovato per titolo, impostare `BILANCIO_SHEET_ID` su Railway.

## 27. Le attività in giun.os: tendina sotto la commessa, microtask nelle schede

Antonio (12/9): "le sotto task andrebbero aperte a tendina nella view
generale ma non ha senso enumerarle tutte nel progetto".

1. **Dati.** L'adattatore legge anche `project_activities` (facoltativa:
   senza tabella nessun avviso, le attività nominate nei daily compaiono
   comunque per nome). Il modello ricava le ore per attività dalle microtask
   dei daily (`activity_id` nel JSON) con la stessa regola delle categorie:
   contano solo se il daily torna con il consuntivo della commessa; il resto
   è "senza attività". Il consuntivo per commessa non cambia mai.
2. **Tabella clienti e commesse.** Sotto ogni commessa un pulsante "N
   attività" apre le righe delle attività del periodo: nome, stato (aperta,
   chiusa, oltre la fine, fino al…), ore, persone e numero di microtask. Le
   microtask non si elencano qui. In fondo la riga "Senza attività" con le
   ore che nessuna attività ha preso.
3. **Scheda commessa.** Pannello "Attività": ogni attività si apre e mostra
   le microtask con persona, data, testo e ore (le stime marcate).
4. **Scheda persona.** Pannello "Attività e microtask": commessa →
   attività → microtask della persona, con le microtask senza attività a
   parte, così si vede cosa ha fatto ciascuno e a quale pezzo di lavoro
   serviva.

## 28. "Altro" non crea più commesse dal testo libero

Antonio (12/9, screenshot di giun.os): "ancora molti progetti sono
spezzettati. Tantissimi sono come questo": righe come "Vini Gambino -
riunione con cliente + fix premi + ricerca visiva shooting" o "Tutte le
pubblicazioni e le caption dei contenuti che ancora non le hanno" comparivano
come commesse.

Causa: la voce "Altro (non in lista)" del planner creava un progetto
manuale (`prj_`, tag `fonte:planner`) con qualunque testo la persona
scrivesse, e le persone ci scrivevano il task, non la commessa. Ogni riga
diventava un progetto attivo a sé, con le sue ore.

1. **Il testo libero si aggancia, mai crea** (`src/services/otherProjectResolver.js`):
   stesso nome di una commessa esistente; oppure il cliente o la commessa
   nominati nel testo, con le stesse regole del daily più le parole in
   altro ordine ("Vini Gambino" → "Gambino Vini"); oppure un'attività
   trasversale ("riunione di management"). Se non si aggancia la riga non
   passa: "scegli una voce in lista o scrivi il nome del cliente; le
   commesse nuove le creano gli admin". Con due commesse dello stesso
   cliente nominato non si sceglie.
2. **Pulizia di quelle già nate** (`projectDedupJob.plannerProposals`):
   `/giuno admin progetti dedup` propone per ogni riga nata dal planner
   l'unione nella commessa che nomina (le ore seguono), e `apply` le
   applica; le righe irriconoscibili restano elencate a parte per un
   `merge` a mano o una chiusura. Le righe del planner non entrano più nei
   gruppi per somiglianza: i loro nomi lunghi avrebbero fuso commesse
   diverse.

3. **Capire dal contesto** (Antonio: "non va bene, ma non possiamo farlo
   capire dal contesto?"). Quando il testo non nomina nessuno,
   `src/services/projectContext.js` guarda chi l'ha scritto: le sue commesse
   recenti (ore registrate e pianificate negli ultimi 21 giorni), il
   vocabolario delle attività aperte di quelle commesse ("caption" →
   PED di Gambino Vini → Gambino Vini · Social), e solo dopo il modello,
   che vede le commesse recenti della persona per prime e risponde con un
   nome esatto o NONE, mai a indovinare. Vale in tre punti: la voce "Altro"
   del planner (l'errore resta solo se nemmeno il modello sa, e suggerisce
   le ultime tre commesse della persona), i task del daily
   (`enrichTasksWithProjects` con `userId`: vocabolario prima del modello,
   recenti per prime nel prompt), e la dedup delle righe già nate dal
   planner (contesto di chi le ha scritte, `owner_slack_id`).
   Due limiti voluti (review Codex): nel planner si è prima dell'ack di
   Slack (tre secondi), quindi lì il modello non viene interpellato (solo
   commesse recenti e vocabolario); e un'unione letta dal modello non si
   applica da sola con `dedup apply` (anteprima e apply sarebbero due
   campionamenti diversi): il report la propone con il comando `merge`
   esplicito, l'admin decide.

Da fare dopo il merge: `/giuno admin progetti dedup` in anteprima, poi
`apply`; le poche righe che restano irriconoscibili si uniscono con
`/giuno admin progetti merge <riga> -> <commessa>` o si chiudono.

## 29. Stime del daily: perché mancano, e quattro rimedi

Antonio (12/9): "come possiamo migliorare le stime di Giuno? Ieri non ha
nemmeno fatto la stima". In #daily alle 18:00 dell'11/9: "per Paolo e
Gianna non ho trovato tracce di giornata: niente stima". La stima era
partita, ma le fonti erano vuote: Drive e inviti si leggono con il Google
di un admin, i canali contano solo dove c'è Giuno, `SLACK_USER_TOKEN` e
`FIGMA_TOKEN` mancano, e i due non avevano piano né "domani".

1. **Diagnosi per persona agli admin** (`dailyEstimator.explainMissing`,
   `dailyStandupV2.notifyMissingEstimates`). Alle 18:00, per chi resta
   senza stima, un DM agli admin con una riga a testa: "calendario: Google
   non collegato e nessun admin con Google", "canali: nessun messaggio suo
   nei canali dove c'è Giuno", "ricerca Slack: SLACK_USER_TOKEN mancante",
   "Figma: FIGMA_TOKEN non configurato", "nessun piano settimanale". Le
   frasi cambiano quando la causa è risolta ("Drive: nessun file suo oggi,
   letto con il Google di 1 admin"). In fondo, cosa sblocca ogni fonte.
2. **Bottoni rapidi quando non c'è stima** (`quickProjectButtons`, action
   `daily_quick_project`). Nel DM delle 16:00 senza proposta: "Oggi hai
   lavorato su una di queste?" con le commesse recenti della persona (max
   4, per ore delle ultime tre settimane). Un tap apre il modulo con la
   prima riga già intestata alla commessa: restano ore e dettaglio.
3. **Stime persistite** (`standup_data.stime`, migrazione in
   `supabase_migration.sql`). Le proposte delle 16:00 vivevano in memoria e
   un deploy tra le 16:00 e le 18:00 le cancellava (l'11/9 abbiamo
   pubblicato alle 16:10). Ora stanno nello stato del daily già
   persistito, con degradazione se la colonna manca; alle 18:00 si
   svuotano insieme al resto.
4. **Attività nel prompt della stima.** Le attività aperte sulle commesse
   recenti della persona, con il loro vocabolario, entrano nel prompt: il
   modello chiama il task con il nome dell'attività ("PED settembre 2026")
   quando le tracce combaciano, e la microtask si aggancia da sola.

Da fare dopo il merge: applicare la migrazione (`ALTER TABLE standup_data
ADD COLUMN IF NOT EXISTS stime JSONB NOT NULL DEFAULT '{}'`); collegare
Google da un admin; invitare Giuno nei canali dove lavorano Paolo e Gianna;
`SLACK_USER_TOKEN`, `FIGMA_TOKEN`, `FIGMA_TEAM_ID` su Railway.

## 30. Il daily scritto a mano, postato su richiesta

Antonio (17/9): "devi fare in modo che Giuno posti il mio daily se glielo
scrivo manualmente chiedendo di postarlo". Un DM come "Giuno, posta questo
daily: oggi ho fatto…" non arrivava da nessuna parte: le euristiche del
daily testuale (`classifyDailyText`) lo scartavano come richiesta al bot
(inizia con "giuno,"), il modello riceveva il messaggio ma non aveva un
tool per pubblicare un daily, e la strada del daily in DM vale comunque
solo tra le 16:00 e le 18:00 (`standupInAttesa`).

1. **Riconoscimento della richiesta** (`dailyStandupV2.extractDailyFromRequest`).
   Se la prima riga (fino ai due punti o a capo) o l'ultima riga del
   messaggio contiene "daily" e un verbo tra posta/pubblica/registra/
   manda/metti/inserisci/carica/invia, e il resto sembra un daily, il resto
   è il daily. "Manda il daily a Marco" resta una richiesta di test, "hai
   postato il mio daily?" resta una domanda.
2. **In DM, senza modello** (`slackHandlers.js`, prima del blocco
   `standupInAttesa`). Il corpo va in `handleDailyResponse`, la stessa
   strada del daily testuale: parser AI, aggancio commesse,
   `standup_entries`, consuntivo, post in #daily. Vale a qualsiasi ora.
   Risposta: "Fatto: daily di oggi registrato e pubblicato in #daily".
3. **In #daily con il tag** ("@Giuno posta il mio daily: …"): si registra
   con `recordChannelDaily` senza ripubblicare, come il daily taggato puro.
4. **Tool `post_daily`** (`standupTools.js`, pacchetto `team_admin`, che
   già si accende sulla parola "daily"). Copre le forme che le euristiche
   non prendono ("postalo" riferito al messaggio prima, il daily dentro
   una conversazione): il modello passa il testo così com'è, il tool lo
   registra a nome di chi scrive; solo un admin può intestarlo a un altro
   con `user_id`. Il prompt gli dice di chiedere il testo se manca, non di
   compilarlo lui.

Test: `test/daily-post-on-request.test.js`. Niente migrazioni.

## 31. Figma esce dal contesto quotidiano delle persone

Antonio (17/9): "leviamo anche Figma dal contesto quotidiano delle
persone?". Sì. La fonte non è mai stata attiva (`FIGMA_TOKEN` e
`FIGMA_TEAM_ID` mai impostati) e la sua unica traccia visibile era la riga
"Figma: FIGMA_TOKEN/FIGMA_TEAM_ID non configurati" nella diagnosi delle
18:00 agli admin, ogni giorno, per ogni persona senza stima.

Tolto dall'estimatore (`src/agents/dailyEstimator.js`): la raccolta delle
versioni dei file del team (`collectFigmaActivity`), i campi Figma del
contesto di giornata, la sezione "FILE FIGMA CON VERSIONI SALVATE OGGI"
nel prompt, gli eventi Figma nelle sessioni di lavoro, la voce nella
diagnosi e il suggerimento su `FIGMA_TOKEN` nel DM agli admin. Le sessioni
(`activitySessions.js`) non conoscono più il tipo `figma`. Le fonti del
daily stimato restano: piano di ieri e settimanale, calendario, Drive,
canali Slack, ricerca Slack, email.

Resta com'è il registro delle posizioni di progetto
(`projectLocations.js`, tabella `project_locations`): i tipi `figma_project`
e `figma_file` sono nel vincolo della tabella e nel comando admin
`/giuno admin progetti posizione`, e riguardano le commesse, non la
giornata delle persone. Senza token il rebuild li salta già. Niente
migrazioni. Se `FIGMA_TOKEN`/`FIGMA_TEAM_ID` sono su Railway si possono
togliere.

## 32. La stima alle 17:30 a tutti, Antonio compreso; si approva, si modifica o si rifà

Antonio (17/9): "mi inserisci pure a me nella richiesta di daily e mi
restituisci la stima che poi va approvata o modificata? Vorrei che
arrivasse la stima a un certo orario a tutti, poi si chiede se aggiungere
altro, modificare qualcosa, approvarla o compilare il bottone. Alle 17:30."

1. **Orari** (`DAILY_TIMES` in `dailyStandupV2.js`): invio 17:30, promemoria
   18:00, recap 18:30, lun-ven. Prima: 16:00 / 17:30 / 18:00. Il recap è
   scivolato di mezz'ora per lasciare tempo di rispondere alla stima: alle
   17:30 la giornata è chiusa e le tracce sono complete, ma trenta minuti
   soli tra proposta e pubblicazione erano pochi. Override senza deploy:
   `DAILY_SEND_AT`, `DAILY_PUSH_AT`, `DAILY_RECAP_AT` (HH:MM). I messaggi
   ("il recap esce alle …") leggono gli stessi valori.
2. **Antonio dentro.** `config/tracking.js` non esclude più "antonio": riceve
   la stima come tutti, e la sua giornata entra nel consuntivo. Restano
   fuori Gloria, Corrado e i numeri di servizio. Attenzione: se su Railway
   c'è `TRACKING_EXCLUDED_NAMES`, vince quella lista e va aggiornata a mano.
3. **Il messaggio delle 17:30** (`estimateProposalMessage`): la stima, poi
   "Va bene così? Approva con il bottone, modifica nel modulo già
   compilato, oppure scrivimi qui cosa aggiungere o cambiare", e tre
   bottoni: *✅ Approvo* (la stima diventa il daily), *✏️ Modifico nel
   modulo* (modulo precompilato), *📝 Compilo da zero* (modulo vuoto,
   action `open_daily_modal_blank`).
4. **Modifica a parole** (`classifyEstimateReply`, `amendPendingEstimate`,
   `dailyEstimator.amendEstimate`). Con una proposta in sospeso, un DM come
   "aggiungi 1h di call con Elios", "la grafica erano 3h", "togli la
   revisione", "non ho fatto la call" va al modello con la stima corrente
   in JSON e la sola istruzione; il modello applica quella modifica e
   Giuno rimanda la proposta aggiornata ("Ok Paolo, aggiornato così:") con
   gli stessi bottoni. "ok", "va bene così", "approvo" a parole valgono
   come il bottone. Questo controllo sta PRIMA del daily testuale: "aggiungi
   1h di call" somiglia a un daily e prima sarebbe stato salvato così, al
   posto di tutto il resto. Un daily strutturato ("Oggi: … Domani: …")
   sostituisce ancora la proposta per intero.

Test: `test/daily-estimate-1730.test.js`. Niente migrazioni.

Da fare dopo il merge: controllare `TRACKING_EXCLUDED_NAMES` su Railway
(se presente, togliere "antonio"); verificare che per Antonio
`standup_enabled` non sia a false nelle preferenze.

Primo giorno (17/9): la PR è andata su `main` alle 17:25 e il cron delle
17:30 è scattato sull'istanza vecchia (o è stato saltato dal riavvio):
Antonio non ha ricevuto nulla. Da qui `trigger_daily_request` manda prima
la STIMA con i tre bottoni, e solo senza tracce il modulo
(`sendDailyRequestWithEstimate`): "mandami la stima del daily" o "non mi è
arrivato il daily" la fanno arrivare subito, a chiunque.

Alle 18:02 il secondo tentativo è fallito su `users.list`: "la chiamata a
Slack va in timeout (due tentativi)". `users.list` è lenta e contingentata
(Tier 2, 20 chiamate al minuto) e il daily la chiama decine di volte tra
invio, stime e promemoria. Ora `slackService.listMembers` la tiene in cache
per 5 minuti, con Slack giù usa l'ultima lista buona e senza nemmeno quella
il roster in DB; `trigger_daily_request` non dipende più da quella lista
(`users.info`, o il solo id) e manda il DM in background, perché la
ricostruzione può superare i 55 secondi del turno.

## 33. Le stime non funzionavano dal 10/9: il thinking di Sonnet 5 mangiava il budget

Antonio (17/9, sera): "possiamo analizzare e capire il problema? Giuno ha
detto che non ha stime di Gianna e Claudia". Con i log di Railway (collegati
oggi) e Supabase il quadro è questo.

**Cosa dicevano i log.** Alle 17:30 il cron nuovo è partito regolarmente:
"Daily precompilati: 0 su 8". Alle 18:16 i tre trigger a mano: tutti
"modulo". In tutta la giornata nessuna riga `[DAILY-ESTIMATE]`: né
successo, né "nessuna traccia", né errore. Circa 20 secondi a persona:
il modello veniva chiamato e rispondeva, e il codice scartava la risposta
in silenzio. Stesso schema nel parser del daily scritto a mano di Antonio
(zero task, zero ore) e nel consolidamento memorie ("reading 'trim' of
undefined" per ogni utente). Le diagnosi delle 18:30 mostravano che
Claudia e Gianna avevano calendario, Drive, ricerca Slack ed email pieni:
"nessuna traccia" era falso.

**La causa.** Dal 10/9 il modello utility è `claude-sonnet-5`, che ragiona
(thinking adattivo) di default. Le 21 chiamate utility avevano budget da
60 a 1500 token: il modello li consumava ragionando e non arrivava mai al
testo. Contenuto senza blocco `text`, JSON non trovato, `return null` senza
log. I recap del 15 e 16/9 ("nessuna traccia" per 4 e 6 persone) erano lo
stesso bug.

**Cosa cambia.**
1. `src/services/utilityModel.js`: un solo punto per le chiamate utility.
   Thinking spento dove il modello lo accetta (`thinkingOffParams` in
   `config/models.js`: Sonnet 5, Opus 5, 4.6-4.8; effort basso su Fable),
   risposta vuota o troncata loggata con funzione, modello e stop_reason,
   costo tracciato. Tutte le 21 chiamate passano da qui (stima e modifica
   del daily, parser, memorie, riassunti, dossier, retrospettiva, note
   Gemini, aggancio commesse, briefing, welcome, App Home). Budget della
   stima 900 → 2000, del parser 1500 → 2500, timeout del parser 20 → 30 s.
2. **Costi per funzione.** `api_usage` ha la colonna `feature` (migrazione
   applicata): chat, daily_estimate, daily_parser, memory_consolidation,
   ecc. Le letture dalla cache costano un decimo, le scritture 1,25: prima
   la chat era contata tutta a prezzo pieno e le utility non erano contate.
   `get_api_costs` restituisce anche `by_feature` e `by_model`.
3. **Recap che ricostruisce.** Alle 18:30, per chi manca e non ha una
   stima in memoria, Giuno la costruisce lì per lì: quattro deploy oggi
   avevano svuotato la memoria. Colonna `standup_data.stime` applicata
   (era rimasta in sospeso dal 12/9).
4. **Lock del promemoria.** Alle 18:00 il push è stato saltato per un lock
   `daily_push` di origine ignota. Ora lo skip dice chi tiene il lock e
   fino a quando, e il TTL del push è 5 minuti.

Non spiegato: il lock `daily_push` delle 18:00. Con la diagnostica nuova
la prossima volta si vede.

Nota sul primo giorno: il DM delle 17:30 ad Antonio era arrivato (17:30:54,
un messaggio a blocchi) ma non l'aveva visto; alle 18:02 il trigger è
fallito su `users.list` (sezione 32).

## 34. Il "domani" della stima viene dal calendario del giorno dopo

Antonio (17/9, dopo la fix): "funziona ma mancano gli eventi del giorno
dopo". La stima leggeva solo il calendario di oggi e il prompt diceva di
riempire "domani" solo da piano settimanale o messaggi: quasi sempre vuoto.

Ora `collectEvidence` legge anche il calendario del prossimo giorno
lavorativo (`nextWorkingDay`: venerdì → lunedì): quello della persona se ha
Google collegato, altrimenti gli inviti negli admin. Le riunioni entrano
nel prompt come "CALENDARIO DI DOMANI (data)" con orario e durata, e la
regola del modello è: una riga in "domani" per ogni riunione, con la sua
durata, più piano settimanale e messaggi; niente inventato. Fonte
"calendario di domani" nella riga delle fonti.

## 35. "ok" a una risposta non è un'approvazione; "leva" è una correzione; niente più `content[0].text`

Alle 19:00 Antonio ha scritto "leva il meeting di fondazione per il sud che
è saltato": il verbo non era tra quelli riconosciuti, il messaggio è andato
al modello che ha risposto con un consiglio (sbagliato: "se non tocchi
nulla non viene salvata"). Antonio ha risposto "ok" al consiglio e Giuno
l'ha preso come approvazione della stima: il daily buono delle 17:31 è
stato sovrascritto dalla stima.

1. **Approvazione nuda** ("ok", "sì", "va bene", "perfetto") vale solo se
   l'ultimo messaggio di Giuno nel DM è la proposta con i bottoni
   (`lastBotMessageIsProposal`, una lettura di `conversations.history`).
   "Approvo" e "confermo" valgono sempre.
2. **Verbi di correzione**: aggiunti leva/levare, rimetti, "ci levi",
   "puoi levare".
3. **Il prompt conosce il flusso** (`config/dailyTimes.describeFlow`, dove
   ora vivono anche gli orari): cosa succede alle 17:30, 18:00, 18:30, e
   che approvare la stima sostituisce un daily già registrato.
4. **`content[0].text` non esiste più** (segnalazione dai log del deploy
   #159: il cron CONSOLIDATE falliva per tutti gli utenti perché con
   Opus 5 il primo blocco è `thinking`). I 22 punti che lo leggevano
   passano tutti da `utilityModel` (thinking spento, costo tracciato per
   funzione) e leggono il testo con `textOf`. Priorità ad aggancio commesse
   (`projectMatcher`, `projectContext`), dove l'errore era silenzioso.
   Test con un blocco thinking davanti: `test/thinking-block-responses.test.js`.
5. **Sync canali** (`channelProjectSyncJob`): un canale che Slack non lascia
   leggere (oggi C06FP326WPP) non blocca più il sync né l'archiviazione; la
   sua commessa resta com'è e il log lo elenca.

Da fare per Antonio: il daily di oggi va rimandato ("posta il daily: …" con
il testo delle 17:31, che è in #daily): il parser ora funziona e le ore
entrano nel consuntivo al posto della stima.

## 36. Le correzioni alla stima le capisce il modello dal contesto

Antonio (17/9, sera): "dovrebbe capire la chat: se dico 'togli quella cosa'
dovrebbe capirlo dal contesto". Giusto. Il percorso deterministico a verbi
(sezione 32) era nato per due timori (una correzione scambiata per un
daily, il turno da 55 secondi) ma non reggeva il linguaggio vero.

Ora, quando c'è una proposta in sospeso:
- il modello la vede nel contesto ("PROPOSTA DI DAILY IN ATTESA: …",
  `dailyStandupV2.pendingProposalSection`) con le istruzioni sui tool;
- il pacchetto `daily_estimate` viene caricato d'ufficio
  (`extraPacks` in `selectForTurn`): `daily_estimate_amend(instruction)`
  applica la modifica via `amendPendingEstimate` e rimanda la proposta con
  i bottoni; `daily_estimate_approve` la approva, e se oggi esiste già un
  daily vero si ferma e chiede conferma (`replace_existing`);
- in DM restano deterministiche solo le approvazioni ("approvo" sempre;
  "ok" solo se l'ultimo messaggio di Giuno era la proposta); e con una
  proposta in sospeso solo un daily STRUTTURATO ("Oggi: …") la sostituisce
  per intero: "aggiungi 1h di call" va al modello, non nel daily.

Tempi: turno del modello più la chiamata utility per la modifica, 15-30 s.

## 37. Tre correzioni dalla produzione del 17/9 sera (dopo #160 e #161)

1. **Archiviazione che rispetta gli admin** (`db/projects.archiveStaleSyncedProjects`).
   Alle 19:11 il sync canali ha archiviato Angela Intelisano, Museo Civico
   Niscemi e Terzo Settore Coop, tenute attive per decisione admin
   registrata su Supabase. Ora, prima di archiviare, la funzione legge i
   candidati e salta chi ha `lifecycle_evidence.kind='admin'` ancora valida
   (`valid_until` non passato, o assente) oppure il tag `fonte:admin`; le
   commesse protette finiscono nel log. Gli stati su Supabase li ha
   rimessi a posto Antonio a mano.
2. **Attività di un canale letta su un batch** (`slackService.channelActivity`).
   `chan_C076AGC0L94` non entrava tra gli attivi con messaggi di oggi: la
   lettura era di UN solo messaggio e scartava ogni subtype, quindi un
   thread_broadcast, un bot o un join in cima rendevano il canale
   "inattivo". Ora si leggono 20 messaggi e si ignorano solo
   channel/group join e leave.
3. **Consolidamento memorie che non cade** (`jobs/consolidateParse.js`).
   La risposta si troncava a 800 token, il JSON restava aperto, safeParse
   dava null e il job andava in errore "reading 'delete_ids' of null"
   (gruppo condiviso e Alessandra). Budget a 2500, prompt che chiede una
   risposta corta (max 5 memorie da 300 caratteri, solo JSON), parsing che
   restituisce sempre un oggetto e logga il motivo ("troncata a
   max_tokens", "nessun JSON") saltando il gruppo.

Test: `test/reliability-flows.test.js` (archiviazione, parsing) e
`test/daily-estimate-1730.test.js` (attività canale). Nessuna migrazione.

## 38. "Modifico nel modulo" vuoto dopo l'approvazione; terzo bottone a testo libero

Antonio (22/9): "quando uso il pre compilato di Giuno, il bottone Modifico
nel modulo non ha le info già compilate; manca un terzo bottone dove
scrivere tutto di fila e far sistemare a Giuno".

**Perché il modulo arrivava vuoto.** Il modulo si riempiva solo dalla
proposta *in sospeso* (`getPendingEstimate`). La proposta è consumata
appena la persona la approva (Antonio la approva sempre: le sue entry sono
`estimate_confirmed`) e al recap delle 18:30, quando viene pubblicata come
stima e `stime` si svuota. Da lì in poi "Modifico nel modulo" apriva il
modulo vuoto, proprio quando serve per correggere. Nella finestra
17:30-18:30 senza approvare funzionava (verificato con la stima vera del
22/9: 850 caratteri di `private_metadata`, sotto il limite di 3000).

**Cosa cambia.**
1. **Modulo sempre precompilato** (`prefillForModal` in
   `dailyStandupV2.js`, usato da `open_daily_modal`): prima la proposta in
   sospeso, altrimenti il daily di oggi già salvato in `standup_entries`
   (stima approvata, stima pubblicata al recap, daily compilato o scritto).
   Una lettura dal DB con tetto di 1,2 s: il `trigger_id` di Slack dura
   tre secondi. Il log dice da dove viene il prefill ("precompilato da
   estimate/entry").
2. **Il progetto nel testo del task**: `prefillFromEstimate` leggeva solo
   `project`, ma dopo il matcher (e nelle entry) il nome sta in
   `project_name`. Ora il suffisso `[Progetto]` arriva in entrambi i casi e
   non si duplica.
3. **Terzo bottone "🖊️ Scrivo a testo libero"** (`open_daily_modal_text`),
   nella proposta stimata e nel modulo semplice. Apre un modale con una sola
   area di testo (`dailyTextModal`, callback `daily_text_submit`): la
   persona scrive la giornata di fila, anche in un blocco solo. Al submit
   `saveFreeTextDaily` salva un daily VERO (source `modal_text`) passando
   da `handleDailyResponse`: parser AI (`dailyParser`) per task e ore,
   `projectMatcher` per i progetti, ore nel consuntivo. Giuno risponde in DM
   con com'è stato letto ("L'ho letto così: …") e il bottone "✏️ Modifico
   nel modulo", che grazie al punto 1 si apre già compilato con quel daily.
   Se il parser non ricava task, il testo si salva com'è e il DM lo dice.
4. Prompt e descrizioni dei tool (`dailyTimes.describeFlow`,
   `trigger_daily_request`) nominano i quattro bottoni.

Non cambia: "Compilo da zero" resta il modulo vuoto; la correzione a
parole in DM ("aggiungi 1h di call") resta com'era. Il daily scritto nel
modale sostituisce la stima o il daily precedente (upsert su
`slack_user_id,date`), come già faceva il modulo.

Test: `test/daily-prefill.test.js` (prefill da proposta e da entry,
progetto in `project_name`, modale a testo libero, salvataggio, bottoni
nel DM). Niente migrazioni.

Da fare dopo il merge: nessuna configurazione. Se la lettura del DB per il
prefill supera 1,2 s Giuno apre il modulo vuoto e lo logga come "prefill
non disponibile": guardare i log se capita.

## 39. Da fare
1. **Conversazioni legacy in DB**: le chiavi `userId:threadTs` restano come
   fallback in lettura; si possono cancellare dopo qualche settimana.
2. **Casi eval reali**: i sei seed coprono i comportamenti base; servono
   20-30 thread veri importati con `npm run eval:import` e annotati.
3. **Decidere il destino della tabella `leads`**: oggi è allineata "a mano"
   dal confronto; se Attio resta l'unico CRM, `leads` può diventare una cache
   di sola lettura sincronizzata da un job.
