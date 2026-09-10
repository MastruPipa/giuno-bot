#!/usr/bin/env node
// ─── Eval runner ─────────────────────────────────────────────────────────────
// Esegue i casi in eval/cases/*.json contro il router REALE di Giuno (stesso
// codice di produzione: retrieval, intent, tool, modello) e valuta le risposte
// con controlli deterministici + giudice LLM. Va lanciato con un .env completo
// (Supabase, Slack, Anthropic): i tool possono leggere dati reali, ma niente
// viene scritto su Slack (nessun postMessage) — le memorie autoLearn sì, quindi
// per un giro "pulito" usa --no-learn.
//
// Uso:
//   node scripts/eval-run.js                 tutti i casi
//   node scripts/eval-run.js --filter=dm-    solo gli id che contengono "dm-"
//   node scripts/eval-run.js --no-judge      solo controlli deterministici
//   node scripts/eval-run.js --no-learn      disattiva autoLearn/DM summary
//   node scripts/eval-run.js --dry           stampa i casi senza chiamare nulla
//
// Output: tabella a schermo + eval/results/<timestamp>.json (gitignored).

'use strict';

require('dotenv').config();

var fs = require('fs');
var path = require('path');

var args = process.argv.slice(2);
function flag(name) { return args.indexOf('--' + name) !== -1; }
function opt(name) { var a = args.find(function(x) { return x.startsWith('--' + name + '='); }); return a ? a.split('=').slice(1).join('=') : null; }

var CASES_DIR = path.join(__dirname, '..', 'eval', 'cases');
var RESULTS_DIR = path.join(__dirname, '..', 'eval', 'results');

function loadCases() {
  if (!fs.existsSync(CASES_DIR)) return [];
  var filter = opt('filter');
  return fs.readdirSync(CASES_DIR)
    .filter(function(f) { return f.endsWith('.json'); })
    .sort()
    .map(function(f) {
      var c = JSON.parse(fs.readFileSync(path.join(CASES_DIR, f), 'utf8'));
      c.id = c.id || f.replace(/\.json$/, '');
      c._file = f;
      return c;
    })
    .filter(function(c) { return !filter || c.id.indexOf(filter) !== -1; });
}

async function runCase(c, deps) {
  var options = {
    threadTs: c.threadTs || null,
    channelId: c.channelId || (c.mode === 'dm' ? 'D_EVAL' : 'C_EVAL'),
    channelType: c.mode === 'dm' ? 'dm' : 'public',
    isDM: c.mode === 'dm',
    transcript: c.transcript || [],
    allowSilence: !!c.allowSilence,
    isCC: !!c.isCC,
    channelContext: c.channelContext || null,
    mentionedBy: c.mode === 'mention' ? c.userId : null,
  };
  var toolsCalled = [];
  var origExec = deps.registry.executeToolCall;
  deps.registry.executeToolCall = async function(name, input) {
    toolsCalled.push(name);
    // Tool con effetto (DM, email, eventi, CRM, roster…): simulati, così i
    // casi possono pretendere la chiamata senza che l'eval scriva davvero.
    if (deps.sideEffects && deps.sideEffects.has(name)) return simulateSideEffect(name, input);
    return origExec.apply(this, arguments);
  };
  var started = Date.now();
  var reply, error = null;
  try {
    reply = await deps.route(c.userId || 'U_EVAL', c.message, options);
  } catch(e) {
    error = e.message;
    reply = '';
  } finally {
    deps.registry.executeToolCall = origExec;
  }
  return { reply: reply, toolsCalled: toolsCalled, ms: Date.now() - started, error: error };
}

function simulateSideEffect(name, input) {
  input = input || {};
  var targets = [].concat(input.target_user_ids || [], input.target_user_names || [], input.target_user_id || [], input.target_user_name || []);
  var out = { success: true, simulated: true, message: 'Azione ' + name + ' simulata dall\'eval (nessun effetto reale).' };
  if (name === 'send_dm') out.sent = targets.map(function(t) { return { target: t, name: t, ts: '0' }; });
  if (name === 'send_campaign') { out.campaign_id = 'cmp_eval'; out.sent_to = targets; }
  if (name === 'send_google_link') out.target = targets[0] || null;
  return out;
}

async function main() {
  var cases = loadCases();
  if (cases.length === 0) {
    console.log('Nessun caso in eval/cases/. Vedi eval/README.md per il formato.');
    process.exit(0);
  }
  if (flag('dry')) {
    cases.forEach(function(c) { console.log('-', c.id, '|', c.mode, '|', (c.description || '').substring(0, 70)); });
    process.exit(0);
  }

  var noJudge = flag('no-judge');
  if (flag('no-learn')) {
    var svc = require('../src/services/anthropicService');
    svc.autoLearn = async function() {};
  }
  var deps = {
    route: require('../src/orchestrator/router').route,
    registry: require('../src/tools/registry'),
    sideEffects: require('../src/services/anthropicService').SIDE_EFFECT_TOOLS,
  };
  var grader = require('../eval/lib/grader');
  var { MODELS } = require('../src/config/models');
  var judgeClient = noJudge ? null : new (require('@anthropic-ai/sdk'))();

  var db = require('../supabase');
  try { await db.initAll(); } catch(e) { console.warn('initAll:', e.message); }

  var results = [];
  for (var i = 0; i < cases.length; i++) {
    var c = cases[i];
    process.stdout.write('[' + (i + 1) + '/' + cases.length + '] ' + c.id + ' … ');
    var run = await runCase(c, deps);
    var failures = run.error ? ['errore: ' + run.error] : grader.deterministicChecks(c, run.reply, run.toolsCalled);
    var verdict = null;
    if (!noJudge && !run.error && c.expect && c.expect.rubric) {
      try { verdict = await grader.judge(judgeClient, MODELS.UTILITY, c, run.reply); }
      catch(e) { verdict = { score: 0, pass: false, reason: 'giudice fallito: ' + e.message }; }
    }
    var pass = failures.length === 0 && (verdict ? verdict.pass : true);
    console.log(pass ? 'OK' : 'FAIL', '(' + run.ms + 'ms' + (run.toolsCalled.length ? ', tool: ' + run.toolsCalled.join(',') : '') + ')');
    if (failures.length) failures.forEach(function(f) { console.log('     ✗ ' + f); });
    if (verdict) console.log('     giudice ' + verdict.score.toFixed(2) + (verdict.pass ? ' ✓ ' : ' ✗ ') + verdict.reason);
    results.push({ id: c.id, pass: pass, failures: failures, judge: verdict, reply: run.reply, tools: run.toolsCalled, ms: run.ms, error: run.error });
  }

  var passed = results.filter(function(r) { return r.pass; }).length;
  var judged = results.filter(function(r) { return r.judge; });
  var avg = judged.length ? judged.reduce(function(a, r) { return a + r.judge.score; }, 0) / judged.length : null;
  console.log('\n' + passed + '/' + results.length + ' casi superati' + (avg != null ? ' — punteggio medio giudice ' + avg.toFixed(2) : ''));

  if (!fs.existsSync(RESULTS_DIR)) fs.mkdirSync(RESULTS_DIR, { recursive: true });
  var out = path.join(RESULTS_DIR, new Date().toISOString().replace(/[:.]/g, '-') + '.json');
  fs.writeFileSync(out, JSON.stringify({
    ran_at: new Date().toISOString(), model: MODELS.PRIMARY, passed: passed, total: results.length, avg_judge: avg, results: results,
  }, null, 2));
  console.log('Risultati in', path.relative(process.cwd(), out));
  if (flag('json')) console.log('EVAL_JSON ' + JSON.stringify({ passed: passed, total: results.length, avg_judge: avg, file: out, failed: results.filter(function(r) { return !r.pass; }).map(function(r) { return { id: r.id, failures: r.failures, judge: r.judge && r.judge.reason, reply: String(r.reply || '').substring(0, 160) }; }) }));
  process.exit(passed === results.length ? 0 : 1);
}

if (require.main === module) main().catch(function(e) { console.error(e); process.exit(1); });
module.exports = { simulateSideEffect: simulateSideEffect, loadCases: loadCases };
