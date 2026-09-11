# Collegamento contratti ed economics — secondo blocco

## Percorso implementato

`extractEconomics` legge la matrice nativa `2. Effort team`, a partire da A1, con valori non formattati. Estrae righe di attività, ruolo, area, persona indicata, quantità e cella sorgente. Esclude prezzi e subtotali; verifica totali di attività e ruolo. Valori malformati, righe prive di ruolo, markup e formule in errore impediscono la verifica del budget.

Le quantità `M/D` restano giornate. Non si applica implicitamente una giornata di otto ore e non si convertono importi economici in effort.

`assessContract` richiede documento e revisione, evidenza dell’accettazione di quella revisione, collegamento documentato agli economics, periodo, conversione giornate/ore documentata e assenza di conflitti. Per un budget periodico richiede anche evidenza del ciclo. Produce `needs_evidence` oppure un budget verificato per progetto e dettaglio per ruolo/area. I nomi nelle intestazioni non attribuiscono automaticamente ore vendute alle persone. Le assegnazioni di ruolo citate da kickoff o messaggi possono essere conservate separatamente, anche con date ancora sconosciute.

`projectBudgets` blocca revisioni sovrapposte, produce il formato già letto da giun.os e non scrive nel registro ore. Il backend della dashboard legge queste proiezioni; le evidenze ancora incomplete sono disponibili nella risposta API, senza nuove schermate o moduli di compilazione. Un trimestre aggrega soltanto cicli completi e contigui; nessuna ripartizione mensile in settimane è inventata.

`reconcileHistory` confronta fonti e registro attuale, segnala descrizioni con più progetti, possibili sovrapposizioni e semantica temporale incerta. Produce candidati e revisioni, **nessun import automatico di ore**. Il campo “ieri” non viene trasferito meccanicamente sulla data della registrazione. Gli alias di progetto devono essere espliciti; ulteriori clienti possono essere inclusi come contesto per rilevare righe miste senza trasformarli in progetti del campione.

## Uso e rilascio

1. Eseguire `node scripts/reconcile-contracts.js <bundle.json>`: modalità locale, nessuna modifica al database. Il bundle contiene `cases`, `database.time_logs`, `database.legacy`, `standups` e `aliases`.
2. Le `cases` contengono le evidenze normalizzate: riferimenti Drive, revisioni, matrice nativa, eventuali conferme specifiche del perimetro e conflitti ancora aperti. Non inserire credenziali o documenti grezzi di kickoff. Questi dati aziendali restano fuori dal repository.
3. Applicare `docs/contract-reconciliation.sql` prima del rilascio. Crea soltanto un registro delle evidenze, accessibile al backend tramite `service_role`.
4. Usare `--stage` per salvare/aggiornare le schede con un `case_id` stabile. Non modifica `time_logs`, preventivi, contratti o budget preesistenti.
5. Il nuovo job delle 06:40 Europe/Rome rilegge i riferimenti già registrati e aggiorna revisione e matrice. Se la revisione cambia, le conferme riferite alla vecchia versione non valgono per la nuova. Se la lettura fallisce, il confronto diventa non verificato. Dopo 36 ore senza aggiornamento valido l’API non usa il budget come confermato.

Il job non scopre ancora autonomamente nuovi contratti o nuove approvazioni: aggiorna le fonti già collegate. Le evidenze normalizzate iniziali del campione sono state ricostruite dalle fonti nella sessione di analisi; non viene richiesta compilazione agli operativi. La successiva ricerca proattiva potrà alimentare lo stesso formato.

## Verifiche

Test su matrici con subtotali, celle malformate, quantità prive di ruolo, cambio revisione, consenso non collegato, unità mancanti, budget sovrapposti, cicli incompleti, periodi trimestrali, fonte non disponibile o scaduta, ruoli senza ore, daily misti e protezione da import storici arbitrari.

Il confronto non implica che il consuntivo abbia copertura completa. Budget verificato e completezza delle ore sono due proprietà distinte. Il lavoro di riconciliazione non modifica retroattivamente i dati esistenti finché data, perimetro e sovrapposizioni non risultano verificati.
