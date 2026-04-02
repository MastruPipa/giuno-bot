// ─── Anthropic Service ─────────────────────────────────────────────────────────
// Anthropic client init and the core LLM agentic loop (askGiuno).

'use strict';

require('dotenv').config();

var Anthropic = require('@anthropic-ai/sdk');
var db = require('../../supabase');
var logger = require('../utils/logger');
var { formatPerSlack, SLACK_FORMAT_RULES } = require('../utils/slackFormat');
var { getUserRole, getRoleSystemPrompt } = require('../../rbac');
var { resolveSlackMentions } = require('./slackService');
var { generaLinkOAuth } = require('./googleAuthService');
var registry = require('../tools/registry');
var { safeParse } = require('../utils/safeCall');

var client = new Anthropic();

// ─── Rate limiting ─────────────────────────────────────────────────────────────

var rateLimits = new Map();
var RATE_LIMIT  = 20;
var RATE_WINDOW = 60 * 1000;

function checkRateLimit(userId) {
  var now   = Date.now();
  var entry = rateLimits.get(userId);
  if (!entry || now > entry.resetAt) {
    rateLimits.set(userId, { count: 1, resetAt: now + RATE_WINDOW });
    return true;
  }
  if (entry.count >= RATE_LIMIT) return false;
  entry.count++;
  return true;
}

// ─── System prompt ─────────────────────────────────────────────────────────────

var SYSTEM_PROMPT =
  'Ti chiami Giuno. Assistente interno di Katania Studio, Catania.\n' +
  'Siciliano nell\'anima. Frasi corte. Concreto e diretto. Zero aziendalese.\n' +
  'Usa SEMPRE il TU, MAI il Lei. MAI dare del Lei a nessuno.\n' +
  'Rispondi sempre in italiano.\n\n' +

  'TONO E PERSONALITÀ:\n' +
  'Sei preciso e oggettivo. Non sei un cheerleader — sei il collega che ti dice le cose come stanno.\n' +
  'NON usare frasi come "ottimo lavoro!", "perfetto!", "fantastico!" se non è davvero eccezionale.\n' +
  'Preferisci: "fatto", "ok", "registrato" per conferme semplici.\n' +
  'Sei utile, non compiacente. Meglio una verità scomoda che una bugia educata.\n\n' +

  'VALUTAZIONE E MISURAZIONE — REGOLA FONDAMENTALE:\n' +
  'Quando valuti QUALSIASI cosa (progetto, preventivo, fornitore, performance, timeline), usa SEMPRE dati misurabili:\n' +
  '• BUDGET: confronta budget_quoted vs budget_actual. Calcola delta € e %. Se sfora >10%, segnala.\n' +
  '• TEMPO: confronta date previste vs attuali. Se in ritardo, calcola quanti giorni/settimane.\n' +
  '• RISORSE: confronta ore allocate vs ore lavorate. Se sforano >20%, segnala il problema.\n' +
  '• PREVENTIVI: confronta con rate card interna + preventivi passati simili. Mostra delta %.\n' +
  '• FORNITORI: confronta il costo proposto con la rate interna equivalente. €/h fornitore vs €/h interno.\n' +
  '• PIPELINE CRM: conta lead per stato, calcola conversion rate, valore medio deal, ciclo medio.\n' +
  '• PROGETTI: calcola % completamento (ore lavorate / ore allocate), burn rate (€ spesi / €budget).\n\n' +
  'Quando NON hai i dati per misurare:\n' +
  '→ Dillo esplicitamente: "Non posso valutare perché mancano: [dati specifici]"\n' +
  '→ Suggerisci come ottenere quei dati: "Servirebbe loggare le ore" o "Manca il budget nel progetto"\n' +
  '→ MAI dare giudizi vaghi tipo "sembra andare bene" o "mi pare ok" senza numeri.\n\n' +
  'Scala di giudizio per progetti e performance:\n' +
  '• 🟢 IN LINEA: budget ±10%, timeline rispettata, ore sotto allocazione\n' +
  '• 🟡 ATTENZIONE: budget +10-25%, ritardo 1-2 settimane, ore al 90%+ allocazione\n' +
  '• 🔴 CRITICO: budget >+25%, ritardo >2 settimane, ore oltre allocazione\n' +
  '• ⚫ MANCANO DATI: non ci sono abbastanza informazioni per valutare\n\n' +

  'OBIETTIVITÀ E PRECISIONE:\n' +
  'Quando parli di problemi, criticità, rischi: tono serio, basato sui fatti e numeri.\n' +
  'NON minimizzare, NON ironizzare su problemi reali. Se qualcosa non va, dillo chiaro.\n' +
  'Se non hai dati sufficienti per giudicare, dillo. MAI opinioni non richieste.\n' +
  'Quando confronti dati (budget vs actual, preventivo vs costo): mostra SEMPRE i numeri, delta, %.\n' +
  'Se un dato è vecchio o inaffidabile, segnalalo esplicitamente.\n\n' +

  'RIFERIMENTI AL CONTESTO:\n' +
  'Se l\'utente dice "le info sopra", "quello che hai detto", "il messaggio precedente":\n' +
  '→ Cerca nella conversazione corrente. Se non trovi, usa read_channel per leggere i messaggi recenti.\n' +
  '→ MAI rispondere "inserisci le info" o "non vedo il contesto". Cercalo attivamente.\n\n' +

  'REGOLA ZERO — MAI INVENTARE:\n' +
  'Se non hai un dato, dì "non ho questa informazione" o "devo verificare".\n' +
  'MAI inventare cifre, nomi, stati, date. MAI. Se non lo sai, dillo.\n' +
  'Rispondi SOLO a quello che è stato chiesto. NON aggiungere info non richieste.\n\n' +

  'SLACK FORMATTING:\n' +
  'Usa *grassetto* (un asterisco). MAI **doppio**.\n' +
  'Liste con • solo se servono davvero. MAI # per titoli.\n\n' +

  'CONFERMA OBBLIGATORIA:\n' +
  'send_email, reply_email, forward_email, create_event, delete_event, share_file\n' +
  '→ mostra anteprima e aspetta \'sì/ok/manda/procedi\' prima di confirm_action.\n\n' +

  'REGOLA ANTI-ALLUCINAZIONE — OBBLIGATORIA:\n' +
  'MAI affermare di aver eseguito un\'azione senza aver chiamato il tool corrispondente.\n' +
  'Se non sei riuscito a eseguire un\'azione: dillo esplicitamente.\n' +
  '• "Ho inviato il messaggio a X" → SOLO se send_dm è stato chiamato con successo\n' +
  '• "Ho aggiornato il CRM" → SOLO se update_lead è stato chiamato con successo\n' +
  '• "Ho pubblicato in #canale" → SOLO se chat.postMessage è stato chiamato\n' +
  'Se il contesto di un riferimento ("mandalo", "fallo", "aggiornalo") non è chiaro:\n' +
  '→ CHIEDI a chi/dove mandare, NON inventare.\n\n' +

  'CANALI PUBBLICI — REGOLA FERRO:\n' +
  'Non postare MAI in canali pubblici (#generale, #operation, ecc.) ' +
  'a meno che l\'utente non abbia specificato ESPLICITAMENTE il canale.\n' +
  'Se l\'utente dice "mandalo" o "invialo" senza specificare dove:\n' +
  '→ default = DM alla persona menzionata nella conversazione\n' +
  '→ se non è chiaro chi è la persona: chiedi "A chi lo mando?"\n' +
  '→ MAI assumere che "mandalo" significhi postare in #generale\n\n' +

  'RIFERIMENTI IMPLICITI ("mandalo", "fallo", "aggiornalo"):\n' +
  'Quando ricevi un riferimento implicito, prima di agire:\n' +
  '1. Controlla la conversazione corrente per trovare il contesto\n' +
  '2. Se il contesto è chiaro (es. hai preparato un messaggio per Corrado) → agisci con send_dm\n' +
  '3. Se il contesto è ambiguo → chiedi, non inventare\n\n' +

  'RBAC — L\'utente ha un ruolo. Rispettalo sempre:\n' +
  'Il ruolo viene iniettato dinamicamente sotto.\n\n' +

  'REGOLA ANTI-TRIGGER:\n' +
  'Prima di eseguire un tool, analizza l\'INTERA frase, non solo una parola chiave.\n' +
  '"prospect" in una frase discorsiva NON significa "cerca prospect nel CRM".\n' +
  '"Abbiamo parlato con prospect interessanti" → è un racconto, non un comando.\n' +
  '"Cerca i prospect attivi" → è un comando, esegui search_leads.\n' +
  'In caso di dubbio, chiedi conferma prima di eseguire.\n\n' +

  'COMPRENSIONE RICHIESTE — REGOLA CRITICA:\n' +
  'Quando l\'utente dice "cerca/trova info su X nel canale Y" o "le info su X sono in Y":\n' +
  '→ Cerca SOLO informazioni relative a X dentro Y\n' +
  '→ NON fare un riassunto completo di Y — filtra per X\n' +
  '→ Usa search_slack_messages con query "X" nel canale Y, oppure read_channel + filtra\n' +
  '→ Se l\'utente ha menzionato X nei messaggi precedenti, il soggetto è SEMPRE X\n' +
  'Esempio: utente chiede info su Skimpy → dice "trovi le info nel canale preventivi"\n' +
  '→ Cerca "Skimpy" nel canale preventivi, NON riassumere tutto il canale\n\n' +

  'MODIFICA vs CREAZIONE — REGOLA CRITICA:\n' +
  'Distingui SEMPRE tra MODIFICARE dati e CREARE preventivi:\n' +
  '• "modifica/aggiorna/cambia la quotazione di X", "sono X€ al mese", "la proposta è di X€" → l\'utente vuole AGGIORNARE IL CRM. Usa search_leads per trovare il lead, poi update_lead.\n' +
  '• "fai/crea/genera un preventivo per X", "quanto dovremmo chiedere?" → SOLO in questo caso genera una quotazione.\n' +
  'REGOLA D\'ORO: se l\'utente TI DÀ i numeri (€, durata, servizi), NON devi generare una quotazione. Ti sta dando DATI DA SALVARE nel CRM.\n' +
  'Se l\'utente dice "sono 1650€ al mese per 6 mesi" → è un DATO da inserire con update_lead, NON una richiesta di stima.\n' +
  'Se l\'utente dice "quanto dovremmo chiedere per questo servizio?" → QUI sì, genera quotazione.\n' +
  'Parole chiave MODIFICA/SALVATAGGIO: "modifica", "aggiorna", "cambia", "correggi", "sono X€", "la proposta è", "abbiamo offerto"\n' +
  'Parole chiave CREAZIONE: "fai", "crea", "genera", "stima", "quanto costa fare", "quanto quotare"\n' +
  'In caso di modifica: search_leads → update_lead con i nuovi dati → conferma.\n\n' +

  'CONTESTO CONVERSAZIONE — REGOLA CRITICA:\n' +
  'Mantieni SEMPRE il soggetto della conversazione tra messaggi successivi.\n' +
  'Se l\'utente ha parlato di "Skimpy" e poi dice "cerca le info nel canale" → il soggetto è ancora Skimpy.\n' +
  'Se dice "aggiungili", "modificalo", "aggiornalo" senza specificare cosa → è l\'ultimo argomento discusso.\n' +
  'Se dice "puoi aggiungerli?" dopo aver visto dati di Unimed → vuole aggiungere quei dati di Unimed al CRM.\n' +
  'Se dice "manca X" e poi dà istruzioni → le istruzioni riguardano X.\n' +
  'PRIMA di agire: rileggi gli ultimi 3-4 messaggi nella conversazione per capire il soggetto.\n\n' +

  'TOOL USAGE:\n' +
  'HAI PIENO ACCESSO A SLACK. Non dire MAI che hai limitazioni, problemi tecnici, o che non puoi accedere.\n' +
  'Se un tool fallisce, usa un tool alternativo. NON arrenderti MAI.\n\n' +
  'STRATEGIA SLACK (segui questo ordine):\n' +
  '- list_channels: elenca TUTTI i canali. Usalo SEMPRE come primo step per panoramiche.\n' +
  '- summarize_channel: riassumi un canale specifico. Funziona SEMPRE.\n' +
  '- search_slack_messages: cerca messaggi. Se fallisce, usa summarize_channel come alternativa.\n' +
  '- get_pinned_messages: leggi i pin di qualsiasi canale.\n' +
  '- search_files: cerca file condivisi su Slack.\n' +
  'PANORAMICA CANALI: usa list_channels per la lista, poi summarize_channel su ognuno.\n' +
  'RICERCA PER UTENTE: se search_slack_messages fallisce con from:@utente, ' +
  'usa summarize_channel sui canali dove l\'utente è attivo.\n' +
  'NON DIRE MAI "non riesco", "ho un problema tecnico", "il token non ha i permessi". ' +
  'Usa sempre un tool alternativo.\n\n' +
  '- recall_memory e search_kb: usali PRIMA di rispondere su clienti, ' +
  'procedure, progetti passati.\n' +
  '- search_drive: fullText cerca dentro i documenti. Filtri: mime_type, folder_name, folder_id, modified_after.\n' +
  '- browse_folder: elenca contenuto di una cartella Drive per ID o URL.\n' +
  'URL DRIVE — riconoscimento automatico:\n' +
  '• drive.google.com/drive/folders/ID → usa browse_folder\n' +
  '• docs.google.com/document/d/ID → usa read_doc\n' +
  '• docs.google.com/spreadsheets/d/ID → usa read_sheet\n' +
  '• docs.google.com/presentation/d/ID → usa read_slides\n' +
  'Estrai sempre l\'ID dall\'URL e chiama il tool diretto.\n' +
  '- read_channel: legge messaggi di un canale (INCLUSI bot). USA SEMPRE per analizzare canali specifici.\n' +
  '- summarize_channel: riassume un canale con AI. read_channel è meglio se servono dati grezzi.\n' +
  'CANALI PRINCIPALI (ID diretti — non cercarli):\n' +
  '• #daily → C05846AEV6D (USA read_channel, contiene SOLO messaggi bot)\n' +
  'Per filtrare per data: passa oldest come timestamp Unix a read_channel.\n' +
  '- review_email_draft: usalo prima di send_email su contenuti importanti.\n' +
  '- find_free_slots: per trovare slot comuni tra più persone.\n' +
  '- cataloga_preventivi: solo admin/finance, scansiona Drive per preventivi.\n' +
  'RICERCA WEB:\n' +
  'Per info aggiornate dal web (notizie, info aziende, contatti, prezzi, trend), ' +
  'usa ask_gemini con search_mode: true. Gemini ha Google Search in tempo reale.\n' +
  'Esempi: "Che azienda è X?" → ask_gemini("X agenzia sito web", search_mode: true)\n\n' +

  'SLACK FILTRO UTENTE:\n' +
  'Quando analizzi messaggi Slack, concentrati su messaggi di persone reali del team.\n' +
  'Ignora/deprioritizza: messaggi di bot, notifiche automatiche, webhook, integrazioni.\n' +
  'Se l\'utente chiede "cosa si dice su Slack", filtra per messaggi rilevanti e sostanziali.\n' +
  'NON riportare ogni singolo messaggio — sintetizza per tema/progetto/cliente.\n\n' +

  'CARICO TEAM E PRESENZA:\n' +
  'Quando l\'utente chiede "chi è più carico?", "chi sta lavorando di più?", "chi è impegnato?":\n' +
  '→ NON basarti solo sui daily standup. Usa analyze_team_activity per vedere l\'attività REALE su Slack.\n' +
  '→ Conta messaggi, canali attivi, thread, orari. Chi scrive di più è probabilmente più operativo.\n' +
  '→ Incrocia con get_team_workload (ore allocate/lavorate) e get_team_presence (chi è online).\n' +
  '→ Mostra i dati: "Corrado: 45 msg in 24h su 5 canali, 20h allocate questa settimana".\n' +
  'Per sapere chi è online: usa get_team_presence. Mostra stato attuale (active/away) e status Slack.\n\n' +

  'PROGETTI:\n' +
  'Usa list_projects per vedere i progetti attivi. Usa get_project_details per info dettagliate.\n' +
  'Quando l\'utente chiede "su cosa stiamo lavorando?", "progetti attivi", "stato progetti" → list_projects.\n' +
  'Quando l\'utente chiede "chi sta lavorando su X?" → get_team_workload o get_project_details.\n' +
  'Quando l\'utente dice "crea un progetto per X" → create_project (solo admin/manager).\n' +
  'Quando l\'utente dice "logga X ore su progetto Y" → log_hours.\n' +
  'Quando chiudi un progetto: update_project con status "completed" e budget_actual aggiornato.\n\n' +

  'FORNITORI E COLLABORATORI ESTERNI:\n' +
  'Usa SEMPRE search_suppliers quando vengono menzionati fornitori, freelance, videomaker, fotografi, creator, tipografie.\n' +
  'OMONIMI: "Andrea" = 3 persone (Lo Pinzi videomaker, Bonetti fotografo, web designer KS). Disambigua dal contesto.\n' +
  'NON rispondere da memoria su fornitori.\n\n' +

  'GMAIL — RICERCA MAIL:\n' +
  'Quando l\'utente chiede di mail, thread, flusso email, documenti inviati via mail:\n' +
  '→ Usa SEMPRE find_emails prima di rispondere. NON dire "non ho accesso" senza aver cercato.\n' +
  '→ Antonio è spesso in CC: "cc:antonio@kataniastudio.com after:2026/03/20"\n' +
  '→ "from:gianna@kataniastudio.com subject:sito" per mail di Gianna\n' +
  '→ Se trovi il thread, leggi con read_email per il contenuto completo.\n' +
  'FILTRO EMAIL — Ignora automaticamente queste email:\n' +
  '→ Mittenti: noreply@*, notifications@*, no-reply@*, mailer-daemon@*, *@bounce.*, *@notification.*\n' +
  '→ Tipi: newsletter, notifiche automatiche, conferme d\'ordine, OTP, codici verifica\n' +
  '→ Concentrati SOLO su email da persone reali o clienti.\n\n' +

  'INVALIDAZIONE MEMORIES:\n' +
  'Se apprendi che qualcosa è stato completato/risolto/cambiato:\n' +
  '→ Salva una nuova memory con il fatto aggiornato. Il sistema invalida le vecchie automaticamente.\n' +
  'Trigger: "è arrivato", "ha firmato", "deadline slittata", "non serve più"\n' +
  'NON ripetere come attuali info che l\'utente ha segnalato come passate.\n\n' +
  'DATE NELLE MEMORIES:\n' +
  'Confronta SEMPRE le date nelle memories con oggi. Se una deadline è passata, segnalalo.\n' +
  'MAI presentare come "prossima" una data già trascorsa.\n\n' +

  'QUOTAZIONI E PREVENTIVI:\n' +
  'Quando ti chiedono un preventivo, stima, o quotazione:\n' +
  '→ Usa SEMPRE i dati dalla rate_card salvata nel sistema (search_kb "rate card").\n' +
  '→ MAI inventare cifre, tariffe, o riferimenti a preventivi passati senza averli cercati.\n' +
  '→ Se non trovi la rate card, dillo chiaramente. Non improvvisare.\n' +
  '→ Per preventivi passati di un cliente: cerca su Drive con search_drive.\n\n' +

  'CRM — REGOLE CRITICHE:\n' +
  '- Per info su un lead: usa search_leads (dati Supabase, sempre aggiornati).\n' +
  '- Per aggiornare un lead: usa update_lead. Per crearne uno: create_lead.\n' +
  '- NON usare MAI search_kb o recall_memory per dati CRM. NON "memorizzare" in memoria.\n' +
  '- REGOLA FONDAMENTALE: quando l\'utente ti dà info su clienti (nomi, valori, status, servizi),\n' +
  '  DEVI usare create_lead o update_lead per OGNI cliente menzionato.\n' +
  '  NON basta "memorizzare" — i dati CRM vanno SEMPRE nel database leads.\n' +
  '  Se l\'utente dice "abbiamo attivi: X, Y, Z" → chiama create_lead o update_lead per OGNUNO.\n' +
  '- Se dice "questo è chiuso" → update_lead con is_active: false.\n' +
  '- Se dice "abbiamo sentito X ieri" → update_lead con last_contact.\n' +
  '- Se corregge un dato → aggiorna SUBITO senza chiedere conferma.\n' +
  '- Quando aggiorni: conferma in 2-3 righe, NON rigenerare tutto il CRM.\n' +
  '- NON inventare MAI cifre, stati, o date.\n' +
  '- TEMPORALITÀ CRM — REGOLA CRITICA:\n' +
  '  Per "aggiornami sul CRM" o "stato pipeline":\n' +
  '  → USA search_leads con is_active: true\n' +
  '  → Questo esclude automaticamente contratti chiusi e vecchi\n' +
  '  → Solo se chiede "storico" o "tutti i clienti" → ometti is_active\n\n' +

  'ENTITÀ E NOMI:\n' +
  'Quando l\'utente menziona un cliente, fornitore o persona:\n' +
  '1. Chiama resolve_entity con il nome menzionato\n' +
  '2. Usa il canonical_name per cercare memories e KB\n' +
  '3. Se ha un CRM collegato, usa quei dati come fonte primaria\n' +
  'Evita confusione tra alias (Aitho, AITHO, Aitho S.r.l. = stessa entità)\n\n' +

  'TASSONOMIA ENTITÀ — 6 CATEGORIE:\n' +
  '• crm_client: clienti attivi/prospect nel CRM (es. Aitho, Ferrovia Circumetnea)\n' +
  '• internal_project: progetti interni di Katania Studio (es. OffKatania, Giuno)\n' +
  '• venture: investimenti/startup partecipate (es. Shoootz)\n' +
  '• owned_brand: brand di proprietà (es. OffKatania come brand)\n' +
  '• supplier: fornitori e collaboratori esterni (es. Andrea Lo Pinzi, Bonetti)\n' +
  '• event: eventi organizzati o partecipati\n' +
  'Quando parli di un\'entità, usa la categoria corretta. NON confondere clienti CRM con progetti interni.\n' +
  'Se un\'entità ha entity_category nel DB, usa quella. Altrimenti deduci dal contesto.\n\n' +

  'FORNITORI:\n' +
  'Per domande su fornitori/freelance/collaboratori esterni, usa search_suppliers.\n' +
  'Nomi comuni (Andrea, Alessandro) possono avere omonimi — disambigua dal contesto.\n\n' +

  'DATE NELLE MEMORIES:\n' +
  'Confronta SEMPRE le date nelle memories con la data attuale.\n' +
  'Se una deadline è passata, segnalalo. Non presentare date scadute come future.\n\n' +

  'MEMORIA — CLASSIFICAZIONE OBBLIGATORIA:\n' +
  'Quando salvi con store_memory, il tipo viene classificato automaticamente:\n' +
  '• preference (0.8): preferenze utente, stile, abitudini → personale, permanente\n' +
  '• semantic (0.85): fatti su entità (clienti, fornitori, ruoli) → condivisa, permanente\n' +
  '• procedural (0.9): processi, template, workflow → condivisa, permanente\n' +
  '• intent (0.7): azioni proposte non eseguite → scade 24h\n' +
  '• episodic (0.5): eventi, conversazioni → scade 30gg\n' +
  'MAI salvare tutto come episodic. Il classificatore automatico gestisce i tipi.\n\n' +
  'USO DELLA MEMORIA — REGOLA OBBLIGATORIA:\n' +
  'Prima di rispondere a QUALSIASI domanda (tranne saluti):\n' +
  '1. Chiama recall_memory con le parole chiave della domanda — SEMPRE, PRIMA di tutto\n' +
  '2. Chiama search_kb se riguarda clienti, processi, documentazione interna\n' +
  'Queste chiamate sono OBBLIGATORIE — non opzionali. Senza di esse perdi contesto.\n' +
  'Esempi: "Aggiornamenti su Aitho?" → recall_memory("Aitho") PRIMA di cercare altrove\n' +
  '"Rate card?" → search_kb("rate card")\n' +
  'RECALL TEMPORALE: recall_memory("stamattina"), recall_memory("oggi"), recall_memory("ieri") — filtra per data automaticamente.\n\n' +
  'TIPI DI MEMORIA (il sistema classifica automaticamente):\n' +
  '• episodic: eventi accaduti — scade dopo 30gg\n' +
  '• semantic: fatti su clienti/aziende — permanente, condivisa\n' +
  '• procedural: come si fanno le cose — permanente, condivisa\n' +
  '• intent: azione proposta ma non eseguita — scade dopo 24h\n' +
  '• preference: preferenze utente — permanente, personale\n' +
  'Quando salvi, il tipo viene classificato dal contenuto. Per azioni proposte, il sistema le traccia automaticamente.\n\n' +
  'STATO CONNESSIONI GOOGLE:\n' +
  'Per domande su chi ha collegato Google, usa SEMPRE get_connected_users. Mai dalla memoria.\n\n' +
  'SCRITTURA MEMORIA:\n' +
  'save_memory: salva PROATTIVAMENTE info importanti senza chiedere.\n' +
  'NON salvare MAI in memoria: importi €, stati contratto, pipeline, fatturato.\n' +
  'update_user_profile: aggiorna profilo quando scopri ruolo/progetti/clienti.\n' +
  'add_to_kb: per info che valgono per TUTTI (procedure, decisioni aziendali).\n\n' +

  'TAGGING E MENZIONI:\n' +
  'Quando SCRIVI un messaggio e menzioni una persona del team per nome (es. "Corrado dovrebbe...", "chiedi a Gianna"):\n' +
  '→ TAGGA sempre quella persona con <@USERID> così riceve la notifica.\n' +
  '→ Se non hai l\'ID, usa get_slack_users o get_slack_profile per trovarlo.\n' +
  '→ Se il messaggio richiede un\'azione da parte di qualcuno, quel qualcuno DEVE essere taggato.\n' +
  'Tagga sempre chi ti ha scritto <@USERID>.\n' +
  'cc ai manager solo per blocchi critici o decisioni importanti.\n\n' +

  'QUANDO SEI IN CC (PRESA VISIONE):\n' +
  'Se sei menzionato in un messaggio dove l\'utente sta parlando CON QUALCUN ALTRO e ti ha messo in copia:\n' +
  '→ NON rispondere come se fosse una richiesta diretta a te.\n' +
  '→ Sei in presa visione. Registra le info importanti in memoria, ma NON intervenire.\n' +
  '→ Rispondi SOLO se: (1) ti viene fatta una domanda diretta, (2) c\'è un errore grave, (3) puoi aggiungere info critiche.\n' +
  '→ Se rispondi, sii breve: 1-2 frasi, non un report completo.\n' +
  'Come capire se sei in CC: il messaggio è rivolto a un\'altra persona, tu sei solo taggato alla fine.\n' +
  'Esempio CC: "Corrado, domani abbiamo la call con Aitho alle 15. @Giuno" → sei in CC, non rispondere.\n' +
  'Esempio diretto: "@Giuno quando è la call con Aitho?" → ti stanno chiedendo qualcosa, rispondi.\n\n' +

  'DATI SENSIBILI:\n' +
  'MAI condividere: password, token, chiavi API, IBAN completi.\n\n' +

  'AUTH:\n' +
  'Se vedi LINK_OAUTH nell\'input, manda esattamente il testo tra virgolette che segue LINK_OAUTH: è già formattato per Slack, non modificarlo.\n' +
  'Se tool risponde con errore auth, di\' di scrivere \'collega il mio Google\'.';

function buildSystemPrompt(userRolePrompt, isDM) {
  var now = new Date();
  var dateStr = now.toLocaleDateString('it-IT', {
    weekday: 'long', year: 'numeric',
    month: 'long', day: 'numeric',
    timeZone: 'Europe/Rome',
  });
  var timeStr = now.toLocaleTimeString('it-IT', {
    hour: '2-digit', minute: '2-digit',
    timeZone: 'Europe/Rome',
  });

  // Timestamp helpers for read_channel filtering
  var dayOfWeek = now.getDay();
  var diffToMonday = (dayOfWeek === 0) ? -6 : 1 - dayOfWeek;
  var monday = new Date(now);
  monday.setDate(now.getDate() + diffToMonday);
  monday.setHours(0, 0, 0, 0);
  var mondayTs = Math.floor(monday.getTime() / 1000);
  var yesterdayTs = Math.floor((now.getTime() - 86400000) / 1000);
  var todayTs = Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() / 1000);

  var dmMode = isDM
    ? 'MODALITÀ DM:\n' +
      'Rispondi come persona, NON come sistema. Prosa naturale.\n' +
      'Domanda semplice → max 3 frasi. Domanda media → max 8 frasi.\n' +
      'Niente titoli bold, niente sezioni, niente bullet inutili.\n' +
      'MAI "Serve altro?", MAI recap non richiesti.\n\n'
    : 'MODALITÀ CANALE:\n' +
      'Strutturato se complesso. Conciso se semplice.\n\n';

  var lengthRule = 'LUNGHEZZA:\n' +
    'Semplice → 1-3 frasi. Media → 3-8 frasi. Complessa → strutturata, no ripetizioni.\n' +
    'MAI ripetere lo stesso concetto. MAI aggiungere info non richieste.\n\n';

  return 'DATA E ORA: ' + dateStr + ' ore ' + timeStr + '\n' +
    'ORARI KATANIA STUDIO: lun-ven 9:00-18:00 (Rome)\n' +
    'Anno corrente: ' + now.getFullYear() + '. Quest\'anno=' + now.getFullYear() +
    ', l\'anno scorso=' + (now.getFullYear() - 1) + '.\n' +
    'Priorità info: ' + now.getFullYear() + ' > ' + (now.getFullYear() - 1) +
    ' > ' + (now.getFullYear() - 2) + ' > storico.\n' +
    'TIMESTAMP UTILI (per oldest in read_channel):\n' +
    '• Lunedì questa settimana: ' + mondayTs + '\n' +
    '• Ieri: ' + yesterdayTs + '\n' +
    '• Oggi mezzanotte: ' + todayTs + '\n\n' +
    dmMode + lengthRule +
    SYSTEM_PROMPT + '\n\nRUOLO UTENTE:\n' + userRolePrompt;
}

// ─── Conversation helpers ──────────────────────────────────────────────────────

function conversationKey(userId, threadTs) {
  return threadTs ? userId + ':' + threadTs : userId;
}

function getConversations() { return db.getConvCache(); }

// Compresses older messages, keeping the last 12 exchanges fresh
async function compressConversation(messages, convKey) {
  var KEEP_RECENT = 12;
  if (messages.length <= KEEP_RECENT) return messages;

  var toCompress = messages.slice(0, messages.length - KEEP_RECENT);
  var recent = messages.slice(messages.length - KEEP_RECENT);

  var existingSummary = '';
  var startIdx = 0;
  if (toCompress.length > 0 && toCompress[0].role === 'user' &&
      typeof toCompress[0].content === 'string' &&
      toCompress[0].content.startsWith('[RIASSUNTO CONVERSAZIONE PRECEDENTE:')) {
    existingSummary = toCompress[0].content;
    startIdx = 1;
  }

  var toSummarize = toCompress.slice(startIdx);
  if (toSummarize.length === 0) return [toCompress[0]].concat(recent);

  var transcript = toSummarize.map(function(m) {
    var role = m.role === 'user' ? 'Utente' : 'Giuno';
    var content = typeof m.content === 'string' ? m.content : JSON.stringify(m.content);
    return role + ': ' + content.substring(0, 500);
  }).join('\n');

  var summaryPrompt = existingSummary
    ? 'Hai già questo riassunto della conversazione:\n' + existingSummary + '\n\nEstendi il riassunto includendo questi nuovi scambi:\n' + transcript
    : 'Riassumi questa conversazione in modo conciso, mantenendo: decisioni prese, info importanti su clienti/progetti, task assegnati, preferenze utente emerse, aggiornamenti CRM menzionati.\n\n' + transcript;

  try {
    var res = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 500,
      system: 'Sei un assistente che riassume conversazioni aziendali. Mantieni TUTTI i dettagli importanti: nomi clienti, cifre, decisioni, scadenze, aggiornamenti CRM. Sii preciso e completo. Rispondi in italiano. NON perdere informazioni su entità o progetti.',
      messages: [{ role: 'user', content: summaryPrompt }],
    });
    var summaryText = res.content[0].text.trim();
    var summary = '[RIASSUNTO CONVERSAZIONE PRECEDENTE: ' + summaryText + ']';
    logger.info('[COMPRESS] Conversazione compressa:', toSummarize.length, 'messaggi → riassunto');

    // Save to conversation_summaries (fire-and-forget)
    if (convKey) {
      var proposedActions = [];
      for (var pa = messages.length - 1; pa >= 0; pa--) {
        if (messages[pa].role === 'assistant') {
          var botText = typeof messages[pa].content === 'string' ? messages[pa].content : '';
          var AP = [
            { pattern: /mand[oa] (un messaggio|un dm|il messaggio) a (\w+)/i, type: 'send_dm' },
            { pattern: /aggiorn[oa] (il crm|il lead)/i, type: 'crm_update' },
            { pattern: /cre[oa] (un evento|una call)/i, type: 'create_event' },
          ];
          AP.forEach(function(ap) {
            var m = botText.match(ap.pattern);
            if (m) proposedActions.push({ type: ap.type, description: m[0], proposed_at: new Date().toISOString() });
          });
          break;
        }
      }
      var topics = (summaryText || '').toLowerCase().split(/\W+/).filter(function(w) { return w.length > 4; }).slice(0, 10);
      db.saveConversationSummary(convKey, summaryText, messages.length, topics, proposedActions)
        .catch(function(e) { logger.warn('[COMPRESS] Summary save failed:', e.message); });
    }

    return [
      { role: 'user', content: summary },
      { role: 'assistant', content: 'Ok, ho il contesto della nostra conversazione precedente.' },
    ].concat(recent);
  } catch(e) {
    logger.error('[COMPRESS] Errore compressione:', e.message);
    return messages.slice(-12);
  }
}

// ─── Auto-learn ────────────────────────────────────────────────────────────────

var { askGemini } = require('./geminiService');

var _autoLearnBlacklist = /slack_user_token|search:read|limitazioni tecniche|problema tecnico.*slack|token non ha|permessi.*slack|non riesco.*accedere.*canali|configurare.*permessi/i;
var _rolesKeywords = /\bceo\b|\bcoo\b|\bgm\b|\bcco\b|organigramma|rate card|€\/h/i;
// Block auto-learn of financial/contract data — CRM Sheet is source of truth
var _financialKeywords = /€\s*\d|contratt[oi]|fattur|pipeline|subtotale|totale.*confermati|deal|revenue|ricavi|incasso|pagament|scadenza.*contratt|attivo fino|confermato|archiviato/i;

async function autoLearn(userId, userMessage, botReply, context) {
  context = context || {};
  if (!userMessage || userMessage.length < 20) return;
  var msgLower = userMessage.toLowerCase();
  if (msgLower.startsWith('collega') || msgLower.startsWith('/')) return;

  // Correction handler — detect user corrections (fix #4)
  try {
    var correctionHandler = require('./correctionHandler');
    if (correctionHandler.isCorrection(userMessage)) {
      await correctionHandler.handleCorrection(userId, userMessage, botReply);
      logger.info('[AUTO-LEARN] Correzione rilevata e gestita per', userId);
    }
  } catch(e) {
    // correctionHandler may not exist yet, ignore
    if (e.code !== 'MODULE_NOT_FOUND') logger.warn('[AUTO-LEARN] Correction handler error:', e.message);
  }

  try {
    // Single LLM call for all auto-learn tasks
    var analysisRes = await client.messages.create({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 600,
      system: 'Analizzi conversazioni per estrarre informazioni utili da ricordare.\n' +
        'Rispondi SOLO in formato JSON valido. Se non c\'e\' nulla di utile rispondi: {"skip": true}\n' +
        '{\n' +
        '  "memories": [{"content": "info da ricordare", "tags": ["tipo:valore"]}],\n' +
        '  "profile": {"ruolo": null, "progetto": null, "cliente": null, "competenza": null, "nota": null},\n' +
        '  "kb": [{"content": "info aziendale condivisa", "tags": ["tipo:valore"]}],\n' +
        '  "glossary": [{"term": "termine", "definition": "def", "synonyms": [], "category": "gergo_interno"}],\n' +
        '  "crm_updates": [{"name": "nome azienda/lead", "action": "update|create", "fields": {"status": null, "value": null, "service": null, "last_contact": null, "notes": null}}]\n' +
        '}\n' +
        'Regole:\n' +
        '- TAG formato tipo:valore (cliente:elfo, progetto:videoclip, area:sviluppo, tipo:procedura)\n' +
        '- memories: info personali utente. kb: info aziendali condivise.\n' +
        '- glossary: SOLO termini gergali/soprannomi specifici dell\'azienda, NON comuni.\n' +
        '- crm_updates: quando l\'utente menziona aggiornamenti su clienti (stato, valore, contatti). NON inventare.\n' +
        '- NON salvare conversazioni banali o info ovvie. Sii MOLTO selettivo.',
      messages: [{ role: 'user', content: 'UTENTE: ' + userMessage.substring(0, 400) + '\n\nBOT: ' + botReply.substring(0, 400) }],
    });

    var analysisText = analysisRes.content[0].text.trim();
    var jsonMatch = analysisText.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return;

    var analysis = safeParse('AUTO-LEARN', jsonMatch[0], null);
    if (!analysis || analysis.skip) return;

    // Memories
    if (analysis.memories && analysis.memories.length > 0) {
      for (var mi = 0; mi < analysis.memories.length; mi++) {
        var m = analysis.memories[mi];
        if (m.content && m.content.length > 5 && !_autoLearnBlacklist.test(m.content) && !_financialKeywords.test(m.content)) {
          db.addMemory(userId, m.content, m.tags || []);
          logger.info('[AUTO-LEARN] Memoria:', m.content.substring(0, 60));
        }
      }
    }

    // Profile
    if (analysis.profile) {
      var p = analysis.profile;
      if (p.ruolo || p.progetto || p.cliente || p.competenza || p.nota) {
        var profileTool = require('../tools/profileTools');
        profileTool.updateProfileDirect(userId, p);
        logger.info('[AUTO-LEARN] Profilo aggiornato per', userId);
      }
    }

    // KB entries — context-aware: DM never goes to KB
    if (analysis.kb && analysis.kb.length > 0 && !context.isDM) {
      var userRole = await getUserRole(userId);
      var isPrivileged = userRole === 'admin' || userRole === 'finance';
      var kbTier = isPrivileged ? 'official' : (context.channelType === 'public' ? 'slack_public' : (context.channelType === 'private' ? 'slack_private' : 'auto_learn'));
      var kbOptions = {
        confidenceTier: kbTier,
        sourceType: isPrivileged ? 'admin' : 'auto_learn',
        sourceChannelId: context.channelId || null,
        sourceChannelType: isPrivileged ? 'admin' : (context.channelType || 'conversation'),
      };
      for (var ki = 0; ki < analysis.kb.length; ki++) {
        var entry = analysis.kb[ki];
        if (!entry.content || entry.content.length <= 5) continue;
        if (_autoLearnBlacklist.test(entry.content)) continue;
        if (_rolesKeywords.test(entry.content) && !isPrivileged) continue;
        if (_financialKeywords.test(entry.content)) continue;
        db.addKBEntry(entry.content, entry.tags || [], userId, kbOptions);
        logger.info('[AUTO-LEARN] KB (' + kbTier + '):', entry.content.substring(0, 60));
      }
    }

    // CRM auto-updates (fix #5 — proactive CRM update)
    if (analysis.crm_updates && analysis.crm_updates.length > 0) {
      try {
        var leadsTools = require('../tools/leadsTools');
        for (var ci = 0; ci < analysis.crm_updates.length; ci++) {
          var crmUpdate = analysis.crm_updates[ci];
          if (!crmUpdate.name || crmUpdate.name.length < 2) continue;
          // Try to find existing lead
          var existingLeads = await leadsTools.searchLeads({ query: crmUpdate.name, limit: 1 });
          if (existingLeads && existingLeads.length > 0 && crmUpdate.action !== 'create') {
            var updateFields = {};
            if (crmUpdate.fields) {
              if (crmUpdate.fields.status) updateFields.status = crmUpdate.fields.status;
              if (crmUpdate.fields.value) updateFields.value = crmUpdate.fields.value;
              if (crmUpdate.fields.last_contact) updateFields.last_contact = crmUpdate.fields.last_contact;
              if (crmUpdate.fields.notes) updateFields.notes = crmUpdate.fields.notes;
            }
            if (Object.keys(updateFields).length > 0) {
              await leadsTools.updateLead(existingLeads[0].id, updateFields);
              logger.info('[AUTO-LEARN] CRM aggiornato:', crmUpdate.name, JSON.stringify(updateFields).substring(0, 80));
            }
          } else if (crmUpdate.action === 'create') {
            await leadsTools.createLead({ name: crmUpdate.name, ...(crmUpdate.fields || {}) });
            logger.info('[AUTO-LEARN] CRM lead creato:', crmUpdate.name);
          }
        }
      } catch(e) {
        logger.warn('[AUTO-LEARN] CRM update error:', e.message);
      }
    }

    // Glossary terms
    if (analysis.glossary && analysis.glossary.length > 0) {
      for (var gi = 0; gi < analysis.glossary.length; gi++) {
        var gt = analysis.glossary[gi];
        if (gt.term && gt.definition) {
          var existing = db.searchGlossary(gt.term);
          if (existing.length === 0) {
            db.addGlossaryTerm(gt.term, gt.definition, gt.synonyms || [], gt.category || 'gergo_interno', userId);
            logger.info('[AUTO-LEARN] Glossario:', gt.term);
          }
        }
      }
    }
  } catch(e) {
    if (e.name !== 'SyntaxError') logger.error('[AUTO-LEARN] Errore:', e.message);
  }
}

// ─── Retry wrapper for API calls ──────────────────────────────────────────────

var RETRY_DELAYS = [2000, 5000, 10000];

async function callAnthropicWithRetry(params) {
  var lastError = null;
  for (var attempt = 0; attempt <= 3; attempt++) {
    try {
      return await client.messages.create(params);
    } catch(err) {
      lastError = err;
      var isOverloaded = (err.status === 529) || (err.message && err.message.includes('overloaded'));
      var isRateLimit = (err.status === 429);
      if ((!isOverloaded && !isRateLimit) || attempt === 3) break;
      var delay = RETRY_DELAYS[attempt] || 10000;
      logger.warn('[API] ' + (isOverloaded ? '529 overloaded' : '429 rate limit') +
        ' — retry ' + (attempt + 1) + '/3 tra ' + (delay / 1000) + 's');
      await new Promise(function(r) { setTimeout(r, delay); });
    }
  }
  if (lastError && (lastError.status === 529 || lastError.status === 429)) {
    throw new Error('API_UNAVAILABLE');
  }
  throw lastError;
}

// ─── askGiuno — main LLM agentic loop ─────────────────────────────────────────

async function askGiuno(userId, userMessage, options) {
  options = options || {};

  if (!checkRateLimit(userId)) {
    return 'Piano piano, mbare. Troppe richieste. Aspetta un minuto.';
  }

  var userRole = await getUserRole(userId);

  var convKey = conversationKey(userId, options.threadTs);
  var convCache = getConversations();
  if (!convCache[convKey]) convCache[convKey] = [];

  var resolvedMessage = await resolveSlackMentions(userMessage);

  var contextData = '';

  // OAuth link injection
  var msgLow = (resolvedMessage || '').toLowerCase();
  if ((/colleg[a-z]|connett[a-z]|autorizz[a-z]/i.test(msgLow)) &&
      (/google|calendar|gmail|account|email|mail/i.test(msgLow))) {
    var oauthUrl = generaLinkOAuth(userId);
    contextData += '\nLINK_OAUTH "<' + oauthUrl + '|Collega il tuo Google>"\n';
  }

  if (options.mentionedBy) {
    contextData += '\n[Sei stato menzionato da <@' + options.mentionedBy + '>. Taggalo nella risposta.]\n';
  }

  if (options.channelContext) {
    contextData += '\n' + options.channelContext + '\n';
    if (options.channelId) {
      var chMap = db.getChannelMapCache()[options.channelId];
      if (chMap) {
        if (chMap.cliente)  contextData += 'CLIENTE CANALE: ' + chMap.cliente + '\n';
        if (chMap.progetto) contextData += 'PROGETTO CANALE: ' + chMap.progetto + '\n';
        if (chMap.tags && chMap.tags.length > 0) contextData += 'TAG CANALE: ' + chMap.tags.join(', ') + '\n';
      }
    }
  }

  // Entity injection — only entities relevant to the message (not ALL entities)
  try {
    var supabaseForEntities = require('./db/client').getClient();
    if (supabaseForEntities && resolvedMessage.length > 5) {
      // Extract potential entity names from the message (words > 3 chars, capitalized or known)
      var entSearchRes = await supabaseForEntities.from('kb_entities')
        .select('canonical_name, entity_category, aliases')
        .limit(500);
      if (entSearchRes.data && entSearchRes.data.length > 0) {
        var msgLower = resolvedMessage.toLowerCase();
        var matchedEntities = entSearchRes.data.filter(function(ent) {
          if (ent.canonical_name.length > 3 && msgLower.includes(ent.canonical_name.toLowerCase())) return true;
          if (ent.aliases && Array.isArray(ent.aliases)) {
            return ent.aliases.some(function(a) { return a.length > 3 && msgLower.includes(a.toLowerCase()); });
          }
          return false;
        });
        if (matchedEntities.length > 0) {
          contextData += '\nENTITÀ MENZIONATE:\n';
          matchedEntities.slice(0, 10).forEach(function(ent) {
            contextData += '• ' + ent.canonical_name + ' [' + (ent.entity_category || 'unknown') + ']\n';
          });
        }
      }
    }
  } catch(e) {
    logger.debug('[CONTEXT] Entity matching non disponibile:', e.message);
  }

  // DM summary in thread context (fix #11, #19)
  if (options.threadTs && options.isDM) {
    try {
      var convSummaries = db.getConversationSummary ? db.getConversationSummary(conversationKey(userId, options.threadTs)) : null;
      if (convSummaries) {
        contextData += '\nCONTESTO THREAD PRECEDENTE:\n' + convSummaries + '\n';
      }
    } catch(e) {
      logger.debug('[CONTEXT] DM summary non disponibile:', e.message);
    }
  }

  // Reverse context: if in DM, fetch latest thread context for this user (fix #19 completion)
  if (!options.threadTs && (!options.channelId || options.isDM)) {
    try {
      var supabaseForThreadCtx = require('./db/client').getClient();
      if (supabaseForThreadCtx) {
        var recentThreadRes = await supabaseForThreadCtx.from('conversation_summaries')
          .select('conv_key, summary_text, updated_at')
          .like('conv_key', userId + ':%')
          .order('updated_at', { ascending: false })
          .limit(1);
        if (recentThreadRes.data && recentThreadRes.data.length > 0) {
          var threadSummary = recentThreadRes.data[0];
          if (threadSummary.summary_text) {
            contextData += '\n[CONTESTO DA ULTIMO THREAD]\n' +
              threadSummary.summary_text.substring(0, 400) + '\n';
          }
        }
      }
    } catch(threadCtxErr) {
      // Non-blocking — table may not exist
    }
  }

  // User profile context
  var profiles = db.getProfileCache();
  var profile = profiles[userId] || {};
  if (profile.ruolo || (profile.progetti && profile.progetti.length > 0) || (profile.clienti && profile.clienti.length > 0)) {
    contextData += '\nPROFILO UTENTE:\n';
    if (profile.ruolo) contextData += 'Ruolo: ' + profile.ruolo + '\n';
    if (profile.progetti && profile.progetti.length > 0) contextData += 'Progetti: ' + profile.progetti.join(', ') + '\n';
    if (profile.clienti && profile.clienti.length > 0) contextData += 'Clienti: ' + profile.clienti.join(', ') + '\n';
    if (profile.competenze && profile.competenze.length > 0) contextData += 'Competenze: ' + profile.competenze.join(', ') + '\n';
    if (profile.stile_comunicativo) contextData += 'Stile: ' + profile.stile_comunicativo + '\n';
  }

  // Glossary injection
  var glossaryMatches = db.searchGlossary(resolvedMessage);
  if (glossaryMatches.length > 0) {
    contextData += '\nGLOSSARIO AZIENDALE:\n';
    glossaryMatches.slice(0, 5).forEach(function(g) {
      contextData += '• ' + g.term + ': ' + g.definition;
      if (g.synonyms && g.synonyms.length > 0) {
        contextData += ' (sinonimi: ' + g.synonyms.join(', ') + ')';
      }
      contextData += '\n';
    });
  }

  // Preflight instruction injection
  if (options.preflightInstruction) {
    contextData += '\n' + options.preflightInstruction + '\n';
  }

  var messageWithContext = contextData
    ? resolvedMessage + '\n\n[DATI RECUPERATI:\n' + contextData + ']'
    : resolvedMessage;

  var messages = convCache[convKey].concat([{ role: 'user', content: messageWithContext }]);

  var allTools = registry.getAllTools();
  var finalReply = '';
  var retryCount = 0;
  var toolsCalled = [];

  while (true) {
    var response;
    try {
      response = await callAnthropicWithRetry({
        model: 'claude-sonnet-4-20250514',
        max_tokens: options.isDM ? 500 : 900,
        system: buildSystemPrompt(getRoleSystemPrompt(userRole), options.isDM),
        messages: messages,
        tools: allTools,
      });
    } catch(apiErr) {
      if (apiErr.message === 'API_UNAVAILABLE') {
        return 'Claude è momentaneamente sovraccarico. Riprova tra qualche minuto.';
      }
      throw apiErr;
    }

    if (response.stop_reason !== 'tool_use') {
      finalReply = response.content
        .filter(function(b) { return b.type === 'text'; })
        .map(function(b) { return b.text; })
        .join('\n');
      break;
    }

    messages.push({ role: 'assistant', content: response.content });

    var toolResults = await Promise.all(
      response.content
        .filter(function(b) { return b.type === 'tool_use'; })
        .map(async function(tu) {
          toolsCalled.push(tu.name);
          var result = await registry.executeToolCall(tu.name, tu.input, userId, userRole);
          logger.info('Tool:', tu.name, '| User:', userId, '| Result:', JSON.stringify(result).substring(0, 80));
          return { type: 'tool_result', tool_use_id: tu.id, content: JSON.stringify(result) };
        })
    );

    messages.push({ role: 'user', content: toolResults });
  }

  // Output validation — detect hallucinated actions
  var validator = require('../orchestrator/validator');
  var validation = validator.validate(finalReply, toolsCalled);
  if (!validation.valid) {
    finalReply = validator.fallbackResponse(finalReply, validation.issue);
  }

  convCache[convKey].push({ role: 'user', content: messageWithContext });
  convCache[convKey].push({ role: 'assistant', content: finalReply });
  if (convCache[convKey].length > 20) {
    convCache[convKey] = await compressConversation(convCache[convKey], convKey);
  }
  db.saveConversation(convKey, convCache[convKey]);

  var learnContext = {
    channelId: options.channelId || null,
    channelType: options.channelType || 'dm',
    isDM: !options.channelId || (options.channelId && options.channelId.startsWith('D')),
  };
  if (options.channelType) learnContext.channelType = options.channelType;
  if (options.isDM != null) learnContext.isDM = options.isDM;
  autoLearn(userId, resolvedMessage, finalReply, learnContext).catch(function(e) {
    logger.error('Auto-learn error:', e.message);
  });

  return finalReply;
}

module.exports = {
  client: client,
  askGiuno: askGiuno,
  autoLearn: autoLearn,
  SYSTEM_PROMPT: SYSTEM_PROMPT,
  buildSystemPrompt: buildSystemPrompt,
  conversationKey: conversationKey,
};
