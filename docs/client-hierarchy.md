# Gerarchia clienti: pilota Gambino, 12 settembre 2026

## Comportamento

Una identità cliente esplicita riunisce le voci storiche senza fondere i registri. In giun.os il cliente si espande in incarichi, obiettivi mensili, consegne e microtask. Le fonti sono apribili accanto ai nodi. La vista storica delle singole commesse, le attività introdotte da main e le ore individuali restano disponibili.

Contabilità e operatività hanno evidenze datate separate. La presenza in un mese contabile non implica incasso, approvazione, né durata del contratto. Una chiusura in conflitto con attività corrente viene mostrata come conflitto. Un vecchio Won o un canale esistente non alimentano da soli questo stato.

Il matcher del daily e il risolutore Altro riusano la voce generale del cliente quando l’identità è univoca. Conservano il testo della microtask. Più clienti nella stessa frase restano ambigui. Il matching contestuale e le attività di main sono preservati per gli altri casi. Nessun modello nuovo viene invocato prima dell’ack Slack. Lettura anagrafica con cache e timeout; un errore nel planner produce un errore di campo.

Le righe Altro dello stesso cliente e progetto sommano le ore e conservano i singoli testi/durate nella validation. Valori individuali non validi restano separati perché il validatore li rifiuti. La deduplicazione esclude le voci riconciliate e impedisce merge espliciti che le coinvolgano, prima di scrivere ore.

## Database applicato

Migrazioni additive `agency_client_hierarchy` e `client_default_posting_project`, applicate su Supabase. DDL in client-hierarchy.sql e in coda alla migrazione generale, idempotente e con RLS; nessun accesso anon/authenticated. La gerarchia impedisce cicli e parent di altro cliente.

Il pilota collega esplicitamente le voci storiche a un cliente e aggiunge una voce generale per nuove registrazioni. Nessuna riga di time_logs viene spostata o cancellata. I dati reali della riconciliazione e le prove prima/dopo sono conservati fuori dal repository. Le ore storiche composte non vengono ripartite arbitrariamente sui nodi.

## Limiti del blocco

È il primo blocco del pilota, non l’automazione completa dell’agenzia. Le evidenze e i nodi del pilota sono stati riconciliati dai documenti letti in questa sessione; Il job client_evidence_refresh aggiorna alle 7:35 dei giorni lavorativi le evidenze contabili dal lettore di bilancio esistente e quelle operative dalle prove documentate delle commesse. Non rinnova artificialmente le date delle fonti. Le righe contabili sono associate per identità esatta, senza spartire la stessa riga tra clienti simili. La chiusura di una singola commessa non chiude tutto il cliente. Le approvazioni e le nuove righe del PED richiedono ancora un importatore dedicato; i nodi del pilota riflettono le fonti lette in questa sessione. La finestra operativa di 7 giorni è una politica esplicita del pilota, non un termine contrattuale.

Le nuove microtask del daily possono ricevere work_node_id: nome consegna o termini espliciti riconducono al ramo, un mese esplicito o «prossimo mese» può scegliere il PED. Senza mese, «caption video Gambino» raggiunge Gestione social e resta senza attribuzione mensile. Pareggi restano irrisolti. Persona, testo e ore compaiono nel nodo solo se la somma del dettaglio coincide con il registro daily e con il tipo dichiarato/stimato. La sincronizzazione bidirezionale con project_activities e la creazione di nuovi nodi da tutte le fonti restano fuori da questo pilota. Non usare questo pilota come dichiarazione di consegna o approvazione corrente senza una nuova lettura delle fonti.

Il codice richiede merge e deploy per entrare nel bot; le tabelle additive da sole non lo attivano. Un rollback del codice può lasciare queste tabelle senza alterare le ore. Non cancellare la voce generale se nel frattempo riceve registrazioni.

## Validazione

Suite completa sul codice integrato con origin/main, incluse conservazione ore, conflitti di identità, esclusione weekly dal consuntivo, vincoli SQL e riconoscimento Altro/daily. Il rendering viene verificato con test del frontend. La verifica visiva nel browser è rimasta indisponibile: il controllo di sicurezza amministrativo del browser non ha potuto autorizzare la pagina locale.
