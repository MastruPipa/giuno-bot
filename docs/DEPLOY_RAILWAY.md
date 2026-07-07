# Deploy su Railway — stabilità & anti-crash notturno

Configurazione che tiene Giuno in piedi 24/7, in particolare durante i batch
notturni pesanti (storico 01:00, knowledge engine + consolidamento 02:00,
graph/KB 03:00, decay/backfill 04:00–04:30, sweep 05:00).

## Cosa fa il repo già da solo

- **`railway.json`** — config-as-code letta da Railway ad ogni deploy:
  - `restartPolicyType: ALWAYS` → se il processo muore davvero (OOM, kill),
    Railway lo riavvia **sempre**, invece di lasciarlo giù fino al mattino.
  - `numReplicas: 1` → **una sola istanza**. Un bot Slack in Socket Mode NON
    va replicato: due istanze = messaggi gestiti due volte e cron duplicati.

> **Healthcheck — riattivato.** `startOAuthServer()` ora parte **all'inizio**
> di `main()` in `src/app.js`, quindi `/healthz` risponde entro pochi secondi
> dall'avvio del container, per tutta la durata del boot (db.initAll,
> app.start, seed roster). `railway.json` ha di nuovo
> `healthcheckPath: "/healthz"` + `healthcheckTimeout: 120`.
> In più `src/utils/socketWatchdog.js` copre il caso "zombie" (crons vivi ma
> websocket Socket Mode morta, come la mattina del 6/7): dopo 3 minuti di
> disconnessione senza recupero il processo esce con exit(1) e
> `restartPolicyType: ALWAYS` lo rialza pulito. Lo shutdown rapido su SIGTERM
> in `app.js` riduce la finestra in cui vecchia e nuova istanza convivono
> durante un redeploy (fonte dei cron duplicati).
- **`index.js`** — `unhandledRejection` / `uncaughtException` loggati senza
  far morire il processo (`[FATAL-GUARD]`).
- **`slackService.js`** — `app.error()` globale di Bolt (`[BOLT-ERROR]`).

## Cosa impostare a mano su Railway (una tantum)

### 1. Cap di memoria — evita l'OOM-kill silenzioso

L'OOM dell'heap V8 NON è intercettabile dal crash-guard: il processo viene
abortito di colpo. Impostando il cap **sotto** la RAM del container, Node fa
GC più aggressiva e tende a non sforare. Nelle **Variables** del servizio:

```
NODE_OPTIONS=--max-old-space-size=<~75% della RAM del piano in MB>
```

Esempi: piano da 512 MB → `--max-old-space-size=384`; da 1 GB → `768`.
`npm start` (= `node index.js`) eredita automaticamente `NODE_OPTIONS`.

### 2. Log

Railway cattura e conserva già `stdout` (dove scrive il logger). Per ritrovare
una crash dopo il fatto, filtra i log per `[FATAL-GUARD]` o `[BOLT-ERROR]`.

## Verifica post-deploy

```
BASE_URL=https://<tuo-host> bash scripts/post-deploy-check.sh
curl -fsS https://<tuo-host>/healthz   # -> {"status":"ok","uptime":...}
```

> Nota (7/7/2026): la prima build post-merge di PR #116 è fallita su Railway
> senza motivo riconducibile al codice (config JSON valide, dipendenze ok) —
> retrigger con questo commit. Se una build fallisce di nuovo, guardare i
> build logs dal link nell'email di Railway prima di toccare il codice.
