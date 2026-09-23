// ─── Orari del daily (Europe/Rome, lun-ven) ──────────────────────────────────
// Dal 17/9/2026 la stima arriva a tutti alle 17:30: a quell'ora la giornata è
// fatta e le tracce sono complete. Override senza deploy: DAILY_SEND_AT,
// DAILY_PUSH_AT, DAILY_RECAP_AT in formato HH:MM. Vive qui (e non nel
// handler) perché anche il prompt del modello deve sapere il flusso.
'use strict';

function timeFromEnv(name, fallback) {
  var v = String(process.env[name] || '').trim();
  return /^([01]?\d|2[0-3]):[0-5]\d$/.test(v) ? v : fallback;
}

var DAILY_TIMES = {
  send: timeFromEnv('DAILY_SEND_AT', '17:30'),
  push: timeFromEnv('DAILY_PUSH_AT', '18:00'),
  recap: timeFromEnv('DAILY_RECAP_AT', '18:30'),
};

function cronExprFor(hhmm) {
  var parts = hhmm.split(':');
  return String(Number(parts[1])) + ' ' + String(Number(parts[0])) + ' * * 1-5';
}

// Una frase per il prompt: così Giuno risponde giusto a "cosa succede se non approvo?".
function describeFlow() {
  return 'FLUSSO DAILY (lun-ven): alle ' + DAILY_TIMES.send + ' ogni persona riceve in DM la stima della giornata ricostruita da Giuno con i bottoni Approvo / Modifico nel modulo (già compilato: con la proposta, o con il daily di oggi già salvato) / Compilo da zero / Scrivo a testo libero (una sola area di testo, Giuno divide task, ore e progetti); ' +
    'può anche correggerla scrivendo in DM ("aggiungi 1h di call con X", "togli Y", "erano 3h") e Giuno rimanda la proposta aggiornata. ' +
    'Alle ' + DAILY_TIMES.push + ' promemoria a chi non ha risposto. Alle ' + DAILY_TIMES.recap + ' recap: chi non ha approvato né compilato riceve la stima SALVATA come daily marcato "stima di Giuno, non confermata", pubblicato in #daily, con le ore nel consuntivo segnate come stimate; ' +
    'chi non ha nemmeno una stima viene taggato tra i mancanti in #daily. Un daily compilato o approvato sostituisce sempre la stima. ' +
    'Un daily già registrato viene SOSTITUITO se la persona approva la stima dopo: dillo prima di consigliare di approvare.';
}

module.exports = { DAILY_TIMES: DAILY_TIMES, cronExprFor: cronExprFor, describeFlow: describeFlow };
