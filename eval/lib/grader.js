// ─── Eval grader ─────────────────────────────────────────────────────────────
// Due livelli di verifica su una risposta di Giuno:
//   1. controlli deterministici (no_reply, must_include, must_not_include,
//      max_lines, must_call_tool) — gratis, senza modello;
//   2. rubrica letta da un giudice LLM (Sonnet 5) che dà un punteggio 0-1 e una
//      motivazione — solo se il caso ha una `rubric`.
// La parte deterministica è pura e testata; il giudice è isolato in judge().

'use strict';

var { isNoReply } = require('../../src/utils/noReply');

function deterministicChecks(caseDef, reply, toolsCalled) {
  var expect = (caseDef && caseDef.expect) || {};
  var failures = [];
  var text = String(reply || '');
  var low = text.toLowerCase();

  if (expect.no_reply === true) {
    if (!isNoReply(text)) failures.push('doveva restare in silenzio (NO_REPLY), ha risposto: "' + text.substring(0, 80) + '"');
    return failures; // gli altri controlli non hanno senso
  }
  if (expect.no_reply === false && isNoReply(text)) failures.push('doveva rispondere, è rimasto in silenzio');

  (expect.must_include || []).forEach(function(needle) {
    if (low.indexOf(String(needle).toLowerCase()) === -1) failures.push('manca "' + needle + '"');
  });
  (expect.must_not_include || []).forEach(function(needle) {
    if (low.indexOf(String(needle).toLowerCase()) !== -1) failures.push('contiene "' + needle + '" che non doveva esserci');
  });
  if (expect.max_lines) {
    var lines = text.split('\n').filter(function(l) { return l.trim(); }).length;
    if (lines > expect.max_lines) failures.push('troppo lunga: ' + lines + ' righe (max ' + expect.max_lines + ')');
  }
  if (expect.max_chars && text.length > expect.max_chars) failures.push('troppo lunga: ' + text.length + ' caratteri (max ' + expect.max_chars + ')');
  (expect.must_call_tool || []).forEach(function(tool) {
    if ((toolsCalled || []).indexOf(tool) === -1) failures.push('non ha chiamato il tool ' + tool);
  });
  (expect.must_not_call_tool || []).forEach(function(tool) {
    if ((toolsCalled || []).indexOf(tool) !== -1) failures.push('ha chiamato il tool ' + tool + ' che non doveva');
  });
  if (/\*\*[^*]+\*\*/.test(text)) failures.push('formattazione: doppio asterisco (non Slack)');
  if (/^#{1,6}\s/m.test(text)) failures.push('formattazione: titolo markdown con #');
  return failures;
}

var JUDGE_SYSTEM =
  'Sei il valutatore di Giuno, assistente Slack interno di un\'agenzia di marketing. ' +
  'Ricevi la conversazione, il messaggio dell\'utente, la risposta di Giuno e una rubrica scritta da chi conosce il contesto. ' +
  'Giudica SOLO rispetto alla rubrica e ai principi base: risposta pertinente al thread, niente informazioni inventate, ' +
  'lunghezza adeguata alla domanda, tono da collega, formato Slack (*grassetto* singolo, niente #). ' +
  'Rispondi SOLO con JSON: {"score": 0.0-1.0, "pass": true|false, "reason": "una o due frasi in italiano"}. ' +
  'pass = true solo se la rubrica è rispettata nella sostanza (score >= 0.7).';

function buildJudgePrompt(caseDef, reply) {
  var transcript = (caseDef.transcript || []).map(function(t) {
    return (t.role === 'user' ? 'UTENTE' : 'GIUNO') + ': ' + t.content;
  }).join('\n');
  return 'CASO: ' + (caseDef.id || '?') + (caseDef.description ? ' — ' + caseDef.description : '') + '\n\n' +
    'CONVERSAZIONE PRECEDENTE:\n' + (transcript || '(nessuna)') + '\n\n' +
    'MESSAGGIO DELL\'UTENTE:\n' + caseDef.message + '\n\n' +
    'RISPOSTA DI GIUNO:\n' + (reply || '(vuota)') + '\n\n' +
    'RUBRICA:\n' + caseDef.expect.rubric;
}

async function judge(client, model, caseDef, reply) {
  if (!caseDef.expect || !caseDef.expect.rubric) return null;
  var res = await client.messages.create({
    model: model,
    max_tokens: 400,
    system: JUDGE_SYSTEM,
    messages: [{ role: 'user', content: buildJudgePrompt(caseDef, reply) }],
  });
  var text = (res.content || []).filter(function(b) { return b.type === 'text'; }).map(function(b) { return b.text; }).join('');
  var m = text.match(/\{[\s\S]*\}/);
  if (!m) return { score: 0, pass: false, reason: 'giudice senza JSON: ' + text.substring(0, 120) };
  try {
    var parsed = JSON.parse(m[0]);
    return { score: Number(parsed.score) || 0, pass: !!parsed.pass, reason: String(parsed.reason || '') };
  } catch(e) {
    return { score: 0, pass: false, reason: 'JSON giudice malformato' };
  }
}

module.exports = { deterministicChecks: deterministicChecks, buildJudgePrompt: buildJudgePrompt, judge: judge, JUDGE_SYSTEM: JUDGE_SYSTEM };
