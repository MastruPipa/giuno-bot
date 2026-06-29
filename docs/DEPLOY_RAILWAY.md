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
  - `healthcheckPath: /healthz` → Railway interroga l'endpoint; se l'event loop
    è bloccato (job appeso) la probe non risponde e il container viene
    riavviato. Copre il caso "processo vivo ma appeso" che il crash-guard
    in `index.js` non intercetta.
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
