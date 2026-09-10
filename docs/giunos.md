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
