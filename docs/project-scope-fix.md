# Perimetro operativo della dashboard

Attio usa In Progress e Contratto come fasi precedenti a Won 🎉. Non sono
progetti acquisiti. Won prova la vendita, non che il lavoro sia ancora aperto.
La presenza di messaggi nel canale di un cliente non prova lo stato di una
specifica commessa.

La sincronizzazione importa soltanto Won / Won 🎉 come candidati (planning).
Anche i canali scoperti sono candidati, mai attivazioni automatiche.
Progetti chiusi, sospesi, archiviati o uniti non vengono riattivati dalla sync.
La dashboard rispetta lo stato operativo, esclude i contenitori amministrativi
e richiede evidenza per i progetti importati. Le ore restano nel consuntivo
persone e generale, e i dettagli storici restano consultabili.

Evidenza operativa: projects.lifecycle_evidence contiene state: active,
source_url HTTPS, observed_on e valid_until (date ISO). Deve riferirsi alla
commessa specifica e a lavori ancora da consegnare; un evento Slack generico
non è sufficiente. Un contratto scaduto non prova da solo il completamento.
L'estrazione e riconciliazione automatica di questa evidenza non è inclusa
in questa correzione: in assenza di prove i candidati restano esclusi dalla
lista attiva, con un avviso di copertura. Non è richiesto compilare la UI.

Applicare docs/project-lifecycle.sql prima del rilascio: la produzione aveva
un vincolo che rifiutava archived e merged, impedendo l'archiviazione.
La migrazione non riclassifica né cancella dati.

Verifica del 10 settembre: 75 righe projects tutte active e senza end_date;
35 opportunità Won in Attio. Nessuno di questi due conteggi equivale al numero
di commesse operative attive. Prima del rilascio va completata la ricostruzione
del perimetro: altrimenti la nuova vista escluderebbe tutti gli import non
verificati. Questa limitazione è intenzionale e non va nascosta.
