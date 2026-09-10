# Primo blocco di affidabilità — Giuno

## Comportamento

- Il parser dei daily e il fallback di associazione progetti eseguono davvero le operazioni con timeout; i timer vengono liberati e il parser non legge più un campo inesistente.
- I callback schedulati restituiscono il lavoro asincrono allo scheduler. La sovrapposizione locale è bloccata anche durante l’acquisizione del lock; se il database dei lock fallisce, il job non parte senza protezione.
- Errori Attio, risposte invalide, limite di paginazione, errori di attività Slack o scrittura progetti interrompono la sincronizzazione prima dell’archiviazione. Una lista vuota non può archiviare automaticamente un intero catalogo. La disattivazione di tutti i progetti richiede un percorso esplicito distinto.
- `log_time` e `log_hours` impostano il **totale giornaliero per persona/progetto/data** in `time_logs`. Non incrementano un contatore: per una richiesta di ore aggiuntive il bot deve prima leggere il totale e riconciliarlo. Questa è una modifica intenzionale del contratto degli strumenti, descritta nelle rispettive definizioni. Non è ancora un registro di eventi incrementali con identità della singola attività.
- Il report conversazionale legge lo stesso registro della dashboard, separa la quota stimata e non presume la fatturabilità sconosciuta. Indica l’eventuale limite di lettura.
- Le ore non generano più costi fittizi a 45 €/h. Nessun costo o budget storico viene ricalcolato automaticamente.
- Le scritture passano per un’unica funzione transazionale PostgreSQL. Le correzioni complete possono eliminare le righe assenti, incluso l’ultimo progetto. Se ci sono attività non attribuite, si aggiornano soltanto i progetti conosciuti senza cancellare gli altri.
- Le stime non sostituiscono né cancellano dichiarazioni. Ogni modifica effettiva conserva prima/dopo nel registro delle scritture. Rigiocare lo stesso snapshot non somma ore.
- Le allocazioni restano un riepilogo derivato: il comando segnala se le ore sono salvate ma il riepilogo non si è riallineato. In caso di errore di lettura non viene più ricavato uno zero artificiale.

## Pubblicazione

1. Verificare sul database di destinazione lo schema di `time_logs`: colonne e indice univoco definiti in `supabase_migration.sql`, accesso `service_role` e nome del vincolo ore.
2. Applicare `docs/time-log-writes.sql` **prima** del codice. La migrazione è transazionale, preserva le righe esistenti e consente attività inferiori a mezz’ora. Nessun trasferimento da registri storici è incluso.
3. Pubblicare il codice; verificare letture autenticate, parser e stato dei job. Non inviare messaggi al team per i test senza autorizzazione.
4. Verificare che `write_time_logs` sia disponibile con il ruolo applicativo. Se manca, il codice segnala un errore; non ripiega su cancellazioni/scritture non atomiche.

La migrazione è aggiuntiva rispetto al codice precedente: in caso di rollback dell’applicazione, lasciare funzione e storico in sede. Il vecchio codice non beneficia delle nuove protezioni. Non eliminare lo storico per ripristinare l’applicazione.

## Verifica

`npm test` include un PostgreSQL locale tramite PGlite: rollback dopo cancellazione e fallimento di inserimento, replay, totale massimo giornaliero, quarti d’ora, priorità dichiarazioni/stime, correzione vuota e permessi di esecuzione. I test dei percorsi applicativi coprono parsing, chiamate dei due strumenti, errori di scrittura, sync incompleta e mantenimento del lock del callback dossier reale.

## Lavoro successivo

- Riconciliare `time_entries`, daily e allocazioni storiche su tre progetti campione. Non sommare le tabelle: potrebbero descrivere lo stesso lavoro e alcuni vecchi daily erano pianificazioni.
- Aggiungere identità delle singole attività, budget contrattuali versionati e ricerca proattiva delle informazioni mancanti.
- Integrare recupero automatico dei riepiloghi e monitoraggio persistente della freschezza delle fonti. I contatori dello scheduler restano in memoria.
- Recuperare revisioni documentali, segnali brevi di approvazione e gli altri difetti P2 del rapporto: non inclusi in questo blocco.

Questo intervento non rende retroattivamente completo il consuntivo né introduce metriche affidabili di produttività individuale senza la successiva riconciliazione.
