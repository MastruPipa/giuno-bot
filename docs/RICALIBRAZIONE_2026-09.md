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

## 25. Da fare
1. **Conversazioni legacy in DB**: le chiavi `userId:threadTs` restano come
   fallback in lettura; si possono cancellare dopo qualche settimana.
2. **Casi eval reali**: i sei seed coprono i comportamenti base; servono
   20-30 thread veri importati con `npm run eval:import` e annotati.
3. **Decidere il destino della tabella `leads`**: oggi è allineata "a mano"
   dal confronto; se Attio resta l'unico CRM, `leads` può diventare una cache
   di sola lettura sincronizzata da un job.
