# Guida rapida: dove mettere i file e come risolvere il conflitto

## 1) Posizione corretta
Tutti i file/script che abbiamo aggiunto vanno nella root del repo `giuno-bot`:

- `scripts/resolve-slackservice-conflict.sh`
- `scripts/check-conflicts.sh`
- `scripts/post-deploy-check.sh`

Quindi il path completo è, ad esempio:
`/workspace/giuno-bot/scripts/resolve-slackservice-conflict.sh`

## 2) Come usarlo (da root progetto)
```bash
cd /workspace/giuno-bot
npm run resolve:slack-conflict
npm run check:conflicts
npm test
```

## 3) Se stai lavorando su un altro computer
Metti lo script nella cartella `scripts/` del tuo clone locale, poi assicurati che `package.json` abbia gli script npm:

```json
"check:conflicts": "bash scripts/check-conflicts.sh",
"check:deploy": "bash scripts/post-deploy-check.sh",
"resolve:slack-conflict": "bash scripts/resolve-slackservice-conflict.sh"
```

## 4) Dopo la risoluzione
```bash
git add src/services/slackService.js
git commit -m "fix: resolve slackService merge conflict"
git push
```
