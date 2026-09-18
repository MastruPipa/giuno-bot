# giun.os — prima implementazione

Applicazione consultiva integrata nel server di Giuno a `/giunos`. Riusa Node, Supabase e l'accesso amministrativo esistenti. Non avvia nuove raccolte, non invia messaggi e non richiede compilazioni operative.

## Avvio

`npm ci` e `npm run dev:giunos` avviano solo la dashboard su `http://127.0.0.1:8766/giunos`. Il bot Slack e i job non partono. Senza configurazione database appare uno stato esplicito di connessione assente, senza dati inventati.

Nel servizio Giuno esistente, dopo il rilascio il percorso è `/giunos`. Usa `SUPABASE_URL` e `SUPABASE_KEY` già gestite dal backend. L'API richiede `OAUTH_ADMIN_TOKEN` in produzione. La chiave viene immessa nella schermata di accesso e mantenuta solo in memoria, mai nell'URL o nello storage del browser. Primo rilascio riservato alla direzione: non è un sistema di autorizzazioni individuali per il team o i clienti.

## Implementato

- Panoramica, elenco progetti, scheda progetto, elenco e scheda persona.
- Settimane lunedì–domenica, mesi e trimestri di calendario, navigazione storica e data odierna Europe/Rome.
- Ore registrate e stimate separate, esclusione dei weekly plan, deduplicazione delle correzioni del daily.
- Andamento giornaliero/settimanale con filtri per progetto.
- Classificazione indicativa dei testi dei daily; dettaglio usato solo se si riconcilia con il time log canonico. Nessuna ora aggiunta dal daily a quelle già aggregate.
- Azioni chiuse con `done_at`, campione e giorni mediani di calendario, per tipologia indicativa. Non sono tutte le task creative e non sono ore effettive di lavoro.
- Dossier, consegne ricostruite, scadenze e documenti collegati. `consegnato` non viene interpretato come approvato.
- Budget documentati per calendario, persona e intero progetto, mai ricavati dal budget economico o dalla pianificazione settimanale.
- Sorgenti mancanti, errori di connessione, campioni assenti, protezione dell'API e contenuti esterni escapati.

## Budget

`docs/giunos-budgets.sql` è una migrazione opzionale preparata, non eseguita. La tabella contiene ore, fonte, revisione e perimetro accettato. `scope=period` consente il confronto solo su date esattamente uguali al periodo selezionato; `scope=project` confronta tutte le ore nel perimetro contrattuale. Non si ripartiscono automaticamente le ore vendute in parti uguali fra settimane o persone.

L'importazione automatica dalle versioni accettate dei contratti/economics deve ancora essere sviluppata e verificata su esempi reali. Fino a quel momento il budget resta non verificato. Non è previsto un modulo di inserimento manuale per gli operativi.

## Stato e limiti

Verificato sul codice Giuno `43aa9d6`, con test locali. Schema del database di produzione verificato in sola lettura tramite connettore Supabase il 10 settembre 2026; configurazione Railway verificata. Nessuna connessione applicativa locale configurata, nessuna migrazione applicata, nessun deploy effettuato. Il servizio Railway non espone attualmente OAUTH_ADMIN_TOKEN fra le variabili del servizio: occorre configurare l’accesso prima del rilascio.

Il roster e i dossier vengono letti dagli schemi già utilizzati dal bot. Le tabelle opzionali assenti producono un avviso; errori su progetti, persone o consuntivi producono 503, mai totali pari a zero. Le letture sono paginate e limitate a 100.000 righe per tabella, oltre le quali si interrompono senza restituire totali parziali. Per volumi maggiori andrà spostata l'aggregazione in una vista SQL. Gli aggiornamenti avvengono all'apertura, cambio periodo o clic su Aggiorna.

La copertura delle ore non è garantita: assenza di registrazioni non significa assenza di lavoro. Prima di usare i numeri per decisioni sulle persone occorre verificare la copertura delle fonti. Il PM continua a decidere e correggere nei canali di lavoro esistenti.

Passaggi successivi: verifica di lettura su ambiente Giuno, riconciliazione budget accettati, classificazione strutturata delle task e tracking delle approvazioni, poi rilascio della prima vista direzionale.

## Copertura osservata il 10 settembre 2026

75 progetti, 13 membri roster, 200 daily, 29 righe di consuntivo daily, 1 dossier e 0 azioni con chiusura datata. Questi conteggi descrivono la disponibilità dei dati, non il lavoro effettivamente svolto.


## Criteri rivisti l'11 settembre 2026

Vedi `docs/RICALIBRAZIONE_2026-09.md` §22: venduto sulla commessa (verificato o proposta marcata) al posto del venduto per periodo di calendario; tassonomia delle attività da agenzia con distribuzione per progetto e per team; blocchi, milestone, prossimi passi e azioni nella scheda progetto; segnali in ordine di gravità; ciclo di vita esplicito con gli acquisiti in attesa di evidenza separati dallo storico; copertura delle persone.

## Attività (12 settembre 2026)

Livello cliente → commessa → attività → microtask (`docs/RICALIBRAZIONE_2026-09.md` §25 e §27). L'adattatore legge `project_activities` se esiste; le ore per attività vengono dalle microtask dei daily e valgono solo se il daily torna con il consuntivo. Tabella commesse: pulsante "N attività" apre le righe a tendina. Scheda commessa: pannello "Attività" con microtask per persona. Scheda persona: pannello "Attività e microtask".

## 18 settembre 2026 — UX operativa e confronto dei daily

La navigazione approvata passa a Panoramica, Clienti e lavoro, Team, Stime e
Qualità dei dati. Il team comprende il roster attivo anche senza registrazioni
(Corrado e Gloria inclusi), più le persone con daily, ore o piani nel periodo.
L'assenza di daily è esplicita; non è disponibilità libera o zero ore lavorate.
Clienti, commesse, consegne e budget esistenti rimangono raggiungibili. Gli alias
seguono tutta la catena `merged_into`; nessuna modifica a lifecycle o identità.

La vista legge l'API autenticata esistente. Giorno, settimana, mese e trimestre
sono dinamici; ricaricare consulta Supabase senza avviare sincronizzazioni, job
Slack o modelli. La chiave rimane in memoria, mai nell'URL; Esci la elimina e
chiude i dettagli. Il frontend non contiene copie di dati del team.

`giunos_daily_reviews` conserva confronti puntuali con link ai messaggi Slack,
nota, data della verifica e impronta SHA-256 del daily confrontato. Una verifica
scade quando cambia l'originale; un daily aggiunto successivamente prevale sul
supplemento. La tabella ha RLS ed è riservata al servizio. Migrazione idempotente
aggiunta in coda e applicata al database il 18/9.

Il confronto del canale daily 10–17/9 e dei thread ha prodotto 29 verifiche:
14 testi confrontati, 6 correzioni di attribuzione nella vista, 4 supplementi,
1 esclusione per data errata e 4 casi in conflitto. I supplementi comprendono
Claudia 15/16, Paolo 16 e Giusy 10; quest'ultimo sostituisce nella sola vista
il daily erroneamente datato 11. Nessuna somma duplicata con il registro.
I 4 casi ambigui mantengono la versione originale con avviso e fonte.
La correzione nel thread di Alessandra aggiunge lavoro previsto per il 18,
non ore consuntive al 17. I blocchi multicliente restano indivisi.

Le verifiche sono **consultive**: non cambiano `standup_entries`, `time_logs`,
`projects` o le decisioni admin. Il recupero del registro e i problemi di
acquisizione dei daily rimangono interventi separati. Non si deve lanciare un
backfill sulla sola differenza numerica. Le pagine distinguono dichiarazioni,
consuntivi, pianificazioni e stime non confermate, con i messaggi originali
raggiungibili da Qualità dei dati → Fonti Slack.

Le stime mostrano proposte salvate e coppie stima/dichiarazione, senza percentuali
di accuratezza inventate. I tre confronti disponibili, distribuiti su tre persone,
non attivano ancora la calibrazione individuale. Una conferma invariata non è
una misura indipendente. La stima del daily non valuta l'effort di nuove task.

Verifica: test di regressione su date corrette una sola volta, scadenza delle
verifiche, originali intatti, supplementi, stime separate, catene di merge,
roster e rendering delle nuove viste. Anche suite completa prima del push.
La verifica visiva automatica nel browser non è disponibile per la policy della
sessione; il layout deriva dall'anteprima approvata e va ricontrollato dal vivo.


## 18 settembre — account condiviso e decisione sulla bozza contratti

La #135 è stata chiusa su richiesta: nessuno dei suoi job o delle sue tabelle
viene rilasciato. L’account condiviso «Cellulare Aziendale» (`U09J3HK027R`)
è escluso dalla lista persone e dai relativi conteggi, anche se riappare nel
roster Slack. Record originali, ore e account Slack rimangono intatti.
Corrado e Gloria restano visibili anche senza daily.

Le informazioni contrattuali restano importanti per rispondere a «quanto lavoro
abbiamo venduto e quanto ne stiamo utilizzando?». La dashboard dispone già di
budget con fonte e perimetro, distinguendo proposte e budget verificati. Nel
controllo del 18/9 non erano presenti budget nel database: chiudere #135 non
rimuove dati contrattuali già utilizzati in produzione.

Per un’eventuale integrazione successiva, conservare questi requisiti:
- riferimento al contratto e alla revisione effettivamente accettata;
- progetto canonico, deliverable inclusi e periodo di validità;
- ore o giornate vendute, con conversione esplicita e documentata;
- varianti approvate, fonti delle approvazioni e data dell’ultima verifica;
- confronto con ore consuntive, evidenziando prima le lacune nei daily.

Non dedurre ore dagli importi, non distribuire budget di ruolo sulle persone
senza prova e non presentare le ore mancanti come margine residuo affidabile.
La ricostruzione delle fonti potrà essere ripresa come intervento separato,
partendo dai campi già esistenti e da un piccolo campione verificato. Questa
correzione non avvia raccolte contrattuali o nuovi automatismi.
