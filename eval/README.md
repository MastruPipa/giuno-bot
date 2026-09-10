# Eval — misurare Giuno invece di andare a sensazione

Ogni caso è una conversazione Slack (vera o costruita) più il criterio di una
buona risposta. Il runner fa passare il messaggio dal **router di produzione**
(retrieval, intent, tool, modello: lo stesso codice del bot) e valuta la
risposta in due modi:

1. **controlli deterministici** — silenzio atteso, frasi che devono/non devono
   comparire, lunghezza, tool chiamati o vietati, formato Slack;
2. **giudice LLM** (Sonnet 5) — legge la `rubric` scritta da chi conosce il
   contesto e dà un punteggio 0-1 con motivazione.

```
npm run eval                      # tutti i casi, con giudice
npm run eval -- --no-judge        # solo controlli deterministici (gratis)
npm run eval -- --filter=thread   # solo gli id che contengono "thread"
npm run eval -- --no-learn        # non far imparare nulla a Giuno da questo giro
npm run eval -- --dry             # elenca i casi senza chiamare nulla
```

Serve un `.env` completo (Anthropic, Supabase, Slack): i tool leggono dati
reali. Niente viene postato su Slack. I risultati finiscono in
`eval/results/<timestamp>.json` (ignorato da git) — confrontare due file
prima/dopo una modifica è il modo per dire "è migliorato".

## Aggiungere un caso da un thread reale

```
npm run eval:import -- C0123ABC 1725960000.123456 --id=aitho-scadenza --anon
npm run eval:import -- D0123ABC --dm --id=dm-corrado-recap
```

Lo script scrive `eval/cases/<id>.json` con la storia del thread come
`transcript`, l'ultimo messaggio umano come `message` e la risposta reale di
Giuno (se c'era) in `reference_reply`. Poi vanno compilati a mano:

- `description` — cosa deve capire o fare Giuno;
- `expect.rubric` — cosa rende buona una risposta: fatti da citare, cosa non
  inventare, tono, lunghezza. È il testo che legge il giudice;
- `expect.must_include` / `must_not_include` — frasi chiave (case-insensitive);
- `expect.no_reply` — `true` se la risposta giusta è il silenzio;
- `allowSilence` — `true` se nel caso reale Giuno non era taggato.

`--anon` sostituisce gli id Slack con `U1`, `U2`… e toglie i nomi: usarlo per
i casi che escono dal team.

## Formato del caso

```json
{
  "id": "dm-follow-up-breve",
  "description": "…",
  "mode": "dm | thread | mention",
  "userId": "U_EVAL",
  "channelId": "D_EVAL",
  "threadTs": null,
  "allowSilence": false,
  "isCC": false,
  "channelContext": "CANALE: #… (solo per mention/thread, opzionale)",
  "transcript": [ { "role": "user", "content": "…" }, { "role": "assistant", "content": "…" } ],
  "message": "il messaggio da valutare",
  "expect": {
    "no_reply": false,
    "must_include": [], "must_not_include": [],
    "max_lines": 6, "max_chars": null,
    "must_call_tool": [], "must_not_call_tool": [],
    "rubric": "…"
  }
}
```

I sei casi con `"seed": true` sono costruiti a tavolino per coprire i
comportamenti base (riferimenti brevi in DM, silenzio nei thread, CC, ore mai
inventate, formato Slack). Vanno affiancati, e poi sostituiti, da casi reali.
