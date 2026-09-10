// ─── Eval da Slack: processo separato ────────────────────────────────────────
// L'harness (scripts/eval-run.js) stubba i tool con effetto e usa il router
// vero: girarlo dentro il processo del bot romperebbe le risposte live. Qui
// si lancia come figlio con lo stesso env (Railway ha già tutte le chiavi) e
// si legge il riepilogo JSON dallo stdout.

'use strict';

var path = require('path');
var { spawn } = require('child_process');

var TIMEOUT_MS = Number(process.env.EVAL_TIMEOUT_MS) || 20 * 60000;

function parseSummary(stdout) {
  var m = /EVAL_JSON (\{[\s\S]*\})\s*$/m.exec(stdout);
  if (!m) return null;
  try { return JSON.parse(m[1]); } catch(_) { return null; }
}

function formatSummary(sum, stdoutTail) {
  if (!sum) return 'Eval terminata senza riepilogo leggibile.' + (stdoutTail ? '\n```' + stdoutTail.substring(stdoutTail.length - 1200) + '```' : '');
  var lines = ['*Eval:* ' + sum.passed + '/' + sum.total + ' casi superati' + (sum.avg_judge != null ? ' · giudice medio ' + Number(sum.avg_judge).toFixed(2) : '')];
  (sum.failed || []).slice(0, 12).forEach(function(f) {
    lines.push('• ✗ *' + f.id + '*' + (f.failures && f.failures.length ? ' — ' + f.failures.join('; ') : '') + (f.judge ? ' — giudice: ' + f.judge : ''));
    if (f.reply) lines.push('   _"' + f.reply.replace(/\n/g, ' ') + '"_');
  });
  return lines.join('\n');
}

function runEval(args, opts) {
  opts = opts || {};
  var script = path.join(__dirname, '..', '..', 'scripts', 'eval-run.js');
  return new Promise(function(resolve, reject) {
    var child = spawn(process.execPath, [script].concat(args || []), { cwd: path.join(__dirname, '..', '..'), env: process.env, stdio: ['ignore', 'pipe', 'pipe'] });
    var out = '', err = '';
    var timer = setTimeout(function() { try { child.kill('SIGKILL'); } catch(_) {} reject(new Error('timeout dopo ' + Math.round(TIMEOUT_MS / 60000) + ' minuti')); }, opts.timeoutMs || TIMEOUT_MS);
    child.stdout.on('data', function(d) { out += String(d); });
    child.stderr.on('data', function(d) { err += String(d); });
    child.on('error', function(e) { clearTimeout(timer); reject(e); });
    child.on('close', function(code) {
      clearTimeout(timer);
      var sum = parseSummary(out);
      if (!sum && code !== 0 && code !== 1) return reject(new Error('processo uscito con codice ' + code + (err ? ': ' + err.substring(0, 300) : '')));
      resolve({ code: code, summary: sum, text: formatSummary(sum, out) });
    });
  });
}

module.exports = { runEval: runEval, parseSummary: parseSummary, formatSummary: formatSummary };
